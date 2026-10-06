import type { Hex } from "@kirchhoff/engine";
import type { SimulateArgs, SimulateResult } from "./cre.ts";

/**
 * Testnet simulation runner standing in for the CRE DON cron while deploy access is pending. One round:
 *   1. stop if the deployer's Sepolia spend since start exceeds the cap;
 *   2. skip the round if Sepolia gas is above the cap (every broadcast pays Sepolia gas);
 *   3. W1 for every new credit log at or below its chain's trigger confidence (what a deployed log trigger fires on);
 *   4. W3 for every new BreachRecorded on the home ledger (including breaches W1 just wrote);
 *   5. W2 on its cron trigger.
 * Every simulation is retried on rate limits with backoff and then moved to the provider-2 target.
 * All IO is injected (RunnerDeps), so the loop is unit-tested with a mock CLI and mock chains.
 */

export type ChainName = string;

export type ObservedLog = { chain: ChainName; txHash: Hex; blockNumber: bigint; logIndex: number };

/** A log trigger the runner replays: which workflow, which trigger index, which logs. */
export type LogWatch = {
  workflow: "w1-junction" | "w3-responder";
  triggerIndex: number;
  chain: ChainName;
  addresses: Hex[];
  topic0s: Hex[];
  /** Block tag the deployed trigger would wait for: CRE log trigger confidence. */
  confidence: "latest" | "safe" | "finalized";
};

export type RunnerDeps = {
  /** Deployer balance on Sepolia, wei. */
  sepoliaBalance(): Promise<bigint>;
  sepoliaGasPrice(): Promise<bigint>;
  blockAt(chain: ChainName, tag: LogWatch["confidence"]): Promise<bigint>;
  logs(watch: LogWatch, fromBlock: bigint, toBlock: bigint): Promise<ObservedLog[]>;
  /** 0-based position of a log in its transaction's receipt (what `--evm-event-index` takes). */
  receiptIndex(log: ObservedLog): Promise<number>;
  simulate(args: SimulateArgs): Promise<SimulateResult>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  emit(event: RunnerEvent): void;
};

export type RunnerOptions = {
  intervalSeconds: number;
  /** Hard cap on the deployer's Sepolia balance decrease since start, wei. */
  maxSepoliaSpendWei: bigint;
  /** Rounds are skipped while Sepolia gas is above this, wei. */
  maxSepoliaGasWei: bigint;
  /** Stop after this many completed rounds (null: until stopped). */
  rounds: number | null;
  watches: LogWatch[];
  /** Pre-built WASM per workflow (skips the compile on every run). */
  wasm: Partial<Record<SimulateArgs["workflow"], string>>;
  retries: number;
  backoffMs: number;
};

export type RunnerEvent = { event: string; [key: string]: unknown };

