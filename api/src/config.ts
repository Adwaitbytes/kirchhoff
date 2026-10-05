import { join } from "node:path";
import { aiConfigFromEnv } from "@kirchhoff/ai";
import { REPO_ROOT, createDb, networkMode, rpcUrls, type Db } from "@kirchhoff/indexer";
import { CHAIN_KEYS, type Address, type OpsResponse } from "@kirchhoff/sdk";
import { Notifier, channelsFromEnv } from "@kirchhoff/indexer/notifier";
import { AiServices } from "./ai.ts";
import type { AppDeps } from "./app.ts";
import { LabRunner } from "./lab.ts";
import { chainClients } from "./onchain.ts";
import { Ops } from "./ops.ts";

export type Runtime = "server" | "serverless";

function cells(env: NodeJS.ProcessEnv): { id: string; name: string; region: string; version: string }[] {
  const raw = env.CCV_CELLS;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((c: unknown) => {
      if (typeof c !== "object" || c === null) return [];
      const o = c as Record<string, unknown>;
      return typeof o.id === "string" ? [{ id: o.id, name: typeof o.name === "string" ? o.name : o.id, region: typeof o.region === "string" ? o.region : "unknown", version: typeof o.version === "string" ? o.version : "unknown" }] : [];
    });
  } catch {
    console.error("kirchhoff api: CCV_CELLS is not valid JSON; ignoring");
    return [];
  }
}

/** JUDGE_METRICS_URLS="cell-1=http://judge:8787/metrics,cell-2=..." (a bare URL means cell "cell-1"). */
function metricsUrls(env: NodeJS.ProcessEnv): { cellId: string; url: string }[] {
  return (env.JUDGE_METRICS_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((entry, i) => {
      const eq = entry.indexOf("=");
      const cellId = eq > 0 ? entry.slice(0, eq) : `cell-${i + 1}`;
      const url = eq > 0 ? entry.slice(eq + 1) : entry;
      return /^https?:\/\//.test(url) ? [{ cellId, url }] : [];
    });
}

/** Everything the app needs, from env. Secrets stay in memory and are never logged. */
export function depsFromEnv(env: NodeJS.ProcessEnv, runtime: Runtime, db?: Db): AppDeps {
  const url = runtime === "serverless" ? (env.DATABASE_URL_HOSTED ?? env.DATABASE_URL) : env.DATABASE_URL;
  if (!url && !db) throw new Error("DATABASE_URL is required");
  const database = db ?? createDb(url ?? "", { max: runtime === "serverless" ? 3 : 10 });
  const mode = networkMode(env);
  const rpc = rpcUrls(env, mode);
  const labWanted = env.LAB_ENABLED === "true";
  const labEnabled = labWanted && runtime === "server";
  const enforcement: OpsResponse["enforcement"] = env.KIRCHHOFF_ENFORCEMENT === "ccv_cell" ? "ccv_cell" : "token_pool_fallback";
  return {
    db: database,
    ai: new AiServices({
      db: database,
      ai: aiConfigFromEnv(env),
      mode,
      rpc,
      etherscanKey: env.ETHERSCAN_API_KEY,
      narratorWaitMs: Number(env.NARRATOR_WAIT_MS ?? (runtime === "serverless" ? 8_000 : 1_500)),
    }),
    lab: new LabRunner(
      {
        enabled: labEnabled,
        disabledReason: !labWanted
          ? "Attack Lab is disabled on this deployment (LAB_ENABLED is not true). Run the Kelp Replay from the testnet operator console."
          : "Attack Lab runs only on the long-running KIRCHHOFF server, not on serverless functions.",
        command: env.LAB_COMMAND ?? "pnpm",
        args: env.LAB_ARGS ? env.LAB_ARGS.split(" ").filter(Boolean) : ["--filter", "@kirchhoff/demo", "attack", "--network", mode, ...(mode === "local" ? ["--reports", "direct"] : [])],
        cwd: env.LAB_CWD ?? REPO_ROOT,
        timeoutMs: Number(env.LAB_TIMEOUT_MS ?? 600_000),
        token: env.KIRCHHOFF_TOKEN ?? "kETH",
        attacker: (env.ATTACKER_ADDRESS ?? "0x0000000000000000000000000000000000000000").toLowerCase() as Address,
      },
      database,
    ),
    ops: new Ops(database, { rpc, chains: [...CHAIN_KEYS], cells: cells(env), enforcement, metrics: metricsUrls(env), publicBaseUrl: env.API_PUBLIC_URL ?? "", token: env.KIRCHHOFF_TOKEN ?? "kETH" }),
    clients: chainClients(rpc, mode),
    issuerKey: env.ISSUER_API_KEY,
    internalKey: env.INTERNAL_INGEST_KEY ?? env.JUDGE_HMAC_SECRET,
    defaultToken: env.KIRCHHOFF_TOKEN ?? "kETH",
    websocket: runtime === "server",
    sseMaxMs: Number(env.SSE_MAX_MS ?? (runtime === "serverless" ? 25_000 : 300_000)),
    corsOrigins: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(",").map((s) => s.trim()) : true,
    notifier: new Notifier(database, channelsFromEnv(env)),
    webPublicUrl: env.WEB_PUBLIC_URL ?? null,
    aggregatorUrl: env.CCV_AGGREGATOR_URL ?? null,
  };
}

export const API_ROOT = join(import.meta.dirname, "..");
