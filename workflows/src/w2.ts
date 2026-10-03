import {
  blocksHash,
  loop,
  matchAll,
  Reason,
  reasonName,
  ReportType,
  Status,
  statusName,
  trailingFlow,
  type Credit,
  type Debit,
  type Hex,
  type LoopResult,
  type PinnedBlock,
  type SourceView,
  type TimedCredit,
  type TokenSpec,
  type W2Config,
} from "@kirchhoff/engine";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi } from "viem";
import { LEDGER_ABI } from "./abi.ts";
import { logWindow } from "./budget.ts";
import { ledgerTargets, readBlock, type ChainEntry } from "./chains.ts";
import type { BlockHeader, ChainIo, ChainLog } from "./io.ts";
import { decodeAggregate3, encodeAggregate3, successful, type Call } from "./multicall.ts";
import { loopEvidence, writeToLedgers, type LedgerTarget, type ReportBody, type WriteResult } from "./reports.ts";
import { adapterFor, CRE_TRIGGER_LIMIT } from "./w1.ts";
import { debitFromRegistry, encodeDebitOf } from "@kirchhoff/engine/adapters";

/**
 * Most message ids whose consumed flag one aggregate3 can check while its calldata stays under CRE's 5 KB read
 * payload limit (about 170 bytes per isConsumed sub-call next to the supply, escrow and ledger reads).
 */
export const MAX_CONSUMED_CHECKS = 20;

/**
 * 100-block filterLogs windows per chain, ending at the chain's pin. Every credit must pass through a window at or
 * below its pin in some epoch to be settled, so the windows must cover at least one cron interval of blocks
 * (30 s: about 120 Arbitrum Sepolia blocks at 0.25 s, 15 Base Sepolia blocks, 3 Sepolia blocks).
 */
export const W2_WINDOWS_PER_CHAIN = 2;

export type LedgerState = {
  status: number;
  latestEpochId: bigint;
  latestStatus: number;
  latestReason: number;
  recoveryEndsAt: bigint;
};

export type ChainObservation = {
  chain: ChainEntry;
  pinned: BlockHeader;
  supply: bigint;
  ledger: LedgerState;
};

type Watch = W2Config["creditEvents"][number];

/** A uint256 view from the config's read signature; the signature is data, so the ABI is the general `Abi`. */
function uintViewAbi(signature: string): Abi {
  const items: readonly string[] = [`function ${signature} view returns (uint256)`];
  return parseAbi(items);
}

function uint(value: unknown, label: string): bigint {
  if (typeof value !== "bigint") throw new Error(`${label} did not decode to a uint256`);
  return value;
}

function functionName(signature: string): string {
  const name = signature.split("(")[0];
  if (name === undefined || name.length === 0) throw new Error(`invalid read signature ${signature}`);
  return name;
}

/** Every bridge address and topic W2 must see on a chain to rebuild its debits and credits by message id. */
export function bridgeLogFilter(config: W2Config, chain: string): { addresses: Hex[]; topic0s: Hex[] } {
  const watches: Watch[] = [...config.debitEvents, ...config.creditEvents].filter((w) => w.chain === chain);
  const addresses = new Map<string, Hex>();
  const topics = new Map<string, Hex>();
  for (const w of watches) {
    addresses.set(w.address.toLowerCase(), w.address);
    topics.set(w.topic0.toLowerCase(), w.topic0);
    if (w.pairWith !== null) {
      addresses.set(w.pairWith.address.toLowerCase(), w.pairWith.address);
      topics.set(w.pairWith.topic0.toLowerCase(), w.pairWith.topic0);
    }
  }
  return { addresses: [...addresses.values()], topic0s: [...topics.values()] };
}

/** Decodes every debit and credit of the spec's bridges in a chain's window, transaction by transaction. */
export function decodeBridgeLogs(config: W2Config, spec: TokenSpec, chain: ChainEntry, logs: readonly ChainLog[]): { debits: Debit[]; credits: Credit[] } {
  const selector = BigInt(chain.selector);
  const byTx = new Map<string, ChainLog[]>();
  for (const log of logs) {
    const key = log.transactionHash.toLowerCase();
    const list = byTx.get(key) ?? [];
    list.push(log);
    byTx.set(key, list);
  }
  const bridges = new Map<string, Watch>();
  for (const w of [...config.debitEvents, ...config.creditEvents]) if (w.chain === chain.name) bridges.set(w.bridgeId, w);
  const debits: Debit[] = [];
  const credits: Credit[] = [];
  for (const txLogs of byTx.values()) {
    const ordered = [...txLogs].sort((a, b) => a.logIndex - b.logIndex);
    for (const watch of bridges.values()) {
      const adapter = adapterFor(spec, watch);
      debits.push(...adapter.decodeTxDebits(ordered, selector));
      credits.push(...adapter.decodeTxCredits(ordered, selector));
    }
  }
  return { debits, credits };
}

