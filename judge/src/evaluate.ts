/**
 * The I/O shell around the engine's pure judge-core (PRD section 9 steps 2 to 9). It turns one
 * policy hook request into the engine's JudgeInput by reading both chains through both providers,
 * and turns the engine's decision into an HTTP outcome (Revision 2: pending is 503, never FAIL).
 */
import {
  Reason,
  Status,
  judge,
  parseHookRequest,
  protectedTransfer,
  reasonName,
  toReason,
  type Hex,
  type JudgeDecision,
  type ParsedMessage,
  type ProviderPair,
  type Read,
  type ReadPair,
  type SourceDebitLookup,
  type StatusRead,
  type TokenEvaluation,
} from "@kirchhoff/engine";
import { decodeEventLog, toHex, type PublicClient } from "viem";
import {
  LEDGER_ABI,
  LOCKED_OR_BURNED_ABI,
  MULTICALL3,
  QUARANTINE_ABI,
  TOPIC_CCIP_MESSAGE_SENT,
  TOPIC_LOCKED_OR_BURNED,
} from "./abi.ts";
import { readBoth, type ChainProviders } from "./rpc.ts";
import type { EvaluateRequest } from "./schema.ts";
import type { ChainContracts, ProtectedToken, SpecCache } from "./spec-cache.ts";

export type Evidence = Readonly<Record<string, unknown>>;

export type Outcome =
  | {
      kind: "verdict";
      decision: "PASS" | "FAIL";
      reason: Reason;
      reasonString: string;
      symbol: string | null;
      evidence: Evidence;
    }
  | { kind: "pending"; reasonString: string; symbol: string | null; evidence: Evidence }
  | { kind: "invalid"; error: string };

export type EvaluateDeps = {
  cache: SpecCache;
  providersFor: (selector: bigint) => ChainProviders | undefined;
};

const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;
const CONTAINED: readonly Status[] = [Status.BROKEN, Status.QUARANTINED, Status.RECOVERING];

/** statusOf plus the epoch fields the engine needs, from one provider. */
type LedgerView = { status: Status; delta: bigint; stale: boolean; epochId: bigint; epochReason: Reason };

export type DebitView =
  | { kind: "found"; amount: bigint; token: Hex; logIndex: number }
  | { kind: "missing"; why: string };

type TokenReads = {
  token: ProtectedToken;
  amount: bigint;
  source: ReadPair<LedgerView>;
  destination: ReadPair<LedgerView>;
  sourceFrozen: ReadPair<boolean>;
  destinationFrozen: ReadPair<boolean>;
  senderTainted: ReadPair<boolean>;
  incident: ReadPair<Hex>;
  breachReason: ReadPair<number> | null;
  debit: ReadPair<DebitView>;
};

function toStatus(value: number): Status {
  if (!Number.isInteger(value) || value < Status.UNKNOWN || value > Status.RECOVERING) {
    throw new Error(`unknown status ${value}`);
  }
  return value as Status;
}

type CallResult<T> = { status: "success"; result: T } | { status: "failure"; error: Error };

function fromCall<T>(r: CallResult<T>): Read<T> {
  return r.status === "success" ? { ok: true, value: r.result } : { ok: false, error: r.error.message.split("\n")[0] ?? "call failed" };
}

function ledgerRead(
  status: CallResult<readonly [number, bigint, bigint, boolean]>,
  epoch: CallResult<{ epochId: bigint; reason: number }>,
): Read<LedgerView> {
  const s = fromCall(status);
  const e = fromCall(epoch);
  if (!s.ok) return s;
  if (!e.ok) return e;
  try {
    const [code, delta, , stale] = s.value;
    return { ok: true, value: { status: toStatus(code), delta, stale, epochId: e.value.epochId, epochReason: toReason(e.value.reason) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

type SourceView = { ledger: Read<LedgerView>; frozen: Read<boolean>; tainted: Read<boolean> };
type DestinationView = { ledger: Read<LedgerView>; frozen: Read<boolean>; incident: Read<Hex> };

/**
 * One Multicall3 eth_call per chain per provider: every value comes from the same block, and the
 * provider sees one request instead of four (canonical Multicall3 is live on all three testnets).
 */
async function sourceView(client: PublicClient, c: ChainContracts, tokenId: Hex, sender: Hex): Promise<SourceView> {
  const [status, epoch, frozen, tainted] = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: [
      { address: c.ledger, abi: LEDGER_ABI, functionName: "statusOf", args: [tokenId] },
      { address: c.ledger, abi: LEDGER_ABI, functionName: "latestEpoch", args: [tokenId] },
      { address: c.quarantine, abi: QUARANTINE_ABI, functionName: "isFrozen", args: [tokenId] },
      { address: c.quarantine, abi: QUARANTINE_ABI, functionName: "isTainted", args: [tokenId, sender] },
    ],
  });
  return { ledger: ledgerRead(status, epoch), frozen: fromCall(frozen), tainted: fromCall(tainted) };
}

async function destinationView(client: PublicClient, c: ChainContracts, tokenId: Hex): Promise<DestinationView> {
  const [status, epoch, frozen, incident] = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: [
      { address: c.ledger, abi: LEDGER_ABI, functionName: "statusOf", args: [tokenId] },
      { address: c.ledger, abi: LEDGER_ABI, functionName: "latestEpoch", args: [tokenId] },
      { address: c.quarantine, abi: QUARANTINE_ABI, functionName: "isFrozen", args: [tokenId] },
      { address: c.ledger, abi: LEDGER_ABI, functionName: "activeIncident", args: [tokenId] },
    ],
  });
  return { ledger: ledgerRead(status, epoch), frozen: fromCall(frozen), incident: fromCall(incident) };
}

