/**
 * KIRCHHOFF public API contract (PRD section 13), as consumed by Mission Control.
 *
 * The API team implements exactly these shapes. Conventions that apply to every type below:
 *
 * - Token amounts are base-unit integers encoded as decimal strings (`WeiString`), never floats,
 *   never scientific notation. Signed where noted (Δ can be negative). Clients parse with BigInt.
 * - Block numbers are decimal strings (`BlockNumberString`) because uint64 overflows JS numbers.
 * - Timestamps are ISO-8601 UTC strings (`IsoTime`), derived from block timestamps whenever the
 *   value is an onchain fact.
 * - CCIP chain selectors are decimal strings (`ChainSelector`).
 * - Every top-level response carries `MirrorMeta`: `source: "onchain-mirror"`, the ledger it
 *   mirrors and the block the value was read at, so any client can verify it onchain.
 * - Errors are returned with a non-2xx status and an `ApiErrorBody`.
 * - Nothing in this API is in the veto path. It mirrors onchain state; it never produces verdicts.
 */

/* ----------------------------------------------------------------------------------------------
 * Primitives
 * -------------------------------------------------------------------------------------------- */

export type Hex = `0x${string}`;
export type Address = Hex;
/** 32-byte transaction hash. */
export type TxHash = Hex;
/** 32-byte id, e.g. tokenId = keccak256(bytes(symbol)), incidentId, messageId, evidenceHash. */
export type Bytes32 = Hex;
/** Base-unit integer as a decimal string. May start with "-" only where documented as signed. */
export type WeiString = string;
/** uint64 block number as a decimal string. */
export type BlockNumberString = string;
/** uint64 CCIP chain selector as a decimal string. */
export type ChainSelector = string;
/** ISO-8601 UTC timestamp, e.g. "2026-10-06T09:14:03Z". */
export type IsoTime = string;

/** CRE chain names used in KIRCH-SPEC (PRD section 6). */
export type ChainKey =
  | "ethereum-testnet-sepolia"
  | "ethereum-testnet-sepolia-arbitrum-1"
  | "ethereum-testnet-sepolia-base-1";

export const CHAIN_KEYS: readonly ChainKey[] = [
  "ethereum-testnet-sepolia",
  "ethereum-testnet-sepolia-arbitrum-1",
  "ethereum-testnet-sepolia-base-1",
] as const;

/** Token status machine (PRD section 4). Numeric value equals the ConservationFeed answer. */
export type TokenStatus = "UNKNOWN" | "CONSERVED" | "DRIFT" | "BROKEN" | "QUARANTINED" | "RECOVERING";

export const STATUS_FEED_ANSWER: Readonly<Record<TokenStatus, number>> = {
  UNKNOWN: 0,
  CONSERVED: 1,
  DRIFT: 2,
  BROKEN: 3,
  QUARANTINED: 4,
  RECOVERING: 5,
};

/** Reason codes (PRD section 6, docs/INTERFACES.md). Numeric value is the uint16 onchain. */
export type ReasonCode =
  | "OK"
  | "PENDING_ATTESTATION"
  | "DEBIT_NOT_FOUND"
  | "AMOUNT_MISMATCH"
  | "RECIPIENT_MISMATCH"
  | "DOUBLE_CREDIT"
  | "LOOP_DEFICIT"
  | "RESERVE_SHORTFALL"
  | "FLOW_LIMIT"
  | "STATUS_STALE"
  | "TOKEN_BROKEN"
  | "TOKEN_QUARANTINED"
  | "UNKNOWN_TOKEN"
  | "SPEC_MISMATCH"
  | "TOKEN_RECOVERING";

export const REASON_CODE_VALUE: Readonly<Record<ReasonCode, number>> = {
  OK: 0,
  PENDING_ATTESTATION: 1,
  DEBIT_NOT_FOUND: 2,
  AMOUNT_MISMATCH: 3,
  RECIPIENT_MISMATCH: 4,
  DOUBLE_CREDIT: 5,
  LOOP_DEFICIT: 6,
  RESERVE_SHORTFALL: 7,
  FLOW_LIMIT: 8,
  STATUS_STALE: 9,
  TOKEN_BROKEN: 10,
  TOKEN_QUARANTINED: 11,
  UNKNOWN_TOKEN: 12,
  SPEC_MISMATCH: 13,
  TOKEN_RECOVERING: 14,
};

