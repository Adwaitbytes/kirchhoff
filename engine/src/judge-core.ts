import {
  Reason,
  describeError,
  Status,
  reasonName,
  statusName,
  type ChainSel,
  type Decision,
  type Hex,
  type OnStale,
  type Verdict,
} from "./types.ts";

/** The single token transfer of a CCIP 2.0 message (OnRamp 2.0.0 allows at most one). */
export type HookTokenTransfer = {
  amount: bigint;
  sourceToken: Hex;
  sourcePool: Hex;
  destToken: Hex;
  receiver: Hex;
};

/** The parts of a policy hook v1 request the Judge uses, normalized. */
export type ParsedMessage = {
  messageId: Hex;
  sourceTxHash: Hex;
  srcChain: ChainSel;
  dstChain: ChainSel;
  sender: Hex;
  receiver: Hex;
  /** Null for a data-only message. */
  transfer: HookTokenTransfer | null;
};

export type HookParseResult = { ok: true; message: ParsedMessage } | { ok: false; error: string };

const DECIMAL = /^[0-9]{1,78}$/;
const HEX32 = /^0x[0-9a-f]{64}$/;
const UINT64_MAX = (1n << 64n) - 1n;

type Json = Readonly<Record<string, unknown>>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Hook addresses are lowercase hex left-padded to at least 32 bytes. An EVM
 * address is the last 20 bytes with all-zero padding; anything else (a longer
 * non-EVM address, non-zero padding) is not an address on our chains.
 */
export function evmAddress(value: string): Hex | null {
  const hex = value.toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(hex)) return null;
  const digits = hex.slice(2);
  if (digits.length === 40) return hex as Hex;
  if (digits.length !== 64 || !/^0{24}$/.test(digits.slice(0, 24))) return null;
  return `0x${digits.slice(24)}`;
}

