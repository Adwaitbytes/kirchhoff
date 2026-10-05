import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import type { Db } from "@kirchhoff/indexer";
import { ingestVerdict, parseVerdictReport, VerdictValidationError } from "@kirchhoff/indexer/verdicts";
import { SpecInvalidError, askKirchhoff, backtestYaml, draftSpec, runTopologyScout } from "@kirchhoff/ai";
import {
  type AskEvent,
  type AskRequest,
  type BacktestResponse,
  type ChainKey,
  type CheckTransferRequest,
  type CheckTransferResponse,
  type EpochsResponse,
  type IncidentResponse,
  type LabRunResponse,
  type LabStatusResponse,
  type OpsResponse,
  type SpecDraftEvent,
  type SpecProposalResponse,
  type SpecProposalsResponse,
  type ScoutProposal,
  type ScoutProposalsResponse,
  type ScoutResponse,
  type ReplayPlanResponse,
  type Address,
  type ApiKeysResponse,
  type TokensResponse,
  type TokenStatusResponse,
  type VerdictsResponse,
  type TxRef,
} from "@kirchhoff/sdk";
import { randomUUID } from "node:crypto";
import { parseSpec } from "@kirchhoff/engine/spec";
import type { Notifier } from "@kirchhoff/indexer/notifier";
import { askBackend, type AiServices } from "./ai.ts";
import { IncidentPager } from "./pager.ts";
import { replayPlan } from "./replay.ts";
import { SpecResolver } from "./specs.ts";
import { IssuerAuth, requireInternalKey } from "./auth.ts";
import { ApiFailure, errorBody, notFound } from "./errors.ts";
import { IncidentBuilder } from "./incident.ts";
import type { LabRunner } from "./lab.ts";
import { inProcessBackend, registerMcp } from "./mcp.ts";
import { checkTransfer, type ChainClients } from "./onchain.ts";
import type { Ops } from "./ops.ts";
import { ReadModel } from "./readmodel.ts";
import { Materializer, StreamHub } from "./stream.ts";
import * as v from "./validate.ts";

export type AppDeps = {
  db: Db;
  ai: AiServices;
  lab: LabRunner;
  ops: Ops;
  clients: ChainClients;
  issuerKey: string | undefined;
  internalKey: string | undefined;
  defaultToken: string;
  /** WebSocket + outbox fan-out (long-running server). Serverless deployments set false and rely on SSE. */
  websocket: boolean;
  sseMaxMs: number;
  corsOrigins: string[] | true;
  logger?: boolean;
  /** Incident pages (Telegram/Slack/PagerDuty); run by the long-running server only. */
  notifier?: Notifier;
  /** Mission Control base URL for Incident Room links in pages. */
  webPublicUrl?: string | null;
  /** CCV aggregator gRPC URL for replay plans (ccip-cli manual-exec --verifiers). */
  aggregatorUrl?: string | null;
  /** Fetch used to resolve spec URIs (tests inject one). */
  specFetch?: typeof fetch;
};

export type App = FastifyInstance & { kirchhoff: { hub: StreamHub | null; rm: ReadModel; incidents: IncidentBuilder; auth: IssuerAuth } };

type SseWriter = { send: (event: { type?: string; data: unknown; id?: string }) => void; comment: (text: string) => void; end: () => void; closed: () => boolean };

