import { describe, expect, it } from "vitest";
import { backtest, type HistoryEvent } from "../src/backtest.ts";
import { Reason, Status } from "../src/types.ts";
import { ARB, BASE, HOME, creditFor, debit, hash, makeSpec, units } from "./fixtures.ts";
import { World } from "./sim.ts";

describe("backtest", () => {
  it("returns an empty result for an empty history", () => {
    expect(backtest([], makeSpec())).toEqual({
      epochs: [],
      breaches: [],
      drift: [],
      finalStatus: Status.UNKNOWN,
      coverage: { debits: 0, credits: 0, settled: 0, pending: 0, inFlight: 0, epochs: 0 },
    });
  });

  it("waits breach_confirmations epochs before a loop deficit breaks the token", () => {
    const spec = makeSpec({ breachConfirmations: 2 });
    const w = new World(spec);
    w.directMint(ARB, units(1n));
    w.epoch();
    w.epoch();
    const r = backtest(w.history, spec);
    expect(r.drift).toEqual([{ epochId: 1n, reason: Reason.LOOP_DEFICIT }]);
    expect(r.epochs.map((e) => e.status)).toEqual([Status.DRIFT, Status.BROKEN]);
  });

  it("raises FLOW_LIMIT drift from settled credits in the trailing hour", () => {
    const spec = makeSpec({ flowLimit: units(5n) });
    const w = new World(spec);
    w.credit(w.send(HOME, ARB, units(6n)));
    w.epoch();
    const r = backtest(w.history, spec);
    expect(r.drift).toEqual([{ epochId: 1n, reason: Reason.FLOW_LIMIT }]);
    expect(r.finalStatus).toBe(Status.DRIFT);
  });

  it("keeps a credit pending (DRIFT) while its debit is above the source pin, then settles it", () => {
    const spec = makeSpec();
    const w = new World(spec);
    w.credit(w.send(HOME, ARB, units(2n)));
    w.credit(w.send(ARB, HOME, units(1n)));
    w.epoch((c) => (c === ARB ? 3n : 0n));
    w.epoch();
    const r = backtest(w.history, spec);
    expect(r.drift).toEqual([expect.objectContaining({ epochId: 1n, reason: Reason.PENDING_ATTESTATION })]);
    expect(r.epochs.map((e) => e.status)).toEqual([Status.DRIFT, Status.CONSERVED]);
    expect(r.coverage.settled).toBe(2);
    expect(r.breaches).toEqual([]);
  });

  it("defers credits on a chain the epoch did not pin", () => {
    const spec = makeSpec();
    const d = debit({ messageId: hash("m") });
    const history: HistoryEvent[] = [
      { kind: "debit", debit: d },
      { kind: "credit", credit: creditFor(d), timestamp: 1n },
      {
        kind: "epoch",
        epoch: {
          timestamp: 10n,
          sources: new Map([[HOME, { head: 500n, headTimestamp: 10n }]]),
          snapshot: {
            model: "lock_release_home",
            epochId: 1n,
            pinned: [],
            escrow: units(10n),
            supplies: [
              { chain: ARB, supply: 0n },
              { chain: BASE, supply: 0n },
            ],
          },
        },
      },
    ];
    const r = backtest(history, spec);
    expect(r.coverage).toMatchObject({ pending: 1, settled: 0, inFlight: 1 });
    expect(r.epochs[0]?.status).toBe(Status.CONSERVED);
  });

  it("ignores EPOCH outcomes once BROKEN, as the ledger does", () => {
    const spec = makeSpec();
    const w = new World(spec);
    w.directMint(ARB, units(1n));
    w.epoch();
    w.donate(units(1n));
    w.epoch();
    const r = backtest(w.history, spec);
    expect(r.epochs.map((e) => [e.loop.status, e.status])).toEqual([
      [Status.BROKEN, Status.BROKEN],
      [Status.CONSERVED, Status.BROKEN],
    ]);
  });
});
