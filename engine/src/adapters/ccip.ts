import { decodeAbiParameters, toEventSelector } from "viem";
import { EngineInputError, type CcipBridgeSpec, type ChainSel, type Credit, type Debit, type Hex, type TokenSpec } from "../types.ts";
import { addressOn } from "./event.ts";
import type { BridgeAdapter, Log } from "./types.ts";

/**
 * CCIP 2.0.0 event ABIs, verbatim from docs/research/ccip.md (pool events
 * confirmed against live Sepolia logs). Pool events carry no message id.
 */
export const CCIP_EVENTS = {
  LockedOrBurned: "LockedOrBurned(uint64 indexed remoteChainSelector, address token, address sender, uint256 amount)",
  ReleasedOrMinted:
    "ReleasedOrMinted(uint64 indexed remoteChainSelector, address token, address sender, address recipient, uint256 amount)",
  CCIPMessageSent:
    "CCIPMessageSent(uint64 indexed destChainSelector, address indexed sender, bytes32 indexed messageId, address feeToken, uint256 tokenAmountBeforeTokenPoolFees, bytes encodedMessage, (address issuer, uint32 destGasLimit, uint32 destBytesOverhead, uint256 feeTokenAmount, bytes extraArgs)[] receipts, bytes[] verifierBlobs)",
  ExecutionStateChanged:
    "ExecutionStateChanged(uint64 indexed sourceChainSelector, uint64 indexed messageNumber, bytes32 indexed messageId, uint8 state, bytes returnData)",
} as const;

export const CCIP_TOPICS = {
  LockedOrBurned: toEventSelector(CCIP_EVENTS.LockedOrBurned),
  ReleasedOrMinted: toEventSelector(CCIP_EVENTS.ReleasedOrMinted),
  CCIPMessageSent: toEventSelector(CCIP_EVENTS.CCIPMessageSent),
  ExecutionStateChanged: toEventSelector(CCIP_EVENTS.ExecutionStateChanged),
} as const;

/** The ramp events carry the message id in topics[3]. */
const MESSAGE_ID_TOPIC = 3;

type DebitMove = { remoteChain: bigint; amount: bigint };
type CreditMove = DebitMove & { recipient: Hex };

const same = (a: Hex, b: Hex | null): boolean => b !== null && a.toLowerCase() === b.toLowerCase();

/** Topic `index` of a log, which the caller has already checked exists. */
export function topicAt(log: Log, index: number): Hex {
  const topic = log.topics[index];
  if (topic === undefined) throw new EngineInputError(`log ${log.transactionHash} has no topic ${index}`);
  return topic.toLowerCase() as Hex;
}

function decodeDebitMove(log: Log): DebitMove {
  const [, , amount] = decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], log.data);
  return { remoteChain: BigInt(topicAt(log, 1)), amount };
}

function decodeCreditMove(log: Log): CreditMove {
  const [, , recipient, amount] = decodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
    log.data,
  );
  return { remoteChain: BigInt(topicAt(log, 1)), amount, recipient: recipient.toLowerCase() as Hex };
}

type Pairing<M> = {
  pool: Hex | null;
  ramp: Hex | null;
  poolTopic: Hex;
  rampTopic: Hex;
  decode: (log: Log) => M;
};

/**
 * Pairs each ramp log with the nearest preceding unpaired pool log of the same
 * transaction. Observed order on Sepolia: the pool's LockedOrBurned, then the
 * OnRamp's CCIPMessageSent; on delivery the pool's ReleasedOrMinted precedes
 * the OffRamp's ExecutionStateChanged. A failed execution reverts the pool
 * release, so an unpaired ExecutionStateChanged is never a credit.
 */
