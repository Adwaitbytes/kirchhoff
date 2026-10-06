import type { Hex } from "@kirchhoff/engine";
import { describe, expect, it } from "vitest";
import { parseEther, parseGwei } from "viem";
import type { SimulateArgs, SimulateResult } from "../scripts/lib/cre.ts";
import {
  jsonLine,
  reportTxs,
  RunnerState,
  runLoop,
  runRound,
  simulateResilient,
  type LogWatch,
  type ObservedLog,
  type RunnerDeps,
  type RunnerEvent,
  type RunnerOptions,
} from "../scripts/lib/runner-core.ts";

const HOME = "ethereum-testnet-sepolia";
const ARB = "ethereum-testnet-sepolia-arbitrum-1";
const TX = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const LEDGER: Hex = "0x05fE18C1cb1FF308aF668a7abaAf6Ac3f623B5D3";

const ok = (result: string, logs: string[] = []): SimulateResult => ({ command: "cre", exitCode: 0, output: logs.join("\n"), userLogs: logs, result, error: null });
const limited = (): SimulateResult => ({
  command: "cre",
  exitCode: 1,
  output: '✗ workflow execution failed: [2]Unknown: 429 Too Many Requests: {"error":{"code":-32005,"message":"rate limit exceeded"}}',
  userLogs: [],
  result: null,
  error: "✗ workflow execution failed",
});

const W1_ARB: LogWatch = { workflow: "w1-junction", triggerIndex: 1, chain: ARB, addresses: [], topic0s: [], confidence: "finalized" };
const W3_HOME: LogWatch = { workflow: "w3-responder", triggerIndex: 0, chain: HOME, addresses: [], topic0s: [], confidence: "finalized" };

type Mock = RunnerDeps & {
  calls: SimulateArgs[];
  events: RunnerEvent[];
  slept: number[];
  balance: bigint;
  gas: bigint;
  heads: Map<string, bigint>;
  pending: Map<string, ObservedLog[]>;
  script: SimulateResult[];
  onSimulate?: (a: SimulateArgs) => void;
};

/** A mock CLI and chain: simulations answer from `script` (then ok), and every W2 broadcast costs 0.001 ETH. */
function mock(): Mock {
  const m: Mock = {
    calls: [],
    events: [],
    slept: [],
    balance: parseEther("0.012"),
    gas: parseGwei("1.1"),
    heads: new Map([
      [HOME, 100n],
      [ARB, 1000n],
    ]),
    pending: new Map(),
    script: [],
    sepoliaBalance: () => Promise.resolve(m.balance),
    sepoliaGasPrice: () => Promise.resolve(m.gas),
    blockAt: (chain) => Promise.resolve(m.heads.get(chain) ?? 0n),
    logs: (watch, from, to) =>
      Promise.resolve((m.pending.get(`${watch.workflow}:${watch.chain}`) ?? []).filter((l) => l.blockNumber >= from && l.blockNumber <= to)),
    receiptIndex: (log) => Promise.resolve(log.logIndex - 10),
    simulate: (a) => {
      m.calls.push(a);
      m.onSimulate?.(a);
      if (a.workflow === "w2-loop" && a.broadcast) m.balance -= parseEther("0.001");
      return Promise.resolve(m.script.shift() ?? ok(`${a.workflow} ok`));
    },
    sleep: (ms) => {
      m.slept.push(ms);
      return Promise.resolve();
    },
    now: () => new Date(0),
    emit: (e) => m.events.push(e),
  };
  return m;
}

const options = (over: Partial<RunnerOptions> = {}): RunnerOptions => ({
  intervalSeconds: 90,
  maxSepoliaSpendWei: parseEther("0.02"),
  maxSepoliaGasWei: parseGwei("1.5"),
  rounds: 1,
  watches: [W1_ARB, W3_HOME],
  wasm: { "w2-loop": "/abs/w2-loop/binary.wasm" },
  retries: 2,
  backoffMs: 100,
  ...over,
});

