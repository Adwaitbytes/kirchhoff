import type { Hex } from "@kirchhoff/engine";
import { ReadBudget, type ReadKind } from "./budget.ts";

/**
 * The chain operations the workflows perform, independent of the CRE SDK so the workflow logic is plain,
 * synchronous, testable TypeScript. `cre-io.ts` implements it over `EVMClient`; tests use a fake.
 *
 * Block selectors mirror what CRE chain reads accept (docs/research/cre.md section 5): the latest block, the
 * last finalized block, or an explicit number. There is no "safe" read in CRE.
 */
export type BlockRef = { tag: "latest" } | { tag: "finalized" } | { tag: "number"; number: bigint };

export type BlockHeader = { number: bigint; timestamp: bigint; hash: Hex };

/** A log in the engine adapter shape plus its position, for evidence. */
export type ChainLog = {
  address: Hex;
  topics: readonly Hex[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: bigint;
  /** Index of the log within its block. */
  logIndex: number;
};

export type LogQuery = {
  addresses: readonly Hex[];
  /** Per topic position: allowed values (OR); an empty array or missing position matches anything. */
  topics: readonly (readonly Hex[])[];
  fromBlock: bigint;
  toBlock: bigint;
};

export type WriteOutcome =
  | { ok: true; txHash: Hex }
  | { ok: false; error: string };

export interface ChainIo {
  header(chain: string, block: BlockRef): BlockHeader;
  call(chain: string, to: Hex, data: Hex, block: BlockRef): Hex;
  logs(chain: string, query: LogQuery): ChainLog[];
  receiptLogs(chain: string, txHash: Hex): ChainLog[];
  /** Signs `payload` as a CRE report and delivers it to `receiver` through the chain's forwarder. */
  writeReport(chain: string, receiver: Hex, payload: Hex, gasLimit: bigint): WriteOutcome;
  log(message: string): void;
}

/**
 * Wraps a ChainIo so every read is charged to `budget` before it happens. Writes are not reads and are
 * limited separately by CRE (`ChainWrite.TargetsLimit` = 10 chains per report).
 */
export function withBudget(io: ChainIo, budget: ReadBudget): ChainIo {
  const charge = (kind: ReadKind, chain: string, label: string): void => {
    budget.spend(kind, chain, label);
  };
  return {
    header(chain, block) {
      charge("headerByNumber", chain, block.tag === "number" ? block.number.toString() : block.tag);
      return io.header(chain, block);
    },
    call(chain, to, data, block) {
      charge("callContract", chain, `${to}:${data.slice(0, 10)}`);
      return io.call(chain, to, data, block);
    },
    logs(chain, query) {
      charge("filterLogs", chain, `${query.fromBlock.toString()}-${query.toBlock.toString()}`);
      return io.logs(chain, query);
    },
    receiptLogs(chain, txHash) {
      charge("getTransactionReceipt", chain, txHash);
      return io.receiptLogs(chain, txHash);
    },
    writeReport: (chain, receiver, payload, gasLimit) => io.writeReport(chain, receiver, payload, gasLimit),
    log: (message) => {
      io.log(message);
    },
  };
}
