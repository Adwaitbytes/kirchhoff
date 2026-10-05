import {
  blocksHash,
  junction,
  reasonName,
  ReportType,
  Status,
  type Credit,
  type Debit,
  type Hex,
  type JunctionResult,
  type PinnedBlock,
  type TokenSpec,
  type W1Config,
} from "@kirchhoff/engine";
import {
  createCcipV2Adapter,
  createWeakbridgeAdapter,
  debitFromRegistry,
  encodeDebitOf,
  type BridgeAdapter,
} from "@kirchhoff/engine/adapters";
import { decodeFunctionResult, encodeFunctionData, pad } from "viem";
import { LEDGER_ABI } from "./abi.ts";
import { logWindow } from "./budget.ts";
import { chainByName, chainBySelector, ledgerTargets, readBlock, sameAddress, type ChainEntry } from "./chains.ts";
import type { ChainIo, ChainLog } from "./io.ts";
import { junctionEvidence, writeToLedgers, type WriteResult } from "./reports.ts";

type CreditWatch = W1Config["creditTriggers"][number];
type DebitLookup = W1Config["debitLookups"][number];

export type TriggerGroup = { chain: string; addresses: Hex[]; topic0s: Hex[]; confidence: ChainEntry["triggerConfidence"] };

/** CRE `LogTrigger.FilterAddressLimit`: addresses per log trigger. */
export const CRE_TRIGGER_ADDRESS_LIMIT = 5;
/** CRE `TriggerSubscriptionLimit`: triggers per workflow. */
export const CRE_TRIGGER_LIMIT = 10;

/**
 * One log trigger per chain over every credit emitter on it (PRD section 8 W1: "one trigger per chain"). The
 * array position is the `--trigger-index` for `cre workflow simulate`, so it follows `config.chains` order.
 */
export function creditTriggerGroups(config: W1Config): TriggerGroup[] {
  const groups: TriggerGroup[] = [];
  for (const chain of config.chains) {
    const watches = config.creditTriggers.filter((w) => w.chain === chain.name);
    if (watches.length === 0) continue;
    const addresses = unique(watches.map((w) => w.address));
    if (addresses.length > CRE_TRIGGER_ADDRESS_LIMIT) {
      throw new RangeError(`${chain.name} has ${addresses.length} credit emitters; a CRE log trigger takes at most ${CRE_TRIGGER_ADDRESS_LIMIT}`);
    }
    groups.push({ chain: chain.name, addresses, topic0s: unique(watches.map((w) => w.topic0)), confidence: chain.triggerConfidence });
  }
  if (groups.length > CRE_TRIGGER_LIMIT) throw new RangeError(`W1 needs ${groups.length} triggers; CRE allows ${CRE_TRIGGER_LIMIT}`);
  return groups;
}

function unique(values: readonly Hex[]): Hex[] {
  const seen = new Map<string, Hex>();
  for (const v of values) if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  return [...seen.values()];
}

export function adapterFor(spec: TokenSpec, watch: { adapter: string; bridgeId: string }): BridgeAdapter {
  if (watch.adapter === "ccip_v2") return createCcipV2Adapter(spec, watch.bridgeId);
  if (watch.adapter === "weakbridge") return createWeakbridgeAdapter(spec, watch.bridgeId);
  throw new Error(`no workflow adapter for ${watch.adapter} (bridge ${watch.bridgeId})`);
}

/**
 * Step 1: decode the credit carried by the trigger log. Single-event bridges decode the log itself; CCIP 2.0 needs
 * the transaction's logs because the amount sits on the pool log and the message id on the OffRamp log.
 */
export function decodeTriggerCredit(io: ChainIo, config: W1Config, spec: TokenSpec, chain: ChainEntry, log: ChainLog): Credit | null {
  const watch = config.creditTriggers.find(
    (w) => w.chain === chain.name && sameAddress(w.address, log.address) && log.topics[0]?.toLowerCase() === w.topic0.toLowerCase(),
  );
  if (watch === undefined) return null;
  const adapter = adapterFor(spec, watch);
  const selector = BigInt(chain.selector);
  if (watch.pairWith === null) return adapter.decodeCredit(log, selector);
  const credits = adapter.decodeTxCredits(io.receiptLogs(chain.name, log.transactionHash), selector);
  // Several credits can share one execution tx; the trigger log's own message id picks ours.
  return credits.find((c) => c.messageId.toLowerCase() === log.topics[adapter.messageIdTopicIndex]?.toLowerCase()) ?? null;
}

/**
 * Debit lookups on the claimed source chain, the credit's own bridge first. The Junction Rule keys a debit by
 * (source chain, message id) only, so a credit on one bridge that replays a debit made through another bridge is
 * still matched, and then caught as DOUBLE_CREDIT once that debit is consumed (PRD section 17 scenario 4).
 */
export function lookupsFor(config: W1Config, sourceChain: string, credit: CreditWatch): DebitLookup[] {
  const onSource = config.debitLookups.filter((d) => d.chain === sourceChain);
  return [...onSource.filter((d) => d.bridgeId === credit.bridgeId), ...onSource.filter((d) => d.bridgeId !== credit.bridgeId)];
}

/**
 * Step 3 (INTERFACES.md Revision 2): the debit at or below the pinned source block. A bridge with a debit
 * registry is answered exactly by one `debitOf` read at that block; the latest 100-block window is then searched
 * only to attach the debit's transaction as evidence. CCIP has no registry: the OnRamp `CCIPMessageSent` with
 * the message id in topics[3] is searched in that window and its transaction decoded.
 */
