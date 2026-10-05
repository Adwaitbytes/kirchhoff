import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { bridgeForMinter } from "@kirchhoff/engine";
import { parseSpec } from "@kirchhoff/engine/spec";
import { CHAINS, CHAIN_KEYS, parseDeployments, type ChainKey, type Confidence, type DeploymentSet, type NetworkMode } from "@kirchhoff/sdk";

export const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** The slice of the KIRCH-SPEC the read model needs (thresholds shown in the UI). */
export type TokenConfig = {
  symbol: string;
  model: "lock_release_home" | "burn_mint_multi";
  decimals: number;
  homeChain: ChainKey;
  chains: ChainKey[];
  confidence: Record<ChainKey, Confidence>;
  stalenessSeconds: number;
  onStale: "fail_closed" | "fail_open";
  toleranceWei: string;
  /** Each bridge with the chains it can move value between: home plus every remote whose minters name it. */
  bridges: { id: string; kind: "ccip_v2" | "custom"; chains: ChainKey[]; searchWindowBlocks: string }[];
  onBroken: string[];
};

export type IndexerConfig = {
  mode: NetworkMode;
  symbol: string;
  deployments: DeploymentSet;
  token: TokenConfig;
  specYaml: string;
  /** Ordered provider list per chain; the first healthy one is used. */
  rpc: Record<ChainKey, string[]>;
  /** Block tag the cursor follows. `spec` uses each chain's KIRCH-SPEC confidence. */
  followTag: "spec" | Confidence;
  pollMs: number;
  maxChunk: bigint;
  /** First block to index when a chain has no cursor and no deployedAtBlock. */
  defaultLookback: bigint;
};

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function networkMode(env: NodeJS.ProcessEnv): NetworkMode {
  const v = env.KIRCHHOFF_NETWORK ?? "local";
  if (v !== "local" && v !== "testnet") throw new ConfigError(`KIRCHHOFF_NETWORK must be local or testnet, got "${v}"`);
  return v;
}

export function rpcUrls(env: NodeJS.ProcessEnv, mode: NetworkMode): Record<ChainKey, string[]> {
  const out = {} as Record<ChainKey, string[]>;
  for (const key of CHAIN_KEYS) {
    const info = CHAINS[key];
    if (mode === "local") {
      out[key] = [env[`LOCAL_RPC_${info.alias.toUpperCase()}`] ?? info.localRpc];
    } else {
      out[key] = info.rpcEnv.map((name) => env[name]).filter((u): u is string => typeof u === "string" && u.length > 0);
    }
  }
  return out;
}

/**
 * Reads `<name>.json` (engine schema, written by demo/deploy-all) and `<name>-*.raw.json` (contract
 * keys, written by Deploy.s.sol) for one deployment name (default: the network mode). The raw files
 * are applied last so their direct contract records win; other JSON in deployments/ is ignored.
 */
export async function loadDeploymentsDir(dir: string, mode: NetworkMode, symbol: string, name: string = mode): Promise<DeploymentSet> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    files = [];
  }
  const merged = files.filter((f) => f === `${name}.json`);
  const raw = files.filter((f) => f.startsWith(`${name}-`) && f.endsWith(".raw.json")).sort();
  const docs = await Promise.all(
    [...merged, ...raw].map(async (f) => ({ name: f, json: JSON.parse(await readFile(join(dir, f), "utf8")) as unknown })),
  );
  return parseDeployments(docs, mode, symbol);
}

export function tokenConfigFromSpec(yamlText: string): TokenConfig {
  const parsed = parseSpec(yamlText);
  if (!parsed.ok) throw new ConfigError(`KIRCH-SPEC invalid: ${parsed.errors.join("; ")}`);
  const spec = parsed.spec;
  const chains = [spec.home.chain.name, ...spec.remotes.map((r) => r.chain.name)];
  for (const c of chains) if (!CHAIN_KEYS.includes(c as ChainKey)) throw new ConfigError(`spec chain ${c} is not supported`);
  const confidence = {} as Record<ChainKey, Confidence>;
  for (const c of chains as ChainKey[]) confidence[c] = spec.confidence.overrides[c] ?? spec.confidence.default;
  return {
    symbol: spec.token,
    model: spec.model,
    decimals: spec.home.decimals,
    homeChain: spec.home.chain.name as ChainKey,
    chains: chains as ChainKey[],
    confidence,
    stalenessSeconds: Number(spec.rules.stalenessSeconds),
    onStale: spec.rules.onStale,
    toleranceWei: spec.rules.loop.toleranceWei.toString(),
    bridges: spec.bridges.map((b) => ({
      id: b.id,
      kind: b.kind,
      chains: [
        spec.home.chain.name as ChainKey,
        ...spec.remotes.filter((r) => r.minters.some((m) => bridgeForMinter(spec, m, r.chain.alias)?.id === b.id)).map((r) => r.chain.name as ChainKey),
      ],
      searchWindowBlocks: b.searchWindowBlocks.toString(),
    })),
    onBroken: [...spec.response.onBroken],
  };
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

export async function loadIndexerConfig(env: NodeJS.ProcessEnv = process.env): Promise<IndexerConfig> {
  const mode = networkMode(env);
  const symbol = env.KIRCHHOFF_TOKEN ?? "kETH";
  const specPath = env.KIRCHHOFF_SPEC_PATH ?? join(REPO_ROOT, "engine", "specs", `${symbol}.yaml`);
  const specYaml = await readFile(specPath, "utf8");
  const token = tokenConfigFromSpec(specYaml);
  const deployments = await loadDeploymentsDir(env.KIRCHHOFF_DEPLOYMENTS_DIR ?? join(REPO_ROOT, "deployments"), mode, symbol, env.KIRCHHOFF_DEPLOYMENT_NAME ?? mode);
  const missing = token.chains.filter((c) => deployments.chains[c] === undefined);
  if (missing.length > 0) throw new ConfigError(`no ${mode} deployment for ${missing.join(", ")} in deployments/`);
  const follow = env.INDEXER_CONFIDENCE ?? (mode === "local" ? "latest" : "spec");
  if (!["spec", "latest", "safe", "finalized"].includes(follow)) throw new ConfigError("INDEXER_CONFIDENCE must be spec, latest, safe or finalized");
  return {
    mode,
    symbol,
    deployments,
    token,
    specYaml,
    rpc: rpcUrls(env, mode),
    followTag: follow as IndexerConfig["followTag"],
    pollMs: positiveInt(env, "INDEXER_POLL_MS", mode === "local" ? 1_000 : 4_000),
    maxChunk: BigInt(positiveInt(env, "INDEXER_MAX_CHUNK", 2_000)),
    defaultLookback: BigInt(positiveInt(env, "INDEXER_LOOKBACK_BLOCKS", 5_000)),
  };
}
