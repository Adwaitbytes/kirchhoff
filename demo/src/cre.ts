import { join } from "node:path";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { buildWasm, parseSimulateOutput, simulateCommand, type SimulateArgs, type SimulateResult } from "@kirchhoff/workflows/scripts/lib/cre.ts";
import { w1ConfigSchema } from "@kirchhoff/workflows/src/config.ts";
import { creditTriggerGroups } from "@kirchhoff/workflows/src/w1.ts";
import { readFileSync } from "node:fs";
import { env, REPO_ROOT } from "./env.ts";
import { log } from "./events.ts";
import { run, toolPath } from "./forge.ts";
import type { ChainConfig, NetworkName } from "./networks.ts";

const WORKFLOWS_DIR = join(REPO_ROOT, "workflows");

// The CRE runner spawns `cre` (and forge) from PATH; ~/.cre/bin and ~/.foundry/bin are not on every shell's PATH.
process.env.PATH = toolPath();

export type Workflow = SimulateArgs["workflow"];

/** `cre workflow simulate` target for a demo network (workflows/project.yaml). */
export function creTarget(net: NetworkName): "local" | "staging" {
  return net === "local" ? "local" : "staging";
}

/** Regenerates every workflow config from deployments/<network>.json (PRD: configs are never hand-edited). */
export async function genConfig(net: NetworkName): Promise<void> {
  log(`$ pnpm --filter @kirchhoff/workflows gen-config --target ${creTarget(net)} --network ${net}`);
  await run("pnpm", ["--filter", "@kirchhoff/workflows", "gen-config", "--target", creTarget(net), "--network", net], { cwd: REPO_ROOT });
}

const RATE_LIMITED = /429|Too Many Requests|rate limit exceeded/i;
/** CRE login checks reach api.cre.chain.link on every run; a timeout there is not a workflow failure. */
const TRANSIENT = /Credential validation failed|context deadline exceeded|unable to retrieve organization info/;

/**
 * Private copies of the compiled workflows: <workflow>/binary.wasm is shared with other harnesses that rebuild it.
 * Kept short on purpose: `cre --wasm` rejects paths over 97 characters.
 */
const WASM_CACHE = join(homedir(), ".cache", "kirchhoff-demo");

async function wasmFor(workflow: Workflow, target: "local" | "staging"): Promise<string> {
  const cached = join(WASM_CACHE, `${target}-${workflow}.wasm`);
  if (existsSync(cached)) return cached;
  log(`$ cre workflow build ./${workflow} --target ${target}`);
  const built = await buildWasm(WORKFLOWS_DIR, workflow, target);
  mkdirSync(WASM_CACHE, { recursive: true });
  copyFileSync(built, cached);
  return cached;
}

/** Builds every workflow the demo runs for `net` into the private cache, one at a time. */
export async function prebuildWasm(net: NetworkName): Promise<void> {
  for (const workflow of ["w1-junction", "w2-loop", "w3-responder"] as const) await wasmFor(workflow, creTarget(net));
}

/**
 * Archive-capable providers per CRE chain, in rotation order (probed 2026-10-05 with eth_call at the `finalized`
 * block: publicnode serves it on Sepolia and Base but not on Arbitrum, where finalized is ~4,000 blocks deep).
 * Burst-tolerant endpoints come first: the Tenderly public gateway (the repo's provider 1) rejects most of a burst
 * of parallel reads (measured 2026-10-06: 1 of 20), which is exactly how a CRE simulation reads. An optional
 * ALCHEMY_API_KEY puts a keyed provider in front of all of them.
 */
function rpcRotation(): Record<"RPC_ETH_SEPOLIA_1" | "RPC_ARB_SEPOLIA_1" | "RPC_BASE_SEPOLIA_1", string[]> {
  const e = env();
  const alchemy = (net: string): string | undefined => (e.ALCHEMY_API_KEY ? `https://${net}.g.alchemy.com/v2/${e.ALCHEMY_API_KEY}` : undefined);
  const list = (...urls: (string | undefined)[]): string[] => [...new Set(urls.filter((u): u is string => u !== undefined && u !== ""))];
  return {
    RPC_ETH_SEPOLIA_1: list(alchemy("eth-sepolia"), "https://ethereum-sepolia-rpc.publicnode.com", e.RPC_ETH_SEPOLIA_1, "https://gateway.tenderly.co/public/sepolia"),
    RPC_ARB_SEPOLIA_1: list(alchemy("arb-sepolia"), "https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia.drpc.org", e.RPC_ARB_SEPOLIA_1),
    RPC_BASE_SEPOLIA_1: list(alchemy("base-sepolia"), "https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org", "https://base-sepolia.drpc.org", e.RPC_BASE_SEPOLIA_1),
  };
}

