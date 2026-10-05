import { decodeEventLog, type Abi, type Hex, type Log } from "viem";
import {
  bridgeAbi,
  ccipAbi,
  ledgerAbi,
  quarantineAbi,
  registryAbi,
  type Address,
  type ChainDeploymentInfo,
} from "@kirchhoff/sdk";

export type RawLog = Pick<Log<bigint, number, false>, "address" | "topics" | "data" | "blockNumber" | "transactionHash" | "logIndex">;

type Loc = { txHash: Hex; logIndex: number; block: bigint };

/** Every onchain fact the read model mirrors, decoded from one log (CCIP pairs from two). */
export type IndexedEvent = Loc &
  (
    | { kind: "EpochRecorded"; tokenId: Hex; epochId: bigint; delta: bigint; status: number }
    | { kind: "StatusChanged"; tokenId: Hex; from: number; to: number; reason: number }
    | {
        kind: "BreachRecorded";
        tokenId: Hex;
        reason: number;
        evidenceHash: Hex;
        offendingChain: bigint;
        offendingTx: Hex;
        recipient: Address;
        amount: bigint;
      }
    | { kind: "MessageConsumed"; tokenId: Hex; messageId: Hex }
    | { kind: "IncidentOpened"; tokenId: Hex; incidentId: Hex; evidenceHash: Hex }
    | { kind: "RecoveryStarted"; tokenId: Hex; incidentId: Hex; recoveryEndsAt: bigint }
    | { kind: "LanesFrozen"; tokenId: Hex; incidentId: Hex }
    | { kind: "LanesUnfrozen"; tokenId: Hex }
    | { kind: "Tainted"; tokenId: Hex; account: Address; incidentId: Hex }
    | { kind: "Untainted"; tokenId: Hex; account: Address }
    | { kind: "IncidentResolved"; tokenId: Hex; incidentId: Hex; recoveryEndsAt: bigint }
    | { kind: "SpecProposed"; tokenId: Hex; specHash: Hex; specURI: string; eta: bigint }
    | { kind: "SpecActivated"; tokenId: Hex; specHash: Hex; specURI: string; version: bigint }
    | { kind: "SpecProposalCancelled"; tokenId: Hex; specHash: Hex }
    | { kind: "Debit"; bridge: "weakbridge" | "ccip"; messageId: Hex; sender: Address | null; recipient: Address | null; amount: bigint; dstSelector: bigint }
    | { kind: "Credit"; bridge: "weakbridge" | "ccip"; messageId: Hex; recipient: Address | null; amount: bigint; srcSelector: bigint }
  );

const lower = (a: string): Address => a.toLowerCase() as Address;

function tryDecode(abi: Abi, log: RawLog): { eventName: string; args: Record<string, unknown> } | null {
  try {
    const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
    // viem types eventName as possibly undefined for ABIs without a matching event; strict decoding already threw then.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return { eventName: decoded.eventName ?? "", args: (decoded.args ?? {}) as Record<string, unknown> };
  } catch {
    // A log under a watched address with an event we do not mirror (Ownable, config events) is not an error.
    return null;
  }
}

const hex = (v: unknown): Hex => v as Hex;
const big = (v: unknown): bigint => v as bigint;
const num = (v: unknown): number => Number(v);