function ledgerCalls(chain: ChainEntry, tokenId: Hex): Call[] {
  return [
    { target: chain.ledger, callData: encodeFunctionData({ abi: LEDGER_ABI, functionName: "statusOf", args: [tokenId] }) },
    { target: chain.ledger, callData: encodeFunctionData({ abi: LEDGER_ABI, functionName: "latestEpoch", args: [tokenId] }) },
    { target: chain.ledger, callData: encodeFunctionData({ abi: LEDGER_ABI, functionName: "recoveryEndsAt", args: [tokenId] }) },
  ];
}

function decodeLedger(results: readonly Hex[]): LedgerState {
  const [statusData, epochData, recoveryData] = results;
  if (statusData === undefined || epochData === undefined || recoveryData === undefined) throw new Error("ledger reads missing");
  const [status] = decodeFunctionResult({ abi: LEDGER_ABI, functionName: "statusOf", data: statusData });
  const epoch = decodeFunctionResult({ abi: LEDGER_ABI, functionName: "latestEpoch", data: epochData });
  const recoveryEndsAt = decodeFunctionResult({ abi: LEDGER_ABI, functionName: "recoveryEndsAt", data: recoveryData });
  return { status, latestEpochId: epoch.epochId, latestStatus: epoch.status, latestReason: epoch.reason, recoveryEndsAt };
}

export type EpochPlan = { target: LedgerTarget; body: ReportBody | null; note: string };

/**
 * What each ledger receives this epoch (contracts/README.md decisions 4, 5 and 7):
 * - BROKEN: the same BREACH on every chain (recipient zero: a Loop deficit has no single recipient);
 * - RECOVERING with the timelock over and Δ >= 0: RECOVERY_CHECK;
 * - otherwise EPOCH, also while the token is contained, because ignored EPOCHs still raise the ledger's epoch
 *   high-water mark; except the first EPOCH of an UNKNOWN ledger, which must be CONSERVED.
 */
export function planEpoch(args: {
  observations: readonly ChainObservation[];
  result: LoopResult;
  epochId: bigint;
  blocksHash: Hex;
  evidenceHash: Hex;
  settled: readonly Hex[];
  now: bigint;
}): EpochPlan[] {
  const { result } = args;
  const targets = ledgerTargets(args.observations.map((o) => o.chain));
  return args.observations.map((obs, i): EpochPlan => {
    const target = targets[i];
    if (target === undefined) throw new Error("ledger target missing");
    if (result.status === Status.BROKEN) {
      return {
        target,
        note: `BREACH ${reasonName(result.reason)} delta ${result.delta}`,
        body: {
          reportType: ReportType.BREACH,
          payload: {
            epochId: args.epochId,
            delta: result.delta,
            blocksHash: args.blocksHash,
            evidenceHash: args.evidenceHash,
            reason: result.reason,
            offendingChain: 0n,
            offendingTx: `0x${"0".repeat(64)}`,
            recipient: "0x0000000000000000000000000000000000000000",
            amount: -result.delta,
            messageId: `0x${"0".repeat(64)}`,
          },
        },
      };
    }
    const ledger = obs.ledger;
    if (ledger.status === Status.RECOVERING) {
      // The pin's timestamp is earlier than the write's block.timestamp, so this never sends a check the ledger
      // would reject for an unfinished timelock.
      if (ledger.recoveryEndsAt > obs.pinned.timestamp || result.delta < 0n) {
        return { target, body: epochBody(args), note: `RECOVERING until ${ledger.recoveryEndsAt}: EPOCH only raises the high-water mark` };
      }
      return {
        target,
        note: `RECOVERY_CHECK delta ${result.delta}`,
        body: { reportType: ReportType.RECOVERY_CHECK, payload: { epochId: args.epochId, delta: result.delta, blocksHash: args.blocksHash } },
      };
    }
    if (ledger.status === Status.UNKNOWN && result.status !== Status.CONSERVED) {
      return { target, body: null, note: `ledger UNKNOWN cannot take a first EPOCH with status ${statusName(result.status)}` };
    }
    return { target, body: epochBody(args), note: `EPOCH ${statusName(result.status)} ${reasonName(result.reason)} delta ${result.delta}` };
  });
}

