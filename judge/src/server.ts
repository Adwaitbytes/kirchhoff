/**
 * node:http rather than a framework: one route on the hot path, and the HMAC needs the exact raw
 * body bytes before any parsing.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { reasonName, type Hex } from "@kirchhoff/engine";
import type { AuthConfig } from "./config.ts";
import { evaluate, type EvaluateDeps, type Outcome } from "./evaluate.ts";
import { verifyHmac } from "./hmac.ts";
import type { Logger } from "./log.ts";
import type { JudgeMetrics } from "./metrics.ts";
import { toReport, type VerdictSink } from "./sink.ts";
import { describeSchemaErrors, type EvaluateResponse, type PolicyHookValidators } from "./schema.ts";

export const MAX_BODY_BYTES = 1024 * 1024;
/** The verifier truncates longer reasons in its logs (OpenAPI EvaluateResponse.reason). */
export const MAX_REASON_CHARS = 256;

export type ServerDeps = EvaluateDeps & {
  auth: AuthConfig;
  basePath: string;
  budgetMs: number;
  validators: PolicyHookValidators;
  metrics: JudgeMetrics;
  logger: Logger;
  now?: () => number;
  /** Optional verdict sink to the API read model; called after the answer is sent, never awaited. */
  verdictSink?: { sink: VerdictSink; cellId: string; specSelectors: ReadonlySet<string> };
};

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  res.end(payload);
}

function truncate(reason: string): string {
  return reason.length <= MAX_REASON_CHARS ? reason : reason.slice(0, MAX_REASON_CHARS);
}

/** Resolves when the budget is spent and aborts the signal, so in-flight work can stop early. */
function budget(ms: number): { deadline: Promise<{ expired: true }>; signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<{ expired: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ expired: true });
    }, Math.max(ms, 0));
  });
  return {
    deadline,
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
    },
  };
}

export function createJudgeServer(deps: ServerDeps): Server {
  const now = deps.now ?? Date.now;
  const evaluatePath = `${deps.basePath}/v1/evaluate`;
  const { metrics, logger } = deps;

  async function handleEvaluate(req: IncomingMessage, res: ServerResponse, startedAt: number): Promise<void> {
    const observe = (outcome: string): void => {
      metrics.latency.observe({ outcome }, (performance.now() - startedAt) / 1000);
    };
    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        metrics.invalidRequests.inc();
        observe("INVALID");
        send(res, 413, { error: "request body too large" });
        return;
      }
      throw e;
    }

    // Step 1: HMAC over the exact bytes received and the exact request target.
    if (deps.auth.mode === "hmac") {
      const verdict = verifyHmac(deps.auth.creds, req.url ?? "/", raw, req.headers, now());
      if (!verdict.ok) {
        metrics.authFailures.inc({ failure: verdict.failure });
        observe("UNAUTHORIZED");
        logger.log("warn", "unauthorized policy hook call", { failure: verdict.failure, remote: req.socket.remoteAddress });
        send(res, 401, { error: "unauthorized" });
        return;
      }
    }

    // Step 2: parse and validate against the OpenAPI v1 EvaluateRequest schema.
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      metrics.invalidRequests.inc();
      observe("INVALID");
      send(res, 400, { error: "body is not JSON" });
      return;
    }
    if (!deps.validators.request(body)) {
      const error = describeSchemaErrors(deps.validators.request.errors);
      metrics.invalidRequests.inc();
      observe("INVALID");
      logger.log("warn", "invalid EvaluateRequest", { error });
      send(res, 400, { error: `invalid EvaluateRequest: ${error}` });
      return;
    }
    const request = body;

    const timer = budget(deps.budgetMs - (performance.now() - startedAt));
    let outcome: Outcome;
    try {
      outcome = await evaluate(request, deps, timer.deadline, timer.signal);
    } finally {
      timer.clear();
    }
    const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const messageId = request.message_id as Hex;
    const report = (decision: "PASS" | "FAIL" | "PENDING", reasonString: string, symbol: string | null): void => {
      const target = deps.verdictSink;
      if (target === undefined) return;
      try {
        const r = toReport({ cellId: target.cellId, request, decision, reasonString, symbol, latencyMs, evaluatedAt: new Date(now()) }, target.specSelectors);
        if (r !== null) target.sink.offer(r);
      } catch (e) {
        logger.log("warn", "verdict sink offer failed", { messageId, error: e instanceof Error ? e.message : String(e) });
      }
    };

    switch (outcome.kind) {
      case "invalid": {
        metrics.invalidRequests.inc();
        observe("INVALID");
        logger.log("warn", "invalid EvaluateRequest", { messageId, error: outcome.error });
        send(res, 400, { error: outcome.error });
        return;
      }
      case "pending": {
        const reason = truncate(outcome.reasonString);
        metrics.decisions.inc({ decision: "PENDING", reason: "PENDING_ATTESTATION" });
        observe("PENDING");
        logger.log("info", "verdict pending, verifier will retry", {
          messageId,
          decision: "PENDING",
          reasonCode: "PENDING_ATTESTATION",
          reason,
          latencyMs,
          evidence: outcome.evidence,
        });
        send(res, 503, { error: reason });
        report("PENDING", outcome.reasonString, outcome.symbol);
        return;
      }
      case "verdict": {
        const reason = truncate(outcome.reasonString);
        const code = reasonName(outcome.reason);
        metrics.decisions.inc({ decision: outcome.decision, reason: code });
        observe(outcome.decision);
        const fields = { messageId, decision: outcome.decision, reasonCode: code, reason, latencyMs, evidence: outcome.evidence };
        if (outcome.decision === "FAIL") logger.log("warn", "verdict FAIL", fields);
        else logger.log("debug", "verdict PASS", fields);
        const response: EvaluateResponse = { decision: outcome.decision, message_id: request.message_id, reason };
        send(res, 200, response);
        report(outcome.decision, outcome.reasonString, outcome.symbol);
        return;
      }
    }
  }

  const server = createServer((req, res) => {
    const startedAt = performance.now();
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    const route = async (): Promise<void> => {
      if (path === evaluatePath) {
        if (req.method !== "POST") {
          res.setHeader("allow", "POST");
          send(res, 405, { error: "method not allowed" });
          return;
        }
        await handleEvaluate(req, res, startedAt);
        return;
      }
      if (req.method === "GET" && path === "/healthz") {
        send(res, 200, { status: "ok" });
        return;
      }
      if (req.method === "GET" && path === "/readyz") {
        const ready = deps.cache.ready();
        send(res, ready ? 200 : 503, { status: ready ? "ready" : "spec cache not synced" });
        return;
      }
      if (req.method === "GET" && path === "/metrics") {
        for (const t of deps.cache.tokens) {
          metrics.specSynced.set({ token: t.symbol }, deps.cache.active(t.tokenId).state === "synced" ? 1 : 0);
        }
        send(res, 200, await metrics.registry.metrics(), metrics.registry.contentType);
        return;
      }
      send(res, 404, { error: "not found" });
    };
    route().catch((e: unknown) => {
      logger.log("error", "unhandled request error", { path, error: e instanceof Error ? e.stack ?? e.message : String(e) });
      // Any non-200 makes the verifier retry; never let an internal error read as a verdict.
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}