function decodeLedger(log: RawLog, loc: Loc): IndexedEvent | null {
  const d = tryDecode(ledgerAbi, log);
  if (!d) return null;
  const a = d.args;
  switch (d.eventName) {
    case "EpochRecorded":
      return { ...loc, kind: "EpochRecorded", tokenId: hex(a.tokenId), epochId: big(a.epochId), delta: big(a.delta), status: num(a.status) };
    case "StatusChanged":
      return { ...loc, kind: "StatusChanged", tokenId: hex(a.tokenId), from: num(a.from), to: num(a.to), reason: num(a.reason) };
    case "BreachRecorded":
      return {
        ...loc,
        kind: "BreachRecorded",
        tokenId: hex(a.tokenId),
        reason: num(a.reason),
        evidenceHash: hex(a.evidenceHash),
        offendingChain: big(a.offendingChain),
        offendingTx: hex(a.offendingTx),
        recipient: lower(a.recipient as string),
        amount: big(a.amount),
      };
    case "MessageConsumed":
      return { ...loc, kind: "MessageConsumed", tokenId: hex(a.tokenId), messageId: hex(a.messageId) };
    case "IncidentOpened":
      return { ...loc, kind: "IncidentOpened", tokenId: hex(a.tokenId), incidentId: hex(a.incidentId), evidenceHash: hex(a.evidenceHash) };
    case "RecoveryStarted":
      return { ...loc, kind: "RecoveryStarted", tokenId: hex(a.tokenId), incidentId: hex(a.incidentId), recoveryEndsAt: big(a.recoveryEndsAt) };
    default:
      return null;
  }
}

function decodeQuarantine(log: RawLog, loc: Loc): IndexedEvent | null {
  const d = tryDecode(quarantineAbi, log);
  if (!d) return null;
  const a = d.args;
  switch (d.eventName) {
    case "LanesFrozen":
      return { ...loc, kind: "LanesFrozen", tokenId: hex(a.tokenId), incidentId: hex(a.incidentId) };
    case "LanesUnfrozen":
      return { ...loc, kind: "LanesUnfrozen", tokenId: hex(a.tokenId) };
    case "Tainted":
      return { ...loc, kind: "Tainted", tokenId: hex(a.tokenId), account: lower(a.account as string), incidentId: hex(a.incidentId) };
    case "Untainted":
      return { ...loc, kind: "Untainted", tokenId: hex(a.tokenId), account: lower(a.account as string) };
    case "IncidentResolved":
      return { ...loc, kind: "IncidentResolved", tokenId: hex(a.tokenId), incidentId: hex(a.incidentId), recoveryEndsAt: big(a.recoveryEndsAt) };
    default:
      return null;
  }
}

function decodeRegistry(log: RawLog, loc: Loc): IndexedEvent | null {
  const d = tryDecode(registryAbi, log);
  if (!d) return null;
  const a = d.args;
  switch (d.eventName) {
    case "SpecProposed":
      return { ...loc, kind: "SpecProposed", tokenId: hex(a.tokenId), specHash: hex(a.specHash), specURI: String(a.specURI), eta: big(a.eta) };
    case "SpecActivated":
      return { ...loc, kind: "SpecActivated", tokenId: hex(a.tokenId), specHash: hex(a.specHash), specURI: String(a.specURI), version: big(a.version) };
    case "SpecProposalCancelled":
      return { ...loc, kind: "SpecProposalCancelled", tokenId: hex(a.tokenId), specHash: hex(a.specHash) };
    default:
      return null;
  }
}

function decodeBridge(log: RawLog, loc: Loc): IndexedEvent | null {
  const d = tryDecode(bridgeAbi, log);
  if (!d) return null;
  const a = d.args;
  if (d.eventName === "Burned") {
    return {
      ...loc,
      kind: "Debit",
      bridge: "weakbridge",
      messageId: hex(a.id),
      sender: lower(a.from as string),
      recipient: lower(a.to as string),
      amount: big(a.amount),
      dstSelector: big(a.dstChain),
    };
  }
  if (d.eventName === "Released") {
    return { ...loc, kind: "Credit", bridge: "weakbridge", messageId: hex(a.id), recipient: lower(a.to as string), amount: big(a.amount), srcSelector: big(a.srcChain) };
  }
  return null;
}

/**
 * CCIP 2.0.0 pool events carry no message id (docs/INTERFACES.md revision 2): pair each OnRamp
 * CCIPMessageSent / OffRamp ExecutionStateChanged with the nearest preceding unpaired pool event of
 * the same transaction. A failed execution reverts the pool release, so an unpaired ramp log is not a credit.
 */
