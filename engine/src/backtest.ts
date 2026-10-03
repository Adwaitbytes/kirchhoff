import { matchAll, trailingFlow, type FlowEntry, type SourceView, type TimedCredit } from "./junction.ts";
import { loop } from "./loop.ts";
import { applyCreReport } from "./status.ts";
import {
  Reason,
  Status,
  type BurnMintSnapshot,
  type ChainSel,
  type Credit,
  type Debit,
  type Hex,
  type LockReleaseSnapshot,
  type LoopResult,
  type TokenSpec,
} from "./types.ts";

type Observed<S> = Omit<S, "inFlightOut" | "inFlightIn" | "flowLastHour" | "priorDeficitEpochs">;

/** Balances read at the epoch's pinned blocks; in-flight and flow are derived by the backtester. */
export type ObservedSnapshot = Observed<LockReleaseSnapshot> | Observed<BurnMintSnapshot>;

export type EpochObservation = {
  /** Evaluation timestamp, seconds. */
  timestamp: bigint;
  /** Pinned (confident) head per chain. Credits above their chain's pin wait for a later epoch. */
  sources: ReadonlyMap<ChainSel, SourceView>;
  snapshot: ObservedSnapshot;
};

export type HistoryEvent =
  | { kind: "debit"; debit: Debit }
  | { kind: "credit"; credit: Credit; timestamp: bigint }
  | { kind: "epoch"; epoch: EpochObservation };

export type Breach = {
  epochId: bigint;
  reason: Reason;
  rule: "junction" | "loop";
  delta: bigint;
  /** Junction breaches identify the offending credit. */
  credit?: Credit;
};

export type DriftEvent = { epochId: bigint; reason: Reason; messageId?: Hex };

export type EpochOutcome = {
  epochId: bigint;
  /** Token status after this epoch's reports are applied. */
  status: Status;
  loop: LoopResult;
  settled: readonly Hex[];
};

export type BacktestResult = {
  epochs: readonly EpochOutcome[];
  breaches: readonly Breach[];
  drift: readonly DriftEvent[];
  finalStatus: Status;
  coverage: {
    debits: number;
    credits: number;
    settled: number;
    /** Credits still awaiting a confident debit at the end of the history. */
    pending: number;
    /** Debits not yet credited at the last epoch. */
    inFlight: number;
    epochs: number;
  };
};


/**
 * Replays an ordered event history through matchAll and loop once per epoch,
 * exactly as W2 would, and drives the status machine with the reports W1 and
 * W2 would write. Pure: the history is the only input. Used by the spec
 * lifecycle (any BROKEN on real history blocks activation) and by the tests.
 */
export function backtest(history: readonly HistoryEvent[], spec: TokenSpec): BacktestResult {
  let openDebits: Debit[] = [];
  let pending: TimedCredit[] = [];
  const consumed = new Set<string>();
  const flow: FlowEntry[] = [];
  const epochs: EpochOutcome[] = [];
  const breaches: Breach[] = [];
  const drift: DriftEvent[] = [];
  let status: Status = Status.UNKNOWN;
  let priorDeficitEpochs = 0;
  let debitCount = 0;
  let creditCount = 0;
  let settledCount = 0;
  let inFlightCount = 0;

  for (const event of history) {
    if (event.kind === "debit") {
      openDebits.push(event.debit);
      debitCount++;
      continue;
    }
    if (event.kind === "credit") {
      pending.push({ credit: event.credit, timestamp: event.timestamp });
      creditCount++;
      continue;
    }

    const { epoch } = event;
    const epochId = epoch.snapshot.epochId;
    // W2 only reads logs up to each chain's pinned block; later credits wait for a later epoch.
    const visible = (c: TimedCredit): boolean => c.credit.block <= (epoch.sources.get(c.credit.dstChain)?.head ?? -1n);
    const evaluated = pending.filter(visible);
    const deferred = pending.filter((c) => !visible(c));
    const match = matchAll(openDebits, evaluated, spec, {
      now: epoch.timestamp,
      sources: epoch.sources,
      isConsumed: (id) => consumed.has(id.toLowerCase()),
    });

    const stillPending: TimedCredit[] = [...deferred];
    let junctionBroken = false;
    for (const { credit, timestamp, result } of match.verdicts) {
      if (result.status === Status.BROKEN) {
        junctionBroken = true;
        breaches.push({ epochId, reason: result.reason, rule: "junction", delta: 0n, credit });
      } else if (result.status === Status.DRIFT) {
        stillPending.push({ credit, timestamp });
        drift.push({ epochId, reason: result.reason, messageId: credit.messageId });
      }
    }
    for (const id of match.settled) consumed.add(id.toLowerCase());
    settledCount += match.settled.length;
    flow.push(...match.settledFlow);
    pending = stillPending;
    openDebits = openDebits.filter((d) => !consumed.has(d.messageId.toLowerCase()));
    inFlightCount = match.inFlight.length;

    const loopResult = loop(
      {
        ...epoch.snapshot,
        inFlightOut: match.inFlightOut,
        inFlightIn: match.inFlightIn,
        flowLastHour: trailingFlow(flow, epoch.timestamp),
        priorDeficitEpochs,
      },
      spec,
    );
    priorDeficitEpochs = loopResult.deficit ? priorDeficitEpochs + 1 : 0;

    if (loopResult.status === Status.BROKEN) {
      breaches.push({ epochId, reason: loopResult.reason, rule: "loop", delta: loopResult.delta });
    } else if (loopResult.status === Status.DRIFT) {
      drift.push({ epochId, reason: loopResult.reason });
    }

    if (junctionBroken || loopResult.status === Status.BROKEN) {
      status = applyCreReport(status, { kind: "BREACH" });
    } else {
      const epochStatus =
        loopResult.status === Status.DRIFT || stillPending.length > deferred.length ? Status.DRIFT : Status.CONSERVED;
      status = applyCreReport(status, { kind: "EPOCH", status: epochStatus });
    }
    epochs.push({ epochId, status, loop: loopResult, settled: match.settled });
  }

  return {
    epochs,
    breaches,
    drift,
    finalStatus: status,
    coverage: {
      debits: debitCount,
      credits: creditCount,
      settled: settledCount,
      pending: pending.length,
      inFlight: inFlightCount,
      epochs: epochs.length,
    },
  };
}
