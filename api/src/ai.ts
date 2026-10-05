import type { PublicClient } from "viem";
import { createChainClient, type Db, type Queryable } from "@kirchhoff/indexer";
import {
  BlockscoutExplorer,
  CachedProvider,
  CompositeExplorer,
  EtherscanExplorer,
  LocalArtifactExplorer,
  PostgresCache,
  backtestYaml,
  bundleKey,
  narrateIncident,
  templateNarrative,
  validateYaml,
  type AiConfig,
  type AskBackend,
  type CopilotEnv,
  type Explorer,
  type IncidentBundle,
  type SqlResult,
} from "@kirchhoff/ai";
import { CHAINS, CHAIN_KEYS, type ChainKey, type IncidentNarrative, type NetworkMode } from "@kirchhoff/sdk";

/** Wiring between the API and @kirchhoff/ai. Nothing here can write onchain or change status. */

export type AiDeps = {
  db: Db;
  ai: AiConfig;
  mode: NetworkMode;
  rpc: Record<ChainKey, string[]>;
  etherscanKey: string | undefined;
  narratorWaitMs: number;
};

export class AiServices {
  readonly provider: CachedProvider | null;
  readonly model: string;
  readonly fastModel: string;
  private readonly deps: AiDeps;
  private readonly inflight = new Map<string, Promise<IncidentNarrative>>();
  private readonly lastStart = new Map<string, number>();
  private clientsCache: Partial<Record<ChainKey, PublicClient>> | null = null;

  constructor(deps: AiDeps) {
    this.deps = deps;
    this.provider = deps.ai.provider ? new CachedProvider(deps.ai.provider, new PostgresCache(deps.db)) : null;
    this.model = deps.ai.model;
    this.fastModel = deps.ai.fastModel;
  }

  clients(): Partial<Record<ChainKey, PublicClient>> {
    if (this.clientsCache) return this.clientsCache;
    const out: Partial<Record<ChainKey, PublicClient>> = {};
    for (const c of CHAIN_KEYS) if (this.deps.rpc[c].length > 0) out[c] = createChainClient(c, this.deps.mode, this.deps.rpc[c], 8_000);
    this.clientsCache = out;
    return out;
  }

  explorer(): Explorer {
    if (this.deps.mode === "local") return new LocalArtifactExplorer(this.clients());
    const list: Explorer[] = [new BlockscoutExplorer()];
    if (this.deps.etherscanKey) list.push(new EtherscanExplorer(this.deps.etherscanKey));
    return new CompositeExplorer(list);
  }

  copilotEnv(): CopilotEnv {
    const clients = this.clients();
    const testnet = this.deps.mode === "testnet";
    const tar: CopilotEnv["tokenAdminRegistry"] = {};
    const ramps: CopilotEnv["ramps"] = {};
    if (testnet) {
      for (const c of CHAIN_KEYS) {
        tar[c] = CHAINS[c].ccip.tokenAdminRegistry;
        ramps[c] = { onRamp: CHAINS[c].ccip.onRamp, offRamp: CHAINS[c].ccip.offRamp };
      }
    }
    return {
      clients,
      explorer: this.explorer(),
      tokenAdminRegistry: tar,
      ramps,
      validateSpec: (yaml) => validateYaml(yaml, clients, { emitterLookback: testnet ? 50_000n : null }),
      backtestSpec: (yaml, from) => {
        const fromBlock: Partial<Record<ChainKey, bigint>> = {};
        if (from !== null) for (const c of CHAIN_KEYS) fromBlock[c] = from;
        return backtestYaml(yaml, fromBlock, { clients, defaultLookback: testnet ? 50_000n : null });
      },
      logLookback: testnet ? 100_000n : 1_000_000n,
      explorerLinks: testnet,
    };
  }

  /**
   * Cached model narrative when one exists for this exact bundle; otherwise the template now and a
   * model run in the background (stored on the incident row when it validates). Waits up to
   * narratorWaitMs for the model so a fresh request can still get it.
   */
  async narrative(incidentId: string, bundle: IncidentBundle): Promise<IncidentNarrative> {
    const stable = { incident: { ...bundle.incident, status: undefined, resolvedAt: undefined, recoveryEndsAt: undefined }, evidence: bundle.evidence };
    const key = bundleKey(stable as unknown as IncidentBundle);
    const row = (await this.deps.db.query<{ narrative: IncidentNarrative | null; narrative_key: string | null }>("select narrative, narrative_key from incidents where id = $1", [incidentId])).rows[0];
    if (row?.narrative && row.narrative_key === key) return row.narrative;
    if (!this.provider) return templateNarrative(bundle);
    let p = this.inflight.get(key);
    const last = this.lastStart.get(incidentId) ?? 0;
    if (!p && Date.now() - last > 60_000) {
      this.lastStart.set(incidentId, Date.now());
      p = narrateIncident(bundle, { provider: this.provider.withKind("narrator"), model: this.model, onError: (e) => { console.error("kirchhoff narrator: fell back to template:", e instanceof Error ? e.message : e); } }).then(async (n) => {
        if (n.generator === "model") {
          await this.deps.db.query("update incidents set narrative = $2, narrative_key = $3 where id = $1", [incidentId, JSON.stringify(n), key]);
        }
        this.inflight.delete(key);
        return n;
      });
      this.inflight.set(key, p);
    }
    if (!p) return row?.narrative ?? templateNarrative(bundle);
    const timeout = new Promise<null>((r) => setTimeout(() => { r(null); }, this.deps.narratorWaitMs));
    return (await Promise.race([p, timeout])) ?? row?.narrative ?? templateNarrative(bundle);
  }
}

/** Ask KIRCHHOFF's read-only SQL: READ ONLY transaction, 2s timeout, the ask_ro role, ask views only. */
export function askBackend(db: Db, evidence: (id: string) => Promise<unknown>): AskBackend {
  return {
    async sql(query: string): Promise<SqlResult> {
      const client = await db.connect();
      try {
        await client.query("begin read only");
        await client.query("set local statement_timeout = 2000");
        await client.query("set local role kirchhoff_ask_ro");
        await client.query("set local search_path = ask");
        const r = await client.query<Record<string, unknown>>(`select * from (${query}) as ask_query limit 51`);
        const rows = r.rows.slice(0, 50).map((row) =>
          Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])),
        );
        return { columns: r.fields.map((f) => f.name), rows, truncated: r.rows.length > 50 };
      } catch (e) {
        throw new Error(`query rejected: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`, { cause: e });
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }
    },
    evidence,
  };
}

export type { Queryable };
