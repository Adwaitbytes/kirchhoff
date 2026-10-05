import { createPublicClient, http } from "viem";
import type { Queryable } from "@kirchhoff/indexer";
import type { ChainKey, CellHealth, CreRun, OpsResponse, ReasonCode, RpcAgreement, WorkflowId } from "@kirchhoff/sdk";
import { histogramQuantile, judgeScrape, parsePrometheus, type JudgeScrape } from "./prometheus.ts";

/**
 * Verifier Ops read model. Judge latency p50/p99 and decision counts are scraped from each cell's
 * Judge Prometheus /metrics (JUDGE_METRICS_URLS) when configured, else taken from the verdict sink; RPC
 * agreement is this API's own probe of the two configured providers per chain (the Judge keeps its
 * own); CRE runs are reconstructed from the ledger writes each workflow produced, one run per report batch.
 */

const WINDOW_SECONDS = 3_600;
const AGREE_BLOCKS = 3n;

type Probe = { at: number; agreed: boolean };

export type OpsConfig = {
  rpc: Record<ChainKey, string[]>;
  chains: ChainKey[];
  cells: { id: string; name: string; region: string; version: string }[];
  enforcement: OpsResponse["enforcement"];
  /** One Judge /metrics endpoint per cell. */
  metrics?: { cellId: string; url: string }[];
  fetch?: typeof fetch;
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "provider";
  }
}

export class Ops {
  private readonly db: Queryable;
  private readonly cfg: OpsConfig;
  private readonly probes = new Map<ChainKey, Probe[]>();
  private readonly lastDisagreement = new Map<ChainKey, number>();

  constructor(db: Queryable, cfg: OpsConfig) {
    this.db = db;
    this.cfg = cfg;
  }

  private async probe(chain: ChainKey): Promise<RpcAgreement> {
    const urls = this.cfg.rpc[chain];
    const providers = await Promise.all(
      urls.slice(0, 2).map(async (url) => {
        const started = Date.now();
        try {
          const head = await createPublicClient({ transport: http(url, { timeout: 2_000, retryCount: 0 }) }).getBlockNumber();
          return { name: hostOf(url), healthy: true, head: head.toString(), latencyMs: Date.now() - started };
        } catch {
          return { name: hostOf(url), healthy: false, head: "0", latencyMs: Date.now() - started };
        }
      }),
    );
    const healthy = providers.filter((p) => p.healthy);
    const agreed = healthy.length === providers.length && healthy.length > 0 && (healthy.length < 2 || (() => {
      const [a, b] = healthy.map((p) => BigInt(p.head));
      const d = (a ?? 0n) - (b ?? 0n);
      return (d < 0n ? -d : d) <= AGREE_BLOCKS;
    })());
    const now = Date.now();
    const list = (this.probes.get(chain) ?? []).filter((p) => now - p.at < WINDOW_SECONDS * 1000);
    list.push({ at: now, agreed });
    this.probes.set(chain, list);
    if (!agreed) this.lastDisagreement.set(chain, now);
    const last = this.lastDisagreement.get(chain);
    return {
      chain,
      providers,
      agreementRate: list.filter((p) => p.agreed).length / list.length,
      lastDisagreementAt: last ? new Date(last).toISOString() : null,
    };
  }

  private async creRuns(): Promise<CreRun[]> {
    type Row = { workflow: WorkflowId; run_id: string; triggered_at: Date; ended_at: Date; outcome: CreRun["outcome"]; trigger: CreRun["trigger"]; txs: { chain: ChainKey; hash: `0x${string}`; block: string; timestamp: string }[] };
    const r = await this.db.query<Row>(
      `select * from (
         select 'w2-loop' as workflow, 'epoch-' || epoch_id as run_id, min(block_time) as triggered_at, max(block_time) as ended_at,
                'ok' as outcome, 'cron' as trigger,
                json_agg(json_build_object('chain', chain, 'hash', tx_hash, 'block', block::text, 'timestamp', to_char(block_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) as txs
         from epochs group by epoch_id
         union all
         select case when reason = 'LOOP_DEFICIT' then 'w2-loop' else 'w1-junction' end, 'breach-' || evidence_hash, min(block_time), max(block_time),
                'breach', case when reason = 'LOOP_DEFICIT' then 'cron' else 'log' end,
                json_agg(json_build_object('chain', chain, 'hash', tx_hash, 'block', block::text, 'timestamp', to_char(block_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
         from breaches group by evidence_hash, reason
         union all
         select 'w3-responder', 'quarantine-' || coalesce(incident_id, tx_hash), min(block_time), max(block_time), 'ok', 'log',
                json_agg(json_build_object('chain', chain, 'hash', tx_hash, 'block', block::text, 'timestamp', to_char(block_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
         from incident_actions where kind = 'quarantine_applied' group by coalesce(incident_id, tx_hash)
       ) x order by triggered_at desc limit 25`,
    );
    return r.rows.map((x) => ({
      workflow: x.workflow,
      runId: x.run_id,
      trigger: x.trigger,
      triggeredAt: x.triggered_at.toISOString(),
      durationMs: x.ended_at.getTime() - x.triggered_at.getTime(),
      outcome: x.outcome,
      reportTxs: x.txs,
    }));
  }

