import { parseCredentials, type HmacCredentials } from "./hmac.ts";

/**
 * `hmac` verifies every request (401 otherwise). `insecure` skips verification and exists because the
 * ccv-cell Helm chart v0.8.0 does not template the verifier's [policy_hook] api_key/secret_key, so an
 * in-cluster Judge reachable only by its verifier (NetworkPolicy) runs unauthenticated, as the
 * Starter Kit docs recommend. It must be chosen explicitly.
 */
export type AuthConfig = { mode: "hmac"; creds: HmacCredentials } | { mode: "insecure" };

export type LogLevel = "debug" | "info" | "warn" | "error";

export type JudgeConfig = {
  host: string;
  port: number;
  /** Path prefix the verifier's base_url carries, e.g. "/compliance". Empty for none. */
  basePath: string;
  budgetMs: number;
  specSyncMs: number;
  /** A spec cache older than this answers 503 instead of trusting an old registry read. */
  specMaxAgeMs: number;
  auth: AuthConfig;
  specPaths: readonly string[];
  deploymentsPath: string;
  /** Two independent RPC URLs per spec chain name. */
  rpc: ReadonlyMap<string, readonly [string, string]>;
  logLevel: LogLevel;
  /** API read-model sink; null disables it. */
  verdictSink: { url: string; key: string; cellId: string } | null;
};

/** Spec chain name to the .env provider prefix (RPC_<PREFIX>_1 and RPC_<PREFIX>_2). */
export const RPC_ENV_PREFIX: Readonly<Record<string, string>> = {
  "ethereum-testnet-sepolia": "RPC_ETH_SEPOLIA",
  "ethereum-testnet-sepolia-arbitrum-1": "RPC_ARB_SEPOLIA",
  "ethereum-testnet-sepolia-base-1": "RPC_BASE_SEPOLIA",
};

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Env = Readonly<Record<string, string | undefined>>;

function intVar(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return value;
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new ConfigError(`${name} is required`);
  return value;
}

function parseBasePath(raw: string | undefined): string {
  const value = (raw ?? "").replace(/\/+$/, "");
  if (value !== "" && !/^\/[A-Za-z0-9._~\-/]*$/.test(value)) throw new ConfigError("JUDGE_BASE_PATH must be a URL path");
  return value;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw ?? "info";
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  throw new ConfigError("JUDGE_LOG_LEVEL must be debug, info, warn or error");
}

function parseAuth(env: Env): AuthConfig {
  const mode = env.JUDGE_AUTH_MODE ?? "hmac";
  if (mode === "insecure") return { mode };
  if (mode !== "hmac") throw new ConfigError("JUDGE_AUTH_MODE must be hmac or insecure");
  try {
    return { mode, creds: parseCredentials(required(env, "JUDGE_HMAC_API_KEY"), required(env, "JUDGE_HMAC_SECRET")) };
  } catch (e) {
    throw new ConfigError(e instanceof Error ? e.message : String(e));
  }
}

/** Mirrors the API: INTERNAL_INGEST_KEY, falling back to JUDGE_HMAC_SECRET. */
function parseSink(env: Env): JudgeConfig["verdictSink"] {
  const url = env.VERDICT_SINK_URL;
  if (url === undefined || url === "") return null;
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ConfigError("VERDICT_SINK_URL must be an http(s) URL");
  const key = env.VERDICT_SINK_KEY ?? env.INTERNAL_INGEST_KEY ?? env.JUDGE_HMAC_SECRET ?? "";
  if (key.length < 16) throw new ConfigError("VERDICT_SINK_URL needs INTERNAL_INGEST_KEY (or JUDGE_HMAC_SECRET), at least 16 chars");
  return { url, key, cellId: env.JUDGE_CELL_ID ?? "" };
}

/** RPC URLs for every chain the specs name; both providers are mandatory and must differ. */
export function rpcFor(env: Env, chainNames: Iterable<string>): Map<string, readonly [string, string]> {
  const out = new Map<string, readonly [string, string]>();
  for (const name of chainNames) {
    const prefix = RPC_ENV_PREFIX[name];
    if (prefix === undefined) throw new ConfigError(`no RPC env prefix for chain ${name}`);
    const first = required(env, `${prefix}_1`);
    const second = required(env, `${prefix}_2`);
    if (first === second) throw new ConfigError(`${prefix}_1 and ${prefix}_2 must be independent providers`);
    for (const url of [first, second]) {
      if (!/^https?:\/\//.test(url)) throw new ConfigError(`${prefix} URLs must be http(s)`);
    }
    out.set(name, [first, second]);
  }
  return out;
}

/** Everything except RPC URLs, which depend on the chains the loaded specs name. */
export function loadConfig(env: Env): Omit<JudgeConfig, "rpc"> {
  const specSyncSeconds = intVar(env, "JUDGE_SPEC_SYNC_SECONDS", 60, 1, 3600);
  return {
    host: env.JUDGE_HOST ?? "0.0.0.0",
    port: intVar(env, "JUDGE_PORT", 8080, 1, 65535),
    basePath: parseBasePath(env.JUDGE_BASE_PATH),
    budgetMs: intVar(env, "JUDGE_TIME_BUDGET_MS", 2000, 50, 15_000),
    specSyncMs: specSyncSeconds * 1000,
    specMaxAgeMs: intVar(env, "JUDGE_SPEC_MAX_AGE_SECONDS", specSyncSeconds * 3, specSyncSeconds, 86_400) * 1000,
    auth: parseAuth(env),
    specPaths: required(env, "JUDGE_SPEC_PATH")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== ""),
    deploymentsPath: required(env, "JUDGE_DEPLOYMENTS_PATH"),
    logLevel: parseLogLevel(env.JUDGE_LOG_LEVEL),
    verdictSink: parseSink(env),
  };
}
