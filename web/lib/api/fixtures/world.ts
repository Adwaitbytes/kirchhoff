/**
 * Deterministic fixture world for development, Playwright and previews.
 * Active only when NEXT_PUBLIC_DATA_SOURCE=fixtures. Never shown on a deployed site as real data:
 * the app renders a persistent "Fixture data" banner and next.config.ts refuses a production build.
 *
 * The world models one lock-and-release token per config with the Loop Rule terms of PRD section 6,
 * runs a quiet CCIP transfer loop, and plays the 7-step Kelp Replay of PRD section 5 Flow B.
 */
import type {
  Address,
  BridgeInfo,
  Bytes32,
  ChainKey,
  ChainReadHealth,
  ChainSupply,
  ContainmentAction,
  EpochPoint,
  EvidenceItem,
  Incident,
  IncidentNarrative,
  IncidentResponse,
  LabConsoleLine,
  LabRun,
  LabStep,
  LabStepKey,
  Lane,
  LaneTransfer,
  MirrorMeta,
  ReasonCode,
  StreamMessage,
  TokenStatus,
  TokenStatusResponse,
  TokenSummary,
  TxRef,
  Verdict,
} from "@/lib/api/types";
import { LAB_STEP_ORDER } from "@/lib/api/types";
import { CHAINS } from "@/lib/chains";
import { BlockClock, fxAddress, fxHash, incidentIdOf, tokenIdOf } from "@/lib/api/fixtures/ids";

export type FixtureScenario =
  | "live"
  | "broken"
  | "breach"
  | "recovering"
  | "drift"
  | "stale"
  | "rpc-error"
  | "api-down"
  | "empty"
  | "loading"
  | "lab-disabled";

export const FIXTURE_SCENARIOS: readonly FixtureScenario[] = [
  "live",
  "broken",
  "breach",
  "recovering",
  "drift",
  "stale",
  "rpc-error",
  "api-down",
  "empty",
  "loading",
  "lab-disabled",
];

export function isFixtureScenario(v: string | null): v is FixtureScenario {
  return v !== null && (FIXTURE_SCENARIOS as readonly string[]).includes(v);
}

const HOME: ChainKey = "ethereum-testnet-sepolia";
const ARB: ChainKey = "ethereum-testnet-sepolia-arbitrum-1";
const BASE: ChainKey = "ethereum-testnet-sepolia-base-1";

const E18 = 10n ** 18n;
const u = (n: number): bigint => BigInt(Math.round(n * 1000)) * E18 / 1000n;

const FORGED_AMOUNT = u(116_500);
const STALENESS_SECONDS = 120;
const EPOCH_MS = 30_000;
const TRANSFER_EVERY_MS = 9_000;
const SETTLE_AFTER_MS = 2_400;

/** Kelp Replay step timings (ms from run start). */
const LAB_TIMELINE: Record<LabStepKey, readonly [number, number]> = {
  forge_release: [0, 2_600],
  junction_search: [2_600, 4_400],
  breach_written: [4_400, 6_200],
  quarantine_applied: [6_200, 7_800],
  ccip_refused: [9_000, 12_400],
  guard_and_lending: [13_200, 16_000],
  loop_confirmed: [16_800, 19_000],
};

interface TokenConfig {
  symbol: string;
  name: string;
  decimals: number;
  remotes: readonly ChainKey[];
  canonicalSupply: bigint;
  escrow: bigint;
  supply: Readonly<Partial<Record<ChainKey, bigint>>>;
  bridges: readonly BridgeInfo[];
  /** Unordered chain pairs per bridge; each yields two directional lanes. */
  links: readonly { bridge: string; a: ChainKey; b: ChainKey }[];
  amounts: readonly number[];
}

const contractsFor = (symbol: string, chain: ChainKey) => ({
  token: fxAddress(`${symbol}:${chain}:token`),
  ledger: fxAddress(`ledger:${chain}`),
  feed: fxAddress(`${symbol}:${chain}:feed`),
  quarantineController: fxAddress(`quarantine:${chain}`),
  escrow: chain === HOME ? fxAddress(`${symbol}:escrow`) : null,
  guard: chain === HOME ? fxAddress(`${symbol}:guard`) : null,
});

const TOKENS: readonly TokenConfig[] = [
  {
    symbol: "kETH",
    name: "Kirchhoff Demo ETH",
    decimals: 18,
    remotes: [ARB, BASE],
    canonicalSupply: u(1_000_000),
    escrow: u(250_000),
    supply: { [ARB]: u(180_000), [BASE]: u(70_000) },
    bridges: [
      {
        id: "ccip",
        kind: "ccip_v2",
        label: "CCIP 2.0",
        contracts: { [HOME]: fxAddress("kETH:pool:home"), [ARB]: fxAddress("kETH:pool:arb"), [BASE]: fxAddress("kETH:pool:base") },
      },
      {
        id: "weakbridge",
        kind: "custom",
        label: "WeakBridge (1-of-1 verifier)",
        contracts: { [HOME]: fxAddress("kETH:escrow"), [ARB]: fxAddress("kETH:weakbridge:arb") },
      },
    ],
    links: [
      { bridge: "ccip", a: HOME, b: ARB },
      { bridge: "weakbridge", a: HOME, b: ARB },
      { bridge: "ccip", a: HOME, b: BASE },
      { bridge: "ccip", a: ARB, b: BASE },
    ],
    amounts: [10, 2.5, 48, 120, 7.25, 315, 64, 18.5, 900, 33],
  },
  {
    symbol: "kBTC",
    name: "Kirchhoff Demo BTC",
    decimals: 18,
    remotes: [ARB, BASE],
    canonicalSupply: u(21_000),
    escrow: u(2_400),
    supply: { [ARB]: u(1_500), [BASE]: u(900) },
    bridges: [
      {
        id: "ccip",
        kind: "ccip_v2",
        label: "CCIP 2.0",
        contracts: { [HOME]: fxAddress("kBTC:pool:home"), [ARB]: fxAddress("kBTC:pool:arb"), [BASE]: fxAddress("kBTC:pool:base") },
      },
    ],
    links: [
      { bridge: "ccip", a: HOME, b: ARB },
      { bridge: "ccip", a: HOME, b: BASE },
      { bridge: "ccip", a: ARB, b: BASE },
    ],
    amounts: [0.5, 1.25, 0.1, 3, 0.75],
  },
];

