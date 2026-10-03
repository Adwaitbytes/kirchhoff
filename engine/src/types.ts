/**
 * Source of truth for the TypeScript side of docs/INTERFACES.md.
 *
 * Enums are `as const` objects rather than TS `enum`s so the package runs under
 * erasable-syntax-only toolchains (Node type stripping, the CRE WASM bundler).
 */

export type Hex = `0x${string}`;

/** CCIP chain selector. Always a bigint so uint64 values never lose precision. */
export type ChainSel = bigint;

export const Status = {
  UNKNOWN: 0,
  CONSERVED: 1,
  DRIFT: 2,
  BROKEN: 3,
  QUARANTINED: 4,
  RECOVERING: 5,
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export const Reason = {
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
} as const;
export type Reason = (typeof Reason)[keyof typeof Reason];
export type ReasonCode = keyof typeof Reason;

export const ReportType = {
  EPOCH: 1,
  BREACH: 2,
  QUARANTINE_APPLIED: 3,
  RECOVERY_CHECK: 4,
} as const;
export type ReportType = (typeof ReportType)[keyof typeof ReportType];

const STATUS_NAMES = Object.fromEntries(Object.entries(Status).map(([k, v]) => [v, k])) as Record<
  Status,
  keyof typeof Status
>;
const REASON_NAMES = Object.fromEntries(Object.entries(Reason).map(([k, v]) => [v, k])) as Record<
  Reason,
  ReasonCode
>;

export function statusName(status: Status): keyof typeof Status {
  return STATUS_NAMES[status];
}

export function reasonName(reason: Reason): ReasonCode {
  return REASON_NAMES[reason];
}

/** Narrows a decoded uint16 to a known Reason, rejecting codes this engine does not define. */
export function toReason(value: number): Reason {
  if (!(value in REASON_NAMES)) throw new EngineInputError(`unknown reason code ${value.toString()}`);
  return value as Reason;
}

/** PRD section 10 Debit: a source-side event that removes value (lock or burn). */
export type Debit = {
  messageId: Hex;
  srcChain: ChainSel;
  dstChain: ChainSel;
  amount: bigint;
  recipient?: Hex;
  txHash: Hex;
  block: bigint;
};

/** PRD section 10 Credit: a destination-side event that adds value (release or mint). */
export type Credit = {
  messageId: Hex;
  claimedSrcChain: ChainSel;
  dstChain: ChainSel;
  amount: bigint;
  recipient?: Hex;
  txHash: Hex;
  block: bigint;
};

export type Model = "lock_release_home" | "burn_mint_multi";
export type Confidence = "latest" | "safe" | "finalized";
export type Unit = "tokens" | "shares";
export type OnStale = "fail_closed" | "fail_open";
export type ResponseAction = "freeze_ccip_lanes" | "taint_recipient" | "flip_feed" | "page_issuer";

export type ChainRef = {
  /** CRE chain name, e.g. `ethereum-testnet-sepolia`. */
  name: string;
  selector: ChainSel;
  /** Short key used by bridge address maps (`home`, `arb`, `base`). */
  alias: string;
};

/**
 * Which event parameter carries each Credit/Debit field. Names refer to the
 * parameter names in the declared event signature.
 */
export type EventFieldMap = {
  messageId: string;
  amount: string;
  /** Absent when the bridge does not carry the recipient on that side. */
  recipient: string | null;
  /** Debit: destination selector parameter. Credit: claimed source selector parameter. */
  remoteChain: string;
};

export type BridgeEvents = {
  debitEvent: string;
  creditEvent: string;
  debitFields: EventFieldMap;
  creditFields: EventFieldMap;
};

/**
 * CCIP 2.0.0 lane. Pool events carry no message id, so the adapter pairs them
 * with the OnRamp `CCIPMessageSent` / OffRamp `ExecutionStateChanged` log of the
 * same transaction (docs/research/ccip.md); the ramps are part of the spec.
 */
export type CcipBridgeSpec = {
  id: string;
  kind: "ccip_v2";
  /** Token pool address per chain alias. */
  pools: Readonly<Record<string, Hex>>;
  /** OnRamp 2.0.0 per chain alias (one per chain for all lanes). */
  onramps: Readonly<Record<string, Hex>>;
  /** OffRamp 2.0.0 per chain alias. */
  offramps: Readonly<Record<string, Hex>>;
  /** ERC20LockBox that holds lock-release escrow on the home chain; null for burn-mint only lanes. */
  lockbox: Hex | null;
  searchWindowBlocks: bigint;
  maxDeliverySeconds: number;
};

export type CustomBridgeSpec = {
  id: string;
  kind: "custom";
  /** Emitting contract per chain alias. */
  contracts: Readonly<Record<string, Hex>>;
  events: BridgeEvents;
  searchWindowBlocks: bigint;
  maxDeliverySeconds: number;
};

export type BridgeSpec = CcipBridgeSpec | CustomBridgeSpec;

export type HomeSpec = {
  chain: ChainRef;
  canonical: Hex;
  /** Required for lock_release_home; null for burn_mint_multi. */
  escrow: Hex | null;
  decimals: number;
};

export type RemoteSpec = {
  chain: ChainRef;
  token: Hex;
  minters: readonly string[];
  decimals: number;
};

/** Typed, normalized form of a KIRCH-SPEC YAML document (PRD section 6). */
export type TokenSpec = {
  specVersion: 1;
  token: string;
  tokenId: Hex;
  model: Model;
  unit: Unit;
  home: HomeSpec;
  remotes: readonly RemoteSpec[];
  bridges: readonly BridgeSpec[];
  reserves: { porFeed: Hex | null; decimals: number };
  confidence: { default: Confidence; overrides: Readonly<Record<string, Confidence>> };
  rules: {
    junction: { matchWindowSeconds: bigint };
    loop: { toleranceWei: bigint; breachConfirmations: number };
    soft: { flowLimitPerHour: bigint | null };
    stalenessSeconds: bigint;
    onStale: OnStale;
  };
  response: {
    onBroken: readonly ResponseAction[];
    replayRequires: "issuer_multisig";
    recoveryTimelockSeconds: bigint;
  };
};

export type PinnedBlock = { chain: ChainSel; block: bigint };

type SnapshotBase = {
  epochId: bigint;
  pinned: readonly PinnedBlock[];
  /** Raw `totalSupply` (or total shares) per chain, in that chain's own decimals. */
  supplies: readonly { chain: ChainSel; supply: bigint }[];
  /** Locked-not-minted, canonical units, from message matching. */
  inFlightOut: bigint;
  /** Burned-not-released, canonical units, from message matching. */
  inFlightIn: bigint;
  /** Canonical units credited inside the trailing hour, for the FLOW_LIMIT soft rule. */
  flowLastHour: bigint;
  /** Consecutive earlier epochs that already showed a deficit (for `breach_confirmations`). */
  priorDeficitEpochs: number;
};

export type LockReleaseSnapshot = SnapshotBase & {
  model: "lock_release_home";
  /** Sum of every home escrow holder's balance (escrow adapter plus lock-release pools), home decimals. */
  escrow: bigint;
};

export type BurnMintSnapshot = SnapshotBase & {
  model: "burn_mint_multi";
  /** I_net: issuer mints minus burns, canonical units. */
  issuanceNet: bigint;
  /** Proof of Reserve answer in the feed's decimals; null when the spec has no PoR feed. */
  reserve: bigint | null;
};

export type Snapshot = LockReleaseSnapshot | BurnMintSnapshot;

/** Mirrors the Solidity `Epoch` struct (PRD section 7). */
export type Epoch = {
  epochId: bigint;
  delta: bigint;
  evaluatedAt: bigint;
  blocksHash: Hex;
  evidenceHash: Hex;
  status: Status;
  reason: Reason;
};

export type JunctionResult = {
  status: typeof Status.CONSERVED | typeof Status.DRIFT | typeof Status.BROKEN;
  reason: Reason;
  /** Present only when the credit settled a debit (status CONSERVED). */
  settledMessageId?: Hex;
};

export type LoopResult = {
  status: typeof Status.CONSERVED | typeof Status.DRIFT | typeof Status.BROKEN;
  reason: Reason;
  /** Backing minus claims, canonical units. */
  delta: bigint;
  backing: bigint;
  claims: bigint;
  /** Positive part of delta: unclaimed surplus, e.g. escrow donations. */
  surplus: bigint;
  /** True when delta < -tolerance, whether or not breach_confirmations is reached yet. */
  deficit: boolean;
};

/**
 * PENDING is not a verdict: the Judge answers it with HTTP 503 so the CCV
 * verifier retries, because a FAIL drops the message permanently (INTERFACES.md revision 2).
 */
export type Decision = "PASS" | "FAIL" | "PENDING";

/** Judge outcome for one CCIP message. */
export type Verdict = {
  decision: Decision;
  reason: Reason;
  note: string;
};

/** Raised for programmer errors in engine inputs (shape mismatches), never for rule outcomes. */
export class EngineInputError extends Error {
  override readonly name = "EngineInputError";
}

/** Message of an unknown thrown value, for error reports that must not lose the cause. */
export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