function openSse(req: FastifyRequest, reply: FastifyReply): SseWriter {
  // CORS and rate-limit headers set by hooks live on the Fastify reply; copy them onto the raw stream.
  for (const [k, val] of Object.entries(reply.getHeaders())) if (val !== undefined) reply.raw.setHeader(k, val);
  reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  reply.hijack();
  let closed = false;
  req.raw.on("close", () => {
    closed = true;
  });
  return {
    send: ({ type, data, id }) => {
      if (closed) return;
      reply.raw.write(`${id !== undefined ? `id: ${id}\n` : ""}${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
    },
    comment: (text) => {
      if (!closed) reply.raw.write(`: ${text}\n\n`);
    },
    end: () => {
      if (!closed) reply.raw.end();
      closed = true;
    },
    closed: () => closed,
  };
}

export async function buildApp(deps: AppDeps): Promise<App> {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 512 * 1024, trustProxy: true }) as unknown as App;
  const rm = new ReadModel(deps.db);
  const incidents = new IncidentBuilder(deps.db, rm);
  const auth = new IssuerAuth(deps.db, deps.issuerKey);
  const mat = new Materializer(deps.db, rm, incidents, (id) => deps.lab.get(id));
  const hub = deps.websocket ? new StreamHub(mat) : null;
  const specResolver = new SpecResolver(deps.db, deps.specFetch ? { fetch: deps.specFetch } : {});
  app.decorate("kirchhoff", { hub, rm, incidents, auth });
  await auth.seed(deps.issuerKey).catch((e: unknown) => {
    console.error("kirchhoff api: could not seed the issuer key row", e instanceof Error ? e.message : e);
  });

  await app.register(cors, { origin: deps.corsOrigins, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["content-type", "authorization", "last-event-id"] });
  await app.register(rateLimit, { global: false });
  if (deps.websocket) await app.register(websocket, { options: { maxPayload: 1024 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiFailure) return reply.status(err.status).send(errorBody(err.code, err.message, err.chain));
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 429) return reply.status(429).send(errorBody("RATE_LIMITED", "Too many requests. Slow down and retry."));
    if (e.statusCode !== undefined && e.statusCode >= 400 && e.statusCode < 500) return reply.status(e.statusCode).send(errorBody("BAD_REQUEST", e.message ?? "bad request"));
    console.error("kirchhoff api: unhandled error", err);
    return reply.status(500).send(errorBody("INTERNAL", "Internal error. The onchain feed remains the source of truth."));
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send(errorBody("NOT_FOUND", `no route ${req.method} ${req.url.split("?")[0] ?? ""}`)));

  app.get("/healthz", async () => {
    await deps.db.query("select 1");
    return { ok: true, websocket: deps.websocket, lab: deps.lab.enabled, ai: deps.ai.provider !== null };
  });

  const listTokens = async (): Promise<TokensResponse> => {
    const rows = await rm.tokenRows();
    return { ...(await rm.meta(rows[0])), items: rows.map((t) => rm.summary(t)) };
  };
  const incidentResponse = async (id: string): Promise<IncidentResponse> => {
    const bundle = await incidents.bundle(id);
    const token = await rm.tokenRow(bundle.incident.token);
    const narrative = await deps.ai.narrative(id, bundle).catch((e: unknown) => {
      console.error("kirchhoff api: narrative unavailable", e instanceof Error ? e.message : e);
      return null;
    });
    return { ...(await rm.meta(token)), ...bundle, narrative };
  };
  const dryRun = async (body: CheckTransferRequest): Promise<CheckTransferResponse> => {
    if (body.srcChain === body.dstChain) throw new ApiFailure(400, "BAD_REQUEST", "srcChain and dstChain must differ");
    const token = await rm.tokenRow(body.token).catch((e: unknown) => {
      if (e instanceof ApiFailure && e.code === "NOT_FOUND") return null;
      throw e;
    });
    const res = await checkTransfer(body, token, await rm.chainRows(), deps.clients);
    return { source: "onchain-mirror", ...res, servedAt: new Date().toISOString() };
  };
  registerMcp(
    app,
    inProcessBackend({ tokens: listTokens, status: (t) => rm.status(t), checkTransfer: dryRun, verdict: (m) => rm.verdict(m), incident: incidentResponse }),
  );

  await app.register(
    // eslint-disable-next-line @typescript-eslint/require-await -- Fastify registers encapsulated plugins as async functions.
    async (r) => {
      r.get("/tokens", listTokens);

      r.get<{ Params: { token: string } }>("/tokens/:token/status", async (req): Promise<TokenStatusResponse> => rm.status(v.tokenSymbol(req.params.token)));

      r.get<{ Params: { token: string }; Querystring: Record<string, string | undefined> }>("/tokens/:token/epochs", async (req): Promise<EpochsResponse> => {
        const symbol = v.tokenSymbol(req.params.token);
        const limit = v.intInRange(req.query.limit, "limit", 1, 500, 100);
        const cursor = v.decodeCursor(req.query.cursor, 2);
        const since = v.isoTime(req.query.since, "since");
        const token = await rm.tokenRow(symbol);
        const page = await rm.epochs(symbol, limit, cursor, since);
        return { ...(await rm.meta(token)), items: page.items, nextCursor: page.nextCursor ? v.encodeCursor(page.nextCursor) : null };
      });

      r.get<{ Params: { token: string }; Querystring: Record<string, string | undefined> }>("/tokens/:token/verdicts", async (req): Promise<VerdictsResponse> => {
        const symbol = v.tokenSymbol(req.params.token);
        const limit = v.intInRange(req.query.limit, "limit", 1, 200, 50);
        const cursor = v.decodeCursor(req.query.cursor, 2);
        const token = await rm.tokenRow(symbol);
        const page = await rm.verdicts(symbol, limit, cursor);
        return { ...(await rm.meta(token)), items: page.items, nextCursor: page.nextCursor ? v.encodeCursor(page.nextCursor) : null };
      });

      r.get<{ Params: { id: string } }>("/incidents/:id", async (req): Promise<IncidentResponse> => {
        return incidentResponse(v.bytes32(req.params.id, "id"));
      });

      r.post<{ Body: unknown }>(
        "/check-transfer",
        { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
        async (req): Promise<CheckTransferResponse> => {
          const b = v.object(req.body);
          const body = {
            token: v.tokenSymbol(b.token),
            srcChain: v.chainKey(b.srcChain, "srcChain"),
            dstChain: v.chainKey(b.dstChain, "dstChain"),
            amount: v.wei(b.amount, "amount").toString(),
            sender: v.address(b.sender, "sender"),
          };
          return dryRun(body);
        },
      );

      r.post<{ Body: unknown }>("/specs/draft", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
        await auth.require(req.headers.authorization, "specs:draft");
        const b = v.object(req.body);
        const canonical = v.object(b.canonical, "canonical");
        const body = {
          description: v.str(b.description, "description", { min: 3, max: 2_000 }),
          canonical: { chain: v.chainKey(canonical.chain, "canonical.chain"), address: v.address(canonical.address, "canonical.address") },
        };
        const sse = openSse(req, reply);
        const emit = (e: SpecDraftEvent): void => {
          sse.send({ type: e.type, data: e });
          // Drafts are stored by hash so a later onchain proposal of the same hash can be diffed.
          if (e.type === "draft") {
            const parsed = parseSpec(e.yaml);
            if (parsed.ok) {
              void deps.db
                .query(
                  `insert into specs (spec_hash, token_symbol, yaml, state, source) values ($1, $2, $3, 'draft', 'copilot')
                   on conflict (spec_hash, token_symbol) do update set yaml = coalesce(specs.yaml, excluded.yaml)`,
                  [e.specHash.toLowerCase(), parsed.spec.token, e.yaml],
                )
                .catch((err: unknown) => {
                  console.error("kirchhoff api: could not store draft", err instanceof Error ? err.message : err);
                });
            }
          }
        };
        if (!deps.ai.provider) {
          emit({ type: "error", message: "Spec Copilot is unavailable: no AI provider key is configured on this deployment." });
          sse.end();
          return;
        }
        const controller = new AbortController();
        req.raw.on("close", () => {
          controller.abort();
        });
        await draftSpec(body, { provider: deps.ai.provider.withKind("copilot"), model: deps.ai.model, env: deps.ai.copilotEnv(), emit, signal: controller.signal });
        sse.end();
      });

      r.post<{ Body: unknown }>("/specs/backtest", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req): Promise<BacktestResponse> => {
        await auth.require(req.headers.authorization, "specs:backtest");
        const b = v.object(req.body);
        const yaml = v.str(b.yaml, "yaml", { min: 10, max: 256 * 1024 });
        const fromBlock: Partial<Record<ChainKey, bigint>> = {};
        if (b.fromBlock !== undefined && b.fromBlock !== null) {
          const fb = v.object(b.fromBlock, "fromBlock");
          for (const [k, val] of Object.entries(fb)) fromBlock[v.chainKey(k, "fromBlock key")] = BigInt(v.str(val, `fromBlock.${k}`, { pattern: /^\d{1,20}$/ }));
        }
        try {
          const result = await backtestYaml(yaml, fromBlock, { clients: deps.ai.clients(), defaultLookback: null });
          const token = (await rm.tokenRows())[0];
          return { ...(await rm.meta(token)), ...result };
        } catch (e) {
          if (e instanceof SpecInvalidError) throw new ApiFailure(400, "BAD_REQUEST", e.message);
          throw e;
        }
      });

      r.get<{ Params: { token: string } }>("/tokens/:token/spec-proposals", async (req): Promise<SpecProposalsResponse> => {
        const token = await rm.tokenRow(v.tokenSymbol(req.params.token));
        const home = await rm.homeChain(token);
        const items = await specResolver.proposals(token.symbol, home.chain, (home.issuer_safe ?? "0x0000000000000000000000000000000000000000"));
        return { ...(await rm.meta(token)), token: token.symbol, items };
      });

      r.post<{ Body: unknown }>("/specs/scout", { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } }, async (req, reply) => {
        await auth.require(req.headers.authorization, "specs:draft");
        const token = await rm.tokenRow(v.tokenSymbol(v.object(req.body).token));
        const chains = await rm.chainRows();
        const known = new Set(
          chains.flatMap((c) => [c.token, c.escrow, c.weak_bridge, c.ccip_pool, c.ccip_lockbox, c.ledger, c.quarantine, c.feed, c.guard, c.registry]).filter((a): a is Address => a !== null).map((a) => a.toLowerCase()),
        );
        const sources = deps.ai.scoutSources();
        const runId = randomUUID();
        const startedAt = new Date().toISOString();
        const wantsSse = (req.headers.accept ?? "").includes("text/event-stream");
        const sse = wantsSse ? openSse(req, reply) : null;
        const findings: ScoutProposal[] = [];
        await runTopologyScout({
          symbol: token.symbol,
          name: token.name,
          known,
          sources,
          provider: deps.ai.provider?.withKind("scout") ?? null,
          model: deps.ai.fastModel,
          db: deps.db,
          specChains: token.chains,
          emit: (e) => {
            if (e.type === "finding") findings.push(e.finding);
            sse?.send({ type: e.type, data: e });
          },
        });
        if (sse) {
          sse.end();
          return;
        }
        const res: ScoutResponse = { ...(await rm.meta(token)), runId, startedAt, finishedAt: new Date().toISOString(), proposals: findings };
        return reply.send(res);
      });

      r.get<{ Querystring: Record<string, string | undefined> }>("/specs/proposals", async (req): Promise<ScoutProposalsResponse> => {
        await auth.require(req.headers.authorization, "specs:draft");
        const token = await rm.tokenRow(v.tokenSymbol(req.query.token));
        const rows = await deps.db.query<{ finding: ScoutProposal }>(
          "select notes->'finding' as finding from specs where token_symbol = $1 and source = 'topology_scout' and notes ? 'finding' order by created_at desc limit 200",
          [token.symbol],
        );
        return { ...(await rm.meta(token)), items: rows.rows.map((x) => x.finding) };
      });

      r.post<{ Params: { id: string } }>("/incidents/:id/replay-plan", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req): Promise<ReplayPlanResponse> => {
        const id = v.bytes32(req.params.id, "id");
        const bundle = await incidents.bundle(id);
        const token = await rm.tokenRow(bundle.incident.token);
        const plan = replayPlan(bundle, bundle.tokenStatus, { enforcement: deps.ops.enforcement, aggregatorUrl: deps.aggregatorUrl ?? null });
        return { ...(await rm.meta(token)), ...plan };
      });

      r.get<{ Params: { specHash: string } }>("/specs/:specHash", async (req): Promise<SpecProposalResponse> => {
        const hash = v.bytes32(req.params.specHash, "specHash");
        const s = (
          await deps.db.query<{
            token_symbol: string;
            state: string;
            propose_chain: ChainKey | null;
            propose_tx: string | null;
            propose_block: string | null;
            proposed_at: Date | null;
            activates_at: Date | null;
            activate_tx: string | null;
            activate_block: string | null;
            activated_at: Date | null;
          }>("select * from specs where spec_hash = $1 order by created_at desc limit 1", [hash])
        ).rows[0];
        if (!s) throw notFound(`spec ${hash}`);
        const token = await rm.tokenRow(s.token_symbol);
        const home = await rm.homeChain(token);
        const tx = (h: string | null, block: string | null, at: Date | null): TxRef | null =>
          h ? { chain: home.chain, hash: h as `0x${string}`, block: block ?? "0", timestamp: (at ?? new Date(0)).toISOString() } : null;
        const timelock = s.proposed_at && s.activates_at ? Math.round((s.activates_at.getTime() - s.proposed_at.getTime()) / 1000) : 600;
        return {
          ...(await rm.meta(token)),
          token: s.token_symbol,
          specHash: hash,
          state: s.state === "cancelled" ? "superseded" : (s.state as SpecProposalResponse["state"]),
          proposeTx: tx(s.propose_tx, s.propose_block, s.proposed_at),
          proposedAt: s.proposed_at?.toISOString() ?? null,
          activatesAt: s.activates_at?.toISOString() ?? null,
          timelockSeconds: timelock,
          activateTx: tx(s.activate_tx, s.activate_block, s.activated_at),
          registry: (home.registry ?? "0x0000000000000000000000000000000000000000"),
          issuerSafe: (home.issuer_safe ?? "0x0000000000000000000000000000000000000000"),
        };
      });

      r.post<{ Body: unknown }>("/ask", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
        const b = v.object(req.body);
        const history = Array.isArray(b.history) ? b.history.slice(-10) : [];
        const body: AskRequest = {
          question: v.str(b.question, "question", { min: 2, max: 1_000 }),
          token: b.token === null || b.token === undefined ? null : v.tokenSymbol(b.token),
          history: history.map((h, i) => {
            const o = v.object(h, `history[${i}]`);
            if (o.role !== "user" && o.role !== "assistant") throw new ApiFailure(400, "BAD_REQUEST", `history[${i}].role must be user or assistant`);
            return { role: o.role, content: v.str(o.content, `history[${i}].content`, { max: 4_000 }) };
          }),
        };
        const sse = openSse(req, reply);
        const emit = (e: AskEvent): void => {
          sse.send({ type: e.type, data: e });
        };
        if (!deps.ai.provider) {
          emit({ type: "error", message: "Ask KIRCHHOFF is unavailable: no AI provider key is configured on this deployment." });
          sse.end();
          return;
        }
        const controller = new AbortController();
        req.raw.on("close", () => {
          controller.abort();
        });
        const backend = askBackend(deps.db, async (id) => incidents.bundle(id).catch(() => null));
        await askKirchhoff(body, { provider: deps.ai.provider.withKind("ask"), model: deps.ai.model, backend, emit, signal: controller.signal });
        sse.end();
      });

      r.get("/lab/status", async (): Promise<LabStatusResponse> => {
        const token = (await rm.tokenRows())[0];
        return { ...(await rm.meta(token)), enabled: deps.lab.enabled, disabledReason: deps.lab.disabledReason, run: await deps.lab.latest() };
      });

      r.post("/lab/kelp-replay", { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } }, async (): Promise<LabRunResponse> => {
        const run = deps.lab.start();
        const token = (await rm.tokenRows())[0];
        return { ...(await rm.meta(token)), run };
      });

      r.get<{ Params: { id: string } }>("/lab/runs/:id", async (req): Promise<LabRunResponse> => {
        const id = v.str(req.params.id, "id", { pattern: /^[0-9a-f-]{36}$/ });
        const run = await deps.lab.byId(id);
        if (!run) throw notFound(`lab run ${id}`);
        const token = (await rm.tokenRows())[0];
        return { ...(await rm.meta(token)), run };
      });

      r.get("/ops", async (): Promise<OpsResponse> => {
        const token = (await rm.tokenRows())[0];
        return { ...(await rm.meta(token)), ...(await deps.ops.snapshot()) };
      });

      r.get("/keys", async (req): Promise<ApiKeysResponse> => {
        await auth.require(req.headers.authorization, "keys:manage");
        const token = (await rm.tokenRows())[0];
        return { ...(await rm.meta(token)), items: await auth.list() };
      });

      r.get<{ Querystring: Record<string, string | undefined> }>("/stream/sse", async (req, reply) => {
        const symbol = (await rm.tokenRow(v.tokenSymbol(req.query.token))).symbol;
        const lastHeader = req.headers["last-event-id"];
        const resumeFrom = typeof lastHeader === "string" && /^\d{1,19}$/.test(lastHeader) ? BigInt(lastHeader) : null;
        const sse = openSse(req, reply);
        sse.comment("KIRCHHOFF stream. Mirrors onchain state; never a verdict source.");
        reply.raw.write("retry: 1000\n\n");
        let last = resumeFrom ?? (await mat.latestId());
        if (resumeFrom === null) sse.send({ id: last.toString(), data: { channel: "status", token: symbol, data: await rm.status(symbol) } });
        const deadline = Date.now() + deps.sseMaxMs;
        let lastPing = Date.now();
        while (!sse.closed() && Date.now() < deadline) {
          const batch = await mat.since(last, symbol);
          for (const { id, message } of batch.items) sse.send({ id: id.toString(), data: message });
          last = batch.maxId;
          if (Date.now() - lastPing > 15_000) {
            sse.send({ data: { channel: "ping" } });
            lastPing = Date.now();
          }
          await new Promise((res) => setTimeout(res, 1_000));
        }
        sse.end();
      });

      if (hub) {
        r.get<{ Querystring: Record<string, string | undefined> }>("/stream", { websocket: true }, (socket, req) => {
          let symbol: string;
          try {
            symbol = v.tokenSymbol(req.query.token);
          } catch {
            socket.close(1008, "token query parameter required");
            return;
          }
          const sub = {
            token: symbol,
            cursor: 0n,
            send: (frame: string) => {
              if (socket.readyState === socket.OPEN) socket.send(frame);
            },
          };
          let remove: (() => void) | null = null;
          socket.on("close", () => remove?.());
          socket.on("message", () => {
            // Client to server: none (types.ts). Inbound frames are ignored.
          });
          // Cursor first, then the snapshot: every event after the cursor is delivered, none lost.
          hub
            .latestId()
            .then(async (cursor) => {
              sub.cursor = cursor;
              const data = await rm.status(symbol);
              if (socket.readyState !== socket.OPEN) return;
              socket.send(JSON.stringify({ channel: "status", token: data.token.symbol, data }));
              remove = hub.add(sub);
            })
            .catch(() => {
              socket.close(1008, "unknown token");
            });
        });
      }
    },
    { prefix: "/v1" },
  );

  app.post<{ Body: unknown }>("/internal/verdicts", async (req, reply) => {
    const header = req.headers["x-kirchhoff-internal-key"];
    requireInternalKey(typeof header === "string" ? header : undefined, deps.internalKey);
    const list = Array.isArray(req.body) ? req.body : [req.body];
    if (list.length === 0 || list.length > 100) throw new ApiFailure(400, "BAD_REQUEST", "send 1..100 verdict reports");
    let stored = 0;
    for (const raw of list) {
      try {
        const report = parseVerdictReport(raw);
        await ingestVerdict(deps.db, report, deps.defaultToken);
        stored++;
      } catch (e) {
        if (e instanceof VerdictValidationError) throw new ApiFailure(400, "BAD_REQUEST", e.message);
        throw e;
      }
    }
    return reply.status(202).send({ stored });
  });

  const pager = deps.notifier && deps.websocket ? new IncidentPager(deps.db, incidents, deps.ai, deps.notifier, { linkBase: deps.webPublicUrl ?? null }) : null;
  pager?.start();
  app.addHook("onClose", () => {
    pager?.stop();
    hub?.stop();
    deps.lab.stop();
  });
  hub?.start();
  return app;
}