/** Bridge families with an adapter (PRD section 10). */
export type BridgeKind = "ccip_v2" | "custom" | "layerzero_oft" | "wormhole_ntt";
/** Read confidence per chain (PRD glossary). */
export type Confidence = "latest" | "safe" | "finalized";
export type TokenModel = "lock_release_home" | "burn_mint_multi";
export type StalePolicy = "fail_closed" | "fail_open";

/* ----------------------------------------------------------------------------------------------
 * Provenance and references
 * -------------------------------------------------------------------------------------------- */

/** A transaction on one chain. Clients build explorer links from (chain, hash). */
export interface TxRef {
  chain: ChainKey;
  hash: TxHash;
  block: BlockNumberString;
  /** Block timestamp of the transaction. */
  timestamp: IsoTime;
}

/** A block a value was read at. */
export interface BlockRef {
  chain: ChainKey;
  number: BlockNumberString;
  timestamp: IsoTime;
}

/** The onchain contract a mirrored value comes from. */
export interface LedgerRef {
  chain: ChainKey;
  /** ConservationLedger address on `chain`. */
  address: Address;
}

/**
 * Present on every top-level response (PRD section 13: "All responses include
 * source: onchain-mirror, the ledger address and the block the value was read at").
 */
export interface MirrorMeta {
  source: "onchain-mirror";
  /** Ledger on the token's home chain unless the endpoint documents otherwise. */
  ledger: LedgerRef;
  /** Block on `ledger.chain` the response was consistent with. */
  block: BlockRef;
  /** Server wall clock when the response was produced. Used for staleness timers. */
  servedAt: IsoTime;
}

export interface Paginated<T> {
  items: T[];
  /** Opaque cursor for the next (older) page, null when exhausted. */
  nextCursor: string | null;
}

/** Body of every non-2xx response. */
export interface ApiErrorBody {
  error: {
    code:
      | "NOT_FOUND"
      | "BAD_REQUEST"
      | "UNAUTHORIZED"
      | "RATE_LIMITED"
      | "LAB_DISABLED"
      | "UPSTREAM_RPC"
      | "INTERNAL";
    message: string;
    /** Set when the failure is attributable to one chain's RPC. */
    chain?: ChainKey;
  };
}

/* ----------------------------------------------------------------------------------------------
 * GET /tokens
 * -------------------------------------------------------------------------------------------- */

export interface TokenSummary {
  symbol: string;
  /** keccak256(bytes(symbol)). */
  tokenId: Bytes32;
  name: string;
  decimals: number;
  model: TokenModel;
  homeChain: ChainKey;
  chains: ChainKey[];
  status: TokenStatus;
  reason: ReasonCode;
  /** Signed. Backing minus claims, base units. */
  delta: WeiString;
  epochId: string;
  /** Block timestamp of the latest status write on the home ledger. */
  updatedAt: IsoTime;
  stale: boolean;
  /** Open incident for this token, if any. */
  activeIncidentId: Bytes32 | null;
  /** Active KIRCH-SPEC hash in KirchhoffRegistry. */
  specHash: Bytes32;
  /** True for demo tokens deployed by demo/deploy-all ("Testnet simulation"). */
  simulation: boolean;
}

export interface TokensResponse extends MirrorMeta {
  items: TokenSummary[];
}

/* ----------------------------------------------------------------------------------------------
 * GET /tokens/{token}/status
 * -------------------------------------------------------------------------------------------- */

/** Per-chain contract addresses of the KIRCHHOFF suite. */
export interface ChainContracts {
  /** Canonical token on the home chain, RemoteKETH-style token on remotes. */
  token: Address;
  ledger: Address;
  feed: Address;
  quarantineController: Address;
  /** HomeEscrowAdapter on the home chain, null on remotes. */
  escrow: Address | null;
  /** KirchhoffGuard if the token opted in on this chain. */
  guard: Address | null;
}

