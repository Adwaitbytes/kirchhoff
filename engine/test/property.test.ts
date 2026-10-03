/**
 * PRD section 17, "the one test that matters most": random valid histories
 * (in-flight messages across epoch boundaries, mixed decimals, escrow
 * donations) plus at most one injected forgery per history. Every forgery must
 * be flagged with the right reason, and valid traffic must never be flagged.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { backtest } from "../src/backtest.ts";
import { decimalsOn } from "../src/chains.ts";
import { rescale } from "../src/units.ts";
import { Reason, Status, type ChainSel, type Credit, type TokenSpec } from "../src/types.ts";
import { ARB, BASE, HOME, MALLORY, makeSpec } from "./fixtures.ts";
import { World } from "./sim.ts";

const CHAINS: readonly ChainSel[] = [HOME, ARB, BASE];
const chainAt = (i: number): ChainSel => CHAINS[i % CHAINS.length] ?? HOME;

type Command =
  | { t: "send"; src: number; dst: number; k: bigint }
  | { t: "deliver"; i: number }
  | { t: "epoch" }
  | { t: "donate"; k: bigint };

type Forgery =
  | { t: "none" }
  | { t: "no_debit"; dst: number; src: number; k: bigint }
  | { t: "amount"; up: boolean }
  | { t: "recipient" }
  | { t: "double" }
  | { t: "direct_mint"; chain: number; k: bigint };

const amount = fc.bigInt({ min: 1n, max: 1_000_000n });
const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant("send" as const), src: fc.nat(2), dst: fc.nat(2), k: amount }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("deliver" as const), i: fc.nat(20) }) },
  { weight: 2, arbitrary: fc.constant({ t: "epoch" as const }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("donate" as const), k: amount }) },
);
const forgery: fc.Arbitrary<Forgery> = fc.oneof(
  fc.constant({ t: "none" as const }),
  fc.record({ t: fc.constant("no_debit" as const), dst: fc.nat(2), src: fc.nat(1), k: amount }),
  fc.record({ t: fc.constant("amount" as const), up: fc.boolean() }),
  fc.constant({ t: "recipient" as const }),
  fc.constant({ t: "double" as const }),
  fc.record({ t: fc.constant("direct_mint" as const), chain: fc.nat(1), k: amount }),
);
const decimals = fc.constantFrom(6, 8, 18);

function specFor(arbDecimals: number, baseDecimals: number): TokenSpec {
  return makeSpec({ arbDecimals, baseDecimals, flowLimit: null });
}

/** Applies one valid command; returns false when the command is not possible in this state. */
function apply(w: World, c: Command, lag: () => (chain: ChainSel) => bigint, deltas: bigint[]): void {
  switch (c.t) {
    case "send": {
      const src = chainAt(c.src);
      const dst = chainAt(c.dst);
      if (src === dst) return;
      const canonical = c.k * w.granularity(src, dst);
      if (src !== HOME && (w.supplies.get(src) ?? 0n) < w.native(src, canonical)) return;
      w.send(src, dst, canonical);
      return;
    }
    case "deliver":
      w.deliver(c.i);
      return;
    case "epoch":
      w.epoch(lag());
      deltas.push(w.donated);
      return;
    case "donate":
      w.donate(c.k);
      return;
  }
}

type Expected = { rule: "junction"; reason: Reason; credit: Credit } | { rule: "loop"; reason: Reason } | null;

/**
 * `donationsAhead` is every donation still to come in the history. The Loop
 * Rule nets surplus against deficit by design (donations raise delta), so a
 * direct mint no larger than the unclaimed surplus is not a deficit; the
 * generator mints strictly more than all donations so the forgery is real.
 */
