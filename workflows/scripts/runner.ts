/**
 * Testnet simulation runner standing in for the CRE DON cron while deploy access is pending.
 *
 *   pnpm --filter @kirchhoff/workflows runner --target staging --interval 90 --max-sepolia-eth 0.02 [--rounds N]
 *
 * Every interval it runs `cre workflow simulate ./w2-loop --target staging --broadcast` on the cron trigger, and
 * W1 / W3 on every new credit / BreachRecorded log at its trigger confidence, so the testnet ledgers stay fresh and
 * the system reacts on its own. Stops on SIGINT / SIGTERM after the current simulation, on `--rounds`, or when the
 * deployer's Sepolia balance has dropped by more than `--max-sepolia-eth`. Rounds are skipped while Sepolia gas is
 * above `--max-sepolia-gwei` (default 1.5). Every event is one JSON line on stdout and in runner.log.jsonl.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPublicClient, fallback, http, parseEther, parseGwei, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { w1ConfigSchema, w3ConfigSchema } from "../src/config.ts";
import { creditTriggerGroups } from "../src/w1.ts";
import { buildWasm, simulate, type SimulateArgs } from "./lib/cre.ts";
import { loadEnv, privateKey, required } from "./lib/env.ts";
import { jsonLine, RunnerState, runLoop, type LogWatch, type RunnerDeps, type RunnerEvent } from "./lib/runner-core.ts";

const WORKFLOWS = resolve(import.meta.dirname, "..");
const REPO = resolve(WORKFLOWS, "..");

function arg(name: string, fallbackValue?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? fallbackValue : process.argv[i + 1];
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

const target = arg("target", "staging");
if (target !== "staging") throw new Error("the runner drives the public testnets only (--target staging)");
const intervalSeconds = Number(arg("interval", "90"));
if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30) throw new Error("--interval must be an integer >= 30 (CRE cron floor)");
const roundsArg = process.argv.includes("--rounds") ? Number(arg("rounds")) : null;
if (roundsArg !== null && (!Number.isInteger(roundsArg) || roundsArg < 1)) throw new Error("--rounds must be a positive integer");

const env = loadEnv(join(REPO, ".env"));
const deployer = privateKeyToAccount(privateKey(env, "CRE_ETH_PRIVATE_KEY")).address;
const LOG_PATH = join(WORKFLOWS, "runner.log.jsonl");

/** Provider 1 with provider 2 as fallback for the runner's own reads. */
const client = (one: string, two: string): PublicClient =>
  createPublicClient({ transport: fallback([http(required(env, one), { retryCount: 2 }), http(required(env, two), { retryCount: 2 })]) });
const clients: Record<string, PublicClient> = {
  "ethereum-testnet-sepolia": client("RPC_ETH_SEPOLIA_1", "RPC_ETH_SEPOLIA_2"),
  "ethereum-testnet-sepolia-arbitrum-1": client("RPC_ARB_SEPOLIA_1", "RPC_ARB_SEPOLIA_2"),
  "ethereum-testnet-sepolia-base-1": client("RPC_BASE_SEPOLIA_1", "RPC_BASE_SEPOLIA_2"),
};
const chainClient = (name: string): PublicClient => {
  const c = clients[name];
  if (c === undefined) throw new Error(`no RPC for ${name}`);
  return c;
};
const sepolia = chainClient("ethereum-testnet-sepolia");

const readConfig = (workflow: string): unknown => JSON.parse(readFileSync(join(WORKFLOWS, workflow, "config.staging.json"), "utf8"));
const w1 = w1ConfigSchema.parse(readConfig("w1-junction"));
const w3 = w3ConfigSchema.parse(readConfig("w3-responder"));
const tag = (c: "LATEST" | "SAFE" | "FINALIZED"): LogWatch["confidence"] => (c === "LATEST" ? "latest" : c === "SAFE" ? "safe" : "finalized");
const watches: LogWatch[] = [
  ...creditTriggerGroups(w1).map((g, i) => ({
    workflow: "w1-junction" as const,
    triggerIndex: i,
    chain: g.chain,
    addresses: g.addresses,
    topic0s: g.topic0s,
    confidence: tag(g.confidence),
  })),
  {
    workflow: "w3-responder",
    triggerIndex: 0,
    chain: w3.breachTrigger.chain,
    addresses: [w3.breachTrigger.address],
    topic0s: [w3.breachTrigger.topic0],
    confidence: tag(w3.breachTrigger.confidence),
  },
];

const emit = (e: RunnerEvent): void => {
  const line = jsonLine(e, new Date());
  process.stdout.write(`${line}\n`);
  appendFileSync(LOG_PATH, `${line}\n`);
};

const deps: RunnerDeps = {
  sepoliaBalance: () => sepolia.getBalance({ address: deployer }),
  sepoliaGasPrice: () => sepolia.getGasPrice(),
  async blockAt(chain, blockTag) {
    return (await chainClient(chain).getBlock({ blockTag })).number;
  },
  async logs(watch, fromBlock, toBlock) {
    const logs = await chainClient(watch.chain).getLogs({ address: watch.addresses, fromBlock, toBlock });
    return logs
      .filter((l) => l.topics[0] !== undefined && watch.topic0s.some((t) => t.toLowerCase() === l.topics[0]?.toLowerCase()))
      .map((l) => ({ chain: watch.chain, txHash: l.transactionHash, blockNumber: l.blockNumber, logIndex: l.logIndex }));
  },
  async receiptIndex(log) {
    const receipt = await chainClient(log.chain).getTransactionReceipt({ hash: log.txHash });
    const i = receipt.logs.findIndex((l) => l.logIndex === log.logIndex);
    if (i === -1) throw new Error(`log ${log.logIndex.toString()} not in receipt ${log.txHash}`);
    return i;
  },
  simulate: (a: SimulateArgs) => simulate(WORKFLOWS, a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
  emit,
};

const state = new RunnerState();
const stop = (signal: string): void => {
  if (state.stopRequested) return;
  state.stopRequested = true;
  emit({ event: "shutdown_requested", signal });
};
process.on("SIGINT", () => {
  stop("SIGINT");
});
process.on("SIGTERM", () => {
  stop("SIGTERM");
});

// Compile each workflow once; every run then passes --wasm (config is read per run).
const wasm: Partial<Record<SimulateArgs["workflow"], string>> = {};
for (const workflow of ["w1-junction", "w2-loop", "w3-responder"] as const) wasm[workflow] = await buildWasm(WORKFLOWS, workflow, "staging");

emit({
  event: "runner_started",
  label: "Testnet simulation runner standing in for the CRE DON cron while deploy access is pending",
  intervalSeconds,
  rounds: roundsArg,
  maxSepoliaEth: arg("max-sepolia-eth", "0.02"),
  deployer,
  watches: watches.map((w) => ({ workflow: w.workflow, triggerIndex: w.triggerIndex, chain: w.chain, confidence: w.confidence })),
});
const outcome = await runLoop(
  deps,
  {
    intervalSeconds,
    maxSepoliaSpendWei: parseEther(arg("max-sepolia-eth", "0.02")),
    maxSepoliaGasWei: parseGwei(arg("max-sepolia-gwei", "1.5")),
    rounds: roundsArg,
    watches,
    wasm,
    retries: 4,
    // Provider 1's rate window is tens of seconds: 5, 10, 20, 40 s before moving to the fallback target.
    backoffMs: 5_000,
  },
  state,
);
process.exit(outcome === "stopped_cap" ? 2 : 0);

