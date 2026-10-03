import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { REPO_ROOT } from "./env.ts";
import { log } from "./events.ts";
import { run } from "./forge.ts";
import type { NetworkName } from "./networks.ts";

const WORKFLOWS_DIR = join(REPO_ROOT, "workflows");

/** `cre workflow simulate` target name; the demo network maps to the project.yaml target (local / staging). */
export function creTarget(net: NetworkName): "local" | "staging" {
  return net === "local" ? "local" : "staging";
}

/** Regenerates every workflow config from the merged deployments doc (PRD: configs are never hand-edited). */
export async function genConfig(net: NetworkName): Promise<void> {
  log(`cre: gen-config --target ${creTarget(net)} --network ${net}`);
  await run("pnpm", ["--filter", "@kirchhoff/workflows", "gen-config", "--target", creTarget(net), "--network", net], { cwd: REPO_ROOT, echo: true });
}

export type SimulateOptions = {
  workflow: "w1-junction" | "w2-loop" | "w3-responder";
  net: NetworkName;
  triggerIndex: number;
  broadcast: boolean;
  /** For W1's EVM log trigger: the attack transaction and the log index within it. */
  evm?: { txHash: Hex; eventIndex: number };
  httpPayload?: string;
};

/**
 * Drives one CRE workflow through `cre workflow simulate` (docs/research/cre.md section 3 flags). Requires `cre
 * login` (simulation needs no deploy access). `--broadcast` sends the reports through the per-chain simulation mock
 * forwarder from CRE_ETH_PRIVATE_KEY.
 */
export async function simulate(o: SimulateOptions): Promise<void> {
  const folder = join(WORKFLOWS_DIR, o.workflow);
  if (!existsSync(join(folder, `config.${creTarget(o.net)}.json`))) throw new Error(`${o.workflow}/config.${creTarget(o.net)}.json missing; run gen-config first`);
  const args = ["workflow", "simulate", `./${o.workflow}`, "--non-interactive", "--target", creTarget(o.net), "--trigger-index", String(o.triggerIndex)];
  if (o.evm !== undefined) args.push("--evm-tx-hash", o.evm.txHash, "--evm-event-index", String(o.evm.eventIndex));
  if (o.httpPayload !== undefined) args.push("--http-payload", o.httpPayload);
  if (o.broadcast) args.push("--broadcast");
  log(`cre workflow simulate ./${o.workflow} --trigger-index ${o.triggerIndex}${o.broadcast ? " --broadcast" : ""}`);
  const result = await run("cre", args, { cwd: WORKFLOWS_DIR, echo: true, env: {} });
  if (/Write report transaction succeeded: 0x0{64}/.test(result.stdout) && o.broadcast) {
    throw new Error(`${o.workflow} simulate did not broadcast (dry-run tx hash); check CRE_ETH_PRIVATE_KEY funding`);
  }
}
