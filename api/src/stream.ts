import type { Queryable } from "@kirchhoff/indexer";
import type { LabRun, StreamMessage } from "@kirchhoff/sdk";
import type { IncidentBuilder } from "./incident.ts";
import type { ReadModel } from "./readmodel.ts";

/**
 * Live channels (PRD section 13: status, epoch, verdict, incident; plus transfer and lab). The
 * indexer, the verdict sink and the lab runner append to the `stream_events` outbox; WebSocket
 * and SSE both tail it by id, so a reconnecting client resumes without gaps (SSE Last-Event-ID).
 */

type OutboxRow = { id: string; token_symbol: string; channel: StreamMessage["channel"]; ref: Record<string, unknown> };

export class Materializer {
  private readonly db: Queryable;
  private readonly rm: ReadModel;
  private readonly incidents: IncidentBuilder;
  private readonly labRun: (id: string) => LabRun | null;

  constructor(db: Queryable, rm: ReadModel, incidents: IncidentBuilder, labRun: (id: string) => LabRun | null) {
    this.db = db;
    this.rm = rm;
    this.incidents = incidents;
    this.labRun = labRun;
  }

  /** Messages after `lastId`, plus the highest outbox id scanned (advance to it even when rows were skipped). */
  async since(lastId: bigint, tokenSymbol: string | null, limit = 200): Promise<{ maxId: bigint; items: { id: bigint; message: StreamMessage }[] }> {
    const r = await this.db.query<OutboxRow>(
      `select id::text, token_symbol, channel, ref from stream_events where id > $1 and ($2::text is null or lower(token_symbol) = lower($2)) order by id limit $3`,
      [lastId.toString(), tokenSymbol, limit],
    );
    const out: { id: bigint; message: StreamMessage }[] = [];
    // Coalesce status bursts: one full status frame per batch per token is enough.
    const lastStatus = new Map<string, string>();
    for (const row of r.rows) if (row.channel === "status") lastStatus.set(row.token_symbol, row.id);
    for (const row of r.rows) {
      if (row.channel === "status" && lastStatus.get(row.token_symbol) !== row.id) continue;
      const message = await this.materialize(row).catch((e: unknown) => {
        console.error(`kirchhoff stream: cannot materialize ${row.channel} #${row.id}:`, e instanceof Error ? e.message : e);
        return null;
      });
      if (message) out.push({ id: BigInt(row.id), message });
    }
    const last = r.rows[r.rows.length - 1];
    return { maxId: last ? BigInt(last.id) : lastId, items: out };
  }

  async latestId(): Promise<bigint> {
    const r = await this.db.query<{ id: string | null }>("select max(id)::text as id from stream_events");
    return BigInt(r.rows[0]?.id ?? "0");
  }

  private async materialize(row: OutboxRow): Promise<StreamMessage | null> {
    const token = row.token_symbol;
    const ref = row.ref;
    switch (row.channel) {
      case "status":
        return { channel: "status", token, data: await this.rm.status(token) };
      case "epoch": {
        const p = await this.rm.epochPoint(token, String(ref.chain), String(ref.txHash), Number(ref.logIndex));
        return p ? { channel: "epoch", token, data: p } : null;
      }
      case "verdict": {
        const v = await this.rm.verdict(String(ref.messageId));
        return v ? { channel: "verdict", token, data: v } : null;
      }
      case "incident": {
        const { incident } = await this.incidents.incident(String(ref.incidentId));
        return { channel: "incident", token, data: incident };
      }
      case "transfer": {
        const t = await this.rm.transfer(String(ref.messageId), String(ref.bridge));
        return t ? { channel: "transfer", token, data: t } : null;
      }
      case "lab": {
        const run = this.labRun(String(ref.runId)) ?? (await this.db.query<{ run: LabRun }>("select run from lab_runs where id = $1", [String(ref.runId)])).rows[0]?.run ?? null;
        return run ? { channel: "lab", token, data: run } : null;
      }
      case "ping":
        return null;
    }
  }
}

export type Subscriber = { token: string; send: (frame: string) => void; /** Outbox id already covered by the initial snapshot. */ cursor: bigint };

/** Long-running fan-out for WebSocket clients: each subscriber has its own outbox cursor, so joining is race-free. */
export class StreamHub {
  private readonly mat: Materializer;
  private readonly subs = new Set<Subscriber>();
  private timer: NodeJS.Timeout | null = null;
  private pinger: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;

  constructor(mat: Materializer, intervalMs = 1_000) {
    this.mat = mat;
    this.intervalMs = intervalMs;
  }

  /** The cursor a new subscriber starts from: read it BEFORE building the initial snapshot. */
  latestId(): Promise<bigint> {
    return this.mat.latestId();
  }

  add(sub: Subscriber): () => void {
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  get size(): number {
    return this.subs.size;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.pinger = setInterval(() => {
      for (const s of this.subs) s.send(JSON.stringify({ channel: "ping" }));
    }, 15_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pinger) clearInterval(this.pinger);
    this.timer = null;
    this.pinger = null;
  }

  async tick(): Promise<void> {
    if (this.running || this.subs.size === 0) return;
    this.running = true;
    try {
      const subs = [...this.subs];
      const from = subs.reduce((m, s) => (s.cursor < m ? s.cursor : m), subs[0]?.cursor ?? 0n);
      const batch = await this.mat.since(from, null);
      for (const { id, message } of batch.items) {
        if (message.channel === "ping") continue;
        const frame = JSON.stringify(message);
        for (const s of subs) if (id > s.cursor && s.token.toLowerCase() === message.token.toLowerCase()) s.send(frame);
      }
      for (const s of subs) if (batch.maxId > s.cursor) s.cursor = batch.maxId;
    } catch (e) {
      console.error("kirchhoff stream: tick failed", e instanceof Error ? e.message : e);
    } finally {
      this.running = false;
    }
  }
}