export function findDebit(
  io: ChainIo,
  spec: TokenSpec,
  lookup: DebitLookup,
  source: ChainEntry,
  messageId: Hex,
  pinned: bigint,
): Debit | null {
  const selector = BigInt(source.selector);
  // Nothing above genesis is confident yet, so no debit can be.
  if (pinned < 1n) return null;
  const window = logWindow(pinned, BigInt(lookup.searchWindowBlocks));
  const idTopics: Hex[][] = [[lookup.topic0]];
  for (let i = 1; i < lookup.messageIdTopicIndex; i++) idTopics.push([]);
  idTopics.push([pad(messageId, { size: 32 })]);
  const query = { addresses: [lookup.address], topics: idTopics, ...window };

  if (lookup.registry !== null) {
    const data = io.call(source.name, lookup.address, encodeDebitOf(messageId), { tag: "number", number: pinned });
    const registered = debitFromRegistry(messageId, selector, data);
    if (registered === null) return null;
    const evidence = io.logs(source.name, query)[0];
    return evidence === undefined ? registered : { ...registered, txHash: evidence.transactionHash };
  }
  const rampLog = io.logs(source.name, query)[0];
  if (rampLog === undefined) return null;
  const adapter = adapterFor(spec, lookup);
  const debits = adapter.decodeTxDebits(io.receiptLogs(source.name, rampLog.transactionHash), selector);
  return debits.find((d) => d.messageId.toLowerCase() === messageId.toLowerCase()) ?? null;
}

export type JunctionOutcome =
  | { kind: "ignored"; reason: string }
  | {
      kind: "evaluated";
      credit: Credit;
      debit: Debit | null;
      verdict: JunctionResult;
      sourceHead: bigint;
      writes: WriteResult[];
    };

const ZERO_TX: Hex = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";

/**
 * PRD section 8 W1, steps 1-6, for one credit log. Reads: 1 header (credit block) + 1 header (source pin) +
 * per source bridge until the debit is found (registry: debitOf + evidence filterLogs; CCIP: OnRamp filterLogs +
 * receipt) + 1 isConsumed, plus 1 receipt for a CCIP credit. Two bridges: at most 2 + 4 + 1 + 1 = 8 of 15.
 */
export function runJunction(io: ChainIo, config: W1Config, spec: TokenSpec, chainName: string, log: ChainLog, now: bigint): JunctionOutcome {
  const dst = chainByName(config.chains, chainName);
  const credit = decodeTriggerCredit(io, config, spec, dst, log);
  if (credit === null) return { kind: "ignored", reason: `log ${log.transactionHash}#${log.logIndex} is not a credit of ${config.token}` };
  const watch = config.creditTriggers.find((w) => w.chain === dst.name && sameAddress(w.address, log.address));
  if (watch === undefined) return { kind: "ignored", reason: "credit emitter is not watched" };
  io.log(`credit ${credit.messageId} on ${dst.name}: ${credit.amount} to ${credit.recipient ?? "?"} claiming source ${credit.claimedSrcChain}`);

  const creditHeader = io.header(dst.name, { tag: "number", number: credit.block });
  const source = chainBySelector(config.chains, credit.claimedSrcChain);
  const lookups = source === undefined ? [] : lookupsFor(config, source.name, watch);

  let debit: Debit | null = null;
  let sourceHead = 0n;
  let sourceFinal = true;
  const pinned: PinnedBlock[] = [{ chain: BigInt(dst.selector), block: credit.block }];
  if (source !== undefined && lookups.length > 0) {
    // Step 2: the source chain's confident head bounds the debit search.
    const head = io.header(source.name, readBlock(source.readConfidence));
    sourceHead = head.number;
    sourceFinal = head.timestamp >= creditHeader.timestamp;
    if (source.name !== dst.name) pinned.push({ chain: BigInt(source.selector), block: head.number });
    for (const lookup of lookups) {
      debit = findDebit(io, spec, lookup, source, credit.messageId, head.number);
      if (debit !== null) break;
    }
  }
  // A source chain or bridge outside the spec can never hold a valid debit: the claim itself is forged.

  // Step 4: the consumed-debit set on the credited chain's ledger.
  const consumedData = io.call(
    dst.name,
    dst.ledger,
    encodeFunctionData({ abi: LEDGER_ABI, functionName: "isConsumed", args: [credit.messageId] }),
    { tag: "latest" },
  );
  const consumed = decodeFunctionResult({ abi: LEDGER_ABI, functionName: "isConsumed", data: consumedData });

  // Step 5.
  const verdict = junction(credit, debit, {
    spec,
    sourceHead,
    sourceFinal,
    isConsumed: () => consumed,
    creditTimestamp: creditHeader.timestamp,
    now,
  });
  io.log(`junction ${credit.messageId}: status ${verdict.status} reason ${reasonName(verdict.reason)}${debit === null ? " (no debit)" : ""}`);

  // Step 6. OK: W2 settles the id in its next EPOCH (it re-matches by id). BROKEN: BREACH everywhere, now.
  if (verdict.status !== Status.BROKEN) return { kind: "evaluated", credit, debit, verdict, sourceHead, writes: [] };
  const evidenceHash = junctionEvidence({ dstChain: credit.dstChain, txHash: credit.txHash, messageId: credit.messageId, reason: verdict.reason });
  const writes = writeToLedgers(io, ledgerTargets(config.chains), config.tokenId, {
    reportType: ReportType.BREACH,
    payload: {
      epochId: credit.block,
      delta: 0n,
      blocksHash: blocksHash(pinned),
      evidenceHash,
      reason: verdict.reason,
      offendingChain: credit.dstChain,
      offendingTx: credit.txHash === ZERO_TX ? log.transactionHash : credit.txHash,
      recipient: credit.recipient ?? ZERO_ADDRESS,
      amount: credit.amount,
      messageId: credit.messageId,
    },
  });
  return { kind: "evaluated", credit, debit, verdict, sourceHead, writes };
}