/** Health of the mirror's read of one chain. Drives the "RPC error names the chain" banner. */
export type ChainReadHealth =
  | { ok: true }
  | {
      ok: false;
      /** Human readable, e.g. "RPC timeout after 2s on 2 of 2 providers". */
      error: string;
      /** Last block the mirror read successfully. Values below come from this block. */
      lastGoodBlock: BlockRef | null;
      since: IsoTime;
    };

export interface ChainSupply {
  chain: ChainKey;
  selector: ChainSelector;
  role: "home" | "remote";
  confidence: Confidence;
  contracts: ChainContracts;
  /** Remote: token totalSupply. Home: canonical supply circulating outside escrow (informational). */
  supply: WeiString;
  /** Home: escrow balance (the backing E_H). Remote: null. */
  escrow: WeiString | null;
  /** Debited on this chain, not yet credited elsewhere (F_out contribution). */
  inFlightOut: WeiString;
  /** Credits expected on this chain whose debit is final elsewhere (F_in contribution). */
  inFlightIn: WeiString;
  /** Block pinned for the latest epoch on this chain (from the epoch's blocksHash preimage). */
  pinnedBlock: BlockRef;
  /** Status as read from this chain's own ConservationLedger. */
  ledgerStatus: TokenStatus;
  /** QuarantineController.isFrozen(tokenId) on this chain. */
  frozen: boolean;
  read: ChainReadHealth;
}

/** One transfer seen on a lane (debit, and credit once settled). */
export interface LaneTransfer {
  messageId: Bytes32;
  bridge: string;
  srcChain: ChainKey;
  dstChain: ChainKey;
  amount: WeiString;
  sender: Address | null;
  recipient: Address | null;
  /** Source debit. Null for a forged credit (no debit exists). */
  debitTx: TxRef | null;
  /** Destination credit. Null while in flight or refused. */
  creditTx: TxRef | null;
  state: "in_flight" | "settled" | "refused" | "forged";
  /** CCIP explorer message link available for ccip_v2 lanes. */
  ccipMessageId: Bytes32 | null;
}

/** One wire in the Circuit Map: one bridge, one direction. */
export interface Lane {
  /** Stable id, `${bridge}:${srcChain}->${dstChain}`. */
  id: string;
  bridge: string;
  bridgeKind: BridgeKind;
  srcChain: ChainKey;
  dstChain: ChainKey;
  /** CCIP lanes freeze on quarantine; custom bridges are outside our control and never "frozen". */
  frozen: boolean;
  /** The lane that carried the breach-causing credit. */
  offending: boolean;
  /** Newest first, at most 10 (hover card on the wire). */
  recentTransfers: LaneTransfer[];
}

export interface BridgeInfo {
  id: string;
  kind: BridgeKind;
  /** Display name, e.g. "CCIP 2.0", "WeakBridge (1-of-1 verifier)". */
  label: string;
  /** Pool or bridge contract per chain. */
  contracts: Partial<Record<ChainKey, Address>>;
}

export interface EpochSummary {
  epochId: string;
  evaluatedAt: IsoTime;
  /** keccak256(abi.encode(selectors[], blockNumbers[])). */
  blocksHash: Bytes32;
  evidenceHash: Bytes32;
  /** The EPOCH or BREACH report write on each chain's ledger. */
  reportTxs: TxRef[];
}

export interface TokenStatusResponse extends MirrorMeta {
  token: TokenSummary;
  epoch: EpochSummary | null;
  /** Loop Rule terms, base units. delta = backing - claims.total. */
  backing: WeiString;
  claims: {
    remoteSupply: WeiString;
    inFlightOut: WeiString;
    inFlightIn: WeiString;
    total: WeiString;
  };
  /** Spec tolerance τ, base units. */
  tolerance: WeiString;
  /** Positive Δ above tolerance caused by escrow donations (PRD section 10). */
  unclaimedSurplus: WeiString;
  stalenessSeconds: number;
  onStale: StalePolicy;
  chains: ChainSupply[];
  bridges: BridgeInfo[];
  lanes: Lane[];
}

/* ----------------------------------------------------------------------------------------------
 * GET /tokens/{token}/epochs?limit&cursor
 * -------------------------------------------------------------------------------------------- */

export interface EpochPoint extends EpochSummary {
  /** Signed, base units. */
  delta: WeiString;
  status: TokenStatus;
  reason: ReasonCode;
  /** Incident opened by or active during this epoch. Drives Δ chart incident markers. */
  incidentId: Bytes32 | null;
}

