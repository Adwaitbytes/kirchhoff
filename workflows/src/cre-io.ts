import {
  bigintToProtoBigInt,
  bytesToHex,
  EVMClient,
  type EVMLog,
  encodeCallMsg,
  hexToBase64,
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER,
  prepareReportRequest,
  protoBigIntToBigint,
  type Runtime,
  TxStatus,
} from "@chainlink/cre-sdk";
import { EVM_PB } from "@chainlink/cre-sdk/pb";
import type { Hex } from "@kirchhoff/engine";
import type { BlockHeader, BlockRef, ChainIo, ChainLog, LogQuery, WriteOutcome } from "./io.ts";

const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";

type BigIntJson = ReturnType<typeof bigintToProtoBigInt>;

function blockJson(block: BlockRef): BigIntJson {
  switch (block.tag) {
    case "latest":
      return LATEST_BLOCK_NUMBER;
    case "finalized":
      return LAST_FINALIZED_BLOCK_NUMBER;
    case "number":
      return bigintToProtoBigInt(block.number);
  }
}

/** Converts a CRE log into the engine adapter shape. */
export function fromCreLog(log: EVMLog): ChainLog {
  if (log.blockNumber === undefined) throw new Error("CRE log has no block number");
  return {
    address: bytesToHex(log.address).toLowerCase() as Hex,
    topics: log.topics.map((t) => bytesToHex(t).toLowerCase() as Hex),
    data: bytesToHex(log.data),
    transactionHash: bytesToHex(log.txHash).toLowerCase() as Hex,
    blockNumber: protoBigIntToBigint(log.blockNumber),
    logIndex: log.index,
  };
}

/**
 * ChainIo over the CRE EVM capability. Every call is a DON consensus read; `.result()` blocks until the
 * capability answers (never awaited, per the SDK contract).
 */
export function creChainIo<C>(runtime: Runtime<C>, selectors: ReadonlyMap<string, bigint>): ChainIo {
  const clients = new Map<string, EVMClient>();
  const client = (chain: string): EVMClient => {
    const existing = clients.get(chain);
    if (existing !== undefined) return existing;
    const selector = selectors.get(chain);
    if (selector === undefined) throw new Error(`chain ${chain} is not in the workflow config`);
    const created = new EVMClient(selector);
    clients.set(chain, created);
    return created;
  };

  return {
    header(chain, block): BlockHeader {
      const reply = client(chain).headerByNumber(runtime, { blockNumber: blockJson(block) }).result();
      const header = reply.header;
      if (header?.blockNumber === undefined) throw new Error(`no ${block.tag} header on ${chain}`);
      return {
        number: protoBigIntToBigint(header.blockNumber),
        timestamp: header.timestamp,
        hash: bytesToHex(header.hash),
      };
    },
    call(chain, to, data, block): Hex {
      const reply = client(chain)
        .callContract(runtime, {
          call: encodeCallMsg({ from: ZERO_ADDRESS, to, data }),
          blockNumber: blockJson(block),
        })
        .result();
      return bytesToHex(reply.data);
    },
    logs(chain, query: LogQuery): ChainLog[] {
      const reply = client(chain)
        .filterLogs(runtime, {
          filterQuery: {
            addresses: query.addresses.map((a) => hexToBase64(a)),
            topics: query.topics.map((slot) => ({ topic: slot.map((t) => hexToBase64(t)) })),
            fromBlock: bigintToProtoBigInt(query.fromBlock),
            toBlock: bigintToProtoBigInt(query.toBlock),
          },
        })
        .result();
      return reply.logs.map(fromCreLog);
    },
    receiptLogs(chain, txHash): ChainLog[] {
      const reply = client(chain).getTransactionReceipt(runtime, { hash: hexToBase64(txHash) }).result();
      if (reply.receipt === undefined) throw new Error(`no receipt for ${txHash} on ${chain}`);
      return reply.receipt.logs.map(fromCreLog);
    },
    writeReport(chain, receiver, payload, gasLimit): WriteOutcome {
      const report = runtime.report(prepareReportRequest(payload)).result();
      const reply = client(chain)
        .writeReport(runtime, { receiver, report, gasConfig: { gasLimit: gasLimit.toString() } })
        .result();
      const txHash = bytesToHex(reply.txHash ?? new Uint8Array(32));
      if (reply.txStatus !== TxStatus.SUCCESS) {
        return { ok: false, error: `tx status ${TxStatus[reply.txStatus]}: ${reply.errorMessage ?? "no error message"}` };
      }
      // The forwarder transaction succeeds even when onReport reverts (docs/research/cre-contracts.md section 6).
      if (reply.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.REVERTED) {
        return { ok: false, error: `receiver ${receiver} reverted in tx ${txHash}: ${reply.errorMessage ?? ""}` };
      }
      return { ok: true, txHash };
    },
    log(message) {
      runtime.log(message);
    },
  };
}
