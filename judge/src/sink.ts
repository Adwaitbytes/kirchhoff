/**
 * Fire-and-forget verdict sink to the API's POST /internal/verdicts (the UI read model). It is
 * outside the decision path: `offer` is synchronous and O(1), the verdict has already been sent
 * when it is called, and nothing here can throw into the request. A bounded queue drops the
 * oldest report when the API is down; one batch (<= 100) is in flight at a time.
 */
import type { Counter, Gauge } from "prom-client";
import type { Logger } from "./log.ts";

export type VerdictReport = {
  cellId: string;
  messageId: string;
  decision: "PASS" | "FAIL" | "PENDING";
  reason: string;
  note: string;
  latencyMs: number;
  evaluatedAt: string;
  srcChain: string;
  dstChain: string;
  amount: string;
  sender: string;
  receiver: string;
  token?: string;
  sourceTxHash: string;
};

export type SinkMetrics = {
  sent: Counter;
  dropped: Counter<"reason">;
  failures: Counter;
  queued: Gauge;
};

export type SinkOptions = {
  url: string;
  key: string;
  metrics: SinkMetrics;
  logger: Logger;
  maxQueue?: number;
  batchSize?: number;
  flushMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
};

export const SINK_PATH = "/internal/verdicts";
const MAX_BACKOFF_MS = 30_000;

export class VerdictSink {
  private readonly queue: VerdictReport[] = [];
  private readonly opts: Required<Omit<SinkOptions, "fetchFn">> & { fetchFn: typeof fetch };
  private inFlight = false;
  private timer: NodeJS.Timeout | undefined;
  private backoffMs = 0;
  private nextAttemptAt = 0;
  private stopped = false;

  constructor(options: SinkOptions) {
    this.opts = {
      maxQueue: 5000,
      batchSize: 100,
      flushMs: 1000,
      timeoutMs: 5000,
      fetchFn: fetch,
      ...options,
      url: options.url.replace(/\/+$/, ""),
    };
  }

  /** Never throws, never awaits. */
  offer(report: VerdictReport): void {
    if (this.stopped) return;
    this.queue.push(report);
    while (this.queue.length > this.opts.maxQueue) {
      this.queue.shift();
      this.opts.metrics.dropped.inc({ reason: "overflow" });
    }
    this.opts.metrics.queued.set(this.queue.length);
    if (this.queue.length >= this.opts.batchSize) this.kick();
  }

  start(): void {
    this.timer = setInterval(() => {
      this.kick();
    }, this.opts.flushMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  get size(): number {
    return this.queue.length;
  }

  /** Starts a flush unless one is running or the API is backing off. */
  kick(): void {
    if (this.inFlight || this.queue.length === 0 || Date.now() < this.nextAttemptAt) return;
    this.inFlight = true;
    void this.flush().finally(() => {
      this.inFlight = false;
    });
  }

  private async flush(): Promise<void> {
    const batch = this.queue.splice(0, this.opts.batchSize);
    try {
      const res = await this.opts.fetchFn(`${this.opts.url}${SINK_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-kirchhoff-internal-key": this.opts.key },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (res.ok) {
        this.opts.metrics.sent.inc(batch.length);
        this.backoffMs = 0;
        this.nextAttemptAt = 0;
      } else if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        // The API refused the content or the key: resending the same batch cannot succeed.
        this.opts.metrics.dropped.inc({ reason: "rejected" }, batch.length);
        this.opts.logger.log("warn", "verdict sink batch rejected", { status: res.status, body: (await res.text()).slice(0, 200), reports: batch.length });
      } else {
        this.retryLater(batch, `HTTP ${res.status.toString()}`);
      }
    } catch (e) {
      this.retryLater(batch, e instanceof Error ? e.message : String(e));
    } finally {
      this.opts.metrics.queued.set(this.queue.length);
    }
  }

  private retryLater(batch: VerdictReport[], why: string): void {
    this.opts.metrics.failures.inc();
    this.queue.unshift(...batch);
    while (this.queue.length > this.opts.maxQueue) {
      this.queue.shift();
      this.opts.metrics.dropped.inc({ reason: "overflow" });
    }
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs === 0 ? this.opts.flushMs : this.backoffMs * 2);
    this.nextAttemptAt = Date.now() + this.backoffMs;
    this.opts.logger.log("warn", "verdict sink unavailable, keeping reports", { why, queued: this.queue.length, retryInMs: this.backoffMs });
  }
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const EVM_PADDED = /^0x(?:0{24})?[0-9a-fA-F]{40}$/;
const CELL_ID = /^[A-Za-z0-9._-]{1,64}$/;

export type SinkInput = {
  cellId: string;
  request: {
    message_id: string;
    source_tx_hash: string;
    verifier_id: string;
    message: { source_chain_selector: string; dest_chain_selector: string; sender: string; receiver: string; token_transfer?: { amount: string } };
  };
  decision: "PASS" | "FAIL" | "PENDING";
  reasonString: string;
  symbol: string | null;
  latencyMs: number;
  evaluatedAt: Date;
};

/**
 * The API's report shape, or null for a message the read model cannot hold (a chain outside the
 * specs, a non-EVM address): those would make the API reject the whole batch.
 */
export function toReport(input: SinkInput, specSelectors: ReadonlySet<string>): VerdictReport | null {
  const { request: r } = input;
  const m = r.message;
  if (!specSelectors.has(m.source_chain_selector) || !specSelectors.has(m.dest_chain_selector)) return null;
  if (!BYTES32.test(r.message_id) || !BYTES32.test(r.source_tx_hash)) return null;
  if (!EVM_PADDED.test(m.sender) || !EVM_PADDED.test(m.receiver)) return null;
  const cellId = CELL_ID.test(input.cellId) ? input.cellId : CELL_ID.test(r.verifier_id) ? r.verifier_id : null;
  if (cellId === null) return null;
  const [reason = "", ...rest] = input.reasonString.split(" ");
  const note = (input.symbol !== null && rest[0] === input.symbol ? rest.slice(1) : rest).join(" ");
  return {
    cellId,
    messageId: r.message_id.toLowerCase(),
    decision: input.decision,
    reason,
    note: note.slice(0, 200),
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    evaluatedAt: input.evaluatedAt.toISOString(),
    srcChain: m.source_chain_selector,
    dstChain: m.dest_chain_selector,
    amount: m.token_transfer?.amount ?? "0",
    sender: m.sender.toLowerCase(),
    receiver: m.receiver.toLowerCase(),
    ...(input.symbol === null ? {} : { token: input.symbol }),
    sourceTxHash: r.source_tx_hash.toLowerCase(),
  };
}