export interface EpochsQuery {
  /** 1..500, default 100. */
  limit?: number;
  cursor?: string;
  /** Only epochs evaluated at or after this time. */
  since?: IsoTime;
}

export interface EpochsResponse extends MirrorMeta, Paginated<EpochPoint> {}

/* ----------------------------------------------------------------------------------------------
 * GET /tokens/{token}/verdicts?cursor
 * -------------------------------------------------------------------------------------------- */

export interface Verdict {
  /** Stable row id (cell id + message id). */
  id: string;
  messageId: Bytes32;
  evaluatedAt: IsoTime;
  bridge: "ccip";
  srcChain: ChainKey;
  dstChain: ChainKey;
  amount: WeiString;
  sender: Address;
  receiver: Address;
  decision: "PASS" | "FAIL";
  reason: ReasonCode;
  /** Short note returned to the verifier after the code, e.g. "attacker transfer to Base Sepolia". */
  note: string;
  /** CCV cells that returned this decision (committee view). */
  cells: { cellId: string; decision: "PASS" | "FAIL"; latencyMs: number }[];
  /** Source chain debit (CCIP pool lockOrBurn) tx. */
  sourceTx: TxRef;
  /** Destination execution tx; null when never executed (FAIL) or pending. */
  executionTx: TxRef | null;
  /** Incident that caused a FAIL, if any. */
  incidentId: Bytes32 | null;
}

export interface VerdictsQuery {
  cursor?: string;
  /** 1..200, default 50. */
  limit?: number;
}

export interface VerdictsResponse extends MirrorMeta, Paginated<Verdict> {}

/* ----------------------------------------------------------------------------------------------
 * GET /incidents/{id}
 * -------------------------------------------------------------------------------------------- */

export type Severity = "SEV1" | "SEV2" | "SEV3";

/** Containment actions from KIRCH-SPEC `response.on_broken`. */
export type ContainmentKind = "freeze_ccip_lanes" | "taint_recipient" | "flip_feed" | "page_issuer";

/** Fixed playbook (PRD section 11). The narrator may only pick from this list. */
export type PlaybookStep =
  | "rotate_bridge_verifier_key"
  | "contact_dex_for_pool_pause"
  | "prepare_holder_communication";

export const PLAYBOOK_LABEL: Readonly<Record<PlaybookStep, string>> = {
  rotate_bridge_verifier_key: "Rotate bridge verifier key",
  contact_dex_for_pool_pause: "Contact DEX for pool pause",
  prepare_holder_communication: "Prepare holder communication",
};

export type EvidenceKind =
  | "offending_credit"
  | "debit_search"
  | "breach_report"
  | "quarantine_tx"
  | "refused_message"
  | "guard_revert"
  | "epoch_report";

/** One citable fact in the evidence bundle. Built deterministically by W3 and the API. */
export interface EvidenceItem {
  /** Stable id used by narrative citations, e.g. "ev-3". */
  id: string;
  kind: EvidenceKind;
  chain: ChainKey;
  at: IsoTime;
  /** One-line, deterministic description. */
  label: string;
  /** Tx proving the fact. Null for read-only facts (debit_search), which carry `blocks` instead. */
  tx: TxRef | null;
  /** debit_search only: the block range searched for the missing debit. */
  blocks: { from: BlockNumberString; to: BlockNumberString; matches: number } | null;
  /** refused_message only. */
  messageId: Bytes32 | null;
}

export interface ContainmentAction {
  kind: ContainmentKind;
  applied: boolean;
  /** One entry per chain the action was applied on. */
  txs: TxRef[];
  appliedAt: IsoTime | null;
}

export interface BlastRadiusEntry {
  chain: ChainKey;
  /** Value at risk on this chain, base units. */
  exposure: WeiString;
  taintedAddresses: Address[];
  frozenLanes: string[];
}

export interface HeldMessage {
  messageId: Bytes32;
  srcChain: ChainKey;
  dstChain: ChainKey;
  amount: WeiString;
  sender: Address;
  heldAt: IsoTime;
  reason: ReasonCode;
}