/** Provider throttling as the CLI reports it (never matched against a successful run: tx hashes contain digits). */
/** One JSON line; bigints (block numbers, wei) become decimal strings. */
export function jsonLine(e: RunnerEvent, ts: Date): string {
  return JSON.stringify({ ts: ts.toISOString(), ...e }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

export const RATE_LIMITED = /Too Many Requests|rate limit exceeded|status code 429/i;

/** Transaction links the workflow logged (`<TYPE> -> <chain> ledger <addr>: tx 0x...`). */
export function reportTxs(result: SimulateResult): { chain: string; type: string; txHash: Hex }[] {
  const out: { chain: string; type: string; txHash: Hex }[] = [];
  for (const line of result.userLogs) {
    const m = /^(\w+) -> (\S+) ledger 0x[0-9a-fA-F]{40}: tx (0x[0-9a-fA-F]{64})$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) out.push({ type: m[1], chain: m[2], txHash: m[3] as Hex });
  }
  return out;
}

export class RunnerState {
  stopRequested = false;
  /** A method, not a field read, because a signal handler flips the flag while a round is awaiting IO. */
  stopping(): boolean {
    return this.stopRequested;
  }
  readonly cursors = new Map<string, bigint>();
  startBalance: bigint | null = null;
  /**
   * Once provider 1 has rate-limited a run that then succeeded on the fallback target, later runs start there:
   * a 429 can land after a run has already written to some ledgers, so every retry costs a Sepolia write.
   */
  preferFallback = false;
  completedRounds = 0;
}

const watchKey = (w: LogWatch): string => `${w.workflow}:${w.chain}:${w.triggerIndex.toString()}`;

/**
 * One simulation with rate-limit handling: provider 1 (`staging`) with exponential backoff, then provider 2
 * (`staging-fallback`) with the same budget. Any other failure is returned as is.
 */
export async function simulateResilient(
  deps: RunnerDeps,
  opts: RunnerOptions,
  args: Omit<SimulateArgs, "target" | "wasm">,
  state: RunnerState = new RunnerState(),
): Promise<SimulateResult> {
  let last: SimulateResult | null = null;
  const order = state.preferFallback ? (["staging-fallback", "staging"] as const) : (["staging", "staging-fallback"] as const);
  for (const target of order) {
    for (let attempt = 0; attempt <= opts.retries; attempt++) {
      const wasm = opts.wasm[args.workflow];
      last = await deps.simulate({ ...args, target, ...(wasm === undefined ? {} : { wasm }) });
      if (last.error === null || !RATE_LIMITED.test(last.output)) {
        if (target === "staging-fallback" && last.error === null && !state.preferFallback) {
          state.preferFallback = true;
          deps.emit({ event: "provider_sticky", target });
        }
        return last;
      }
      const wait = opts.backoffMs * 2 ** attempt;
      deps.emit({ event: "rate_limited", workflow: args.workflow, target, attempt, retryInMs: wait, error: last.error });
      await deps.sleep(wait);
    }
    deps.emit({ event: "provider_fallback", workflow: args.workflow, from: target });
  }
  if (last === null) throw new Error("no simulation attempted");
  return last;
}

async function runLogWatch(deps: RunnerDeps, opts: RunnerOptions, state: RunnerState, watch: LogWatch): Promise<void> {
  const head = await deps.blockAt(watch.chain, watch.confidence);
  const key = watchKey(watch);
  const from = state.cursors.get(key);
  // First sight of a chain: start at the confident head, never replay history.
  if (from === undefined || from > head) {
    state.cursors.set(key, head + 1n);
    return;
  }
  const logs = await deps.logs(watch, from, head);
  state.cursors.set(key, head + 1n);
  for (const log of logs) {
    const eventIndex = await deps.receiptIndex(log);
    const result = await simulateResilient(
      deps,
      opts,
      { workflow: watch.workflow, triggerIndex: watch.triggerIndex, evm: { txHash: log.txHash, eventIndex }, broadcast: true },
      state,
    );
    deps.emit({ event: "simulated", workflow: watch.workflow, trigger: log, result: result.result, error: result.error, txs: reportTxs(result) });
  }
}

export type RoundOutcome = "ran" | "skipped_gas" | "stopped_cap" | "stopped";

export async function runRound(deps: RunnerDeps, opts: RunnerOptions, state: RunnerState): Promise<RoundOutcome> {
  const round = state.completedRounds + 1;
  const before = await deps.sepoliaBalance();
  state.startBalance ??= before;
  const spent = state.startBalance - before;
  if (spent > opts.maxSepoliaSpendWei) {
    deps.emit({ event: "spend_cap_reached", round, spentWei: spent.toString(), capWei: opts.maxSepoliaSpendWei.toString() });
    return "stopped_cap";
  }
  const gas = await deps.sepoliaGasPrice();
  if (gas > opts.maxSepoliaGasWei) {
    deps.emit({ event: "round_skipped_gas", round, sepoliaGasWei: gas.toString(), capWei: opts.maxSepoliaGasWei.toString() });
    return "skipped_gas";
  }
  deps.emit({ event: "round_start", round, at: deps.now().toISOString(), sepoliaGasWei: gas.toString(), balanceWei: before.toString() });
  // W1 first so its BREACH is visible to the W3 watch in this same round.
  for (const watch of opts.watches.filter((w) => w.workflow === "w1-junction")) {
    if (state.stopping()) return "stopped";
    await runLogWatch(deps, opts, state, watch);
  }
  for (const watch of opts.watches.filter((w) => w.workflow === "w3-responder")) {
    if (state.stopping()) return "stopped";
    await runLogWatch(deps, opts, state, watch);
  }
  if (state.stopping()) return "stopped";
  const w2 = await simulateResilient(deps, opts, { workflow: "w2-loop", triggerIndex: 0, broadcast: true }, state);
  const after = await deps.sepoliaBalance();
  deps.emit({
    event: "round_done",
    round,
    w2: w2.result,
    error: w2.error,
    txs: reportTxs(w2),
    sepoliaSpentWei: (before - after).toString(),
    totalSpentWei: (state.startBalance - after).toString(),
  });
  return "ran";
}

/** Runs rounds every `intervalSeconds` until stopped, the round count is reached, or the spend cap is hit. */
export async function runLoop(deps: RunnerDeps, opts: RunnerOptions, state: RunnerState): Promise<RoundOutcome> {
  for (;;) {
    if (state.stopping()) return "stopped";
    const started = deps.now().getTime();
    const outcome = await runRound(deps, opts, state);
    if (outcome === "stopped_cap" || outcome === "stopped") {
      deps.emit({ event: "runner_stopped", reason: outcome, rounds: state.completedRounds });
      return outcome;
    }
    if (outcome === "ran") state.completedRounds++;
    if (opts.rounds !== null && state.completedRounds >= opts.rounds) {
      deps.emit({ event: "runner_stopped", reason: "rounds", rounds: state.completedRounds });
      return "stopped";
    }
    const elapsed = deps.now().getTime() - started;
    const wait = Math.max(0, opts.intervalSeconds * 1000 - elapsed);
    // Sleep in short slices so a shutdown request is honored within a second.
    for (let slept = 0; slept < wait && !state.stopping(); slept += 1000) await deps.sleep(Math.min(1000, wait - slept));
  }
}
