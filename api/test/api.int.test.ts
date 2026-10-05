import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { keccak256, toHex, type Hex } from "viem";
import { ChainIndexer, bootstrap, createChainClient, createDb, incidentIdOf, migrate, resetSchema, tokenConfigFromSpec, type Db, type IndexerConfig } from "@kirchhoff/indexer";
import { ScriptedProvider } from "@kirchhoff/ai";
import { parseSpec, specHash } from "@kirchhoff/engine/spec";
import { Notifier, type IncidentNotice } from "@kirchhoff/indexer/notifier";
import { IncidentPager } from "../src/pager.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ApiErrorBody,
  ReplayPlanResponse,
  ScoutProposalsResponse,
  ScoutResponse,
  SpecProposalsResponse,
  ApiKeysResponse,
  CheckTransferResponse,
  EpochsResponse,
  IncidentResponse,
  LabStatusResponse,
  OpsResponse,
  StreamMessage,
  TokensResponse,
  TokenStatusResponse,
  VerdictsResponse,
} from "@kirchhoff/sdk";
import { ACCOUNTS, TOKEN_ID, World } from "../../indexer/test/world.ts";
import { AiServices } from "../src/ai.ts";
import { buildApp, type App } from "../src/app.ts";
import { LabRunner } from "../src/lab.ts";
import { chainClients } from "../src/onchain.ts";
import { Ops } from "../src/ops.ts";

const TEST_DB = process.env.API_TEST_DATABASE_URL ?? "postgres://kirchhoff:kirchhoff@127.0.0.1:5434/kirchhoff_api_test";
const HOME = "ethereum-testnet-sepolia" as const;
const ARB = "ethereum-testnet-sepolia-arbitrum-1" as const;
const BASE = "ethereum-testnet-sepolia-base-1" as const;
const ISSUER_KEY = "test-issuer-key-0123456789";
const INTERNAL_KEY = "test-internal-key-0123456789";

let world: World;
let db: Db;
let app: App;
let cfg: IndexerConfig;
let incidentId: Hex;
let loopIncidentId: Hex;
let baseUrl: string;
/** Spec documents served at mocked spec URIs. */
const specDocs = new Map<string, string>();

async function tickAll(): Promise<void> {
  for (const chain of [HOME, ARB, BASE]) {
    await new ChainIndexer(db, cfg, chain, { log: () => undefined }, createChainClient(chain, "local", world.rpc[chain])).tick();
  }
}

