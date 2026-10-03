/**
 * The six scripted scenarios of PRD section 17, at engine level: each one is
 * replayed through the backtester (matchAll + loop per epoch, as W1/W2 do).
 */
import { describe, expect, it } from "vitest";
import { backtest } from "../src/backtest.ts";
import { Reason, Status } from "../src/types.ts";
import { ARB, HOME, MALLORY, makeSpec, units } from "./fixtures.ts";
import { World } from "./sim.ts";

const spec = makeSpec();

describe("PRD section 17 scenarios", () => {
  it("scenario1: normal round trip home to Arbitrum to home stays CONSERVED throughout", () => {
    const w = new World(spec);
    w.epoch();
    const out = w.send(HOME, ARB, units(10n));
    w.epoch();
    w.credit(out);
    w.epoch();
    const back = w.send(ARB, HOME, units(10n));
    w.epoch();
    w.credit(back);
    w.epoch();
    const r = backtest(w.history, spec);
    expect(r.breaches).toEqual([]);
    expect(r.drift).toEqual([]);
    expect(r.epochs.map((e) => e.status)).toEqual(Array(5).fill(Status.CONSERVED));
    expect(r.epochs.map((e) => e.loop.delta)).toEqual([0n, 0n, 0n, 0n, 0n]);
    expect(r.coverage).toMatchObject({ debits: 2, credits: 2, settled: 2, pending: 0, inFlight: 0, epochs: 5 });
  });

  it("scenario2: a message in flight across an epoch boundary raises no false DRIFT or BROKEN", () => {
    const w = new World(spec);
    const d = w.send(HOME, ARB, units(7n));
    w.epoch();
    w.epoch();
    w.credit(d);
    w.epoch();
    const r = backtest(w.history, spec);
    expect(r.breaches).toEqual([]);
    expect(r.drift).toEqual([]);
    expect(r.epochs.map((e) => [e.status, e.loop.claims])).toEqual([
      [Status.CONSERVED, units(7n)],
      [Status.CONSERVED, units(7n)],
      [Status.CONSERVED, units(7n)],
    ]);
  });

  it("scenario3: a forged WeakBridge release (Kelp Replay) is BROKEN by DEBIT_NOT_FOUND", () => {
    const w = new World(spec);
    const seed = w.send(HOME, ARB, units(200_000n));
    w.credit(seed);
    w.epoch();
    const forged = w.forge(HOME, ARB, units(116_500n), MALLORY);
    w.epoch();
    const r = backtest(w.history, spec);
    expect(r.breaches[0]).toMatchObject({ rule: "junction", reason: Reason.DEBIT_NOT_FOUND, credit: forged, epochId: 2n });
    // W2 confirms the Loop Rule deficit in the same epoch: delta = -116,500 kETH.
    expect(r.breaches[1]).toMatchObject({ rule: "loop", reason: Reason.LOOP_DEFICIT, delta: -units(116_500n) });
    expect(r.finalStatus).toBe(Status.BROKEN);
  });

  it("scenario4: a double credit of one real burn is BROKEN by DOUBLE_CREDIT, in one batch or across epochs", () => {
    for (const split of [false, true]) {
      const w = new World(spec);
      const lock = w.send(HOME, ARB, units(5n));
      w.credit(lock);
      const burn = w.send(ARB, HOME, units(5n));
      w.credit(burn);
      if (split) w.epoch();
      const replay = w.credit(burn);
      w.epoch();
      const r = backtest(w.history, spec);
      expect(r.breaches.filter((b) => b.rule === "junction")).toEqual([
        expect.objectContaining({ reason: Reason.DOUBLE_CREDIT, credit: replay }),
      ]);
      expect(r.finalStatus).toBe(Status.BROKEN);
    }
  });

  it("scenario5: a direct mint by a compromised minter key, with no message, is BROKEN by LOOP_DEFICIT", () => {
    const w = new World(spec);
    w.epoch();
    w.directMint(ARB, units(1_000n));
    w.epoch();
    const r = backtest(w.history, spec);
    expect(r.breaches).toEqual([
      { epochId: 2n, reason: Reason.LOOP_DEFICIT, rule: "loop", delta: -units(1_000n) },
    ]);
    expect(r.epochs.map((e) => e.status)).toEqual([Status.CONSERVED, Status.BROKEN]);
  });

  it("scenario6: a donation to the escrow raises delta, stays CONSERVED and shows as surplus", () => {
    const w = new World(spec);
    const d = w.send(HOME, ARB, units(3n));
    w.credit(d);
    w.epoch();
    w.donate(units(42n));
    w.epoch();
    const r = backtest(w.history, spec);
    expect(r.breaches).toEqual([]);
    expect(r.finalStatus).toBe(Status.CONSERVED);
    expect(r.epochs[1]?.loop).toMatchObject({ status: Status.CONSERVED, delta: units(42n), surplus: units(42n) });
  });
});