interface ChainLive {
  escrow: bigint | null;
  supply: bigint;
  inFlightOut: bigint;
  inFlightIn: bigint;
  read: ChainReadHealth;
}

interface TokenState {
  cfg: TokenConfig;
  tokenId: Bytes32;
  status: TokenStatus;
  reason: ReasonCode;
  epochId: bigint;
  updatedAtMs: number;
  stale: boolean;
  chains: Record<ChainKey, ChainLive>;
  transfers: (LaneTransfer & { laneId: string })[];
  verdicts: Verdict[];
  epochs: EpochPoint[];
  frozen: boolean;
  offendingLaneId: string | null;
  activeIncidentId: Bytes32 | null;
  transferSeq: number;
}

interface IncidentState {
  incident: Incident;
  evidence: EvidenceItem[];
  actions: ContainmentAction[];
  refused: Verdict[];
  narrative: IncidentNarrative | null;
  tainted: Address[];
}

type Listener = (msg: StreamMessage) => void;

const ATTACKER = fxAddress("attacker");
const ISSUER_SAFE = fxAddress("issuer-safe");
const REGISTRY = fxAddress("registry");
const USERS = [fxAddress("user:ana"), fxAddress("user:ravi"), fxAddress("user:mei"), fxAddress("user:jon")];

function laneId(bridge: string, src: ChainKey, dst: ChainKey): string {
  return `${bridge}:${src}->${dst}`;
}

export class FixtureWorld {
  readonly scenario: FixtureScenario;
  readonly anchorMs: number;
  private readonly clock: BlockClock;
  private readonly tokens = new Map<string, TokenState>();
  private readonly incidents = new Map<Bytes32, IncidentState>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private intervals: ReturnType<typeof setInterval>[] = [];
  private labRun: LabRun | null = null;
  private started = false;

  constructor(scenario: FixtureScenario, now: number = Date.now()) {
    this.scenario = scenario;
    this.anchorMs = now;
    this.clock = new BlockClock(now);
    this.seed();
  }

  /* ------------------------------------------------------------------ lifecycle */

  private seed(): void {
    this.tokens.clear();
    this.incidents.clear();
    this.labRun = null;
    if (this.scenario === "empty") return;
    for (const cfg of TOKENS) this.tokens.set(cfg.symbol, this.seedToken(cfg));
    const keth = this.tokens.get("kETH");
    if (!keth) return;
    switch (this.scenario) {
      case "broken":
        this.applyForgery(keth, this.anchorMs - 40_000);
        this.applyBreach(keth, this.anchorMs - 36_000);
        break;
      case "breach":
        this.fastForwardLab(keth, this.anchorMs - 60_000);
        break;
      case "recovering": {
        this.fastForwardLab(keth, this.anchorMs - 30 * 60_000);
        keth.status = "RECOVERING";
        keth.reason = "TOKEN_RECOVERING";
        const inc = keth.activeIncidentId ? this.incidents.get(keth.activeIncidentId) : undefined;
        if (inc) {
          inc.incident.status = "recovering";
          inc.incident.resolvedAt = new Date(this.anchorMs - 10 * 60_000).toISOString();
          inc.incident.recoveryEndsAt = new Date(this.anchorMs + 50 * 60_000).toISOString();
        }
        break;
      }
      case "drift":
        keth.status = "DRIFT";
        keth.reason = "FLOW_LIMIT";
        break;
      case "stale":
        keth.updatedAtMs = this.anchorMs - 134_000;
        keth.stale = true;
        keth.status = "UNKNOWN";
        keth.reason = "STATUS_STALE";
        break;
      case "rpc-error":
        keth.chains[BASE].read = {
          ok: false,
          error: "RPC timeout after 2s on 2 of 2 providers",
          lastGoodBlock: {
            chain: BASE,
            number: this.clock.blockAt(BASE, this.anchorMs - 95_000).toString(),
            timestamp: new Date(this.anchorMs - 95_000).toISOString(),
          },
          since: new Date(this.anchorMs - 95_000).toISOString(),
        };
        break;
      default:
        break;
    }
  }