export interface NarrativeSentence {
  text: string;
  /** EvidenceItem ids. Every sentence carries at least one (PRD section 11 eval bar). */
  citations: string[];
}

export interface IncidentNarrative {
  /** Model name from env, shown for transparency. */
  model: string;
  generatedAt: IsoTime;
  /** Rendered verbatim as the panel label. */
  label: "AI summary. Verify against evidence.";
  /** About 120 words split into cited sentences. */
  summary: NarrativeSentence[];
  timeline: NarrativeSentence[];
  nextSteps: PlaybookStep[];
  /** "template" when the deterministic fallback narrator produced it (cut list). */
  generator: "model" | "template";
}

export interface Incident {
  id: Bytes32;
  token: string;
  tokenId: Bytes32;
  severity: Severity;
  status: "open" | "recovering" | "resolved";
  reason: ReasonCode;
  /** Signed Δ before the offending credit and after the confirming epoch. */
  deltaBefore: WeiString;
  deltaAfter: WeiString;
  offending: {
    chain: ChainKey;
    tx: TxRef;
    bridge: string;
    recipient: Address;
    amount: WeiString;
    messageId: Bytes32;
    claimedSrcChain: ChainKey;
  };
  /** Timestamp of the block containing the offending credit. */
  offendingBlockAt: IsoTime;
  /** Timestamp of the first BREACH report landing onchain. */
  brokenAt: IsoTime;
  /** brokenAt minus offendingBlockAt, in seconds. */
  timeToBrokenSeconds: number;
  evidenceHash: Bytes32;
  openedAt: IsoTime;
  resolvedAt: IsoTime | null;
  recoveryEndsAt: IsoTime | null;
}

/** What the UI needs to prepare `QuarantineController.resolve(tokenId, incidentId)` for the Safe. */
export interface IncidentResolution {
  chain: ChainKey;
  issuerSafe: Address;
  quarantineController: Address;
  /** True once the current status allows resolve (QUARANTINED). */
  canResolve: boolean;
}

export interface IncidentResponse extends MirrorMeta {
  incident: Incident;
  evidence: EvidenceItem[];
  actions: ContainmentAction[];
  blastRadius: BlastRadiusEntry[];
  heldMessages: HeldMessage[];
  refused: Verdict[];
  /** Null while the narrator is running or unavailable. The evidence stands without it. */
  narrative: IncidentNarrative | null;
  resolution: IncidentResolution;
  /** Current token status, so "Replay after recovery" can enable on CONSERVED. */
  tokenStatus: TokenStatus;
}

/* ----------------------------------------------------------------------------------------------
 * POST /check-transfer
 * -------------------------------------------------------------------------------------------- */

export interface CheckTransferRequest {
  token: string;
  srcChain: ChainKey;
  dstChain: ChainKey;
  amount: WeiString;
  sender: Address;
}

export interface CheckTransferResponse extends MirrorMeta {
  wouldPass: boolean;
  reason: ReasonCode;
  advice: string;
  status: TokenStatus;
}

/* ----------------------------------------------------------------------------------------------
 * POST /specs/draft (issuer key, Server-Sent Events)
 * -------------------------------------------------------------------------------------------- */

export interface SpecDraftRequest {
  description: string;
  canonical: { chain: ChainKey; address: Address };
}

export type CopilotTool =
  | "get_contract"
  | "list_role_grants"
  | "list_ccip_pools"
  | "list_oft_peers"
  | "sample_events"
  | "validate_spec"
  | "backtest_spec";

/** Where one YAML line's value came from. */
export interface LineProvenance {
  /** "tool": from a tool result. "schema": structural line required by the schema. "issuer": typed by a human. */
  kind: "tool" | "schema" | "issuer";
  /** Tool call id from the trace (kind "tool"). */
  toolCallId: string | null;
  tool: CopilotTool | null;
  /** Explorer or onchain link backing the value. */
  href: string | null;
  /** Plain-English why, shown beside minter lines. */
  why: string | null;
}

export interface SpecDraftLine {
  /** 1-based line number in `yaml`. */
  line: number;
  text: string;
  /** Null means no provenance: rendered red, blocks approval (PRD section 11 principle 2). */
  provenance: LineProvenance | null;
}