function pairInTx<M>(logs: readonly Log[], p: Pairing<M>): { move: M; ramp: Log }[] {
  const stack: M[] = [];
  const pairs: { move: M; ramp: Log }[] = [];
  for (const log of logs) {
    const t0 = log.topics[0]?.toLowerCase();
    if (same(log.address, p.pool) && t0 === p.poolTopic && log.topics.length === 2) {
      try {
        stack.push(p.decode(log));
      } catch {
        // Undecodable data under our topic is not a value movement we key on; its ramp log stays unpaired.
      }
    } else if (same(log.address, p.ramp) && t0 === p.rampTopic && log.topics.length === 4) {
      const move = stack.pop();
      if (move !== undefined) pairs.push({ move, ramp: log });
    }
  }
  return pairs;
}

function ccipBridge(spec: TokenSpec, bridgeId: string): CcipBridgeSpec {
  const bridge = spec.bridges.find((b) => b.id === bridgeId);
  if (bridge?.kind !== "ccip_v2") throw new EngineInputError(`spec ${spec.token} has no ccip_v2 bridge "${bridgeId}"`);
  return bridge;
}

/**
 * CCIP 2.0 adapter. Debits and credits are decoded per transaction because the
 * message id is on the OnRamp/OffRamp log, not on the pool log; a single log
 * alone never yields one. filterLogs by message id targets the OnRamp
 * (`CCIPMessageSent`, topics[3]) for debits and the OffRamp for credits.
 */
export function createCcipV2Adapter(spec: TokenSpec, bridgeId = "ccip"): BridgeAdapter {
  const bridge = ccipBridge(spec, bridgeId);
  const has = (s: TokenSpec, chain: ChainSel, map: "onramps" | "offramps"): boolean => {
    const b = s.bridges.find((x) => x.id === bridgeId);
    return b?.kind === "ccip_v2" && addressOn(s, b[map], chain) !== null;
  };
  return {
    id: "ccip_v2",
    messageIdTopicIndex: MESSAGE_ID_TOPIC,
    maxDeliverySeconds: bridge.maxDeliverySeconds,
    debitTopics: (s, chain) => (has(s, chain, "onramps") ? [CCIP_TOPICS.CCIPMessageSent] : []),
    creditTopics: (s, chain) => (has(s, chain, "offramps") ? [CCIP_TOPICS.ExecutionStateChanged] : []),
    decodeDebit: () => null,
    decodeCredit: () => null,
    decodeTxDebits(logs, chain): Debit[] {
      const pool = addressOn(spec, bridge.pools, chain);
      const onramp = addressOn(spec, bridge.onramps, chain);
      const pairs = pairInTx(logs, {
        pool,
        ramp: onramp,
        poolTopic: CCIP_TOPICS.LockedOrBurned,
        rampTopic: CCIP_TOPICS.CCIPMessageSent,
        decode: decodeDebitMove,
      });
      return pairs.map(({ move, ramp }) => ({
          messageId: topicAt(ramp, MESSAGE_ID_TOPIC),
          srcChain: chain,
          dstChain: move.remoteChain,
          // The pool's own amount: what was actually locked or burned (fee-on-transfer safe).
          amount: move.amount,
          txHash: ramp.transactionHash,
          block: ramp.blockNumber,
        }));
    },
    decodeTxCredits(logs, chain): Credit[] {
      const pool = addressOn(spec, bridge.pools, chain);
      const offramp = addressOn(spec, bridge.offramps, chain);
      const pairs = pairInTx(logs, {
        pool,
        ramp: offramp,
        poolTopic: CCIP_TOPICS.ReleasedOrMinted,
        rampTopic: CCIP_TOPICS.ExecutionStateChanged,
        decode: decodeCreditMove,
      });
      return pairs.flatMap(({ move, ramp }): Credit[] => {
        const claimedSrcChain = BigInt(topicAt(ramp, 1));
        // The pool and the OffRamp must agree on the lane, or this is not the same message.
        if (claimedSrcChain !== move.remoteChain) return [];
        return [
          {
            messageId: topicAt(ramp, MESSAGE_ID_TOPIC),
            claimedSrcChain,
            dstChain: chain,
            amount: move.amount,
            recipient: move.recipient,
            txHash: ramp.transactionHash,
            block: ramp.blockNumber,
          },
        ];
      });
    },
  };
}
