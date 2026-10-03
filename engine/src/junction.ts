import { isHome } from "./chains.ts";
import { toCanonical } from "./units.ts";
import { Reason, Status, type ChainSel, type Credit, type Debit, type Hex, type JunctionResult, type TokenSpec } from "./types.ts";

export type JunctionContext = {
  spec: TokenSpec;
  /** Source chain head block at the spec's required confidence for that chain. */
  sourceHead: bigint;
  /**
   * True when every source block that could hold the matching debit is already
   * at or below the required confidence, so a missing debit can never appear.
   */
  sourceFinal: boolean;
  /** Whether the message id was already consumed by an earlier credit (ConservationLedger.isConsumed). */
  isConsumed: (messageId: Hex) => boolean;
  /** Block timestamp of the credit, seconds. */
  creditTimestamp: bigint;
  /** Evaluation timestamp, seconds. Passed in because the engine never reads a clock. */
  now: bigint;
};

const settled = (messageId: Hex): JunctionResult => ({
  status: Status.CONSERVED,
  reason: Reason.OK,
  settledMessageId: messageId,
});
const broken = (reason: Reason): JunctionResult => ({ status: Status.BROKEN, reason });
const pending: JunctionResult = { status: Status.DRIFT, reason: Reason.PENDING_ATTESTATION };

function sameAddress(a: Hex, b: Hex): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * A credit with no confident debit yet is DRIFT while it is inside the match
 * window, then BROKEN. Once the source side is final, absence is proof of forgery.
 */
function unmatched(ctx: JunctionContext): JunctionResult {
  if (ctx.sourceFinal) return broken(Reason.DEBIT_NOT_FOUND);
  const windowEnds = ctx.creditTimestamp + ctx.spec.rules.junction.matchWindowSeconds;
  return ctx.now <= windowEnds ? pending : broken(Reason.DEBIT_NOT_FOUND);
}

/**
 * PRD section 6 Junction Rule for one credit. The token half of condition 2 is
 * enforced by the adapters, which only decode logs emitted by the spec's own
 * contracts on each chain.
 */
export function junction(credit: Credit, debit: Debit | null, ctx: JunctionContext): JunctionResult {
  if (debit === null) {
    // A replayed id was already settled; the debit may be outside this lookup window, but it is spent.
    return ctx.isConsumed(credit.messageId) ? broken(Reason.DOUBLE_CREDIT) : unmatched(ctx);
  }
  // 1. Same message id from the claimed source chain, sent to this destination.
  if (
    debit.messageId.toLowerCase() !== credit.messageId.toLowerCase() ||
    debit.srcChain !== credit.claimedSrcChain ||
    debit.dstChain !== credit.dstChain
  ) {
    return unmatched(ctx);
  }
  // 2. Same amount once both sides are in canonical base units.
  const debitAmount = toCanonical(ctx.spec, debit.srcChain, debit.amount);
  const creditAmount = toCanonical(ctx.spec, credit.dstChain, credit.amount);
  if (debitAmount !== creditAmount) return broken(Reason.AMOUNT_MISMATCH);
  // 3. Same recipient, when the bridge carries it on both sides.
  if (debit.recipient !== undefined && credit.recipient !== undefined && !sameAddress(debit.recipient, credit.recipient)) {
    return broken(Reason.RECIPIENT_MISMATCH);
  }
  // 4. The debit must be at or below the source chain's required confidence.
  if (debit.block > ctx.sourceHead) return unmatched({ ...ctx, sourceFinal: false });
  // 5. Not already consumed by an earlier credit.
  if (ctx.isConsumed(debit.messageId)) return broken(Reason.DOUBLE_CREDIT);
  return settled(debit.messageId);
}

export type SourceView = {
  /** Head block at the chain's required confidence. */
  head: bigint;
  /** Timestamp of that head block, seconds. */
  headTimestamp: bigint;
};

export type MatchContext = {
  now: bigint;
  /**
   * Confident head per chain. For W2 this is the pinned block of the epoch, so
   * it also decides which debits the snapshot balances already reflect. A chain
   * with no entry is treated as not final at block 0.
   */
  sources: ReadonlyMap<ChainSel, SourceView>;
  isConsumed: (messageId: Hex) => boolean;
};

/** A credit with its block timestamp, which the match window is measured from. */
export type TimedCredit = { credit: Credit; timestamp: bigint };

export type CreditVerdict = { credit: Credit; timestamp: bigint; result: JunctionResult };

export type MatchResult = {
  verdicts: readonly CreditVerdict[];
  /** Message ids settled in this batch, in credit order: the EPOCH `settledMessageIds`. */
  settled: readonly Hex[];
  /** Debits at or below their chain's pin with no credit yet and not previously consumed. Each counts once in F. */
  inFlight: readonly Debit[];
  /** Net locked-on-home not yet credited, canonical units. */
  inFlightOut: bigint;
  /** Net burned-on-remote not yet credited, canonical units. */
  inFlightIn: bigint;
  /** Canonical amount and timestamp of every settled credit, for the FLOW_LIMIT soft rule. */
  settledFlow: readonly FlowEntry[];
};