/** SSE `data:` payloads, one JSON object per event, event name equals `type`. */
export type SpecDraftEvent =
  | { type: "tool_call"; id: string; tool: CopilotTool; input: Record<string, string | number | boolean | null>; at: IsoTime }
  | { type: "tool_result"; id: string; tool: CopilotTool; ok: boolean; summary: string; href: string | null; durationMs: number }
  | { type: "thinking"; text: string }
  | { type: "draft"; yaml: string; lines: SpecDraftLine[]; specHash: Bytes32 }
  | { type: "validation"; ok: boolean; errors: { line: number | null; message: string }[] }
  | { type: "done" }
  | { type: "error"; message: string };

/* ----------------------------------------------------------------------------------------------
 * POST /specs/backtest (issuer key)
 * -------------------------------------------------------------------------------------------- */

export interface BacktestRequest {
  yaml: string;
  /** Per-chain start block; defaults to each contract's deployment block. */
  fromBlock?: Partial<Record<ChainKey, BlockNumberString>>;
}

export interface BacktestResponse extends MirrorMeta {
  specHash: Bytes32;
  /** False if any BROKEN on real history. Activation is blocked when false. */
  ok: boolean;
  eventsReplayed: number;
  durationMs: number;
  coverage: {
    chain: ChainKey;
    fromBlock: BlockNumberString;
    toBlock: BlockNumberString;
    debits: number;
    credits: number;
    matched: number;
  }[];
  breaches: { reason: ReasonCode; tx: TxRef; amount: WeiString; note: string }[];
  driftEvents: { reason: ReasonCode; tx: TxRef; note: string }[];
}

/* ----------------------------------------------------------------------------------------------
 * GET /specs/{specHash} (spec lifecycle: propose, timelock, activate; PRD section 6)
 * -------------------------------------------------------------------------------------------- */

export interface SpecProposalResponse extends MirrorMeta {
  token: string;
  specHash: Bytes32;
  state: "draft" | "proposed" | "active" | "superseded";
  /** KirchhoffRegistry propose tx, sent by the issuer Safe. */
  proposeTx: TxRef | null;
  proposedAt: IsoTime | null;
  /** proposedAt + timelock. */
  activatesAt: IsoTime | null;
  timelockSeconds: number;
  activateTx: TxRef | null;
  registry: Address;
  issuerSafe: Address;
}

/* ----------------------------------------------------------------------------------------------
 * POST /ask (Ask KIRCHHOFF, Server-Sent Events)
 * -------------------------------------------------------------------------------------------- */

export interface AskRequest {
  question: string;
  token: string | null;
  /** Prior turns, oldest first, at most 10. */
  history: { role: "user" | "assistant"; content: string }[];
}

export interface AskCitation {
  /** Referenced inline in text as [n]. */
  n: number;
  kind: "tx" | "row" | "onchain_read";
  label: string;
  href: string;
}

export type AskEvent =
  | { type: "tool"; tool: "sql" | "evidence"; summary: string }
  | { type: "text"; delta: string }
  | { type: "citation"; citation: AskCitation }
  | { type: "done" }
  | { type: "error"; message: string };

/* ----------------------------------------------------------------------------------------------
 * Attack Lab (demo only). POST /lab/kelp-replay, GET /lab/status, GET /lab/runs/{id}
 * Triggers demo/attack-kelp-replay. Disabled outside testnet deployments.
 * -------------------------------------------------------------------------------------------- */

/** The 7 steps of PRD section 5, Flow B, in order. */
export type LabStepKey =
  | "forge_release"
  | "junction_search"
  | "breach_written"
  | "quarantine_applied"
  | "ccip_refused"
  | "guard_and_lending"
  | "loop_confirmed";

export const LAB_STEP_ORDER: readonly LabStepKey[] = [
  "forge_release",
  "junction_search",
  "breach_written",
  "quarantine_applied",
  "ccip_refused",
  "guard_and_lending",
  "loop_confirmed",
] as const;

