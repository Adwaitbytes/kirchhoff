/**
 * CRE production limit `ChainRead.CallLimit`: 15 EVM reads per execution (callContract, filterLogs,
 * headerByNumber, getTransactionReceipt, ...), enforced by `cre workflow simulate` by default
 * (docs/research/cre.md section 8). Every read goes through a ReadBudget so a workflow fails with a clear
 * message before the DON would reject the sixteenth call, and so tests can assert the per-workflow budget.
 */
export const CRE_CHAIN_READ_LIMIT = 15;

/** CRE `ChainRead.LogQueryBlockLimit`: one filterLogs query may span at most 100 blocks (inclusive range). */
export const CRE_LOG_QUERY_BLOCK_LIMIT = 100n;

export type ReadKind = "headerByNumber" | "callContract" | "filterLogs" | "getTransactionReceipt";

export type ReadRecord = { kind: ReadKind; chain: string; label: string };

export class ReadBudgetExceeded extends Error {
  override readonly name = "ReadBudgetExceeded";
}

export class ReadBudget {
  readonly #limit: number;
  readonly #reads: ReadRecord[] = [];

  constructor(limit: number = CRE_CHAIN_READ_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1 || limit > CRE_CHAIN_READ_LIMIT) {
      throw new RangeError(`read budget must be an integer in [1, ${CRE_CHAIN_READ_LIMIT}], got ${limit}`);
    }
    this.#limit = limit;
  }

  /** Records one read; throws before the read is made when it would exceed the budget. */
  spend(kind: ReadKind, chain: string, label: string): void {
    if (this.#reads.length >= this.#limit) {
      throw new ReadBudgetExceeded(
        `EVM read budget of ${this.#limit} exhausted before ${kind} ${label} on ${chain}; reads so far: ${this.describe()}`,
      );
    }
    this.#reads.push({ kind, chain, label });
  }

  get used(): number {
    return this.#reads.length;
  }

  get remaining(): number {
    return this.#limit - this.#reads.length;
  }

  get reads(): readonly ReadRecord[] {
    return this.#reads;
  }

  describe(): string {
    return this.#reads.map((r) => `${r.kind}(${r.chain}:${r.label})`).join(", ");
  }
}

/**
 * The inclusive block range of the latest `CRE_LOG_QUERY_BLOCK_LIMIT` blocks ending at `head`,
 * clamped at genesis. `filterLogs` with this range never exceeds the CRE query limit.
 */
export function logWindow(head: bigint, blocks: bigint = CRE_LOG_QUERY_BLOCK_LIMIT): { fromBlock: bigint; toBlock: bigint } {
  if (blocks < 1n || blocks > CRE_LOG_QUERY_BLOCK_LIMIT) {
    throw new RangeError(`log window must span 1..${CRE_LOG_QUERY_BLOCK_LIMIT} blocks, got ${blocks}`);
  }
  if (head < 0n) throw new RangeError(`head block must be non-negative, got ${head}`);
  const from = head - blocks + 1n;
  return { fromBlock: from < 0n ? 0n : from, toBlock: head };
}
