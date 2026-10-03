import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyCreReport, transition, type StatusEvent } from "../src/status.ts";
import { Status } from "../src/types.ts";

const { UNKNOWN, CONSERVED, DRIFT, BROKEN, QUARANTINED, RECOVERING } = Status;
const ALL = [UNKNOWN, CONSERVED, DRIFT, BROKEN, QUARANTINED, RECOVERING] as const;
const recoveryOk: StatusEvent = { kind: "RECOVERY_CHECK", delta: 0n, timelockEnded: true };

describe("transition: PRD section 4 allowed transitions", () => {
  it.each([
    [UNKNOWN, { kind: "EPOCH", status: CONSERVED }, CONSERVED],
    [CONSERVED, { kind: "EPOCH", status: DRIFT }, DRIFT],
    [CONSERVED, { kind: "BREACH" }, BROKEN],
    [CONSERVED, { kind: "STALE" }, UNKNOWN],
    [DRIFT, { kind: "EPOCH", status: CONSERVED }, CONSERVED],
    [DRIFT, { kind: "BREACH" }, BROKEN],
    [BROKEN, { kind: "QUARANTINE_APPLIED" }, QUARANTINED],
    [QUARANTINED, { kind: "BEGIN_RECOVERY" }, RECOVERING],
    [RECOVERING, recoveryOk, CONSERVED],
  ] as const)("%i --%o--> %i", (from, event, to) => {
    expect(transition(from, event)).toEqual({ ok: true, status: to, changed: true });
  });
});

describe("transition: INTERFACES.md contract rules", () => {
  it("ignores an EPOCH while contained", () => {
    for (const from of [BROKEN, QUARANTINED, RECOVERING]) {
      expect(transition(from, { kind: "EPOCH", status: CONSERVED })).toEqual({ ok: true, status: from, changed: false });
    }
  });
  it("keeps the status on a same-status EPOCH", () => {
    expect(transition(CONSERVED, { kind: "EPOCH", status: CONSERVED })).toEqual({ ok: true, status: CONSERVED, changed: false });
  });
  it("accepts a DRIFT epoch before the first CONSERVED one", () => {
    expect(transition(UNKNOWN, { kind: "EPOCH", status: DRIFT }).ok).toBe(true);
  });
  it("records a repeat BREACH without a status change", () => {
    expect(transition(BROKEN, { kind: "BREACH" })).toEqual({ ok: true, status: BROKEN, changed: false });
    expect(transition(QUARANTINED, { kind: "BREACH" })).toEqual({ ok: true, status: QUARANTINED, changed: false });
  });
  it("breaks from UNKNOWN and RECOVERING", () => {
    expect(transition(UNKNOWN, { kind: "BREACH" })).toEqual({ ok: true, status: BROKEN, changed: true });
    expect(transition(RECOVERING, { kind: "BREACH" })).toEqual({ ok: true, status: BROKEN, changed: true });
  });
  it("demotes DRIFT to UNKNOWN when stale and never demotes contained statuses", () => {
    expect(transition(DRIFT, { kind: "STALE" })).toEqual({ ok: true, status: UNKNOWN, changed: true });
    for (const from of [UNKNOWN, BROKEN, QUARANTINED, RECOVERING]) {
      expect(transition(from, { kind: "STALE" })).toEqual({ ok: true, status: from, changed: false });
    }
  });
});

describe("transition: illegal", () => {
  it.each([
    [CONSERVED, { kind: "QUARANTINE_APPLIED" }, "only allowed when BROKEN"],
    [BROKEN, { kind: "BEGIN_RECOVERY" }, "only allowed when QUARANTINED"],
    [QUARANTINED, recoveryOk, "only allowed when RECOVERING"],
    [RECOVERING, { kind: "RECOVERY_CHECK", delta: 0n, timelockEnded: false }, "timelock"],
    [RECOVERING, { kind: "RECOVERY_CHECK", delta: -1n, timelockEnded: true }, "negative"],
  ] as const)("%i on %o", (from, event, why) => {
    const r = transition(from, event);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.from).toBe(from);
      expect(r.error.event).toBe(event.kind);
      expect(r.error.why).toContain(why);
    }
  });
});

describe("applyCreReport", () => {
  it("is total over every status", () => {
    for (const from of ALL) {
      expect(ALL).toContain(applyCreReport(from, { kind: "BREACH" }));
      expect(ALL).toContain(applyCreReport(from, { kind: "EPOCH", status: CONSERVED }));
    }
  });
});

const eventArb: fc.Arbitrary<StatusEvent> = fc.oneof(
  fc.constantFrom<StatusEvent>(
    { kind: "EPOCH", status: CONSERVED },
    { kind: "EPOCH", status: DRIFT },
    { kind: "BREACH" },
    { kind: "QUARANTINE_APPLIED" },
    { kind: "BEGIN_RECOVERY" },
    { kind: "STALE" },
  ),
  fc.record({ kind: fc.constant("RECOVERY_CHECK" as const), delta: fc.bigInt(-5n, 5n), timelockEnded: fc.boolean() }),
);

describe("status machine invariant (mirrors the Foundry invariant)", () => {
  it("never goes from BROKEN to CONSERVED without passing RECOVERING", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
        let status: Status = UNKNOWN;
        let brokenSinceRecovery = false;
        for (const event of events) {
          const r = transition(status, event);
          if (!r.ok) continue;
          if (r.status === BROKEN) brokenSinceRecovery = true;
          if (r.status === RECOVERING) brokenSinceRecovery = false;
          if (r.status === CONSERVED && brokenSinceRecovery) return false;
          status = r.status;
        }
        return true;
      }),
      { numRuns: 2000 },
    );
  });
});