function epochBody(args: { result: LoopResult; epochId: bigint; blocksHash: Hex; evidenceHash: Hex; settled: readonly Hex[] }): ReportBody {
  const status = args.result.status;
  if (status === Status.BROKEN) throw new Error("a BROKEN result is reported as BREACH, not EPOCH");
  return {
    reportType: ReportType.EPOCH,
    payload: {
      epochId: args.epochId,
      delta: args.result.delta,
      blocksHash: args.blocksHash,
      evidenceHash: args.evidenceHash,
      status,
      reason: args.result.reason,
      settledMessageIds: args.settled,
    },
  };
}

export type LoopOutcome = {
  epochId: bigint;
  result: LoopResult;
  settled: readonly Hex[];
  inFlightOut: bigint;
  inFlightIn: bigint;
  blocksHash: Hex;
  plans: EpochPlan[];
  writes: WriteResult[];
};

/**
 * PRD section 8 W2 for one epoch. Reads per chain: the pin header at the read confidence, W2_WINDOWS_PER_CHAIN
 * filterLogs over the bridge contracts ending at the pin, one Multicall3 aggregate3 at the pin (supply, ledger
 * state, escrow balances, consumed flags, registry debits of credits whose debit is older than the windows): 4 per
 * chain, 12 for 3 chains. Plus at most one aggregate3 at the latest block per source chain that still owes a debit
 * (a credit delivered before its source debit reached the pin): at most 15 of the 15 allowed.
 */