  private seedToken(cfg: TokenConfig): TokenState {
    const chains = {} as Record<ChainKey, ChainLive>;
    chains[HOME] = { escrow: cfg.escrow, supply: cfg.canonicalSupply - cfg.escrow, inFlightOut: 0n, inFlightIn: 0n, read: { ok: true } };
    for (const r of cfg.remotes) chains[r] = { escrow: null, supply: cfg.supply[r] ?? 0n, inFlightOut: 0n, inFlightIn: 0n, read: { ok: true } };
    const s: TokenState = {
      cfg,
      tokenId: tokenIdOf(cfg.symbol),
      status: "CONSERVED",
      reason: "OK",
      epochId: 4_000n,
      updatedAtMs: this.anchorMs - 6_000,
      stale: false,
      chains,
      transfers: [],
      verdicts: [],
      epochs: [],
      frozen: false,
      offendingLaneId: null,
      activeIncidentId: null,
      transferSeq: 0,
    };
    // 24h of epoch history at 5 minute resolution, then the latest epoch 6s ago.
    const start = this.anchorMs - 24 * 3_600_000;
    for (let t = start; t < this.anchorMs - 6_000; t += 300_000) s.epochs.push(this.makeEpoch(s, t, 0n, "CONSERVED", "OK"));
    s.epochs.push(this.makeEpoch(s, this.anchorMs - 6_000, 0n, "CONSERVED", "OK"));
    // Two hours of settled transfers, one every 6 minutes.
    const lanes = this.laneList(cfg).filter((l) => !(l.bridge === "weakbridge" && l.srcChain !== HOME));
    for (let i = 20; i >= 1; i -= 1) {
      const lane = lanes[i % lanes.length];
      if (!lane) continue;
      const at = this.anchorMs - i * 360_000;
      const t = this.makeTransfer(s, lane.bridge, lane.srcChain, lane.dstChain, at);
      t.state = "settled";
      t.creditTx = this.clock.tx(lane.dstChain, `${cfg.symbol}:credit:${t.messageId}`, at + SETTLE_AFTER_MS);
      s.transfers.unshift(t);
      if (lane.bridge === "ccip") s.verdicts.unshift(this.makeVerdict(s, t, at + 1_800, "PASS", "OK", "settled"));
    }
    return s;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.scenario === "stale" || this.scenario === "empty" || this.scenario === "loading" || this.scenario === "api-down") return;
    this.intervals.push(setInterval(() => this.tickTransfers(), TRANSFER_EVERY_MS));
    this.intervals.push(setInterval(() => this.tickEpochs(), EPOCH_MS));
    this.timers.push(setTimeout(() => this.tickTransfers(), 2_000));
  }

  stop(): void {
    this.timers.forEach(clearTimeout);
    this.intervals.forEach(clearInterval);
    this.timers = [];
    this.intervals = [];
    this.started = false;
  }

  reset(): void {
    this.stop();
    this.seed();
    for (const symbol of this.tokens.keys()) this.emitStatus(symbol);
    this.start();
  }

  on(token: string, listener: Listener): () => void {
    const set = this.listeners.get(token) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(token, set);
    return () => set.delete(listener);
  }

  private emit(token: string, msg: StreamMessage): void {
    this.listeners.get(token)?.forEach((l) => l(msg));
  }

  private emitStatus(symbol: string): void {
    const status = this.status(symbol);
    if (status) this.emit(symbol, { channel: "status", token: symbol, data: status });
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  /* ------------------------------------------------------------------ builders */

  meta(chain: ChainKey = HOME): MirrorMeta {
    const now = Date.now();
    return {
      source: "onchain-mirror",
      ledger: { chain, address: fxAddress(`ledger:${chain}`) },
      block: { chain, number: this.clock.blockAt(chain, now).toString(), timestamp: new Date(now).toISOString() },
      servedAt: new Date(now).toISOString(),
    };
  }

  private laneList(cfg: TokenConfig): { id: string; bridge: string; srcChain: ChainKey; dstChain: ChainKey }[] {
    return cfg.links.flatMap((l) => [
      { id: laneId(l.bridge, l.a, l.b), bridge: l.bridge, srcChain: l.a, dstChain: l.b },
      { id: laneId(l.bridge, l.b, l.a), bridge: l.bridge, srcChain: l.b, dstChain: l.a },
    ]);
  }

  private chainsOf(s: TokenState): ChainKey[] {
    return [HOME, ...s.cfg.remotes];
  }

  private delta(s: TokenState): bigint {
    const backing = s.chains[HOME].escrow ?? 0n;
    let claims = 0n;
    for (const c of this.chainsOf(s)) {
      const ch = s.chains[c];
      if (c !== HOME) claims += ch.supply;
      claims += ch.inFlightOut + ch.inFlightIn;
    }
    return backing - claims;
  }

  private makeEpoch(s: TokenState, at: number, delta: bigint, status: TokenStatus, reason: ReasonCode, incidentId: Bytes32 | null = null): EpochPoint {
    const id = (s.epochId + BigInt(s.epochs.length)).toString();
    return {
      epochId: id,
      evaluatedAt: new Date(at).toISOString(),
      blocksHash: fxHash(`${s.cfg.symbol}:blocks:${id}`),
      evidenceHash: fxHash(`${s.cfg.symbol}:evidence:${id}`),
      reportTxs: this.chainsOf(s).map((c) => this.clock.tx(c, `${s.cfg.symbol}:epoch:${id}:${c}`, at)),
      delta: delta.toString(),
      status,
      reason,
      incidentId,
    };
  }

  private makeTransfer(s: TokenState, bridge: string, src: ChainKey, dst: ChainKey, at: number): LaneTransfer & { laneId: string } {
    s.transferSeq += 1;
    const seq = s.transferSeq;
    const amount = u(s.cfg.amounts[seq % s.cfg.amounts.length] ?? 1);
    const messageId = fxHash(`${s.cfg.symbol}:msg:${bridge}:${seq}:${at}`);
    const user = USERS[seq % USERS.length] ?? USERS[0]!;
    return {
      laneId: laneId(bridge, src, dst),
      messageId,
      bridge,
      srcChain: src,
      dstChain: dst,
      amount: amount.toString(),
      sender: user,
      recipient: user,
      debitTx: this.clock.tx(src, `${s.cfg.symbol}:debit:${messageId}`, at),
      creditTx: null,
      state: "in_flight",
      ccipMessageId: bridge === "ccip" ? messageId : null,
    };
  }

  private makeVerdict(s: TokenState, t: LaneTransfer, at: number, decision: "PASS" | "FAIL", reason: ReasonCode, note: string): Verdict {
    const cells = ["cell-1", "cell-2", "cell-3", "cell-4"].map((cellId, i) => ({ cellId, decision, latencyMs: 9 + ((t.messageId.charCodeAt(4 + i) * 7) % 23) }));
    return {
      id: `${t.messageId}`,
      messageId: t.messageId,
      evaluatedAt: new Date(at).toISOString(),
      bridge: "ccip",
      srcChain: t.srcChain,
      dstChain: t.dstChain,
      amount: t.amount,
      sender: t.sender ?? ATTACKER,
      receiver: t.recipient ?? ATTACKER,
      decision,
      reason,
      note,
      cells,
      sourceTx: t.debitTx ?? this.clock.tx(t.srcChain, `${s.cfg.symbol}:src:${t.messageId}`, at),
      executionTx: decision === "PASS" ? this.clock.tx(t.dstChain, `${s.cfg.symbol}:exec:${t.messageId}`, at + 600) : null,
      incidentId: decision === "FAIL" ? s.activeIncidentId : null,
    };
  }

  /* ------------------------------------------------------------------ live loop */

  private tickTransfers(): void {
    for (const s of this.tokens.values()) {
      if (s.status !== "CONSERVED" && s.status !== "DRIFT") continue;
      if (s.cfg.symbol !== "kETH" && s.transferSeq % 3 !== 0) {
        s.transferSeq += 1;
        continue;
      }
      const lanes = this.laneList(s.cfg).filter((l) => l.bridge === "ccip");
      const lane = lanes[s.transferSeq % lanes.length];
      if (!lane) continue;
      const now = Date.now();
      const t = this.makeTransfer(s, lane.bridge, lane.srcChain, lane.dstChain, now);
      const amount = BigInt(t.amount);
      this.debit(s, lane.srcChain, amount);
      this.inflight(s, lane.srcChain, lane.dstChain, amount);
      s.transfers.unshift(t);
      this.emit(s.cfg.symbol, { channel: "transfer", token: s.cfg.symbol, data: t });
      this.emitStatus(s.cfg.symbol);
      this.later(SETTLE_AFTER_MS, () => {
        if (s.status !== "CONSERVED" && s.status !== "DRIFT") return;
        const at = Date.now();
        this.inflight(s, lane.srcChain, lane.dstChain, -amount);
        this.credit(s, lane.dstChain, amount);
        t.state = "settled";
        t.creditTx = this.clock.tx(lane.dstChain, `${s.cfg.symbol}:credit:${t.messageId}`, at);
        const v = this.makeVerdict(s, t, at - 600, "PASS", "OK", `${CHAINS[lane.srcChain].short} to ${CHAINS[lane.dstChain].short}`);
        s.verdicts.unshift(v);
        this.emit(s.cfg.symbol, { channel: "verdict", token: s.cfg.symbol, data: v });
        this.emit(s.cfg.symbol, { channel: "transfer", token: s.cfg.symbol, data: { ...t } });
        this.emitStatus(s.cfg.symbol);
      });
    }
  }

  private tickEpochs(): void {
    const now = Date.now();
    for (const s of this.tokens.values()) {
      // EPOCH reports are ignored onchain while BROKEN, QUARANTINED or RECOVERING (docs/INTERFACES.md).
      if (s.status !== "CONSERVED" && s.status !== "DRIFT") continue;
      const e = this.makeEpoch(s, now, this.delta(s), s.status, s.reason);
      s.epochs.push(e);
      s.updatedAtMs = now;
      this.emit(s.cfg.symbol, { channel: "epoch", token: s.cfg.symbol, data: e });
      this.emitStatus(s.cfg.symbol);
    }
  }

  private debit(s: TokenState, chain: ChainKey, amount: bigint): void {
    const c = s.chains[chain];
    if (chain === HOME) {
      c.escrow = (c.escrow ?? 0n) + amount;
      c.supply -= amount;
    } else c.supply -= amount;
  }

  private credit(s: TokenState, chain: ChainKey, amount: bigint): void {
    const c = s.chains[chain];
    if (chain === HOME) {
      c.escrow = (c.escrow ?? 0n) - amount;
      c.supply += amount;
    } else c.supply += amount;
  }

  private inflight(s: TokenState, src: ChainKey, dst: ChainKey, amount: bigint): void {
    // Home lock not yet minted is F_out on home; remote burn not yet released is F_in on home.
    if (src === HOME) s.chains[HOME].inFlightOut += amount;
    else if (dst === HOME) s.chains[HOME].inFlightIn += amount;
    else s.chains[src].inFlightOut += amount;
  }

  /* ------------------------------------------------------------------ Kelp Replay */

  private applyForgery(s: TokenState, at: number): TxRef {
    const release = this.clock.tx(HOME, "kelp:release", at);
    const home = s.chains[HOME];
    home.escrow = (home.escrow ?? 0n) - FORGED_AMOUNT;
    home.supply += FORGED_AMOUNT;
    const messageId = fxHash("kelp:forged-message");
    s.offendingLaneId = laneId("weakbridge", ARB, HOME);
    s.transfers.unshift({
      laneId: s.offendingLaneId,
      messageId,
      bridge: "weakbridge",
      srcChain: ARB,
      dstChain: HOME,
      amount: FORGED_AMOUNT.toString(),
      sender: null,
      recipient: ATTACKER,
      debitTx: null,
      creditTx: release,
      state: "forged",
      ccipMessageId: null,
    });
    return release;
  }

  private evidenceBase(s: TokenState, releaseAt: number, breachAt: number): IncidentState {
    const evidenceHash = fxHash("kelp:evidence-bundle");
    const id = incidentIdOf(s.tokenId, evidenceHash);
    const release = this.clock.tx(HOME, "kelp:release", releaseAt);
    const evidence: EvidenceItem[] = [
      {
        id: "ev-1",
        kind: "offending_credit",
        chain: HOME,
        at: release.timestamp,
        label: "WeakBridge Released 116,500 kETH to the attacker, claimed source Arbitrum Sepolia",
        tx: release,
        blocks: null,
        messageId: fxHash("kelp:forged-message"),
      },
      ...s.cfg.remotes.map((c, i): EvidenceItem => {
        const to = this.clock.blockAt(c, releaseAt);
        return {
          id: `ev-${2 + i}`,
          kind: "debit_search",
          chain: c,
          at: new Date(releaseAt + 900 + i * 300).toISOString(),
          label: `No matching Burned debit on ${CHAINS[c].name}`,
          tx: null,
          blocks: { from: (to - 50_000n).toString(), to: to.toString(), matches: 0 },
          messageId: fxHash("kelp:forged-message"),
        };
      }),
      ...this.chainsOf(s).map((c, i): EvidenceItem => ({
        id: `ev-${4 + i}`,
        kind: "breach_report",
        chain: c,
        at: new Date(breachAt).toISOString(),
        label: `BREACH report DEBIT_NOT_FOUND recorded on ${CHAINS[c].name}`,
        tx: this.clock.tx(c, `kelp:breach:${c}`, breachAt),
        blocks: null,
        messageId: null,
      })),
    ];
    const incident: Incident = {
      id,
      token: s.cfg.symbol,
      tokenId: s.tokenId,
      severity: "SEV1",
      status: "open",
      reason: "DEBIT_NOT_FOUND",
      deltaBefore: "0",
      deltaAfter: (-FORGED_AMOUNT).toString(),
      offending: {
        chain: HOME,
        tx: release,
        bridge: "weakbridge",
        recipient: ATTACKER,
        amount: FORGED_AMOUNT.toString(),
        messageId: fxHash("kelp:forged-message"),
        claimedSrcChain: ARB,
      },
      offendingBlockAt: release.timestamp,
      brokenAt: new Date(breachAt).toISOString(),
      timeToBrokenSeconds: Math.round((breachAt - releaseAt) / 100) / 10,
      evidenceHash,
      openedAt: new Date(breachAt).toISOString(),
      resolvedAt: null,
      recoveryEndsAt: null,
    };
    const actions: ContainmentAction[] = [
      { kind: "flip_feed", applied: true, txs: evidence.filter((e) => e.kind === "breach_report" && e.tx).map((e) => e.tx as TxRef), appliedAt: incident.brokenAt },
      { kind: "freeze_ccip_lanes", applied: false, txs: [], appliedAt: null },
      { kind: "taint_recipient", applied: false, txs: [], appliedAt: null },
      { kind: "page_issuer", applied: false, txs: [], appliedAt: null },
    ];
    return { incident, evidence, actions, refused: [], narrative: null, tainted: [] };
  }

  private applyBreach(s: TokenState, at: number): IncidentState {
    const releaseAt = Date.parse(s.transfers[0]?.creditTx?.timestamp ?? new Date(at).toISOString());
    const inc = this.evidenceBase(s, releaseAt, at);
    this.incidents.set(inc.incident.id, inc);
    s.activeIncidentId = inc.incident.id;
    s.status = "BROKEN";
    s.reason = "DEBIT_NOT_FOUND";
    s.updatedAtMs = at;
    s.epochs.push(this.makeEpoch(s, at, this.delta(s), "BROKEN", "DEBIT_NOT_FOUND", inc.incident.id));
    return inc;
  }

  private applyQuarantine(s: TokenState, inc: IncidentState, at: number): void {
    s.status = "QUARANTINED";
    s.reason = "TOKEN_QUARANTINED";
    s.frozen = true;
    s.updatedAtMs = at;
    inc.tainted = [ATTACKER];
    const qtxs = this.chainsOf(s).map((c) => this.clock.tx(c, `kelp:quarantine:${c}`, at));
    qtxs.forEach((tx, i) =>
      inc.evidence.push({
        id: `ev-${7 + i}`,
        kind: "quarantine_tx",
        chain: tx.chain,
        at: tx.timestamp,
        label: `QUARANTINE_APPLIED: CCIP lanes frozen, attacker tainted on ${CHAINS[tx.chain].name}`,
        tx,
        blocks: null,
        messageId: null,
      }),
    );
    inc.actions = inc.actions.map((a) =>
      a.kind === "flip_feed" ? a : { ...a, applied: true, txs: a.kind === "page_issuer" ? [] : qtxs, appliedAt: new Date(at).toISOString() },
    );
    inc.narrative = this.narrative(inc, at + 1_200);
  }

  private applyRefusal(s: TokenState, inc: IncidentState, at: number): Verdict {
    const messageId = fxHash("kelp:ccip-escape");
    const t: LaneTransfer & { laneId: string } = {
      laneId: laneId("ccip", HOME, BASE),
      messageId,
      bridge: "ccip",
      srcChain: HOME,
      dstChain: BASE,
      amount: u(116_500).toString(),
      sender: ATTACKER,
      recipient: ATTACKER,
      debitTx: this.clock.tx(HOME, "kelp:ccip-send", at - 2_000),
      creditTx: null,
      state: "refused",
      ccipMessageId: messageId,
    };
    s.transfers.unshift(t);
    const v = this.makeVerdict(s, t, at, "FAIL", "TOKEN_BROKEN", "attacker transfer to Base Sepolia");
    s.verdicts.unshift(v);
    inc.refused.unshift(v);
    inc.evidence.push({
      id: "ev-10",
      kind: "refused_message",
      chain: HOME,
      at: v.evaluatedAt,
      label: "CCIP message to Base Sepolia refused: Judge FAIL TOKEN_BROKEN on 4 of 4 cells",
      tx: v.sourceTx,
      blocks: null,
      messageId,
    });
    return v;
  }

  private applyGuard(inc: IncidentState, at: number): void {
    inc.evidence.push({
      id: "ev-11",
      kind: "guard_revert",
      chain: HOME,
      at: new Date(at).toISOString(),
      label: "kETH transfer from the tainted attacker reverted in KirchhoffGuard; DemoLendingMarket.borrow reverted CollateralBroken()",
      tx: this.clock.tx(HOME, "kelp:guard-revert", at),
      blocks: null,
      messageId: null,
    });
  }

  private applyLoop(s: TokenState, inc: IncidentState, at: number): void {
    const e = this.makeEpoch(s, at, this.delta(s), s.status, "LOOP_DEFICIT", inc.incident.id);
    s.epochs.push(e);
    s.updatedAtMs = at;
    inc.evidence.push({
      id: "ev-12",
      kind: "epoch_report",
      chain: HOME,
      at: e.evaluatedAt,
      label: "W2 epoch confirms the Loop Rule deficit: Δ = −116,500 kETH (LOOP_DEFICIT)",
      tx: e.reportTxs[0] ?? null,
      blocks: null,
      messageId: null,
    });
  }

  private narrative(inc: IncidentState, at: number): IncidentNarrative {
    return {
      model: "fixture narrator",
      generatedAt: new Date(at).toISOString(),
      label: "AI summary. Verify against evidence.",
      generator: "template",
      summary: [
        { text: "A WeakBridge message released 116,500 kETH from the home escrow on Ethereum Sepolia to a single address.", citations: ["ev-1"] },
        { text: "The message claimed Arbitrum Sepolia as its source, but no matching Burned debit exists on any remote chain within the search window.", citations: ["ev-2", "ev-3"] },
        { text: "KIRCHHOFF recorded BROKEN with reason DEBIT_NOT_FOUND on all three ledgers in the same CRE run.", citations: ["ev-4", "ev-5", "ev-6"] },
        { text: "Quarantine froze the CCIP lanes for kETH and tainted the recipient on every chain.", citations: ["ev-7", "ev-8", "ev-9"] },
        { text: "Clean chains keep their supply; the exposure is the 116,500 kETH released on Ethereum Sepolia.", citations: ["ev-1", "ev-6"] },
      ],
      timeline: [
        { text: "Forged credit lands on Ethereum Sepolia.", citations: ["ev-1"] },
        { text: "Debit search on Arbitrum Sepolia and Base Sepolia finds nothing.", citations: ["ev-2", "ev-3"] },
        { text: "BREACH written to three ledgers.", citations: ["ev-4", "ev-5", "ev-6"] },
        { text: "Lanes frozen, recipient tainted.", citations: ["ev-7", "ev-8", "ev-9"] },
      ],
      nextSteps: ["rotate_bridge_verifier_key", "contact_dex_for_pool_pause", "prepare_holder_communication"],
    };
  }

  /** Builds the finished post-attack state as of `start` (used by the "breach" scenario). */
  private fastForwardLab(s: TokenState, start: number): void {
    const t = (k: LabStepKey) => start + LAB_TIMELINE[k][1];
    this.applyForgery(s, t("forge_release"));
    const inc = this.applyBreach(s, t("breach_written"));
    this.applyQuarantine(s, inc, t("quarantine_applied"));
    this.applyRefusal(s, inc, t("ccip_refused"));
    this.applyGuard(inc, t("guard_and_lending"));
    this.applyLoop(s, inc, t("loop_confirmed"));
    this.labRun = this.completedRun(s, start, inc.incident.id);
  }

  private completedRun(s: TokenState, start: number, incidentId: Bytes32): LabRun {
    const run = this.newRun(s, start);
    run.state = "succeeded";
    run.finishedAt = new Date(start + LAB_TIMELINE.loop_confirmed[1]).toISOString();
    run.incidentId = incidentId;
    run.steps = run.steps.map((st) => this.finishStep(s, st, start));
    run.console = this.consoleFor(s, start, "loop_confirmed");
    return run;
  }

  private newRun(s: TokenState, start: number): LabRun {
    return {
      id: `run-${fxHash(`lab:${start}`).slice(2, 10)}`,
      token: s.cfg.symbol,
      startedAt: new Date(start).toISOString(),
      finishedAt: null,
      state: "running",
      attacker: ATTACKER,
      steps: LAB_STEP_ORDER.map((key): LabStep => ({ key, state: "pending", startedAt: null, finishedAt: null, txs: [], note: null, messageId: null })),
      console: [],
      incidentId: null,
    };
  }

  private stepTxs(s: TokenState, key: LabStepKey, start: number): { txs: TxRef[]; note: string; messageId: Bytes32 | null } {
    const end = start + LAB_TIMELINE[key][1];
    switch (key) {
      case "forge_release":
        return { txs: [this.clock.tx(HOME, "kelp:release", end)], note: "116,500 kETH released on Ethereum Sepolia with no matching burn", messageId: fxHash("kelp:forged-message") };
      case "junction_search":
        return { txs: [], note: "W1 searched Arbitrum Sepolia and Base Sepolia: 0 matching debits", messageId: null };
      case "breach_written":
        return { txs: this.chainsOf(s).map((c) => this.clock.tx(c, `kelp:breach:${c}`, end)), note: "BROKEN · DEBIT_NOT_FOUND on 3 ledgers", messageId: null };
      case "quarantine_applied":
        return { txs: this.chainsOf(s).map((c) => this.clock.tx(c, `kelp:quarantine:${c}`, end)), note: "CCIP lanes frozen, attacker tainted, feed answers BROKEN", messageId: null };
      case "ccip_refused":
        return { txs: [this.clock.tx(HOME, "kelp:ccip-send", end - 2_000)], note: "Judge FAIL TOKEN_BROKEN on 4 of 4 cells. Message never executes", messageId: fxHash("kelp:ccip-escape") };
      case "guard_and_lending":
        return { txs: [this.clock.tx(HOME, "kelp:guard-revert", end)], note: "Guard blocked the transfer; borrow() reverted CollateralBroken()", messageId: null };
      case "loop_confirmed":
        return { txs: [this.clock.tx(HOME, `${s.cfg.symbol}:epoch:loop`, end)], note: "Δ = −116,500 kETH (LOOP_DEFICIT)", messageId: null };
    }
  }

  private finishStep(s: TokenState, st: LabStep, start: number): LabStep {
    const [a, b] = LAB_TIMELINE[st.key];
    const d = this.stepTxs(s, st.key, start);
    return { ...st, state: "done", startedAt: new Date(start + a).toISOString(), finishedAt: new Date(start + b).toISOString(), txs: d.txs, note: d.note, messageId: d.messageId };
  }

  private consoleFor(s: TokenState, start: number, upTo: LabStepKey): LabConsoleLine[] {
    const at = (k: LabStepKey, off = 0) => new Date(start + LAB_TIMELINE[k][0] + off).toISOString();
    const short = `${ATTACKER.slice(0, 6)}…${ATTACKER.slice(-4)}`;
    const lines: (LabConsoleLine & { step: LabStepKey })[] = [
      { step: "forge_release", at: at("forge_release"), stream: "cmd", text: "pnpm --filter @kirchhoff/demo attack-kelp-replay --network testnet", tx: null },
      { step: "forge_release", at: at("forge_release", 300), stream: "stdout", text: "Testnet simulation. Signing a WeakBridge message with its single verifier key", tx: null },
      { step: "forge_release", at: at("forge_release", 900), stream: "stdout", text: "claim: 116,500 kETH burned on Arbitrum Sepolia (no such burn exists)", tx: null },
      { step: "forge_release", at: new Date(start + LAB_TIMELINE.forge_release[1]).toISOString(), stream: "stdout", text: `HomeEscrowAdapter released 116,500 kETH to ${short}`, tx: this.clock.tx(HOME, "kelp:release", start + LAB_TIMELINE.forge_release[1]) },
      { step: "ccip_refused", at: at("ccip_refused"), stream: "cmd", text: "ccip send kETH 116500 --to base-sepolia", tx: null },
      { step: "ccip_refused", at: at("ccip_refused", 1_400), stream: "stdout", text: "CCIP message submitted, waiting for verifier signatures", tx: this.clock.tx(HOME, "kelp:ccip-send", start + LAB_TIMELINE.ccip_refused[1] - 2_000) },
      { step: "ccip_refused", at: new Date(start + LAB_TIMELINE.ccip_refused[1]).toISOString(), stream: "stderr", text: "KIRCHHOFF CCV: FAIL TOKEN_BROKEN on 4 of 4 cells. Message will not execute", tx: null },
      { step: "guard_and_lending", at: at("guard_and_lending"), stream: "cmd", text: "cast send kETH \"transfer(address,uint256)\" 0x5eed…c0de 1000e18", tx: null },
      { step: "guard_and_lending", at: at("guard_and_lending", 900), stream: "revert", text: `revert KirchhoffGuard: Tainted(${short})`, tx: this.clock.tx(HOME, "kelp:guard-revert", start + LAB_TIMELINE.guard_and_lending[1]) },
      { step: "guard_and_lending", at: at("guard_and_lending", 1_500), stream: "cmd", text: "cast send DemoLendingMarket \"borrow(uint256)\" 50000e6", tx: null },
      { step: "guard_and_lending", at: new Date(start + LAB_TIMELINE.guard_and_lending[1]).toISOString(), stream: "revert", text: "revert CollateralBroken()", tx: null },
    ];
    const limit = LAB_STEP_ORDER.indexOf(upTo);
    return lines.filter((l) => LAB_STEP_ORDER.indexOf(l.step) <= limit && Date.parse(l.at) <= Date.now()).map(({ step: _step, ...l }) => l);
  }

  labEnabled(): { enabled: boolean; reason: string | null } {
    if (this.scenario === "lab-disabled") return { enabled: false, reason: "Attack Lab is off on this deployment. The API runs it only with LAB_ENABLED=true on testnet." };
    const s = this.tokens.get("kETH");
    if (!s) return { enabled: false, reason: "No demo token deployed. Run demo/deploy-all first." };
    if (this.labRun?.state === "running") return { enabled: false, reason: "A Kelp Replay is running." };
    if (s.status !== "CONSERVED") return { enabled: false, reason: `kETH is ${s.status}. Run demo/reset to restore a conserved state first.` };
    return { enabled: true, reason: null };
  }

  getLabRun(): LabRun | null {
    return this.labRun ? structuredClone(this.labRun) : null;
  }

  runKelpReplay(): LabRun {
    const s = this.tokens.get("kETH");
    const gate = this.labEnabled();
    if (!s || !gate.enabled) throw new Error(gate.reason ?? "Lab disabled");
    const start = Date.now();
    const run = this.newRun(s, start);
    this.labRun = run;
    let inc: IncidentState | null = null;
    const publish = () => this.emit("kETH", { channel: "lab", token: "kETH", data: structuredClone(run) });
    const step = (key: LabStepKey) => run.steps.find((x) => x.key === key)!;
    const refreshConsole = (key: LabStepKey) => {
      run.console = this.consoleFor(s, start, key);
    };

    for (const key of LAB_STEP_ORDER) {
      const [a, b] = LAB_TIMELINE[key];
      this.later(a, () => {
        const st = step(key);
        st.state = "running";
        st.startedAt = new Date().toISOString();
        refreshConsole(key);
        publish();
      });
      // Console lines that land mid-step.
      this.later(a + Math.floor((b - a) / 2), () => {
        refreshConsole(key);
        publish();
      });
      this.later(b, () => {
        const now = Date.now();
        switch (key) {
          case "forge_release": {
            this.applyForgery(s, now);
            const t = s.transfers[0];
            if (t) this.emit("kETH", { channel: "transfer", token: "kETH", data: t });
            this.emitStatus("kETH");
            break;
          }
          case "breach_written": {
            inc = this.applyBreach(s, now);
            this.emit("kETH", { channel: "incident", token: "kETH", data: inc.incident });
            const e = s.epochs[s.epochs.length - 1];
            if (e) this.emit("kETH", { channel: "epoch", token: "kETH", data: e });
            run.incidentId = inc.incident.id;
            this.emitStatus("kETH");
            break;
          }
          case "quarantine_applied":
            if (inc) this.applyQuarantine(s, inc, now);
            this.emitStatus("kETH");
            break;
          case "ccip_refused":
            if (inc) {
              const v = this.applyRefusal(s, inc, now);
              this.emit("kETH", { channel: "verdict", token: "kETH", data: v });
              const t = s.transfers[0];
              if (t) this.emit("kETH", { channel: "transfer", token: "kETH", data: t });
            }
            break;
          case "guard_and_lending":
            if (inc) this.applyGuard(inc, now);
            break;
          case "loop_confirmed":
            if (inc) {
              this.applyLoop(s, inc, now);
              const e = s.epochs[s.epochs.length - 1];
              if (e) this.emit("kETH", { channel: "epoch", token: "kETH", data: e });
            }
            run.state = "succeeded";
            run.finishedAt = new Date(now).toISOString();
            this.emitStatus("kETH");
            break;
          case "junction_search":
            break;
        }
        const st = step(key);
        const d = this.stepTxs(s, key, start);
        st.state = "done";
        st.finishedAt = new Date(now).toISOString();
        st.txs = d.txs.map((tx) => ({ ...tx, timestamp: new Date(now).toISOString() }));
        st.note = d.note;
        st.messageId = d.messageId;
        refreshConsole(key);
        publish();
      });
    }
    publish();
    return structuredClone(run);
  }

  /* ------------------------------------------------------------------ read model */

  tokenSummaries(): TokenSummary[] {
    return [...this.tokens.values()].map((s) => this.summary(s));
  }

  private summary(s: TokenState): TokenSummary {
    return {
      symbol: s.cfg.symbol,
      tokenId: s.tokenId,
      name: s.cfg.name,
      decimals: s.cfg.decimals,
      model: "lock_release_home",
      homeChain: HOME,
      chains: this.chainsOf(s),
      status: s.status,
      reason: s.reason,
      delta: this.delta(s).toString(),
      epochId: (s.epochId + BigInt(s.epochs.length) - 1n).toString(),
      updatedAt: new Date(s.updatedAtMs).toISOString(),
      stale: s.stale || Date.now() - s.updatedAtMs > STALENESS_SECONDS * 1000,
      activeIncidentId: s.activeIncidentId,
      specHash: fxHash(`${s.cfg.symbol}:spec:v1`),
      simulation: true,
    };
  }

  status(symbol: string): TokenStatusResponse | null {
    const s = this.tokens.get(symbol);
    if (!s) return null;
    const now = Date.now();
    const lastEpoch = s.epochs[s.epochs.length - 1] ?? null;
    const delta = this.delta(s);
    const chains: ChainSupply[] = this.chainsOf(s).map((c) => {
      const live = s.chains[c];
      const lag = c === BASE ? 60_000 : 768_000;
      const pinnedAt = (lastEpoch ? Date.parse(lastEpoch.evaluatedAt) : now) - lag;
      return {
        chain: c,
        selector: CHAINS[c].selector,
        role: c === HOME ? "home" : "remote",
        confidence: c === BASE ? "safe" : "finalized",
        contracts: contractsFor(s.cfg.symbol, c),
        supply: live.supply.toString(),
        escrow: live.escrow === null ? null : live.escrow.toString(),
        inFlightOut: live.inFlightOut.toString(),
        inFlightIn: live.inFlightIn.toString(),
        pinnedBlock: { chain: c, number: this.clock.blockAt(c, pinnedAt).toString(), timestamp: new Date(pinnedAt).toISOString() },
        ledgerStatus: s.status,
        frozen: s.frozen,
        read: live.read,
      };
    });
    let remoteSupply = 0n;
    let fOut = 0n;
    let fIn = 0n;
    for (const c of chains) {
      if (c.role === "remote") remoteSupply += BigInt(c.supply);
      fOut += BigInt(c.inFlightOut);
      fIn += BigInt(c.inFlightIn);
    }
    const lanes: Lane[] = this.laneList(s.cfg).map((l) => {
      const bridge = s.cfg.bridges.find((b) => b.id === l.bridge);
      return {
        id: l.id,
        bridge: l.bridge,
        bridgeKind: bridge?.kind ?? "custom",
        srcChain: l.srcChain,
        dstChain: l.dstChain,
        frozen: s.frozen && l.bridge === "ccip",
        offending: s.offendingLaneId === l.id,
        recentTransfers: s.transfers.filter((t) => t.laneId === l.id).slice(0, 10).map(({ laneId: _l, ...t }) => t),
      };
    });
    return {
      ...this.meta(),
      token: this.summary(s),
      epoch: lastEpoch
        ? { epochId: lastEpoch.epochId, evaluatedAt: lastEpoch.evaluatedAt, blocksHash: lastEpoch.blocksHash, evidenceHash: lastEpoch.evidenceHash, reportTxs: lastEpoch.reportTxs }
        : null,
      backing: (s.chains[HOME].escrow ?? 0n).toString(),
      claims: { remoteSupply: remoteSupply.toString(), inFlightOut: fOut.toString(), inFlightIn: fIn.toString(), total: (remoteSupply + fOut + fIn).toString() },
      tolerance: "0",
      unclaimedSurplus: (delta > 0n ? delta : 0n).toString(),
      stalenessSeconds: STALENESS_SECONDS,
      onStale: "fail_closed",
      chains,
      bridges: [...s.cfg.bridges],
      lanes,
    };
  }

  epochs(symbol: string, sinceMs: number | null, limit: number): EpochPoint[] | null {
    const s = this.tokens.get(symbol);
    if (!s) return null;
    const items = s.epochs.filter((e) => sinceMs === null || Date.parse(e.evaluatedAt) >= sinceMs);
    return items.slice(-limit).reverse();
  }

  verdicts(symbol: string, limit: number): Verdict[] | null {
    const s = this.tokens.get(symbol);
    if (!s) return null;
    return s.verdicts.slice(0, limit);
  }

  incident(id: Bytes32): IncidentResponse | null {
    const inc = this.incidents.get(id);
    if (!inc) return null;
    const s = this.tokens.get(inc.incident.token);
    if (!s) return null;
    return {
      ...this.meta(),
      incident: structuredClone(inc.incident),
      evidence: structuredClone(inc.evidence),
      actions: structuredClone(inc.actions),
      blastRadius: this.chainsOf(s).map((c) => ({
        chain: c,
        exposure: c === HOME ? FORGED_AMOUNT.toString() : "0",
        taintedAddresses: c === HOME || s.frozen ? [...inc.tainted] : [],
        frozenLanes: s.frozen ? this.laneList(s.cfg).filter((l) => l.bridge === "ccip" && (l.srcChain === c || l.dstChain === c)).map((l) => l.id) : [],
      })),
      heldMessages: inc.refused.map((v) => ({ messageId: v.messageId, srcChain: v.srcChain, dstChain: v.dstChain, amount: v.amount, sender: v.sender, heldAt: v.evaluatedAt, reason: v.reason })),
      refused: structuredClone(inc.refused),
      narrative: inc.narrative ? structuredClone(inc.narrative) : null,
      resolution: { chain: HOME, issuerSafe: ISSUER_SAFE, quarantineController: fxAddress(`quarantine:${HOME}`), canResolve: s.status === "QUARANTINED" },
      tokenStatus: s.status,
    };
  }

  registry(): Address {
    return REGISTRY;
  }

  issuerSafe(): Address {
    return ISSUER_SAFE;
  }
}