function decodeCcipTx(logs: readonly RawLog[], dep: ChainDeploymentInfo): IndexedEvent[] {
  const pool = dep.ccipPool;
  if (pool === null) return [];
  const debitStack: { amount: bigint; remote: bigint }[] = [];
  const creditStack: { amount: bigint; remote: bigint; recipient: Address }[] = [];
  const out: IndexedEvent[] = [];
  for (const log of logs) {
    const address = lower(log.address);
    const d = tryDecode(ccipAbi, log);
    if (!d) continue;
    const a = d.args;
    const loc = { txHash: log.transactionHash, logIndex: log.logIndex, block: log.blockNumber };
    if (address === pool && d.eventName === "LockedOrBurned") debitStack.push({ amount: big(a.amount), remote: big(a.remoteChainSelector) });
    else if (address === pool && d.eventName === "ReleasedOrMinted")
      creditStack.push({ amount: big(a.amount), remote: big(a.remoteChainSelector), recipient: lower(a.recipient as string) });
    else if (d.eventName === "CCIPMessageSent" && (dep.onRamp === null || address === dep.onRamp)) {
      const move = debitStack.pop();
      if (move)
        out.push({ ...loc, kind: "Debit", bridge: "ccip", messageId: hex(a.messageId), sender: lower(a.sender as string), recipient: null, amount: move.amount, dstSelector: move.remote });
    } else if (d.eventName === "ExecutionStateChanged" && (dep.offRamp === null || address === dep.offRamp)) {
      const move = creditStack.pop();
      if (move?.remote === big(a.sourceChainSelector))
        out.push({ ...loc, kind: "Credit", bridge: "ccip", messageId: hex(a.messageId), recipient: move.recipient, amount: move.amount, srcSelector: move.remote });
    }
  }
  return out;
}

/** Addresses whose logs the indexer pulls for one chain (one getLogs call per block range). */
export function watchedAddresses(dep: ChainDeploymentInfo): Address[] {
  const list = [dep.ledger, dep.quarantine, dep.registry, dep.escrow, dep.weakBridge, dep.ccipPool, dep.onRamp, dep.offRamp];
  return [...new Set(list.filter((a): a is Address => a !== null))];
}

/**
 * Decodes a block range of logs for one chain. On the home chain the WeakBridge (home mode) and
 * the HomeEscrowAdapter both exist; INTERFACES.md says the adapter emits the home Burned/Released,
 * so the bridge contract's own copies are ignored there to avoid double counting.
 */
export function decodeLogs(logs: readonly RawLog[], dep: ChainDeploymentInfo): IndexedEvent[] {
  const events: IndexedEvent[] = [];
  const byTx = new Map<Hex, RawLog[]>();
  const bridgeEmitter = dep.role === "home" ? (dep.escrow ?? dep.weakBridge) : dep.weakBridge;
  for (const log of logs) {
    const address = lower(log.address);
    const loc = { txHash: log.transactionHash, logIndex: log.logIndex, block: log.blockNumber };
    let ev: IndexedEvent | null = null;
    if (address === dep.ledger) ev = decodeLedger(log, loc);
    else if (address === dep.quarantine) ev = decodeQuarantine(log, loc);
    else if (address === dep.registry) ev = decodeRegistry(log, loc);
    else if (address === bridgeEmitter) ev = decodeBridge(log, loc);
    if (ev) events.push(ev);
    if (address === dep.ccipPool || address === dep.onRamp || address === dep.offRamp) {
      const list = byTx.get(log.transactionHash) ?? [];
      list.push(log);
      byTx.set(log.transactionHash, list);
    }
  }
  for (const txLogs of byTx.values()) events.push(...decodeCcipTx(txLogs.sort((x, y) => x.logIndex - y.logIndex), dep));
  return events.sort((x, y) => (x.block === y.block ? x.logIndex - y.logIndex : x.block < y.block ? -1 : 1));
}
