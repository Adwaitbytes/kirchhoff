import { join } from "node:path";
import { buildWasm, simulate as creSimulate, simulateCommand, type SimulateArgs, type SimulateResult } from "@kirchhoff/workflows/scripts/lib/cre.ts";
import { w1ConfigSchema } from "@kirchhoff/workflows/src/config.ts";
import { creditTriggerGroups } from "@kirchhoff/workflows/src/w1.ts";
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "./env.ts";
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

const wasm = new Map<string, string>();
const RATE_LIMITED = /429|Too Many Requests|rate limit exceeded/i;

export class SimulationError extends Error {
  override readonly name = "SimulationError";
}

/**
 * One `cre workflow simulate --broadcast` run through the CRE team's runner (exact CLI form, transient-login retry).
 * Each workflow is compiled once per process with `cre workflow build` and replayed with `--wasm`; the config is
 * read per run, so regenerated configs need no rebuild. Throws unless the run printed a result and no error.
 */
export async function simulate(
  net: NetworkName,
  workflow: Workflow,
  triggerIndex: number,
  evm?: { txHash: `0x${string}`; eventIndex: number },
): Promise<SimulateResult> {
  const target = creTarget(net);
  const key = `${workflow}:${target}`;
  let binary = wasm.get(key);
  if (binary === undefined) {
    log(`$ cre workflow build ./${workflow} --target ${target}`);
    binary = await buildWasm(WORKFLOWS_DIR, workflow, target);
    wasm.set(key, binary);
  }
  const args: SimulateArgs = { workflow, target, triggerIndex, broadcast: true, wasm: binary, ...(evm === undefined ? {} : { evm }) };
  log(`$ cre ${simulateCommand(args).join(" ")}`);
  const started = Date.now();
  let result = await creSimulate(WORKFLOWS_DIR, args);
  // Public testnet RPC gateways rate-limit bursts (HTTP 429). A rerun is safe: epoch ids only increase, a repeated
  // BREACH is a no-op per incident, and W3 skips ledgers that are already contained.
  for (let attempt = 1; attempt < 5 && result.error !== null && RATE_LIMITED.test(result.output); attempt++) {
    log(`  [${workflow}] RPC rate limited, retrying in ${20 * attempt}s (attempt ${attempt + 1}/5)`);
    await new Promise((r) => setTimeout(r, 20_000 * attempt));
    result = await creSimulate(WORKFLOWS_DIR, args);
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
