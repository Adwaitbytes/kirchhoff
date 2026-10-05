import { Notifier, type IncidentNotice } from "@kirchhoff/indexer/notifier";
import type { Queryable } from "@kirchhoff/indexer";
import { CHAINS, addressUrl, txUrl } from "@kirchhoff/sdk";
import type { AiServices } from "./ai.ts";
import type { IncidentBuilder } from "./incident.ts";

/**
 * Pages the issuer for every new incident (PRD section 3 story 5): exact deficit, offending tx,
 * what is already contained, the Incident Room link and the narrative summary (template fallback).
 * Runs on the long-running API server. It waits for containment to land onchain (or a grace
 * period) so the page can say what is already quarantined.
 */

const short = (a: string): string => `${a.slice(0, 6)}...${a.slice(-4)}`;

export type PagerOptions = { linkBase: string | null; graceMs?: number; intervalMs?: number; simulation?: boolean };

export class IncidentPager {
  private readonly db: Queryable;
  private readonly incidents: IncidentBuilder;
  private readonly ai: AiServices;
  private readonly notifier: Notifier;
  private readonly opts: Required<PagerOptions>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(db: Queryable, incidents: IncidentBuilder, ai: AiServices, notifier: Notifier, opts: PagerOptions) {
    this.db = db;
    this.incidents = incidents;
    this.ai = ai;
    this.notifier = notifier;
    this.opts = { graceMs: 60_000, intervalMs: 5_000, simulation: true, ...opts };
  }

  /** The page content, built from the same evidence bundle and narrative as the Incident Room. */
  async notice(id: string): Promise<{ notice: IncidentNotice; containmentApplied: boolean; openedAt: Date }> {
    const bundle = await this.incidents.bundle(id);
    const token = (await this.db.query<{ decimals: number }>("select decimals from tokens where symbol = $1", [bundle.incident.token])).rows[0];
    const narrative = await this.ai.narrative(id, bundle);
    const inc = bundle.incident;
    const loop = inc.offending.bridge === "loop_rule";
    const bridge = inc.offending.bridge === "weakbridge" ? "WeakBridge" : inc.offending.bridge === "ccip" ? "CCIP" : inc.offending.bridge;
    const contained: string[] = [];
    const frozen = bundle.actions.find((a) => a.kind === "freeze_ccip_lanes");
    if (frozen?.applied) contained.push(`CCIP lanes frozen on ${[...new Set(frozen.txs.map((t) => CHAINS[t.chain].label))].join(", ")}`);
    for (const b of bundle.blastRadius) {
      for (const acct of b.taintedAddresses) contained.push(`${short(acct)} tainted on ${CHAINS[b.chain].label} (${addressUrl(b.chain, acct)})`);
    }
    const flipped = bundle.actions.find((a) => a.kind === "flip_feed");
    if (flipped?.applied) contained.push(`ConservationFeed reads BROKEN on ${flipped.txs.length} chain(s)`);
    if (bundle.heldMessages.length > 0) contained.push(`${bundle.heldMessages.length} CCIP message(s) held for replay`);
    const notice: IncidentNotice = {
      incidentId: inc.id,
      token: inc.token,
      reason: inc.reason,
      deficit: inc.deltaAfter,
      decimals: token?.decimals ?? 18,
      offendingLabel: loop ? `Loop Rule BREACH report on ${CHAINS[inc.offending.chain].label}` : `${bridge} credit on ${CHAINS[inc.offending.chain].label}`,
      offendingTxUrl: BigInt(inc.offending.tx.hash) === 0n ? null : txUrl(inc.offending.tx.chain, inc.offending.tx.hash),
      contained,
      link: this.opts.linkBase ? `${this.opts.linkBase.replace(/\/+$/, "")}/incidents/${inc.id}` : null,
      summary: narrative.summary.map((s) => s.text).join(" "),
      summaryLabel: narrative.generator === "model" ? narrative.label : "Summary (deterministic template).",
      simulation: this.opts.simulation,
    };
    const containmentApplied = bundle.actions.some((a) => a.kind !== "page_issuer" && a.kind !== "flip_feed" && a.applied);
    return { notice, containmentApplied, openedAt: new Date(inc.openedAt) };
  }

  async tick(now: Date = new Date()): Promise<string[]> {
    if (this.running || !this.notifier.configured) return [];
    this.running = true;
    const paged: string[] = [];
    try {
      for (const id of await this.notifier.pending()) {
        const { notice, containmentApplied, openedAt } = await this.notice(id);
        // Page once containment is onchain, or after the grace period at the latest.
        if (!containmentApplied && now.getTime() - openedAt.getTime() < this.opts.graceMs) continue;
        const sent = await this.notifier.notify(notice);
        if (sent.length > 0) paged.push(id);
      }
    } catch (e) {
      console.error("kirchhoff pager: tick failed", e instanceof Error ? e.message : e);
    } finally {
      this.running = false;
    }
    return paged;
  }

  start(): void {
    if (this.timer || !this.notifier.configured) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