/** Projects one field out of a pair of per-provider views; a failed view fails every field. */
function field<V, T>(pair: ReadPair<V>, pick: (v: V) => Read<T>): ReadPair<T> {
  const one = (r: Read<V>): Read<T> => (r.ok ? pick(r.value) : r);
  return [one(pair[0]), one(pair[1])];
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

type RpcLog = { address: Hex; topics: Hex[]; data: Hex; transactionHash: Hex | null; logIndex: Hex | null };

/**
 * PRD step 8 on CCIP 2.0.0: the pool's LockedOrBurned carries no message id, so the debit is the
 * last LockedOrBurned from the spec's pool that precedes the OnRamp's CCIPMessageSent for this
 * message id in the same transaction (Revision 2, item 2).
 */
export async function lookupDebit(
  client: PublicClient,
  src: ChainContracts,
  dstSelector: bigint,
  messageId: Hex,
  txHash: Hex,
  blockNumber: number,
): Promise<DebitView> {
  if (src.onRamp === null || src.pool === null) return { kind: "missing", why: `no CCIP onramp or pool configured on ${src.name}` };
  const block = toHex(blockNumber);
  const logs: readonly RpcLog[] = await client.request({
    method: "eth_getLogs",
    params: [{ fromBlock: block, toBlock: block, address: [src.onRamp, src.pool], topics: [[TOPIC_CCIP_MESSAGE_SENT, TOPIC_LOCKED_OR_BURNED]] }],
  });
  const inTx = logs.filter((l) => l.transactionHash !== null && sameAddress(l.transactionHash, txHash));
  const sent = inTx.find(
    (l) =>
      sameAddress(l.address, src.onRamp ?? "") &&
      l.topics[0] === TOPIC_CCIP_MESSAGE_SENT &&
      l.topics[3] !== undefined &&
      sameAddress(l.topics[3], messageId),
  );
  if (sent === undefined) return { kind: "missing", why: "no CCIPMessageSent for this message id in the source tx" };
  if (sent.topics[1] === undefined || BigInt(sent.topics[1]) !== dstSelector) {
    return { kind: "missing", why: "CCIPMessageSent names a different destination" };
  }
  const sentIndex = Number(sent.logIndex);
  const burn = inTx
    .filter(
      (l) =>
        sameAddress(l.address, src.pool ?? "") &&
        l.topics[0] === TOPIC_LOCKED_OR_BURNED &&
        l.topics[1] !== undefined &&
        BigInt(l.topics[1]) === dstSelector &&
        Number(l.logIndex) < sentIndex,
    )
    .sort((a, b) => Number(b.logIndex) - Number(a.logIndex))[0];
  if (burn === undefined) return { kind: "missing", why: "no pool LockedOrBurned before CCIPMessageSent" };
  const decoded = decodeEventLog({ abi: LOCKED_OR_BURNED_ABI, data: burn.data, topics: burn.topics as [Hex, ...Hex[]] });
  const token = decoded.args.token.toLowerCase() as Hex;
  if (!sameAddress(token, src.token)) return { kind: "missing", why: `pool debit is for token ${token}` };
  return { kind: "found", amount: decoded.args.amount, token, logIndex: Number(burn.logIndex) };
}

async function readToken(
  token: ProtectedToken,
  amount: bigint,
  message: ParsedMessage,
  req: EvaluateRequest,
  deps: EvaluateDeps,
  signal: AbortSignal,
): Promise<TokenReads> {
  const src = token.chains.get(message.srcChain);
  const dst = token.chains.get(message.dstChain);
  const srcRpc = deps.providersFor(message.srcChain);
  const dstRpc = deps.providersFor(message.dstChain);
  if (src === undefined || dst === undefined || srcRpc === undefined || dstRpc === undefined) {
    throw new Error("chain resolution must precede reads");
  }
  const { tokenId } = token;
  const [srcViews, dstViews, debit] = await Promise.all([
    readBoth(srcRpc, (c) => sourceView(c, src, tokenId, message.sender)),
    readBoth(dstRpc, (c) => destinationView(c, dst, tokenId)),
    readBoth(srcRpc, (c) => lookupDebit(c, src, message.dstChain, message.messageId, message.sourceTxHash, req.source_block_number)),
  ]);
  const source = field(srcViews, (v) => v.ledger);
  const destination = field(dstViews, (v) => v.ledger);
  const sourceFrozen = field(srcViews, (v) => v.frozen);
  const destinationFrozen = field(dstViews, (v) => v.frozen);
  const senderTainted = field(srcViews, (v) => v.tainted);
  const incident = field(dstViews, (v) => v.incident);

  // The breach reason only feeds the FAIL note of a contained token, so it costs a second round
  // trip on that path alone.
  let breachReason: ReadPair<number> | null = null;
  const contained = [...source, ...destination].some((r) => r.ok && CONTAINED.includes(r.value.status));
  const [i1, i2] = incident;
  if (contained && !signal.aborted && i1.ok && i2.ok && i1.value === i2.value && i1.value !== ZERO_HASH) {
    const incidentId = i1.value;
    breachReason = await readBoth(dstRpc, async (c) => {
      const breach = await c.readContract({ address: dst.ledger, abi: LEDGER_ABI, functionName: "breachOf", args: [incidentId] });
      return breach.reason;
    });
  }
  return { token, amount, source, destination, sourceFrozen, destinationFrozen, senderTainted, incident, breachReason, debit };
}

function agreedBreachReason(pair: ReadPair<number> | null): Reason | null {
  if (pair === null) return null;
  const [a, b] = pair;
  if (!a.ok || !b.ok || a.value !== b.value) return null;
  try {
    return toReason(a.value);
  } catch {
    return null;
  }
}

function toProviderPair(pair: ReadPair<LedgerView>, breachReason: Reason | null): ProviderPair {
  const one = (r: Read<LedgerView>): StatusRead =>
    r.ok
      ? {
          ok: true,
          status: r.value.status,
          delta: r.value.delta,
          epochId: r.value.epochId,
          stale: r.value.stale,
          reason: CONTAINED.includes(r.value.status) && breachReason !== null ? breachReason : r.value.epochReason,
        }
      : { ok: false, error: r.error };
  return [one(pair[0]), one(pair[1])];
}

/** Frozen on either chain, per provider; an error on either chain makes that provider's answer an error. */
function frozenEither(source: ReadPair<boolean>, destination: ReadPair<boolean>): ReadPair<boolean> {
  const one = (s: Read<boolean>, d: Read<boolean>): Read<boolean> => (!s.ok ? s : !d.ok ? d : { ok: true, value: s.value || d.value });
  return [one(source[0], destination[0]), one(source[1], destination[1])];
}

function toLookup(d: DebitView): SourceDebitLookup {
  return d.kind === "found" ? { kind: "found", amount: d.amount } : { kind: "missing" };
}

function pendingDecision(symbol: string | null, note: string): JudgeDecision {
  const reasonString = [reasonName(Reason.PENDING_ATTESTATION), symbol, note].filter((p) => p !== null).join(" ");
  return { decision: "PENDING", reason: Reason.PENDING_ATTESTATION, note, symbol, reasonString };
}

function readJson<T>(r: Read<T>): unknown {
  return r.ok ? r.value : { error: r.error };
}

function evidenceOf(reads: TokenReads, message: ParsedMessage, req: EvaluateRequest): Evidence {
  return {
    token: reads.token.symbol,
    tokenId: reads.token.tokenId,
    amount: reads.amount,
    sourceChain: message.srcChain,
    destinationChain: message.dstChain,
    sender: message.sender,
    sourceTx: message.sourceTxHash,
    sourceBlock: req.source_block_number,
    verifierId: req.verifier_id,
    source: reads.source.map(readJson),
    destination: reads.destination.map(readJson),
    sourceFrozen: reads.sourceFrozen.map(readJson),
    destinationFrozen: reads.destinationFrozen.map(readJson),
    senderTainted: reads.senderTainted.map(readJson),
    incident: reads.incident.map(readJson),
    breachReason: reads.breachReason?.map(readJson) ?? null,
    debit: reads.debit.map(readJson),
  };
}

function toOutcome(d: JudgeDecision, evidence: Evidence): Outcome {
  // Revision 2: a FAIL drops the message for good, so anything not yet confirmable is a retry.
  if (d.decision === "PENDING" || d.reason === Reason.PENDING_ATTESTATION) {
    return { kind: "pending", reasonString: d.reasonString, symbol: d.symbol, evidence };
  }
  return { kind: "verdict", decision: d.decision, reason: d.reason, reasonString: d.reasonString, symbol: d.symbol, evidence };
}

const FAILED_READ: ProviderPair = [
  { ok: false, error: "not read" },
  { ok: false, error: "not read" },
];
const NOT_READ = { ok: false, error: "not read" } as const;

type Expired = { expired: true };

function race<T>(work: Promise<T>, deadline: Promise<Expired>): Promise<T | Expired> {
  return Promise.race([work, deadline]);
}

function isExpired(value: unknown): value is Expired {
  return typeof value === "object" && value !== null && "expired" in value;
}

/**
 * PRD section 9 steps 2 to 9 for one request. `deadline` resolves when the 2 s budget is spent;
 * reads still in flight are abandoned and the engine answers with budgetExceeded.
 */
export async function evaluate(
  req: EvaluateRequest,
  deps: EvaluateDeps,
  deadline: Promise<Expired>,
  signal: AbortSignal,
): Promise<Outcome> {
  // Step 2: normalize. A message outside every spec's chains is out of scope even when it is not EVM-shaped.
  const parsedResult = parseHookRequest(req);
  if (!parsedResult.ok) {
    const source = BigInt(req.message.source_chain_selector);
    const inScope = deps.cache.tokens.some((t) => t.chains.has(source));
    if (inScope) return { kind: "invalid", error: parsedResult.error };
    const d = judge({ messageId: req.message_id.toLowerCase() as Hex, token: null, budgetExceeded: false });
    return toOutcome(d, { messageId: req.message_id, note: "source chain outside every spec" });
  }
  const message = parsedResult.message;

  // Steps 3 and 4: map the transfer to a protected token.
  const pt = protectedTransfer(message, deps.cache.entries);
  if (pt === null) return toOutcome(judge({ messageId: message.messageId, token: null, budgetExceeded: false }), { messageId: message.messageId });
  const token = deps.cache.byTokenId(pt.entry.tokenId);
  if (token === undefined) throw new Error(`spec cache entry ${pt.entry.tokenId} has no token`);
  const active = deps.cache.active(token.tokenId);
  const evidenceBase = { messageId: message.messageId, token: token.symbol };
  if (active.state === "unsynced") return toOutcome(pendingDecision(token.symbol, `${active.note}, retry`), evidenceBase);

  const base: TokenEvaluation = {
    symbol: token.symbol,
    tokenId: token.tokenId,
    amount: pt.amount,
    cachedSpecHash: token.cachedSpecHash,
    activeSpecHash: active.activeSpecHash,
    onStale: token.onStale,
    laneInSpec: token.chains.has(message.srcChain) && token.chains.has(message.dstChain),
    source: FAILED_READ,
    destination: FAILED_READ,
    frozen: [NOT_READ, NOT_READ],
    senderTainted: [NOT_READ, NOT_READ],
    sourceDebit: [NOT_READ, NOT_READ],
    incidentId: null,
  };
  // Step 3 needs no RPC: the engine answers registry disagreement and undeclared lanes before any read.
  const registryOnly = judge({ messageId: message.messageId, token: base, budgetExceeded: true });
  if (registryOnly.decision === "FAIL") {
    return toOutcome(registryOnly, { ...evidenceBase, destinationChain: message.dstChain, cachedSpecHash: token.cachedSpecHash, activeSpecHash: active.activeSpecHash });
  }
  if (deps.providersFor(message.srcChain) === undefined || deps.providersFor(message.dstChain) === undefined) {
    throw new Error("spec chain without RPC providers");
  }

  const reads = await race(readToken(token, pt.amount, message, req, deps, signal), deadline);
  if (isExpired(reads)) return toOutcome(judge({ messageId: message.messageId, token: base, budgetExceeded: true }), evidenceBase);

  const breachReason = agreedBreachReason(reads.breachReason);
  const [inc1, inc2] = reads.incident;
  const incidentId = inc1.ok && inc2.ok && inc1.value === inc2.value && inc1.value !== ZERO_HASH ? inc1.value : null;
  const evaluation: TokenEvaluation = {
    ...base,
    source: toProviderPair(reads.source, breachReason),
    destination: toProviderPair(reads.destination, breachReason),
    frozen: frozenEither(reads.sourceFrozen, reads.destinationFrozen),
    senderTainted: reads.senderTainted,
    sourceDebit: [
      reads.debit[0].ok ? { ok: true, value: toLookup(reads.debit[0].value) } : reads.debit[0],
      reads.debit[1].ok ? { ok: true, value: toLookup(reads.debit[1].value) } : reads.debit[1],
    ],
    incidentId,
  };
  const decision = judge({ messageId: message.messageId, token: evaluation, budgetExceeded: false });
  return toOutcome(decision, { messageId: message.messageId, ...evidenceOf(reads, message, req) });
}