function inject(w: World, f: Forgery, donationsAhead: bigint): Expected {
  switch (f.t) {
    case "none":
      return null;
    case "no_debit": {
      const dst = chainAt(f.dst);
      const src = chainAt(f.dst + 1 + f.src);
      const credit = w.forge(dst, src, w.native(dst, f.k * w.granularity(dst, dst)), MALLORY);
      return { rule: "junction", reason: Reason.DEBIT_NOT_FOUND, credit };
    }
    case "amount":
    case "recipient": {
      if (w.pending.length === 0) w.send(HOME, ARB, w.granularity(HOME, ARB));
      const d = w.pending[0];
      if (d === undefined) throw new Error("unreachable: a debit was just sent");
      const honest = rescale(
        rescale(d.amount, decimalsOn(w.spec, d.srcChain), w.spec.home.decimals),
        w.spec.home.decimals,
        decimalsOn(w.spec, d.dstChain),
      );
      const credit =
        f.t === "recipient"
          ? w.deliver(0, { recipient: MALLORY })
          : w.deliver(0, { amount: f.up || honest === 1n ? honest + 1n : honest - 1n });
      if (credit === null) throw new Error("unreachable: a debit is pending");
      return {
        rule: "junction",
        reason: f.t === "recipient" ? Reason.RECIPIENT_MISMATCH : Reason.AMOUNT_MISMATCH,
        credit,
      };
    }
    case "double": {
      if (w.delivered.length === 0) {
        w.send(HOME, ARB, w.granularity(HOME, ARB));
        w.deliver(w.pending.length - 1);
      }
      const d = w.delivered[0];
      if (d === undefined) throw new Error("unreachable: a debit was just delivered");
      return { rule: "junction", reason: Reason.DOUBLE_CREDIT, credit: w.credit(d) };
    }
    case "direct_mint": {
      const chain = chainAt(f.chain + 1);
      const g = w.granularity(chain, chain);
      w.directMint(chain, w.native(chain, ((w.donated + donationsAhead) / g + f.k) * g));
      return { rule: "loop", reason: Reason.LOOP_DEFICIT };
    }
  }
}

describe("property: every forgery flagged, zero false flags", () => {
  it("holds over 10,000 random histories", () => {
    let forged = 0;
    let valid = 0;
    fc.assert(
      fc.property(
        decimals,
        decimals,
        fc.array(command, { maxLength: 30 }),
        forgery,
        fc.nat(),
        (arbDecimals, baseDecimals, commands, f, position) => {
          const spec = specFor(arbDecimals, baseDecimals);
          const w = new World(spec);
          const deltas: bigint[] = [];
          const at = position % (commands.length + 1);
          let expected: Expected = null;
          const donationsAfter = (i: number): bigint =>
            commands.slice(i).reduce((sum, c) => (c.t === "donate" ? sum + c.k : sum), 0n);
          commands.forEach((c, i) => {
            if (i === at) expected = inject(w, f, donationsAfter(i));
            apply(w, c, () => () => 0n, deltas);
          });
          if (at === commands.length) expected = inject(w, f, 0n);
          w.epoch();
          deltas.push(w.donated);

          const r = backtest(w.history, spec);
          const exp: Expected = expected;
          if (exp === null) {
            valid++;
            expect(r.breaches).toEqual([]);
            expect(r.drift).toEqual([]);
            expect(r.epochs.every((e) => e.status === Status.CONSERVED)).toBe(true);
            // Valid traffic conserves exactly; only donations move delta, and only upward.
            expect(r.epochs.map((e) => e.loop.delta)).toEqual(deltas);
            return;
          }
          forged++;
          expect(r.finalStatus).toBe(Status.BROKEN);
          const junctionBreaches = r.breaches.filter((b) => b.rule === "junction");
          if (exp.rule === "junction") {
            expect(junctionBreaches).toEqual([expect.objectContaining({ reason: exp.reason, credit: exp.credit })]);
          } else {
            expect(junctionBreaches).toEqual([]);
            expect(r.breaches[0]).toMatchObject({ rule: "loop", reason: exp.reason });
          }
        },
      ),
      { numRuns: 10_000, seed: 20261006 },
    );
    // Both halves of the property must be exercised heavily.
    expect(valid).toBeGreaterThan(1_000);
    expect(forged).toBeGreaterThan(5_000);
  });

  it("valid traffic with lagging, mixed-confidence pins never breaks and settles once pins catch up", () => {
    fc.assert(
      fc.property(
        decimals,
        decimals,
        fc.array(command, { maxLength: 30 }),
        fc.array(fc.nat(4), { minLength: 3, maxLength: 60 }),
        (arbDecimals, baseDecimals, commands, lags) => {
          const spec = specFor(arbDecimals, baseDecimals);
          const w = new World(spec);
          let n = 0;
          const nextLag = () => {
            const base = n;
            n += 3;
            return (chain: ChainSel) => BigInt(lags[(base + CHAINS.indexOf(chain)) % lags.length] ?? 0);
          };
          for (const c of commands) apply(w, c, nextLag, []);
          w.epoch();
          const r = backtest(w.history, spec);
          expect(r.breaches).toEqual([]);
          expect(r.drift.every((d) => d.reason === Reason.PENDING_ATTESTATION)).toBe(true);
          expect(r.finalStatus).toBe(Status.CONSERVED);
          expect(r.epochs.at(-1)?.loop.delta).toBe(w.donated);
          expect(r.coverage.pending).toBe(0);
        },
      ),
      { numRuns: 2_000, seed: 4049 },
    );
  });
});