  private async scrape(): Promise<Map<string, JudgeScrape | null>> {
    const out = new Map<string, JudgeScrape | null>();
    const f = this.cfg.fetch ?? fetch;
    await Promise.all(
      (this.cfg.metrics ?? []).map(async (m) => {
        try {
          const res = await f(m.url, { signal: AbortSignal.timeout(2_000) });
          out.set(m.cellId, res.ok ? judgeScrape(parsePrometheus(await res.text())) : null);
        } catch {
          out.set(m.cellId, null);
        }
      }),
    );
    return out;
  }

  async snapshot(): Promise<Omit<OpsResponse, "source" | "ledger" | "block" | "servedAt">> {
    const scraped = await this.scrape();
    const [latency, counts, byReason, cellRows, rpc, creRuns] = await Promise.all([
      this.db.query<{ p50: number | null; p99: number | null; n: number }>(
        `select percentile_cont(0.5) within group (order by latency_ms) as p50, percentile_cont(0.99) within group (order by latency_ms) as p99, count(*)::int as n
         from judge_verdicts where received_at > now() - make_interval(secs => $1)`,
        [WINDOW_SECONDS],
      ),
      this.db.query<{ decision: string; n: number }>(
        "select decision, count(*)::int as n from judge_verdicts where received_at > now() - make_interval(secs => $1) and decision <> 'PENDING' group by decision",
        [WINDOW_SECONDS],
      ),
      this.db.query<{ reason: ReasonCode; n: number }>(
        "select reason, count(*)::int as n from judge_verdicts where received_at > now() - make_interval(secs => $1) group by reason",
        [WINDOW_SECONDS],
      ),
      this.db.query<{ cell_id: string; last: Date; n: number }>(
        "select cell_id, max(received_at) as last, count(*) filter (where received_at > now() - make_interval(secs => $1))::int as n from judge_verdicts group by cell_id",
        [WINDOW_SECONDS],
      ),
      Promise.all(this.cfg.chains.map((c) => this.probe(c))),
      this.creRuns(),
    ]);
    const seen = new Map(cellRows.rows.map((c) => [c.cell_id, c]));
    const ids = new Set([...this.cfg.cells.map((c) => c.id), ...seen.keys()]);
    const cells: CellHealth[] = [...ids].map((id) => {
      const declared = this.cfg.cells.find((c) => c.id === id);
      const s = seen.get(id);
      return {
        id,
        name: declared?.name ?? id,
        region: declared?.region ?? "unknown",
        healthy: s !== undefined && Date.now() - s.last.getTime() < 10 * 60_000,
        lastHeartbeatAt: (s?.last ?? new Date(0)).toISOString(),
        version: declared?.version ?? "unknown",
        policyTransitions: s?.n ?? 0,
      };
    });
    const live = [...scraped.values()].filter((x): x is JudgeScrape => x !== null);
    for (const c of cells) {
      if (!scraped.has(c.id)) continue;
      const ok = scraped.get(c.id) !== null;
      c.healthy = ok;
      if (ok) c.lastHeartbeatAt = new Date().toISOString();
    }
    for (const [id, sc] of scraped) {
      if (cells.some((c) => c.id === id)) continue;
      cells.push({ id, name: id, region: "unknown", healthy: sc !== null, lastHeartbeatAt: sc ? new Date().toISOString() : new Date(0).toISOString(), version: "unknown", policyTransitions: 0 });
    }
    cells.sort((x, y) => x.id.localeCompare(y.id));
    if (live.length > 0) {
      const buckets = new Map<number, number>();
      const byReasonScraped: Record<string, number> = {};
      for (const sc of live) {
        for (const [le, n] of sc.buckets) buckets.set(le, (buckets.get(le) ?? 0) + n);
        for (const [r, n] of Object.entries(sc.byReason)) byReasonScraped[r] = (byReasonScraped[r] ?? 0) + n;
      }
      const toMs = (v: number | null): number => Math.round((v ?? 0) * 1000);
      return {
        windowSeconds: WINDOW_SECONDS,
        cells,
        judge: { p50Ms: toMs(histogramQuantile(0.5, buckets)), p99Ms: toMs(histogramQuantile(0.99, buckets)), samples: live.reduce((n, x) => n + x.samples, 0) },
        verdictCounts: { pass: live.reduce((n, x) => n + x.pass, 0), fail: live.reduce((n, x) => n + x.fail, 0), byReason: byReasonScraped },
        rpc,
        creRuns,
        enforcement: this.cfg.enforcement,
      };
    }
    const l = latency.rows[0];
    return {
      windowSeconds: WINDOW_SECONDS,
      cells,
      judge: { p50Ms: Math.round(l?.p50 ?? 0), p99Ms: Math.round(l?.p99 ?? 0), samples: l?.n ?? 0 },
      verdictCounts: {
        pass: counts.rows.find((c) => c.decision === "PASS")?.n ?? 0,
        fail: counts.rows.find((c) => c.decision === "FAIL")?.n ?? 0,
        byReason: Object.fromEntries(byReason.rows.map((r) => [r.reason, r.n])),
      },
      rpc,
      creRuns,
      enforcement: this.cfg.enforcement,
    };
  }
}