/**
 * Runs `cre` with the environment passed in memory instead of `-e ../.env` (a `-e` file overrides the process env,
 * which would pin the rate-limited provider). `rotation` picks each chain's provider for this attempt.
 */
async function simulateOnce(args: SimulateArgs, rotation = 0): Promise<SimulateResult> {
  const full = simulateCommand(args);
  const e = full.indexOf("-e");
  const argv = e === -1 ? full : [...full.slice(0, e), ...full.slice(e + 2)];
  const rpcs = Object.fromEntries(Object.entries(rpcRotation()).map(([k, urls]) => [k, urls[rotation % urls.length] ?? ""]));
  const command = `cre ${argv.join(" ")}`;
  try {
    const { stdout, stderr } = await promisify(execFile)("cre", argv, { cwd: WORKFLOWS_DIR, env: { ...process.env, ...env(), ...rpcs }, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
    const output = `${stdout}${stderr}`;
    return { command, exitCode: 0, output, ...parseSimulateOutput(output) };
  } catch (e) {
    const failed = e as { code?: number; stdout?: string; stderr?: string; message: string };
    const output = `${failed.stdout ?? ""}${failed.stderr ?? ""}` || failed.message;
    return { command, exitCode: typeof failed.code === "number" ? failed.code : 1, output, ...parseSimulateOutput(output) };
  }
}

export class SimulationError extends Error {
  override readonly name = "SimulationError";
}

/**
 * One `cre workflow simulate --broadcast` run (exact CLI form from workflows/scripts/lib/cre.ts). Retries the CRE
 * login transient and RPC rate limits with backoff.
 * Reruns are safe: epoch ids only increase, a repeated BREACH is a no-op per incident, W3 skips contained ledgers.
 * Throws unless the run printed a result and no error.
 */
/** Refreshes the CRE CLI session (the access token expires during long testnet runs). */
async function refreshCreSession(): Promise<void> {
  try {
    await promisify(execFile)("cre", ["whoami"], { cwd: WORKFLOWS_DIR, env: { ...process.env, ...env() }, timeout: 60_000 });
    log("  [cre] session refreshed");
  } catch (e) {
    log(`  [cre] session refresh failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

export async function simulate(
  net: NetworkName,
  workflow: Workflow,
  triggerIndex: number,
  evm?: { txHash: `0x${string}`; eventIndex: number },
): Promise<SimulateResult> {
  const target = creTarget(net);
  const args: SimulateArgs = { workflow, target, triggerIndex, broadcast: true, wasm: await wasmFor(workflow, target), ...(evm === undefined ? {} : { evm }) };
  log(`$ cre ${simulateCommand(args).join(" ")}`);
  const started = Date.now();
  let result = await simulateOnce(args);
  // A rate limit rotates every chain to its next archive-capable provider (CRE pins `finalized`, ~17 min deep on
  // these testnets, so non-archive endpoints cannot serve it); a login transient retries as is.
  let rotation = 0;
  for (let attempt = 1; attempt < 7 && result.error !== null; attempt++) {
    const limited = RATE_LIMITED.test(result.output);
    if (!limited && !TRANSIENT.test(result.output)) break;
    if (limited) rotation++;
    // An expired CRE session fails every retry the same way; `cre whoami` exchanges the refresh token first.
    if (result.output.includes("Credential validation failed")) await refreshCreSession();
    log(`  [${workflow}] ${limited ? `RPC rate limited, rotating providers (set ${rotation})` : "CRE login transient"}; retry ${attempt + 1}/7 in ${10 * attempt}s`);
    await new Promise((r) => setTimeout(r, 10_000 * attempt));
    result = await simulateOnce({ ...args, wasm: await wasmFor(workflow, target) }, rotation);
  }
  for (const line of result.userLogs) log(`  [${workflow}] ${line}`);
  log(`  [${workflow}] result: ${result.result ?? "(none)"} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (result.error !== null || result.result === null) {
    log(result.output);
    throw new SimulationError(`${workflow} simulation failed: ${result.error ?? "no result"}`);
  }
  return result;
}

/** W1's `--trigger-index` for credits on `chain`, from the generated config (one log trigger per credit chain). */
export function w1TriggerIndex(net: NetworkName, chain: ChainConfig): number {
  const config = w1ConfigSchema.parse(JSON.parse(readFileSync(join(WORKFLOWS_DIR, "w1-junction", `config.${creTarget(net)}.json`), "utf8")));
  const index = creditTriggerGroups(config).findIndex((g) => g.chain === chain.chainName);
  if (index === -1) throw new SimulationError(`W1 has no credit trigger on ${chain.chainName}`);
  return index;
}

export type { SimulateResult };