export interface LabStep {
  key: LabStepKey;
  state: "pending" | "running" | "done" | "failed";
  startedAt: IsoTime | null;
  finishedAt: IsoTime | null;
  /** Txs that prove the step (one per chain where relevant). */
  txs: TxRef[];
  /** Deterministic one-liner from the script, e.g. "Judge FAIL TOKEN_BROKEN on 1 of 1 cells". */
  note: string | null;
  /** CCIP message id for the refused transfer step. */
  messageId: Bytes32 | null;
}

export interface LabConsoleLine {
  at: IsoTime;
  stream: "cmd" | "stdout" | "stderr" | "revert";
  text: string;
  tx: TxRef | null;
}

export interface LabRun {
  id: string;
  token: string;
  startedAt: IsoTime;
  finishedAt: IsoTime | null;
  state: "running" | "succeeded" | "failed";
  attacker: Address;
  steps: LabStep[];
  console: LabConsoleLine[];
  incidentId: Bytes32 | null;
}

export interface LabStatusResponse extends MirrorMeta {
  enabled: boolean;
  /** Why the lab is disabled, shown on the disabled button. */
  disabledReason: string | null;
  /** Running or most recent run. */
  run: LabRun | null;
}

export interface LabRunResponse extends MirrorMeta {
  run: LabRun;
}

/* ----------------------------------------------------------------------------------------------
 * GET /ops (Verifier Ops)
 * -------------------------------------------------------------------------------------------- */

export interface CellHealth {
  id: string;
  name: string;
  region: string;
  healthy: boolean;
  lastHeartbeatAt: IsoTime;
  version: string;
  /** `verifier_message_transitions_total{stage="policy"}` over the window. */
  policyTransitions: number;
}

export interface RpcAgreement {
  chain: ChainKey;
  providers: { name: string; healthy: boolean; head: BlockNumberString; latencyMs: number }[];
  /** Share of Judge reads where both providers agreed, 0..1, over the window. */
  agreementRate: number;
  lastDisagreementAt: IsoTime | null;
}

export type WorkflowId = "w1-junction" | "w2-loop" | "w3-responder" | "w4-topology";

export interface CreRun {
  workflow: WorkflowId;
  runId: string;
  trigger: "cron" | "log";
  triggeredAt: IsoTime;
  durationMs: number;
  outcome: "ok" | "breach" | "error" | "noop";
  reportTxs: TxRef[];
}

export interface OpsResponse extends MirrorMeta {
  windowSeconds: number;
  cells: CellHealth[];
  judge: { p50Ms: number; p99Ms: number; samples: number };
  verdictCounts: { pass: number; fail: number; byReason: Partial<Record<ReasonCode, number>> };
  rpc: RpcAgreement[];
  creRuns: CreRun[];
  /** Fallback B (KirchhoffTokenPool) or a live CCV cell. Shown honestly in the header. */
  enforcement: "ccv_cell" | "token_pool_fallback";
}

/* ----------------------------------------------------------------------------------------------
 * GET /keys (issuer key) for the Integrations API keys panel
 * -------------------------------------------------------------------------------------------- */

export interface ApiKeyInfo {
  id: string;
  label: string;
  /** First 8 characters only. The full key is shown once at creation and never again. */
  prefix: string;
  scopes: ("specs:draft" | "specs:backtest" | "keys:manage")[];
  createdAt: IsoTime;
  lastUsedAt: IsoTime | null;
}

export interface ApiKeysResponse extends MirrorMeta {
  items: ApiKeyInfo[];
}

/* ----------------------------------------------------------------------------------------------
 * WS /stream?token=
 * Server to client JSON frames. Channels from PRD section 13 plus `transfer` (settled transfers,
 * drives the 600ms wire pulse) and `lab` (Attack Lab run progress).
 * Client to server: none. Server sends `{ channel: "ping" }` every 15s; clients reconnect on silence.
 * -------------------------------------------------------------------------------------------- */

export type StreamMessage =
  | { channel: "status"; token: string; data: TokenStatusResponse }
  | { channel: "epoch"; token: string; data: EpochPoint }
  | { channel: "verdict"; token: string; data: Verdict }
  | { channel: "incident"; token: string; data: Incident }
  | { channel: "transfer"; token: string; data: LaneTransfer & { laneId: string } }
  | { channel: "lab"; token: string; data: LabRun }
  | { channel: "ping" };

export type StreamChannel = Exclude<StreamMessage["channel"], "ping">;