export type FlowEntry = { timestamp: bigint; amount: bigint };

/** Sum of flow entries inside the trailing window ending at `now` (one hour for `flow_limit_per_hour`). */
export function trailingFlow(entries: readonly FlowEntry[], now: bigint, windowSeconds = 3600n): bigint {
  let total = 0n;
  for (const entry of entries) {
    if (entry.timestamp <= now && entry.timestamp + windowSeconds > now) total += entry.amount;
  }
  return total;
}

type DebitSlot = { debit: Debit; ambiguous: boolean };

function debitKey(chain: ChainSel, messageId: Hex): string {
  return `${chain.toString()}:${messageId.toLowerCase()}`;
}

/**
 * Indexes debits by (source chain, message id). An identical repeat of the same
 * log is harmless; two different debits under one key violate "exactly one
 * debit" and make every credit for that key unmatched.
 */
function indexDebits(debits: readonly Debit[]): Map<string, DebitSlot> {
  const index = new Map<string, DebitSlot>();
  for (const debit of debits) {
    const key = debitKey(debit.srcChain, debit.messageId);
    const existing = index.get(key);
    if (existing === undefined) {
      index.set(key, { debit, ambiguous: false });
    } else if (existing.debit.txHash.toLowerCase() !== debit.txHash.toLowerCase()) {
      existing.ambiguous = true;
    }
  }
  return index;
}

/**
 * Pairs a batch of credits with debits by message id and derives in-flight
 * amounts from matching alone, never from snapshot timing.
 *
 * Chains are pinned at different heights, so a credit can sit inside its
 * chain's pin while its fully matching debit is still above the source pin
 * (source finality slower than the destination). The snapshot then shows the
 * credit but not yet the debit, so that amount is subtracted from F once per
 * message. Without it a valid fast transfer reads as a deficit.
 *
 * The batch must not overlap credits already settled onchain, or their ids
 * read as consumed.
 */
export function matchAll(
  debits: readonly Debit[],
  credits: readonly TimedCredit[],
  spec: TokenSpec,
  ctx: MatchContext,
): MatchResult {
  const index = indexDebits(debits);
  const consumedHere = new Set<string>();
  const creditedAhead = new Set<string>();
  const verdicts: CreditVerdict[] = [];
  const settledIds: Hex[] = [];
  const settledFlow: FlowEntry[] = [];
  let inFlightOut = 0n;
  let inFlightIn = 0n;
  const addInFlight = (debit: Debit, sign: 1n | -1n): void => {
    const amount = sign * toCanonical(spec, debit.srcChain, debit.amount);
    if (isHome(spec, debit.srcChain)) inFlightOut += amount;
    else inFlightIn += amount;
  };

  for (const { credit, timestamp: creditTimestamp } of credits) {
    const key = debitKey(credit.claimedSrcChain, credit.messageId);
    const slot = index.get(key);
    const debit = slot === undefined || slot.ambiguous ? null : slot.debit;
    const source = ctx.sources.get(credit.claimedSrcChain);
    const sourceHead = source?.head ?? 0n;
    const result = junction(credit, debit, {
      spec,
      sourceHead,
      sourceFinal: source !== undefined && source.headTimestamp >= creditTimestamp,
      isConsumed: (id) => consumedHere.has(debitKey(credit.claimedSrcChain, id)) || ctx.isConsumed(id),
      creditTimestamp,
      now: ctx.now,
    });
    verdicts.push({ credit, timestamp: creditTimestamp, result });
    if (result.settledMessageId !== undefined) {
      consumedHere.add(key);
      settledIds.push(result.settledMessageId);
      settledFlow.push({ timestamp: creditTimestamp, amount: toCanonical(spec, credit.dstChain, credit.amount) });
    } else if (
      result.status === Status.DRIFT &&
      debit !== null &&
      debit.dstChain === credit.dstChain &&
      debit.block > sourceHead &&
      !creditedAhead.has(key)
    ) {
      creditedAhead.add(key);
      addInFlight(debit, -1n);
    }
  }

  const inFlight: Debit[] = [];
  for (const [key, { debit }] of index) {
    if (consumedHere.has(key) || ctx.isConsumed(debit.messageId)) continue;
    // A debit above its chain's pin is not in the snapshot balances yet.
    if (debit.block > (ctx.sources.get(debit.srcChain)?.head ?? 0n)) continue;
    inFlight.push(debit);
    addInFlight(debit, 1n);
  }

  return { verdicts, settled: settledIds, inFlight, inFlightOut, inFlightIn, settledFlow };
}