describe("runner round", () => {
  it("runs W2 on its cron trigger with --broadcast against staging, using the prebuilt WASM", async () => {
    const m = mock();
    expect(await runRound(m, options(), new RunnerState())).toBe("ran");
    expect(m.calls).toEqual([{ workflow: "w2-loop", triggerIndex: 0, broadcast: true, target: "staging", wasm: "/abs/w2-loop/binary.wasm" }]);
    const done = m.events.find((e) => e.event === "round_done");
    expect(done?.sepoliaSpentWei).toBe(parseEther("0.001").toString());
  });

  it("skips the round (no simulation) while Sepolia gas is above the cap", async () => {
    const m = mock();
    m.gas = parseGwei("1.6");
    expect(await runRound(m, options(), new RunnerState())).toBe("skipped_gas");
    expect(m.calls).toEqual([]);
  });

  it("stops before simulating once the Sepolia spend since start exceeds the cap", async () => {
    const m = mock();
    const state = new RunnerState();
    const opts = options({ maxSepoliaSpendWei: parseEther("0.0015"), rounds: null });
    expect(await runLoop(m, opts, state)).toBe("stopped_cap");
    // Round 1 spends 0.001, round 2 spends 0.001 (0.002 > 0.0015), round 3 refuses to start.
    expect(m.calls.filter((c) => c.workflow === "w2-loop")).toHaveLength(2);
    expect(m.events.at(-2)?.event).toBe("spend_cap_reached");
  });

  it("starts log cursors at the confident head, then replays every new credit through W1 and breaches through W3, before W2", async () => {
    const m = mock();
    const state = new RunnerState();
    await runRound(m, options(), state); // first sight: cursors only
    expect(m.calls.map((c) => c.workflow)).toEqual(["w2-loop"]);
    m.heads.set(ARB, 1010n);
    m.heads.set(HOME, 105n);
    m.pending.set(`w1-junction:${ARB}`, [{ chain: ARB, txHash: TX(1), blockNumber: 1005n, logIndex: 12 }]);
    // The BREACH W1 writes shows up for W3 in the same round.
    m.onSimulate = (a) => {
      if (a.workflow === "w1-junction") m.pending.set(`w3-responder:${HOME}`, [{ chain: HOME, txHash: TX(2), blockNumber: 104n, logIndex: 10 }]);
    };
    await runRound(m, options(), state);
    expect(m.calls.slice(1).map((c) => [c.workflow, c.triggerIndex, c.evm])).toEqual([
      ["w1-junction", 1, { txHash: TX(1), eventIndex: 2 }],
      ["w3-responder", 0, { txHash: TX(2), eventIndex: 0 }],
      ["w2-loop", 0, undefined],
    ]);
    // Logs above the confident head wait for the next round; seen logs are never replayed.
    await runRound(m, options(), state);
    expect(m.calls.slice(4).map((c) => c.workflow)).toEqual(["w2-loop"]);
  });

  it("finishes the current simulation and exits on a shutdown request", async () => {
    const m = mock();
    const state = new RunnerState();
    m.onSimulate = () => {
      state.stopRequested = true;
    };
    expect(await runLoop(m, options({ rounds: null }), state)).toBe("stopped");
    expect(m.calls).toHaveLength(1);
  });

  it("waits the rest of the interval between rounds in 1 s slices", async () => {
    const m = mock();
    await runLoop(m, options({ rounds: 2, intervalSeconds: 3 }), new RunnerState());
    expect(m.slept).toEqual([1000, 1000, 1000]);
  });
});

describe("runner resilience", () => {
  it("retries a 429 with exponential backoff, then falls back to the provider-2 target", async () => {
    const m = mock();
    m.script = [limited(), limited(), limited(), limited(), ok("w2 ok")];
    const result = await simulateResilient(m, options(), { workflow: "w2-loop", triggerIndex: 0, broadcast: true });
    expect(result.result).toBe("w2 ok");
    expect(m.calls.map((c) => c.target)).toEqual(["staging", "staging", "staging", "staging-fallback", "staging-fallback"]);
    expect(m.slept).toEqual([100, 200, 400, 100]);
    expect(m.events.some((e) => e.event === "provider_fallback")).toBe(true);
  });

  it("stays on the fallback target after it succeeded, so later rounds do not repeat partial writes", async () => {
    const m = mock();
    const state = new RunnerState();
    m.script = [limited(), limited(), limited(), ok("w2 ok")];
    await simulateResilient(m, options(), { workflow: "w2-loop", triggerIndex: 0, broadcast: true }, state);
    expect(state.preferFallback).toBe(true);
    await simulateResilient(m, options(), { workflow: "w2-loop", triggerIndex: 0, broadcast: true }, state);
    expect(m.calls.at(-1)?.target).toBe("staging-fallback");
    expect(m.calls).toHaveLength(5);
  });

  it("returns other failures without retrying, and never mistakes digits in a successful run for a 429", async () => {
    const m = mock();
    const failed: SimulateResult = { ...ok("x"), result: null, error: "✗ receiver reverted", output: "✗ receiver reverted" };
    m.script = [failed];
    expect((await simulateResilient(m, options(), { workflow: "w2-loop", triggerIndex: 0, broadcast: true })).error).toBe("✗ receiver reverted");
    m.script = [ok("epoch 1 status=1", [`EPOCH -> ${HOME} ledger ${LEDGER}: tx 0x${"429".padEnd(64, "0")}`])];
    await simulateResilient(m, options(), { workflow: "w2-loop", triggerIndex: 0, broadcast: true });
    expect(m.calls).toHaveLength(2);
  });

  it("writes every event as one JSON line, bigints as decimal strings", () => {
    const line = jsonLine({ event: "simulated", trigger: { chain: ARB, txHash: TX(1), blockNumber: 2n ** 64n, logIndex: 3 } }, new Date(0));
    expect(JSON.parse(line)).toEqual({ ts: "1970-01-01T00:00:00.000Z", event: "simulated", trigger: { chain: ARB, txHash: TX(1), blockNumber: "18446744073709551616", logIndex: 3 } });
  });

  it("extracts the report transactions the workflow logged", () => {
    const tx = TX(7);
    expect(reportTxs(ok("r", [`EPOCH -> ${ARB} ledger ${LEDGER}: tx ${tx}`, "loop: escrow 0"]))).toEqual([{ type: "EPOCH", chain: ARB, txHash: tx }]);
  });
});
