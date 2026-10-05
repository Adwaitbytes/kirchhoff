import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { SinkMetrics } from "./sink.ts";

export type JudgeMetrics = {
  registry: Registry;
  latency: Histogram<"outcome">;
  decisions: Counter<"decision" | "reason">;
  authFailures: Counter<"failure">;
  invalidRequests: Counter;
  specSynced: Gauge<"token">;
  sink: SinkMetrics;
};

export function createMetrics(): JudgeMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "judge_" });
  const specSynced = new Gauge({
    name: "judge_spec_cache_synced",
    help: "1 when the token's registry spec hash is synced within the max age",
    labelNames: ["token"] as const,
    registers: [registry],
  });
  return {
    registry,
    latency: new Histogram({
      name: "judge_evaluate_duration_seconds",
      help: "POST /v1/evaluate latency by outcome (PASS, FAIL, PENDING, UNAUTHORIZED, INVALID)",
      labelNames: ["outcome"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
      registers: [registry],
    }),
    decisions: new Counter({
      name: "judge_decisions_total",
      help: "Verdicts by decision and reason code; PENDING answers HTTP 503",
      labelNames: ["decision", "reason"] as const,
      registers: [registry],
    }),
    authFailures: new Counter({
      name: "judge_auth_failures_total",
      help: "Requests rejected with 401 by HMAC failure kind",
      labelNames: ["failure"] as const,
      registers: [registry],
    }),
    invalidRequests: new Counter({
      name: "judge_invalid_requests_total",
      help: "Requests rejected with 400 (not a valid EvaluateRequest)",
      registers: [registry],
    }),
    specSynced,
    sink: {
      sent: new Counter({ name: "judge_verdict_sink_sent_total", help: "Verdict reports accepted by the API", registers: [registry] }),
      dropped: new Counter({
        name: "judge_verdict_sink_dropped_total",
        help: "Verdict reports dropped: overflow (queue full while the API was down) or rejected (API 4xx)",
        labelNames: ["reason"] as const,
        registers: [registry],
      }),
      failures: new Counter({ name: "judge_verdict_sink_failures_total", help: "Sink flushes that failed and were requeued", registers: [registry] }),
      queued: new Gauge({ name: "judge_verdict_sink_queued", help: "Verdict reports waiting to be sent", registers: [registry] }),
    },
  };
}
