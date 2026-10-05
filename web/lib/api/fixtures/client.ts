import type { KirchhoffApi, StreamHandlers } from "@/lib/api/client";
import { ApiError } from "@/lib/api/client";
import type {
  ApiKeysResponse,
  AskEvent,
  AskRequest,
  BacktestResponse,
  Bytes32,
  CopilotTool,
  LineProvenance,
  OpsResponse,
  SpecDraftEvent,
  SpecDraftLine,
  SpecProposalResponse,
} from "@/lib/api/types";
import { FixtureWorld, type FixtureScenario } from "@/lib/api/fixtures/world";
import { fxAddress, fxHash, BlockClock } from "@/lib/api/fixtures/ids";
import { txUrl, addressUrl } from "@/lib/explorer";

const LATENCY_MS = 180;

function delay<T>(value: () => T, signal: AbortSignal | undefined, ms = LATENCY_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const t = setTimeout(() => {
      try {
        resolve(value());
      } catch (e) {
        reject(e);
      }
    }, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}

const never = <T,>(signal: AbortSignal | undefined): Promise<T> =>
  new Promise<T>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));

function notFound(what: string, endpoint: string): ApiError {
  return new ApiError({ code: "NOT_FOUND", message: `${what} not found`, status: 404, endpoint });
}

export function createFixtureClient(world: FixtureWorld): KirchhoffApi {
  const scenario: FixtureScenario = world.scenario;
  const clock = new BlockClock(world.anchorMs);

  function call<T>(endpoint: string, fn: () => T, signal: AbortSignal | undefined): Promise<T> {
    if (scenario === "loading") return never<T>(signal);
    if (scenario === "api-down") {
      return delay(() => {
        throw new ApiError({ code: "NETWORK", message: `KIRCHHOFF API unreachable (${endpoint})`, status: null, endpoint });
      }, signal);
    }
    return delay(fn, signal);
  }

  async function play<E>(events: { at: number; event: E }[], onEvent: (e: E) => void, signal: AbortSignal | undefined): Promise<void> {
    let last = 0;
    for (const { at, event } of events) {
      await delay(() => undefined, signal, at - last);
      last = at;
      onEvent(event);
    }
  }

  return {
    kind: "fixtures",
    baseUrl: "fixtures://local",

    listTokens: (signal) => call("GET /tokens", () => ({ ...world.meta(), items: world.tokenSummaries() }), signal),

    getStatus: (token, signal) =>
      call(`GET /tokens/${token}/status`, () => {
        const s = world.status(token);
        if (!s) throw notFound(`Token ${token}`, `GET /tokens/${token}/status`);
        return s;
      }, signal),

    getEpochs: (token, q = {}, signal) =>
      call(`GET /tokens/${token}/epochs`, () => {
        const items = world.epochs(token, q.since ? Date.parse(q.since) : null, q.limit ?? 100);
        if (!items) throw notFound(`Token ${token}`, `GET /tokens/${token}/epochs`);
        return { ...world.meta(), items, nextCursor: null };
      }, signal),

    getVerdicts: (token, q = {}, signal) =>
      call(`GET /tokens/${token}/verdicts`, () => {
        const items = world.verdicts(token, q.limit ?? 50);
        if (!items) throw notFound(`Token ${token}`, `GET /tokens/${token}/verdicts`);
        return { ...world.meta(), items, nextCursor: null };
      }, signal),

    getIncident: (id, signal) =>
      call(`GET /incidents/${id}`, () => {
        const inc = world.incident(id);
        if (!inc) throw notFound(`Incident ${id}`, `GET /incidents/${id}`);
        return inc;
      }, signal),

    checkTransfer: (body, signal) =>
      call("POST /check-transfer", () => {
        const s = world.status(body.token);
        if (!s) throw notFound(`Token ${body.token}`, "POST /check-transfer");
        const ok = s.token.status === "CONSERVED" || s.token.status === "DRIFT";
        return {
          ...world.meta(),
          wouldPass: ok,
          reason: ok ? "OK" : s.token.status === "QUARANTINED" ? "TOKEN_QUARANTINED" : "TOKEN_BROKEN",
          advice: ok ? "Transfer would pass the Junction Rule at current status." : "Stop. The token is not conserved; the verifier will refuse this transfer.",
          status: s.token.status,
        };
      }, signal),

    draftSpec: async (body, onEvent, signal) => {
      if (scenario === "loading") return never(signal);
      const now = Date.now();
      const iso = (ms: number) => new Date(now + ms).toISOString();
      const home = body.canonical.chain;
      const t = (label: string, chain: Parameters<typeof txUrl>[0] = home) => txUrl(chain, fxHash(`tx:${label}`));
      const arb = "ethereum-testnet-sepolia-arbitrum-1" as const;
      const base = "ethereum-testnet-sepolia-base-1" as const;
      const canonical = body.canonical.address;
      const escrow = fxAddress("kETH:escrow");
      const remoteArb = fxAddress(`kETH:${arb}:token`);
      const remoteBase = fxAddress(`kETH:${base}:token`);
      const pools = { home: fxAddress("kETH:pool:home"), arb: fxAddress("kETH:pool:arb"), base: fxAddress("kETH:pool:base") };
      const tool = (id: string, toolName: CopilotTool, href: string | null, why: string | null = null): LineProvenance => ({ kind: "tool", toolCallId: id, tool: toolName, href, why });
      const schema = (): LineProvenance => ({ kind: "schema", toolCallId: "tc-7", tool: "validate_spec", href: null, why: null });
      const rows: [string, LineProvenance | null][] = [
        ["spec_version: 1", schema()],
        ["token: kETH", tool("tc-1", "get_contract", addressUrl(home, canonical))],
        ["model: lock_release_home", tool("tc-1", "get_contract", addressUrl(home, canonical))],
        ["home:", schema()],
        ["  chain: ethereum-testnet-sepolia", tool("tc-1", "get_contract", addressUrl(home, canonical))],
        [`  canonical: "${canonical}"`, tool("tc-1", "get_contract", addressUrl(home, canonical))],
        [`  escrow: "${escrow}"`, tool("tc-3", "list_ccip_pools", addressUrl(home, escrow))],
        ["remotes:", schema()],
        ["  - chain: ethereum-testnet-sepolia-arbitrum-1", tool("tc-3", "list_ccip_pools", addressUrl(arb, pools.arb))],
        [`    token: "${remoteArb}"`, tool("tc-3", "list_ccip_pools", addressUrl(arb, remoteArb))],
        ["    minters: [ccip_pool_arb, weakbridge_arb]", tool("tc-2", "list_role_grants", t("grant:arb", arb), "Two MINTER_ROLE grants on Arbitrum Sepolia: the CCIP pool and the WeakBridge adapter. Both can create supply, so both are watched.")],
        ["  - chain: ethereum-testnet-sepolia-base-1", tool("tc-3", "list_ccip_pools", addressUrl(base, pools.base))],
        [`    token: "${remoteBase}"`, tool("tc-3", "list_ccip_pools", addressUrl(base, remoteBase))],
        ["    minters: [ccip_pool_base, weakbridge_base]", null],
        ["bridges:", schema()],
        ["  - id: ccip", tool("tc-3", "list_ccip_pools", addressUrl(home, pools.home))],
        ["    kind: ccip_v2", tool("tc-3", "list_ccip_pools", addressUrl(home, pools.home))],
        [`    pools: { home: "${pools.home}", arb: "${pools.arb}", base: "${pools.base}" }`, tool("tc-3", "list_ccip_pools", addressUrl(home, pools.home))],
        ["  - id: weakbridge", tool("tc-4", "sample_events", t("weak:sample"))],
        ["    kind: custom", tool("tc-4", "sample_events", t("weak:sample"))],
        ['    debit_event: "Burned(bytes32 indexed id, address indexed from, address to, uint256 amount, uint64 dstChain)"', tool("tc-4", "sample_events", t("weak:burned", arb))],
        ['    credit_event: "Released(bytes32 indexed id, address indexed to, uint256 amount, uint64 srcChain)"', tool("tc-4", "sample_events", t("weak:released"))],
        ["    search_window_blocks: 50000", schema()],
        ["confidence:", schema()],
        ["  default: finalized", schema()],
        ["rules:", schema()],
        ["  junction: { match_window_seconds: 1200 }", schema()],
        ['  loop: { tolerance_wei: "0", breach_confirmations: 1 }', schema()],
        ["  staleness_seconds: 120", schema()],
        ["  on_stale: fail_closed", schema()],
        ["response:", schema()],
        ["  on_broken: [freeze_ccip_lanes, taint_recipient, flip_feed, page_issuer]", schema()],
        ["  replay_requires: issuer_multisig", schema()],
        ["  recovery_timelock_seconds: 3600", schema()],
      ];
      const lines: SpecDraftLine[] = rows.map(([text, provenance], i) => ({ line: i + 1, text, provenance }));
      const yaml = lines.map((l) => l.text).join("\n");
      const events: { at: number; event: SpecDraftEvent }[] = [
        { at: 300, event: { type: "thinking", text: "Reading the canonical token and its escrow on Ethereum Sepolia." } },
        { at: 500, event: { type: "tool_call", id: "tc-1", tool: "get_contract", input: { chain: home, address: canonical }, at: iso(500) } },
        { at: 1300, event: { type: "tool_result", id: "tc-1", tool: "get_contract", ok: true, summary: "ERC-20 kETH, 18 decimals, verified source, not a proxy", href: addressUrl(home, canonical), durationMs: 640 } },
        { at: 1500, event: { type: "tool_call", id: "tc-2", tool: "list_role_grants", input: { chain: arb, token: remoteArb }, at: iso(1500) } },
        { at: 2400, event: { type: "tool_result", id: "tc-2", tool: "list_role_grants", ok: true, summary: "2 MINTER_ROLE grants: CCIP pool, WeakBridge adapter", href: t("grant:arb", arb), durationMs: 810 } },
        { at: 2600, event: { type: "tool_call", id: "tc-3", tool: "list_ccip_pools", input: { chain: home, token: canonical }, at: iso(2600) } },
        { at: 3300, event: { type: "tool_result", id: "tc-3", tool: "list_ccip_pools", ok: true, summary: "3 pools in the token admin registry (Sepolia, Arbitrum Sepolia, Base Sepolia)", href: addressUrl(home, pools.home), durationMs: 590 } },
        { at: 3500, event: { type: "tool_call", id: "tc-4", tool: "sample_events", input: { chain: home, address: escrow, topic: "Released", n: 5 }, at: iso(3500) } },
        { at: 4300, event: { type: "tool_result", id: "tc-4", tool: "sample_events", ok: true, summary: "5 Released and 5 Burned events decoded; signatures match the WeakBridge ABI", href: t("weak:sample"), durationMs: 720 } },
        { at: 4500, event: { type: "tool_call", id: "tc-5", tool: "list_role_grants", input: { chain: base, token: remoteBase }, at: iso(4500) } },
        { at: 5200, event: { type: "tool_result", id: "tc-5", tool: "list_role_grants", ok: true, summary: "1 MINTER_ROLE grant: CCIP pool", href: t("grant:base", base), durationMs: 630 } },
        { at: 5400, event: { type: "thinking", text: "Drafting the KIRCH-SPEC from tool results." } },
        { at: 6000, event: { type: "draft", yaml, lines, specHash: fxHash("kETH:spec:v2") } },
        { at: 6200, event: { type: "tool_call", id: "tc-7", tool: "validate_spec", input: { yaml_lines: lines.length }, at: iso(6200) } },
        { at: 6700, event: { type: "tool_result", id: "tc-7", tool: "validate_spec", ok: true, summary: "Schema valid. 1 line has no tool evidence.", href: null, durationMs: 120 } },
        { at: 6800, event: { type: "validation", ok: false, errors: [{ line: 14, message: "weakbridge_base has no MINTER_ROLE grant on Base Sepolia (tc-5). Remove it or cite evidence." }] } },
        { at: 6900, event: { type: "done" } },
      ];
      await play(events, onEvent, signal);
    },

    backtestSpec: (body, signal) =>
      call<BacktestResponse>("POST /specs/backtest", () => {
        const now = Date.now();
        const chains = ["ethereum-testnet-sepolia", "ethereum-testnet-sepolia-arbitrum-1", "ethereum-testnet-sepolia-base-1"] as const;
        return {
          ...world.meta(),
          specHash: fxHash(`spec:${body.yaml.length}`),
          ok: true,
          eventsReplayed: 1_842,
          durationMs: 2_310,
          coverage: chains.map((c, i) => ({
            chain: c,
            fromBlock: (clock.blockAt(c, now) - BigInt(400_000 * (i + 1))).toString(),
            toBlock: clock.blockAt(c, now).toString(),
            debits: [412, 388, 121][i] ?? 0,
            credits: [401, 395, 125][i] ?? 0,
            matched: [401, 388, 121][i] ?? 0,
          })),
          breaches: [],
          driftEvents: [],
        };
      }, signal),

    getSpecProposal: (specHash: Bytes32, signal) =>
      call<SpecProposalResponse>(`GET /specs/${specHash}`, () => {
        const proposedAt = world.anchorMs;
        const home = "ethereum-testnet-sepolia" as const;
        return {
          ...world.meta(),
          token: "kETH",
          specHash,
          state: "proposed",
          proposeTx: clock.tx(home, `propose:${specHash}`, proposedAt),
          proposedAt: new Date(proposedAt).toISOString(),
          activatesAt: new Date(proposedAt + 600_000).toISOString(),
          timelockSeconds: 600,
          activateTx: null,
          registry: world.registry(),
          issuerSafe: world.issuerSafe(),
        };
      }, signal),

    ask: async (body: AskRequest, onEvent: (e: AskEvent) => void, signal) => {
      if (scenario === "loading") return never(signal);
      const s = world.status(body.token ?? "kETH");
      const status = s?.token.status ?? "UNKNOWN";
      const v = world.verdicts(body.token ?? "kETH", 1)?.[0];
      const q = body.question.toLowerCase();
      const events: { at: number; event: AskEvent }[] = [{ at: 250, event: { type: "tool", tool: "sql", summary: "SELECT status, delta, epoch_id FROM epochs ORDER BY epoch_id DESC LIMIT 1" } }];
      const homeTx = s?.epoch?.reportTxs[0];
      if (homeTx) events.push({ at: 500, event: { type: "citation", citation: { n: 1, kind: "tx", label: `Epoch ${s?.epoch?.epochId} report on Ethereum Sepolia`, href: txUrl(homeTx.chain, homeTx.hash) } } });
      const answer =
        q.includes("frozen") || q.includes("lane")
          ? status === "QUARANTINED"
            ? "All kETH CCIP lanes are frozen right now. QuarantineController reports isFrozen = true on all three chains since the quarantine report [1]."
            : "No lanes are frozen. QuarantineController reports isFrozen = false for kETH on all three chains at the latest epoch [1]."
          : q.includes("fail") && v
            ? `Message ${v.messageId.slice(0, 10)} was refused with ${v.reason}: the Judge read kETH as ${status} on the destination ledger before signing [1][2].`
            : `kETH is ${status}. The latest epoch on the home ledger reports Δ of ${s ? (BigInt(s.token.delta) / 10n ** 18n).toString() : "unknown"} kETH [1].`;
      if (v && q.includes("fail")) events.push({ at: 650, event: { type: "citation", citation: { n: 2, kind: "tx", label: `Source tx for ${v.messageId.slice(0, 10)}`, href: txUrl(v.sourceTx.chain, v.sourceTx.hash) } } });
      let at = 700;
      for (const word of answer.split(/(?<= )/)) {
        at += 28;
        events.push({ at, event: { type: "text", delta: word } });
      }
      events.push({ at: at + 50, event: { type: "done" } });
      await play(events, onEvent, signal);
    },

    getLabStatus: (signal) =>
      call("GET /lab/status", () => {
        const g = world.labEnabled();
        return { ...world.meta(), enabled: g.enabled, disabledReason: g.reason, run: world.getLabRun() };
      }, signal),

    runKelpReplay: (signal) =>
      call("POST /lab/kelp-replay", () => {
        const g = world.labEnabled();
        if (!g.enabled) throw new ApiError({ code: "LAB_DISABLED", message: g.reason ?? "Lab disabled", status: 409, endpoint: "POST /lab/kelp-replay" });
        return { ...world.meta(), run: world.runKelpReplay() };
      }, signal),

    getLabRun: (id, signal) =>
      call(`GET /lab/runs/${id}`, () => {
        const run = world.getLabRun();
        if (!run || run.id !== id) throw notFound(`Run ${id}`, `GET /lab/runs/${id}`);
        return { ...world.meta(), run };
      }, signal),

    getOps: (signal) =>
      call<OpsResponse>("GET /ops", () => {
        const now = Date.now();
        const iso = (ms: number) => new Date(now - ms).toISOString();
        const chains = ["ethereum-testnet-sepolia", "ethereum-testnet-sepolia-arbitrum-1", "ethereum-testnet-sepolia-base-1"] as const;
        const workflows = ["w2-loop", "w1-junction", "w2-loop", "w3-responder", "w2-loop", "w4-topology", "w2-loop", "w1-junction"] as const;
        return {
          ...world.meta(),
          windowSeconds: 3600,
          enforcement: "ccv_cell",
          sources: { verdicts: "fixtures://local/v1/tokens/kETH/verdicts", metrics: ["fixtures://local/cell-1/metrics"] },
          cells: ["sgp-1", "fra-1", "iad-1", "nrt-1"].map((name, i) => ({
            metricsUrl: `fixtures://local/cell-${i + 1}/metrics`,
            id: `cell-${i + 1}`,
            name: `cell-${i + 1}`,
            region: name,
            healthy: scenario !== "rpc-error" || i !== 2,
            lastHeartbeatAt: iso(2_000 + i * 900),
            version: "judge 0.1.0",
            policyTransitions: 212 - i * 3,
          })),
          judge: { p50Ms: 14, p99Ms: 41, samples: 848 },
          verdictCounts: { pass: 846, fail: 2, byReason: { OK: 846, TOKEN_BROKEN: 1, PENDING_ATTESTATION: 1 } },
          rpc: chains.map((c, i) => ({
            chain: c,
            providers: [
              { name: "Alchemy", healthy: !(scenario === "rpc-error" && i === 2), head: clock.blockAt(c, now).toString(), latencyMs: 38 + i * 11 },
              { name: "PublicNode", healthy: true, head: clock.blockAt(c, now - 1_000).toString(), latencyMs: 61 + i * 7 },
            ],
            agreementRate: scenario === "rpc-error" && i === 2 ? 0.91 : 1,
            lastDisagreementAt: scenario === "rpc-error" && i === 2 ? iso(95_000) : null,
          })),
          creRuns: workflows.map((w, i) => ({
            workflow: w,
            runId: `run_${fxHash(`cre:${i}`).slice(2, 14)}`,
            trigger: w === "w2-loop" || w === "w4-topology" ? "cron" : "log",
            triggeredAt: iso(i * 30_000 + 4_000),
            durationMs: [1840, 960, 1790, 1210, 1870, 2400, 1820, 940][i] ?? 1000,
            outcome: w === "w4-topology" ? "noop" : "ok",
            reportTxs: w === "w4-topology" ? [] : [clock.tx("ethereum-testnet-sepolia", `cre:${i}`, now - i * 30_000)],
          })),
        };
      }, signal),

    getSpecProposals: (token, signal) =>
      call(`GET /tokens/${token}/spec-proposals`, () => ({ ...world.meta(), token, items: world.specProposals(token) }), signal),

    scout: (body, signal) =>
      call("POST /specs/scout", () => {
        const now = new Date().toISOString();
        return { ...world.meta(), runId: `scout_${fxHash(`scout:${body.token}`).slice(2, 10)}`, startedAt: now, finishedAt: now, proposals: world.scoutProposals(body.token) };
      }, signal),

    listScoutProposals: (token, signal) => call(`GET /specs/proposals`, () => ({ ...world.meta(), items: world.scoutProposals(token) }), signal),

    getReplayPlan: (id, signal) =>
      call(`POST /incidents/${id}/replay-plan`, () => {
        const plan = world.replayPlan(id);
        if (!plan) throw notFound(`Incident ${id}`, `POST /incidents/${id}/replay-plan`);
        return plan;
      }, signal),

    listApiKeys: (key, signal) =>
      call<ApiKeysResponse>("GET /keys", () => {
        if (key.trim().length === 0) throw new ApiError({ code: "UNAUTHORIZED", message: "Issuer key required", status: 401, endpoint: "GET /keys" });
        return {
          ...world.meta(),
          items: [
            { id: "key_1", label: "Mission Control", prefix: "kh_live_", scopes: ["specs:draft", "specs:backtest"], createdAt: new Date(world.anchorMs - 86_400_000 * 3).toISOString(), lastUsedAt: new Date(world.anchorMs - 120_000).toISOString() },
            { id: "key_2", label: "CI backtests", prefix: "kh_ci_7f", scopes: ["specs:backtest"], createdAt: new Date(world.anchorMs - 86_400_000 * 9).toISOString(), lastUsedAt: null },
          ],
        };
      }, signal),

    subscribe: (token: string, { onMessage, onState }: StreamHandlers) => {
      if (scenario === "api-down" || scenario === "loading") {
        onState(scenario === "api-down" ? "offline" : "connecting");
        return () => undefined;
      }
      onState("connecting");
      const t = setTimeout(() => onState("live"), 120);
      const off = world.on(token, onMessage);
      return () => {
        clearTimeout(t);
        off();
      };
    },
  };
}