function field(obj: Json, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function selector(obj: Json, key: string): bigint {
  const text = field(obj, key);
  // Selectors exceed 2^53, so the hook sends them as decimal strings; never parse through Number.
  if (!DECIMAL.test(text) || BigInt(text) > UINT64_MAX) throw new Error(`${key} must be a uint64 decimal string`);
  return BigInt(text);
}

function address(obj: Json, key: string): Hex {
  const parsed = evmAddress(field(obj, key));
  if (parsed === null) throw new Error(`${key} is not an EVM address`);
  return parsed;
}

function hex32(obj: Json, key: string): Hex {
  const text = field(obj, key).toLowerCase();
  if (!HEX32.test(text)) throw new Error(`${key} must be 32-byte hex`);
  return text as Hex;
}

/** Validates and normalizes a policy hook v1 request body (docs/research/ccv.md). Pure: no IO, no clock. */
export function parseHookRequest(body: unknown): HookParseResult {
  try {
    if (!isObject(body)) throw new Error("body must be an object");
    if (body.schema_version !== "v1") throw new Error("schema_version must be v1");
    const message = body.message;
    if (!isObject(message)) throw new Error("message must be an object");
    const tt = message.token_transfer;
    let transfer: HookTokenTransfer | null = null;
    if (tt !== undefined && tt !== null) {
      if (!isObject(tt)) throw new Error("token_transfer must be an object");
      const amount = field(tt, "amount");
      if (!DECIMAL.test(amount)) throw new Error("amount must be a decimal string");
      transfer = {
        amount: BigInt(amount),
        sourceToken: address(tt, "source_token_address"),
        sourcePool: address(tt, "source_pool_address"),
        destToken: address(tt, "dest_token_address"),
        receiver: address(tt, "token_receiver"),
      };
    }
    return {
      ok: true,
      message: {
        messageId: hex32(body, "message_id"),
        sourceTxHash: hex32(body, "source_tx_hash"),
        srcChain: selector(message, "source_chain_selector"),
        dstChain: selector(message, "dest_chain_selector"),
        sender: address(message, "sender"),
        receiver: address(message, "receiver"),
        transfer,
      },
    };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

/** One entry of the Judge's local spec cache, synced from KirchhoffRegistry. */
export type SpecCacheEntry = {
  symbol: string;
  tokenId: Hex;
  /** Token address per chain selector. */
  addresses: ReadonlyMap<ChainSel, Hex>;
};

export type ProtectedTransfer = { entry: SpecCacheEntry; amount: bigint };

/** PRD section 9 step 3, mapping half: the transferred source token to a cached protected token. */
export function protectedTransfer(message: ParsedMessage, cache: readonly SpecCacheEntry[]): ProtectedTransfer | null {
  const transfer = message.transfer;
  if (transfer === null) return null;
  const entry = cache.find((e) => e.addresses.get(message.srcChain)?.toLowerCase() === transfer.sourceToken);
  return entry === undefined ? null : { entry, amount: transfer.amount };
}

/**
 * `statusOf(tokenId)` from one RPC provider, or the error it returned. For
 * BROKEN, QUARANTINED and RECOVERING, `reason` must come from the active
 * incident's breach record (`breachOf(incident).reason`): the ledger never
 * rewrites latestEpoch on a BREACH, so its epoch reason is stale.
 */
export type StatusRead =
  | { ok: true; status: Status; delta: bigint; epochId: bigint; stale: boolean; reason: Reason }
  | { ok: false; error: string };

export type ProviderPair = readonly [StatusRead, StatusRead];

export type SourceDebitLookup = { kind: "found"; amount: bigint } | { kind: "missing" };

/** One provider's answer for a plain read, or the error it returned. */
export type Read<T> = { ok: true; value: T } | { ok: false; error: string };

/** The same read through the Judge's two independent RPC providers. */
export type ReadPair<T> = readonly [Read<T>, Read<T>];

type Agreed<T> = { ok: true; value: T } | { ok: false };

function agreeOn<T>(pair: ReadPair<T>, same: (a: T, b: T) => boolean): Agreed<T> {
  const [a, b] = pair;
  return a.ok && b.ok && same(a.value, b.value) ? { ok: true, value: a.value } : { ok: false };
}

const sameDebit = (a: SourceDebitLookup, b: SourceDebitLookup): boolean =>
  a.kind === "missing" ? b.kind === "missing" : b.kind === "found" && a.amount === b.amount;

/** Everything the Judge service read for the protected token in the message. */
export type TokenEvaluation = {
  symbol: string;
  tokenId: Hex;
  /** Transfer amount in the message, source chain units. */
  amount: bigint;
  /** Hash of the spec in the local cache. */
  cachedSpecHash: Hex;
  /** Active spec hash in KirchhoffRegistry; null when the registry has no active spec for the token. */
  activeSpecHash: Hex | null;
  onStale: OnStale;
  /**
   * False when the message's destination selector (or its source) is not a
   * chain of the token's spec: a lane the issuer never declared is a
   * definitive SPEC_MISMATCH in step 3.
   */
  laneInSpec: boolean;
  source: ProviderPair;
  destination: ProviderPair;
  /** `isFrozen(tokenId)` through both providers. */
  frozen: ReadPair<boolean>;
  /** `isTainted(tokenId, sender)` through both providers. */
  senderTainted: ReadPair<boolean>;
  /**
   * The source pool debit for the message id through both providers: pool
   * LockedOrBurned paired with CCIPMessageSent in source_tx_hash.
   */
  sourceDebit: ReadPair<SourceDebitLookup>;
  /** Latest incident for the token, quoted in FAIL notes when the token is contained. */
  incidentId: Hex | null;
};

export type JudgeInput = {
  messageId: Hex;
  /** Null when the message carries no protected token. */
  token: TokenEvaluation | null;
  /** True when the 2s budget ran out before every read returned. */
  budgetExceeded: boolean;
};

export type JudgeDecision = Verdict & {
  /** `"<REASON_CODE> <symbol> <short note>"`, at most 256 characters (the verifier's log limit). */
  reasonString: string;
  symbol: string | null;
};

const MAX_REASON_CHARS = 256;

function decide(decision: Decision, reason: Reason, symbol: string | null, note: string): JudgeDecision {
  const parts = [reasonName(reason), symbol, note].filter((p): p is string => p !== null);
  return { decision, reason, note, symbol, reasonString: parts.join(" ").slice(0, MAX_REASON_CHARS) };
}

type AgreedStatus = { ok: true; read: Extract<StatusRead, { ok: true }> } | { ok: false; note: string };

function agree(pair: ProviderPair, side: string): AgreedStatus {
  const [a, b] = pair;
  if (!a.ok || !b.ok) return { ok: false, note: `${side} status read failed, retry` };
  if (a.status !== b.status || a.stale !== b.stale) return { ok: false, note: `${side} providers disagree, retry` };
  return { ok: true, read: a };
}

const CONTAINED: ReadonlyMap<Status, Reason> = new Map<Status, Reason>([
  [Status.BROKEN, Reason.TOKEN_BROKEN],
  [Status.QUARANTINED, Reason.TOKEN_QUARANTINED],
  [Status.RECOVERING, Reason.TOKEN_RECOVERING],
]);

/**
 * PRD section 9 steps 3 to 9 in order, with INTERFACES.md revision 2: an
 * outcome that may change on retry (providers disagree or error, debit not yet
 * visible, budget exceeded) is PENDING, never FAIL, because the verifier drops
 * a FAILed message for good. HMAC (step 1) and parsing (step 2) belong to the
 * HTTP layer and parseHookRequest.
 */
export function judge(input: JudgeInput): JudgeDecision {
  const t = input.token;
  // Step 4 (data-only or unprotected token) before step 3, which only applies to protected tokens.
  if (t === null) return decide("PASS", Reason.OK, null, "no protected token");

  // Step 3: registry agreement.
  if (t.activeSpecHash === null) return decide("FAIL", Reason.UNKNOWN_TOKEN, t.symbol, "no active spec in registry");
  if (t.activeSpecHash.toLowerCase() !== t.cachedSpecHash.toLowerCase()) {
    return decide("FAIL", Reason.SPEC_MISMATCH, t.symbol, "cached spec differs from active registry spec");
  }
  if (!t.laneInSpec) return decide("FAIL", Reason.SPEC_MISMATCH, t.symbol, "lane not in spec");
  if (input.budgetExceeded) return decide("PENDING", Reason.PENDING_ATTESTATION, t.symbol, "time budget exceeded, retry");

  // Step 5: both providers must agree on both chains.
  const src = agree(t.source, "source");
  if (!src.ok) return decide("PENDING", Reason.PENDING_ATTESTATION, t.symbol, src.note);
  const dst = agree(t.destination, "destination");
  if (!dst.ok) return decide("PENDING", Reason.PENDING_ATTESTATION, t.symbol, dst.note);

  // Step 6: contained statuses fail; stale or UNKNOWN applies on_stale.
  for (const read of [src.read, dst.read]) {
    const contained = CONTAINED.get(read.status);
    if (contained !== undefined) {
      const incident = t.incidentId === null ? "" : ` incident=${t.incidentId.slice(0, 6)}...`;
      return decide("FAIL", contained, t.symbol, `${reasonName(read.reason)}${incident}`);
    }
    if ((read.stale || read.status === Status.UNKNOWN) && t.onStale === "fail_closed") {
      return decide("FAIL", Reason.STATUS_STALE, t.symbol, "no fresh epoch, fail_closed");
    }
  }

  // Step 7: containment flags. A flag both providers agree is set fails at once,
  // whatever the other flag reads; only an undecided flag makes the answer PENDING.
  const frozen = agreeOn(t.frozen, (a, b) => a === b);
  const tainted = agreeOn(t.senderTainted, (a, b) => a === b);
  if (frozen.ok && frozen.value) return decide("FAIL", Reason.TOKEN_QUARANTINED, t.symbol, "lanes frozen");
  if (tainted.ok && tainted.value) return decide("FAIL", Reason.TOKEN_QUARANTINED, t.symbol, "sender tainted");
  if (!frozen.ok) return decide("PENDING", Reason.PENDING_ATTESTATION, t.symbol, "providers disagree on frozen, retry");
  if (!tainted.ok) return decide("PENDING", Reason.PENDING_ATTESTATION, t.symbol, "providers disagree on senderTainted, retry");

  // Step 8: the source pool debit for this message id must exist with the same amount.
  const debit = agreeOn(t.sourceDebit, sameDebit);
  if (!debit.ok) return decide("PENDING", Reason.PENDING_ATTESTATION, t.symbol, "providers disagree on sourceDebit, retry");
  if (debit.value.kind === "missing") {
    return decide("PENDING", Reason.PENDING_ATTESTATION, t.symbol, "source debit not yet visible, retry");
  }
  if (debit.value.amount !== t.amount) {
    return decide(
      "FAIL",
      Reason.AMOUNT_MISMATCH,
      t.symbol,
      `debit=${debit.value.amount.toString()} transfer=${t.amount.toString()}`,
    );
  }

  // Step 9.
  const view = dst.read;
  return decide(
    "PASS",
    Reason.OK,
    t.symbol,
    `${statusName(view.status)} delta=${view.delta.toString()} epoch=${view.epochId.toString()}`,
  );
}

export type HookResponse =
  | { status: 200; body: { decision: "PASS" | "FAIL"; reason: string; message_id: Hex } }
  | { status: 503; body: { error: string } };

/** The exact HTTP answer for a decision: verdicts are 200, PENDING is 503 so the verifier retries. */
export function hookResponse(messageId: Hex, d: JudgeDecision): HookResponse {
  if (d.decision === "PENDING") return { status: 503, body: { error: d.reasonString } };
  return { status: 200, body: { decision: d.decision, reason: d.reasonString, message_id: messageId } };
}