export function runLoop(io: ChainIo, config: W2Config, spec: TokenSpec, now: bigint): LoopOutcome {
  if (config.model !== "lock_release_home") {
    throw new Error(`W2 implements the lock_release_home Loop Rule; ${config.token} is ${config.model}`);
  }
  const home = config.chains.find((c) => c.isHome);
  if (home === undefined) throw new Error("config has no home chain");

  // Step 1: pin every chain.
  const heads = config.chains.map((chain) => ({ chain, pinned: io.header(chain.name, readBlock(chain.readConfidence)) }));
  io.log(`pinned ${heads.map((h) => `${h.chain.alias}=${h.pinned.number.toString()}`).join(" ")}`);

  // Step 3 (before the multicall, which also checks the consumed flags of what it finds).
  const debits: Debit[] = [];
  const credits: Credit[] = [];
  const windowBlocks = BigInt(config.logQueryBlockLimit);
  for (const { chain, pinned } of heads) {
    const filter = bridgeLogFilter(config, chain.name);
    if (filter.addresses.length === 0) continue;
    const logs: ChainLog[] = [];
    for (let w = 0n; w < BigInt(W2_WINDOWS_PER_CHAIN); w++) {
      const end = pinned.number - w * windowBlocks;
      if (end < 0n) break;
      logs.push(...io.logs(chain.name, { addresses: filter.addresses, topics: [filter.topic0s], ...logWindow(end, windowBlocks) }));
    }
    const decoded = decodeBridgeLogs(config, spec, chain, logs);
    debits.push(...decoded.debits);
    credits.push(...decoded.credits);
  }
  const ids = [...new Set([...debits, ...credits].map((x) => x.messageId.toLowerCase() as Hex))];
  const checked = ids.slice(0, MAX_CONSUMED_CHECKS);
  if (ids.length > checked.length) {
    io.log(`warning: ${ids.length} message ids in the window, consumed flags checked for the first ${checked.length} only`);
  }
  // A credit whose debit is older than the log window: the source bridge's debit registry (INTERFACES.md
  // Revision 2) answers it exactly at the source pin, inside the same aggregate3. Messages in flight across many
  // epochs are therefore still matched by id.
  const known = new Set(debits.map((d) => `${d.srcChain.toString()}:${d.messageId.toLowerCase()}`));
  const registryLookups = credits
    .filter((c) => !known.has(`${c.claimedSrcChain.toString()}:${c.messageId.toLowerCase()}`))
    .slice(0, MAX_CONSUMED_CHECKS);

  // Step 2: one aggregate3 per chain at its pin.
  const holders = [...new Map(config.escrowHolders.map((h) => [h.toLowerCase(), h])).values()];
  const supplyRead = uintViewAbi(config.reads.supply);
  const balanceRead = uintViewAbi(config.reads.balance);
  let escrow = 0n;
  const consumed = new Set<string>();
  const observations: ChainObservation[] = heads.map(({ chain, pinned }) => {
    const reads: { call: Call; use: (data: Hex) => void }[] = [];
    const decoded: { supply?: bigint } = {};
    const ledgerData: Hex[] = [];
    reads.push({
      call: { target: chain.token, callData: encodeFunctionData({ abi: supplyRead, functionName: functionName(config.reads.supply) }) },
      use: (data) => {
        decoded.supply = uint(decodeFunctionResult({ abi: supplyRead, functionName: functionName(config.reads.supply), data }), "supply");
      },
    });
    for (const call of ledgerCalls(chain, config.tokenId)) reads.push({ call, use: (data) => ledgerData.push(data) });
    if (chain.isHome) {
      for (const holder of holders) {
        reads.push({
          call: { target: chain.token, callData: encodeFunctionData({ abi: balanceRead, functionName: functionName(config.reads.balance), args: [holder] }) },
          use: (data) => {
            escrow += uint(decodeFunctionResult({ abi: balanceRead, functionName: functionName(config.reads.balance), data }), "escrow balance");
          },
        });
      }
      for (const id of checked) {
        reads.push({
          call: { target: chain.ledger, callData: encodeFunctionData({ abi: LEDGER_ABI, functionName: "isConsumed", args: [id] }) },
          use: (data) => {
            if (decodeFunctionResult({ abi: LEDGER_ABI, functionName: "isConsumed", data })) consumed.add(id);
          },
        });
      }
    }
    const selector = BigInt(chain.selector);
    const registries = config.debitEvents.filter((w) => w.chain === chain.name && w.registry !== null);
    for (const credit of registryLookups.filter((c) => c.claimedSrcChain === selector)) {
      for (const registry of registries) {
        reads.push({
          call: { target: registry.address, callData: encodeDebitOf(credit.messageId) },
          use: (data) => {
            const debit = debitFromRegistry(credit.messageId, selector, data);
            if (debit !== null) debits.push(debit);
          },
        });
      }
    }
    const raw = io.call(chain.name, config.multicall3, encodeAggregate3(reads.map((r) => r.call)), { tag: "number", number: pinned.number });
    decodeAggregate3(raw, reads.length).forEach((r, i) => {
      const read = reads[i];
      read?.use(successful(r, `${chain.name} ${read.call.target} ${read.call.callData.slice(0, 10)}`));
    });
    if (decoded.supply === undefined) throw new Error(`${chain.name} supply read missing`);
    return { chain, pinned, supply: decoded.supply, ledger: decodeLedger(ledgerData) };
  });

  // A credit can be delivered before its debit reaches the source pin (a bridge faster than finality). Its debit
  // is then read at the latest block, so the engine can net it out of F instead of reading a false deficit.
  const found = new Set(debits.map((d) => `${d.srcChain.toString()}:${d.messageId.toLowerCase()}`));
  for (const { chain } of heads) {
    const selector = BigInt(chain.selector);
    const registries = config.debitEvents.filter((w) => w.chain === chain.name && w.registry !== null);
    const owed = registryLookups.filter((c) => c.claimedSrcChain === selector && !found.has(`${selector.toString()}:${c.messageId.toLowerCase()}`));
    if (owed.length === 0 || registries.length === 0) continue;
    const calls = owed.flatMap((c) => registries.map((r) => ({ credit: c, call: { target: r.address, callData: encodeDebitOf(c.messageId) } })));
    const raw = io.call(chain.name, config.multicall3, encodeAggregate3(calls.map((c) => c.call)), { tag: "latest" });
    decodeAggregate3(raw, calls.length).forEach((r, i) => {
      const entry = calls[i];
      if (entry === undefined || !r.success) return;
      const debit = debitFromRegistry(entry.credit.messageId, selector, r.returnData);
      if (debit !== null) debits.push(debit);
    });
  }

  // Step 3 continued: match by message id against the pins. Credits already settled onchain are excluded (the
  // engine would read them as double credits); credits above their chain's pin are not in the snapshot yet.
  const sources = new Map<bigint, SourceView>(observations.map((o) => [BigInt(o.chain.selector), { head: o.pinned.number, headTimestamp: o.pinned.timestamp }]));
  const timed: TimedCredit[] = [];
  for (const credit of credits) {
    const obs = observations.find((o) => BigInt(o.chain.selector) === credit.dstChain);
    if (obs === undefined || credit.block > obs.pinned.number || consumed.has(credit.messageId.toLowerCase())) continue;
    // Block timestamps are not read per credit (read budget); the pin's timestamp bounds them from above.
    timed.push({ credit, timestamp: obs.pinned.timestamp });
  }
  const match = matchAll(debits, timed, spec, { now, sources, isConsumed: (id) => consumed.has(id.toLowerCase()) });

  // Step 5.
  const pinnedBlocks: PinnedBlock[] = observations.map((o) => ({ chain: BigInt(o.chain.selector), block: o.pinned.number }));
  const homeLedger = observations.find((o) => o.chain.isHome)?.ledger;
  const priorDeficitEpochs = homeLedger?.latestStatus === Status.DRIFT && homeLedger.latestReason === Reason.LOOP_DEFICIT ? 1 : 0;
  const latestId = observations.reduce((m, o) => (o.ledger.latestEpochId > m ? o.ledger.latestEpochId : m), 0n);
  // Ignored EPOCHs raise an unreadable high-water mark, so ids also follow the consensus clock.
  const epochId = latestId + 1n > now ? latestId + 1n : now;
  const result = loop(
    {
      model: "lock_release_home",
      epochId,
      pinned: pinnedBlocks,
      supplies: observations.map((o) => ({ chain: BigInt(o.chain.selector), supply: o.supply })),
      inFlightOut: match.inFlightOut,
      inFlightIn: match.inFlightIn,
      flowLastHour: trailingFlow(match.settledFlow, now),
      priorDeficitEpochs,
      escrow,
    },
    spec,
  );
  const hash = blocksHash(pinnedBlocks);
  io.log(
    `loop: escrow ${escrow} supplies ${observations.map((o) => `${o.chain.alias}=${o.supply}`).join(" ")} Fout ${match.inFlightOut} Fin ${match.inFlightIn} -> delta ${result.delta} ${statusName(result.status)} ${reasonName(result.reason)}; settled ${match.settled.length}`,
  );

  // Step 6.
  const evidenceHash = loopEvidence({
    blocksHash: hash,
    backing: result.backing,
    claims: result.claims,
    inFlightOut: match.inFlightOut,
    inFlightIn: match.inFlightIn,
    delta: result.delta,
    reason: result.reason,
  });
  const plans = planEpoch({ observations, result, epochId, blocksHash: hash, evidenceHash, settled: match.settled, now });
  const writes: WriteResult[] = [];
  for (const plan of plans) {
    io.log(`${plan.target.chain}: ${plan.note}`);
    if (plan.body !== null) writes.push(...writeToLedgers(io, [plan.target], config.tokenId, plan.body));
  }
  return { epochId, result, settled: match.settled, inFlightOut: match.inFlightOut, inFlightIn: match.inFlightIn, blocksHash: hash, plans, writes };
}

/**
 * W2 supply-change triggers, compiled by the engine with topic filters (mint / burn on remotes, escrow in / out on
 * home; one trigger per side because a CRE log trigger ORs within a topic slot and ANDs across slots). With the
 * cron trigger first, the `--trigger-index` of entry i is i + 1.
 */
export function supplyTriggerFilters(config: W2Config): { chain: string; address: Hex; side: string; topics: Hex[][]; confidence: ChainEntry["triggerConfidence"] }[] {
  const out = config.supplyTriggers.map((t) => {
    const chain = config.chains.find((c) => c.name === t.chain);
    if (chain === undefined) throw new Error(`supply trigger on unknown chain ${t.chain}`);
    return { chain: t.chain, address: t.address, side: t.side, topics: t.topics.map((slot) => [...slot]), confidence: chain.triggerConfidence };
  });
  if (out.length + 1 > CRE_TRIGGER_LIMIT) throw new RangeError(`W2 needs ${out.length + 1} triggers; CRE allows ${CRE_TRIGGER_LIMIT}`);
  return out;
}

