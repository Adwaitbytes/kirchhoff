/**
 * Generates every workflow config with the engine's spec compiler (PRD section 8: nobody edits workflow config
 * by hand).
 *
 *   pnpm --filter @kirchhoff/workflows gen-config [--target local|staging] [--network <name>]
 *
 * Inputs: engine/specs/kETH.yaml plus the deployment record of the target's network:
 *   - deployments/<network>.json in the engine's `Deployments` shape, used as is; or
 *   - the per-chain records contracts/script/Deploy.s.sol writes (deployments/<network>-<chain>.json), assembled
 *     here into that shape (see `fromDeployRecords`).
 * Outputs: <workflow>/config.<target>.json for all four workflows and spec.resolved.<target>.json.
 * With no --target, both targets are generated when their deployments exist.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSpecDocuments } from "@kirchhoff/engine/spec";
import { fromDeployRecords, type DeployRecord } from "./lib/deployments.ts";

const WORKFLOWS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(WORKFLOWS_DIR, "..");
const SPEC = join(REPO, "engine/specs/kETH.yaml");
const DEFAULT_NETWORK: Readonly<Record<string, string>> = { local: "local", staging: "testnet" };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function loadDeployments(network: string): Promise<string | null> {
  const dir = join(REPO, "deployments");
  const files = await readdir(dir).catch(() => [] as string[]);
  if (files.includes(`${network}.json`)) {
    const text = await readFile(join(dir, `${network}.json`), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "chains" in parsed) return text;
  }
  const perChain = files.filter((f) => f.startsWith(`${network}-`) && f.endsWith(".json"));
  if (perChain.length === 0) return null;
  const records = await Promise.all(
    perChain.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")) as DeployRecord),
  );
  return JSON.stringify(fromDeployRecords(network, records), null, 2);
}

async function generate(target: string, network: string): Promise<boolean> {
  const deployments = await loadDeployments(network);
  if (deployments === null) {
    process.stderr.write(`skip ${target}: no deployments/${network}.json or deployments/${network}-*.json\n`);
    return false;
  }
  const result = await compileSpecDocuments(await readFile(SPEC, "utf8"), deployments, target);
  for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
  if (!result.ok) {
    for (const e of result.errors) process.stderr.write(`error: ${e}\n`);
    throw new Error(`spec compile failed for ${target}`);
  }
  for (const [relative, content] of Object.entries(result.files)) {
    const out = relative === "spec.resolved.json" ? `spec.resolved.${target}.json` : relative;
    const path = join(WORKFLOWS_DIR, out);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    process.stdout.write(`wrote ${path}\n`);
  }
  return true;
}

const only = arg("target");
const targets = only === undefined ? ["local", "staging"] : [only];
let wrote = 0;
for (const target of targets) {
  const network = arg("network") ?? DEFAULT_NETWORK[target];
  if (network === undefined) throw new Error(`unknown target ${target}; pass --network`);
  if (await generate(target, network)) wrote++;
}
if (wrote === 0) {
  process.stderr.write("no configs generated\n");
  process.exit(1);
}