beforeAll(async () => {
  world = await World.start(Number(process.env.WORLD_BASE_PORT_API ?? 28645));
  db = createDb(TEST_DB, { max: 6 });
  await resetSchema(db);
  await migrate(db);
  const specYaml = readFileSync(join(import.meta.dirname, "..", "..", "engine", "specs", "kETH.yaml"), "utf8");
  cfg = { mode: "local", symbol: "kETH", deployments: world.deployments, token: tokenConfigFromSpec(specYaml), specYaml, rpc: world.rpc, followTag: "latest", pollMs: 200, maxChunk: 100n, defaultLookback: 1000n };
  await bootstrap(db, cfg, "Kirchhoff ETH");

  // A settled round trip, a conserved epoch, then the Kelp-style forgery, breach and quarantine.
  const amount = 10n * 10n ** 18n;
  const { id } = await world.bridgeSend(HOME, ARB, amount);
  await world.bridgeCredit(ARB, id, ACCOUNTS.user.address, amount, HOME);
  for (const c of [HOME, ARB, BASE]) await world.epoch(c, 1n, 0n, [id]);
  const forged = keccak256(toHex("forged"));
  const stolen = 4n * 10n ** 18n;
  const tx = await world.bridgeCredit(HOME, forged, ACCOUNTS.attacker.address, stolen, ARB);
  const evidenceHash = keccak256(toHex("evidence:kelp"));
  for (const c of [HOME, ARB, BASE]) {
    // Like W1: a Junction breach reports delta 0 (W1 does not compute the Loop Rule).
    await world.breach(c, { epochId: 2n, delta: 0n, evidenceHash, reason: 2, offendingChain: HOME, offendingTx: tx, recipient: ACCOUNTS.attacker.address, amount: stolen, messageId: forged });
  }
  incidentId = incidentIdOf(TOKEN_ID, evidenceHash).toLowerCase() as Hex;
  for (const c of [HOME, ARB, BASE]) await world.quarantine(c, incidentId, [ACCOUNTS.attacker.address]);
  // Like W2 confirming the deficit: a Loop Rule BREACH with no offending credit (zero tx, recipient and message).
  const loopEvidence = keccak256(toHex("evidence:loop"));
  const zero32: Hex = `0x${"0".repeat(64)}`;
  for (const c of [HOME, ARB, BASE]) {
    await world.breach(c, { epochId: 3n, delta: -stolen, evidenceHash: loopEvidence, reason: 6, offendingChain: null, offendingTx: zero32, recipient: "0x0000000000000000000000000000000000000000", amount: stolen, messageId: zero32 });
  }
  loopIncidentId = incidentIdOf(TOKEN_ID, loopEvidence).toLowerCase() as Hex;
  await tickAll();

  const rpc = world.rpc;
  app = await buildApp({
    db,
    ai: new AiServices({ db, ai: { provider: null, model: "none", fastModel: "none" }, mode: "local", rpc, etherscanKey: undefined, narratorWaitMs: 100 }),
    lab: new LabRunner({ enabled: false, disabledReason: "Attack Lab is disabled in tests", command: "true", args: [], cwd: ".", timeoutMs: 1000, token: "kETH", attacker: ACCOUNTS.attacker.address }, db),
    ops: new Ops(db, { rpc, chains: [HOME, ARB, BASE], cells: [{ id: "cell-1", name: "Cell 1", region: "sin", version: "test" }], enforcement: "token_pool_fallback" }),
    clients: chainClients(rpc, "local"),
    issuerKey: ISSUER_KEY,
    internalKey: INTERNAL_KEY,
    defaultToken: "kETH",
    websocket: true,
    sseMaxMs: 1_500,
    corsOrigins: true,
    specFetch: ((url: string | URL) => {
      const body = specDocs.get(String(url));
      return Promise.resolve(new Response(body ?? "not found", { status: body ? 200 : 404 }));
    }) as typeof fetch,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  baseUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
}, 300_000);

afterAll(async () => {
  await app.close();
  await db.end();
  await world.stop();
});

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the expected response type.
const get = async <T>(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> => {
  const res = await app.inject({ method: "GET", url: path, headers });
  return { status: res.statusCode, body: res.json() };
};

function expectMeta(body: { source: string; ledger: { chain: string; address: string }; block: { number: string; timestamp: string }; servedAt: string }): void {
  expect(body.source).toBe("onchain-mirror");
  expect(body.ledger.address).toMatch(/^0x[0-9a-f]{40}$/);
  expect(body.block.number).toMatch(/^\d+$/);
  expect(Date.parse(body.block.timestamp)).not.toBeNaN();
  expect(Date.parse(body.servedAt)).not.toBeNaN();
}

describe("REST read model", () => {
  it("GET /v1/tokens lists kETH with mirrored status", async () => {
    const { status, body } = await get<TokensResponse>("/v1/tokens");
    expect(status).toBe(200);
    expectMeta(body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ symbol: "kETH", tokenId: TOKEN_ID, status: "QUARANTINED", homeChain: HOME, activeIncidentId: incidentId, simulation: true });
  });

  it("GET /v1/tokens/kETH/status returns Loop Rule terms, chains, bridges and lanes", async () => {
    const { status, body } = await get<TokenStatusResponse>("/v1/tokens/kETH/status");
    expect(status).toBe(200);
    expectMeta(body);
    expect(body.chains.map((c) => c.chain).sort()).toEqual([HOME, ARB, BASE].sort());
    const home = body.chains.find((c) => c.role === "home");
    expect(home?.escrow).toBe((6n * 10n ** 18n).toString());
    expect(BigInt(body.backing) - BigInt(body.claims.total)).toBe(-(4n * 10n ** 18n));
    expect(body.claims.remoteSupply).toBe((10n * 10n ** 18n).toString());
    expect(home?.frozen).toBe(true);
    const offending = body.lanes.filter((l) => l.offending);
    expect(offending.map((l) => l.id)).toEqual([`weakbridge:${ARB}->${HOME}`]);
    expect(offending[0]?.recentTransfers[0]).toMatchObject({ state: "forged", debitTx: null });
    expect(body.lanes.find((l) => l.id === `weakbridge:${HOME}->${ARB}`)?.recentTransfers[0]?.state).toBe("settled");
    expect(body.bridges.map((b) => b.label)).toEqual(["CCIP 2.0", "WeakBridge (1-of-1 verifier)"]);
    expect(body.lanes.filter((l) => l.bridgeKind === "ccip_v2").every((l) => l.frozen)).toBe(true);
    expect(body.lanes.filter((l) => l.bridgeKind === "custom").every((l) => !l.frozen)).toBe(true);
  });

  it("GET epochs paginates the home ledger history, newest first", async () => {
    const first = await get<EpochsResponse>("/v1/tokens/kETH/epochs?limit=1");
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0]).toMatchObject({ status: "BROKEN", reason: "LOOP_DEFICIT", delta: (-(4n * 10n ** 18n)).toString() });
    expect(first.body.nextCursor).not.toBeNull();
    const second = await get<EpochsResponse>(`/v1/tokens/kETH/epochs?limit=5&cursor=${first.body.nextCursor ?? ""}`);
    expect(second.body.items[0]).toMatchObject({ status: "BROKEN", reason: "DEBIT_NOT_FOUND", incidentId });
    const conserved = second.body.items.find((e) => e.status === "CONSERVED");
    expect(conserved).toMatchObject({ epochId: "1", delta: "0" });
    expect(conserved?.reportTxs).toHaveLength(3);
  });

  it("ingests Judge verdicts from the internal sink and serves the committee view", async () => {
    const msg = keccak256(toHex("ccip-attacker-transfer"));
    const report = {
      cellId: "cell-1",
      messageId: msg,
      decision: "FAIL",
      reason: "TOKEN_BROKEN",
      note: "attacker transfer to Base Sepolia",
      latencyMs: 42,
      evaluatedAt: new Date().toISOString(),
      srcChain: "16015286601757825753",
      dstChain: BASE,
      amount: "1000",
      sender: `0x${"0".repeat(24)}${ACCOUNTS.attacker.address.slice(2)}`,
      receiver: ACCOUNTS.attacker.address,
    };
    const denied = await app.inject({ method: "POST", url: "/internal/verdicts", payload: report });
    expect(denied.statusCode).toBe(401);
    const bad = await app.inject({ method: "POST", url: "/internal/verdicts", payload: { ...report, messageId: "0x12" }, headers: { "x-kirchhoff-internal-key": INTERNAL_KEY } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/internal/verdicts", payload: report, headers: { "x-kirchhoff-internal-key": INTERNAL_KEY } });
    expect(ok.statusCode).toBe(202);
    const { body } = await get<VerdictsResponse>("/v1/tokens/kETH/verdicts");
    expectMeta(body);
    expect(body.items[0]).toMatchObject({ messageId: msg, decision: "FAIL", reason: "TOKEN_BROKEN", srcChain: HOME, dstChain: BASE, incidentId, executionTx: null });
    expect(body.items[0]?.cells).toEqual([{ cellId: "cell-1", decision: "FAIL", latencyMs: 42 }]);
  });

  it("GET /v1/incidents/{id} returns evidence, containment, blast radius and a cited template narrative", async () => {
    const { status, body } = await get<IncidentResponse>(`/v1/incidents/${incidentId}`);
    expect(status).toBe(200);
    expectMeta(body);
    expect(body.incident).toMatchObject({ id: incidentId, reason: "DEBIT_NOT_FOUND", severity: "SEV1", status: "open" });
    expect(body.incident.offending).toMatchObject({ chain: HOME, bridge: "weakbridge", claimedSrcChain: ARB, amount: (4n * 10n ** 18n).toString() });
    const kinds = body.evidence.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["offending_credit", "debit_search", "breach_report", "quarantine_tx", "refused_message"]));
    expect(body.evidence.find((e) => e.kind === "debit_search")?.blocks?.matches).toBe(0);
    expect(body.actions.find((a) => a.kind === "freeze_ccip_lanes")?.applied).toBe(true);
    expect(body.actions.find((a) => a.kind === "taint_recipient")?.txs).toHaveLength(3);
    expect(body.blastRadius.find((b) => b.chain === HOME)?.exposure).toBe((4n * 10n ** 18n).toString());
    expect(body.heldMessages).toHaveLength(1);
    expect(body.resolution.canResolve).toBe(true);
    const n = body.narrative;
    expect(n?.generator).toBe("template");
    expect(n?.label).toBe("AI summary. Verify against evidence.");
    const ids = new Set(body.evidence.map((e) => e.id));
    for (const s of [...(n?.summary ?? []), ...(n?.timeline ?? [])]) {
      expect(s.citations.length).toBeGreaterThan(0);
      for (const c of s.citations) expect(ids.has(c)).toBe(true);
      expect(s.text).not.toMatch(/[—–]/);
    }
    expect(n?.nextSteps).toContain("rotate_bridge_verifier_key");
  });

  it("regression: Junction incident deltas come from ledger rows (before = last epoch, after = confirming Loop Rule breach)", async () => {
    const { body } = await get<IncidentResponse>(`/v1/incidents/${incidentId}`);
    expect(body.incident.deltaBefore).toBe("0");
    expect(body.incident.deltaAfter).toBe((-(4n * 10n ** 18n)).toString());
    expect(body.narrative?.summary.map((s) => s.text).join(" ")).toContain("Delta moved from 0 to -4 kETH");
  });

  it("regression: a Loop Rule incident has a loop-deficit evidence item and no zero-address credit placeholders", async () => {
    const { status, body } = await get<IncidentResponse>(`/v1/incidents/${loopIncidentId}`);
    expect(status).toBe(200);
    expect(body.incident).toMatchObject({ reason: "LOOP_DEFICIT", deltaAfter: (-(4n * 10n ** 18n)).toString() });
    expect(body.incident.offending).toMatchObject({ bridge: "loop_rule", amount: (4n * 10n ** 18n).toString() });
    expect(BigInt(body.incident.offending.tx.hash)).not.toBe(0n);
    const kinds = body.evidence.map((e) => e.kind);
    expect(kinds).not.toContain("offending_credit");
    expect(kinds).not.toContain("debit_search");
    expect(body.evidence[0]).toMatchObject({ kind: "epoch_report" });
    expect(body.evidence[0]?.label).toMatch(/^Loop Rule: backing below claims by 4 kETH at the pinned blocks \(blocksHash 0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}\), delta -4 kETH$/);
    const text = JSON.stringify([body.evidence.map((e) => e.label), body.narrative?.summary, body.narrative?.timeline]);
    expect(text).not.toMatch(/0x0000|unknown credited/);
  });

  it("regression: incident tokenStatus equals GET /tokens/{t}/status token.status", async () => {
    const [inc, st] = await Promise.all([get<IncidentResponse>(`/v1/incidents/${incidentId}`), get<TokenStatusResponse>("/v1/tokens/kETH/status")]);
    expect(inc.body.tokenStatus).toBe(st.body.token.status);
    expect(inc.body.resolution.canResolve).toBe(st.body.token.status === "QUARANTINED");
  });

  it("returns ApiErrorBody for unknown tokens, incidents and routes", async () => {
    const t = await get<ApiErrorBody>("/v1/tokens/NOPE/status");
    expect(t.status).toBe(404);
    expect(t.body.error.code).toBe("NOT_FOUND");
    const i = await get<ApiErrorBody>(`/v1/incidents/0x${"ab".repeat(32)}`);
    expect(i.status).toBe(404);
    const bad = await get<ApiErrorBody>("/v1/incidents/0x12");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("POST /v1/check-transfer reads current onchain status", () => {
  it("refuses with TOKEN_QUARANTINED and the reading block", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/check-transfer", payload: { token: "kETH", srcChain: ARB, dstChain: BASE, amount: "1", sender: ACCOUNTS.user.address } });
    expect(res.statusCode).toBe(200);
    const body = res.json<CheckTransferResponse>();
    expectMeta(body);
    expect(body).toMatchObject({ wouldPass: false, reason: "TOKEN_QUARANTINED", status: "QUARANTINED" });
    expect(body.ledger.chain).toBe(BASE);
    expect(body.advice).not.toMatch(/[—–]/);
  });

  it("answers UNKNOWN_TOKEN for an unprotected token and validates input", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/check-transfer", payload: { token: "USDX", srcChain: ARB, dstChain: BASE, amount: "1", sender: ACCOUNTS.user.address } });
    expect(res.json<CheckTransferResponse>()).toMatchObject({ wouldPass: false, reason: "UNKNOWN_TOKEN" });
    const bad = await app.inject({ method: "POST", url: "/v1/check-transfer", payload: { token: "kETH", srcChain: ARB, dstChain: ARB, amount: "1e18", sender: "nope" } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("issuer and lab endpoints", () => {
  it("requires the issuer key for /specs/* and /keys, and lists keys by prefix only", async () => {
    expect((await app.inject({ method: "POST", url: "/v1/specs/backtest", payload: { yaml: "x".repeat(20) } })).statusCode).toBe(401);
    const keys = await get<ApiKeysResponse>("/v1/keys", { authorization: `Bearer ${ISSUER_KEY}` });
    expect(keys.status).toBe(200);
    expect(keys.body.items[0]).toMatchObject({ id: "env-issuer", prefix: ISSUER_KEY.slice(0, 8) });
    expect(JSON.stringify(keys.body)).not.toContain(ISSUER_KEY);
  });

  it("backtests a resolved spec against the world's history through the engine", async () => {
    const dep = world.deployments.chains;
    const h = dep[HOME];
    const a = dep[ARB];
    const b = dep[BASE];
    if (!h || !a || !b) throw new Error("world incomplete");
    const yaml = cfg.specYaml
      .replace(/(canonical: )"0x0+"/, `$1"${h.token}"`)
      .replace(/(escrow: )"0x0+"/, `$1"${h.escrow ?? ""}"`)
      .replace(/(alias: arb\n\s+token: )"0x0+"/, `$1"${a.token}"`)
      .replace(/(alias: base\n\s+token: )"0x0+"/, `$1"${b.token}"`)
      .replace(/(contracts:\n\s+home: )"0x0+"(\n\s+arb: )"0x0+"(\n\s+base: )"0x0+"/, `$1"${h.escrow ?? ""}"$2"${a.weakBridge ?? ""}"$3"${b.weakBridge ?? ""}"`);
    const res = await app.inject({ method: "POST", url: "/v1/specs/backtest", payload: { yaml }, headers: { authorization: `Bearer ${ISSUER_KEY}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; breaches: { reason: string }[]; coverage: { chain: string; debits: number; credits: number; matched: number }[] }>();
    // The forged release has no debit: the engine must flag it on real history.
    expect(body.ok).toBe(false);
    expect(body.breaches.map((x) => x.reason)).toContain("DEBIT_NOT_FOUND");
    expect(body.coverage.find((c) => c.chain === ARB)).toMatchObject({ credits: 1, matched: 1 });
  });

  it("lab is disabled with a reason: status says why and POST returns 403 LAB_DISABLED", async () => {
    const s = await get<LabStatusResponse>("/v1/lab/status");
    expect(s.body).toMatchObject({ enabled: false, disabledReason: "Attack Lab is disabled in tests" });
    const res = await app.inject({ method: "POST", url: "/v1/lab/kelp-replay", payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json<ApiErrorBody>().error).toEqual({ code: "LAB_DISABLED", message: "Attack Lab is disabled in tests" });
  });

  it("GET /v1/ops reports judge latency, verdict counts, RPC agreement and CRE runs", async () => {
    const { body } = await get<OpsResponse>("/v1/ops");
    expectMeta(body);
    expect(body.judge.samples).toBe(1);
    expect(body.verdictCounts).toMatchObject({ fail: 1, pass: 0, byReason: { TOKEN_BROKEN: 1 } });
    expect(body.rpc).toHaveLength(3);
    expect(body.creRuns.map((r) => r.workflow)).toEqual(expect.arrayContaining(["w1-junction", "w2-loop", "w3-responder"]));
    expect(body.enforcement).toBe("token_pool_fallback");
  });

  it("POST /v1/ask and /v1/specs/draft stream an error event when no AI key is configured", async () => {
    const ask = await fetch(`${baseUrl}/v1/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "Why did it fail?", token: "kETH", history: [] }) });
    expect(ask.headers.get("content-type")).toContain("text/event-stream");
    expect(await ask.text()).toContain('"type":"error"');
  });
});

describe("live channels", () => {
  it("WS /v1/stream sends status on connect and pushes new outbox events", async () => {
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/v1/stream?token=kETH`);
    const frames: StreamMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (d: Buffer) => {
        frames.push(JSON.parse(d.toString()) as StreamMessage);
        if (frames.length === 1) resolve();
      });
      ws.on("error", reject);
    });
    expect(frames[0]?.channel).toBe("status");
    const ingest = await app.inject({
      method: "POST",
      url: "/internal/verdicts",
      headers: { "x-kirchhoff-internal-key": INTERNAL_KEY },
      payload: { cellId: "cell-2", messageId: keccak256(toHex("m2")), decision: "FAIL", reason: "TOKEN_QUARANTINED", note: "held", latencyMs: 9, srcChain: ARB, dstChain: HOME, amount: "5", sender: ACCOUNTS.user.address, receiver: ACCOUNTS.user.address },
    });
    expect(ingest.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 2_500));
    ws.close();
    expect(frames.some((f) => f.channel === "verdict")).toBe(true);
  });

  it("GET /v1/stream/sse emits an initial status frame with an id and ends for resumption", async () => {
    const res = await fetch(`${baseUrl}/v1/stream/sse?token=kETH`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toMatch(/^: KIRCHHOFF stream/m);
    expect(text).toMatch(/^id: \d+$/m);
    expect(text).toContain('"channel":"status"');
  });
});

describe("narrative from a model, validated", () => {
  it("uses a valid cited model narrative and drops unsupported citations", async () => {
    const res = await get<IncidentResponse>(`/v1/incidents/${incidentId}`);
    const ids = res.body.evidence.map((e) => e.id);
    const provider = new ScriptedProvider([
      {
        content: JSON.stringify({
          summary: [
            { text: "A forged WeakBridge release credited kETH with no debit.", citations: [ids[0], "ev-999"] },
            { text: "BROKEN was written on three chains.", citations: [ids[2]] },
            { text: "Uncited claim.", citations: ["ev-999"] },
          ],
          timeline: [{ text: "Breach recorded.", citations: [ids[2]] }],
          nextSteps: ["rotate_bridge_verifier_key"],
        }),
      },
    ]);
    const { narrateIncident } = await import("@kirchhoff/ai");
    const bundle = await app.kirchhoff.incidents.bundle(incidentId);
    const n = await narrateIncident(bundle, { provider, model: "test-model" });
    expect(n.generator).toBe("model");
    expect(n.summary).toHaveLength(2);
    expect(n.summary[0]?.citations).toEqual([ids[0]]);
    expect(provider.requests[0]?.temperature).toBe(0);
  });
});

describe("MCP served by the API at /mcp", () => {
  it("lists the five tools and dry-runs a transfer against onchain status", async () => {
    const client = new Client({ name: "api-mcp-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)) as unknown as Transport);
    expect((await client.listTools()).tools).toHaveLength(5);
    const r = (await client.callTool({ name: "kirchhoff_check_transfer", arguments: { token: "kETH", src_chain: ARB, dst_chain: BASE, amount: "1", sender: ACCOUNTS.user.address } })) as { structuredContent?: Record<string, unknown> };
    expect(r.structuredContent).toMatchObject({ would_pass: false, reason: "TOKEN_QUARANTINED" });
    const v = (await client.callTool({ name: "kirchhoff_incident", arguments: { incident_id: incidentId } })) as { structuredContent?: { incident: { reason: string } } };
    expect(v.structuredContent?.incident.reason).toBe("DEBIT_NOT_FOUND");
    await client.close();
    expect((await fetch(`${baseUrl}/mcp`)).status).toBe(405);
  });
});

/** A KIRCH-SPEC with this world's real addresses (no placeholders), optionally edited. */
function worldSpecYaml(edit: (y: string) => string = (y) => y): string {
  const dep = world.deployments.chains;
  const h = dep[HOME];
  const a = dep[ARB];
  const b = dep[BASE];
  if (!h || !a || !b) throw new Error("world incomplete");
  let y = cfg.specYaml;
  const fill = (re: RegExp, v: string | null): void => {
    y = y.replace(re, (m) => m.replace(/0x0{40}/, v ?? ""));
  };
  fill(/canonical: "0x0{40}"/, h.token);
  fill(/escrow: "0x0{40}"/, h.escrow);
  fill(/alias: arb\n\s+token: "0x0{40}"/, a.token);
  fill(/alias: base\n\s+token: "0x0{40}"/, b.token);
  y = y.replace(/0x0{40}/g, h.ledger);
  return edit(y);
}

describe("spec proposal diff alert (PRD 14 threat 7)", () => {
  it("diffs a pending registry proposal against the active spec field by field, flagging loosened rules", async () => {
    const reg = world.chains[HOME].dep.registry;
    if (!reg) throw new Error("no registry");
    const activeYaml = worldSpecYaml();
    const pendingYaml = worldSpecYaml((y) => y.replace('tolerance_wei: "0"', 'tolerance_wei: "1000"').replace("on_stale: fail_closed", "on_stale: fail_open").replace("minters: [ccip_pool_base, weakbridge_base]", "minters: [ccip_pool_base, weakbridge_base, weakbridge_arb]"));
    const hashOf = (y: string): `0x${string}` => {
      const p = parseSpec(y);
      if (!p.ok) throw new Error(p.errors.join("; "));
      return specHash(p.spec);
    };
    const activeHash = hashOf(activeYaml);
    const pendingHash = hashOf(pendingYaml);
    // The active spec resolves from a stored draft (by hash); the pending one from its spec URI.
    await db.query("insert into specs (spec_hash, token_symbol, yaml, state, source) values ($1, 'kETH', $2, 'draft', 'copilot')", [activeHash.toLowerCase(), activeYaml]);
    const uri = "https://raw.githubusercontent.com/kirchhoff/specs/pending/kETH.yaml";
    specDocs.set(uri, pendingYaml);
    await world.write(world.chains[HOME], "owner", reg, "proposeSpec", [TOKEN_ID, activeHash, "ipfs://active"]);
    await world.chains[HOME].pub.request({ method: "evm_increaseTime" as never, params: [700] as never });
    await world.chains[HOME].pub.request({ method: "evm_mine" as never, params: [] as never });
    await world.write(world.chains[HOME], "owner", reg, "activateSpec", [TOKEN_ID]);
    await world.write(world.chains[HOME], "owner", reg, "proposeSpec", [TOKEN_ID, pendingHash, uri]);
    await tickAll();
    const { status, body } = await get<SpecProposalsResponse>("/v1/tokens/kETH/spec-proposals");
    expect(status).toBe(200);
    expectMeta(body);
    const pending = body.items.find((p) => p.state === "proposed");
    expect(pending).toMatchObject({ specHash: pendingHash.toLowerCase(), activeSpecHash: activeHash.toLowerCase(), timelockSeconds: 600, proposer: ACCOUNTS.owner.address.toLowerCase() });
    const byPath = new Map(pending?.diff.map((d) => [d.path, d]));
    expect(byPath.get("rules.loop.tolerance_wei")).toMatchObject({ kind: "changed", before: "0", after: "1000", effect: "loosens" });
    expect(byPath.get("rules.on_stale")).toMatchObject({ before: "fail_closed", after: "fail_open", effect: "loosens" });
    expect(byPath.get("remotes[base].minters")).toMatchObject({ effect: "loosens" });
    expect(pending?.diff).toHaveLength(3);
  });

  it("an unverifiable proposal is surfaced as unverified, never as no change", async () => {
    const reg = world.chains[HOME].dep.registry;
    if (!reg) throw new Error("no registry");
    await world.write(world.chains[HOME], "owner", reg, "proposeSpec", [TOKEN_ID, keccak256(toHex("mystery")), "https://evil.example/spec.yaml"]);
    await tickAll();
    const { body } = await get<SpecProposalsResponse>("/v1/tokens/kETH/spec-proposals");
    const p = body.items.find((x) => x.specHash === keccak256(toHex("mystery")));
    expect(p?.diff).toEqual([expect.objectContaining({ path: "spec_document", after: expect.stringMatching(/^unverified: /) as unknown })]);
  });
});

describe("Topology Scout via API", () => {
  it("POST /v1/specs/scout files a same-symbol deployment the spec does not list; GET /v1/specs/proposals lists it", async () => {
    const extra = await world.deployContract(world.chains[BASE], "RemoteKETH", [ACCOUNTS.owner.address]);
    const auth = { authorization: `Bearer ${ISSUER_KEY}` };
    expect((await app.inject({ method: "POST", url: "/v1/specs/scout", payload: { token: "kETH" } })).statusCode).toBe(401);
    const res = await app.inject({ method: "POST", url: "/v1/specs/scout", payload: { token: "kETH" }, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json<ScoutResponse>();
    expectMeta(body);
    const f = body.proposals.find((p) => p.address === extra);
    expect(f).toMatchObject({ kind: "same_symbol", chain: BASE, chainName: "Base Sepolia", confidence: "medium", status: "open", specPatch: null });
    expect(f?.evidence.length).toBeGreaterThan(0);
    expect(body.proposals.some((p) => p.address === world.chains[BASE].dep.token)).toBe(false);
    const list = await get<ScoutProposalsResponse>("/v1/specs/proposals?token=kETH", auth);
    expect(list.body.items.map((i) => i.address)).toContain(extra);
  });
});

describe("held message replay plan", () => {
  it("is not allowed until CONSERVED and, under Fallback B, explains there is no CCIP message to execute", async () => {
    const res = await app.inject({ method: "POST", url: `/v1/incidents/${incidentId}/replay-plan`, payload: {} });
    expect(res.statusCode).toBe(200);
    const plan = res.json<ReplayPlanResponse>();
    expectMeta(plan);
    expect(plan).toMatchObject({ incidentId, allowed: false, tokenStatus: "QUARANTINED", calls: [] });
    expect(plan.reason).toMatch(/CONSERVED again/);
    expect(plan.messages).toHaveLength(2);
    const attacker = plan.messages.find((m) => m.sender === ACCOUNTS.attacker.address.toLowerCase());
    expect(attacker).toMatchObject({ action: "skip" });
    expect(attacker?.note).toMatch(/tainted/);
    const other = plan.messages.find((m) => m.sender !== ACCOUNTS.attacker.address.toLowerCase());
    expect(other).toMatchObject({ action: "skip" });
    expect(other?.note).toMatch(/Fallback B/);
  });
});

describe("incident pager", () => {
  it("pages once with deficit, offending tx link, containment, Incident Room link and narrative", async () => {
    const seen: IncidentNotice[] = [];
    const notifier = new Notifier(db, [{ name: "slack", send: (n) => { seen.push(n); return Promise.resolve(); } }]);
    const pager = new IncidentPager(db, app.kirchhoff.incidents, new AiServices({ db, ai: { provider: null, model: "none", fastModel: "none" }, mode: "local", rpc: world.rpc, etherscanKey: undefined, narratorWaitMs: 50 }), notifier, { linkBase: "https://kirchhoff.test" });
    const paged = await pager.tick();
    expect(paged).toContain(incidentId);
    const n = seen.find((x) => x.incidentId === incidentId);
    expect(n).toMatchObject({ reason: "DEBIT_NOT_FOUND", deficit: (-(4n * 10n ** 18n)).toString(), link: `https://kirchhoff.test/incidents/${incidentId}` });
    expect(n?.offendingTxUrl).toMatch(/^https:\/\/sepolia\.etherscan\.io\/tx\/0x[0-9a-f]{64}$/);
    expect(n?.contained.join(" ")).toMatch(/CCIP lanes frozen on .*tainted on Ethereum Sepolia/);
    expect(n?.summary.length).toBeGreaterThan(20);
    const loop = seen.find((x) => x.incidentId === loopIncidentId);
    expect(loop?.offendingLabel).toMatch(/^Loop Rule BREACH report/);
    expect(await pager.tick()).toEqual([]);
  });
});
