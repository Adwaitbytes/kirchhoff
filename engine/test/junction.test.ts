import { describe, expect, it } from "vitest";
import { junction, matchAll, trailingFlow, type JunctionContext, type MatchContext } from "../src/junction.ts";
import { Reason, Status, type Hex } from "../src/types.ts";
import { ARB, BASE, BOB, HOME, creditFor, debit, hash, makeSpec, units } from "./fixtures.ts";

const spec = makeSpec();
const ID = hash("msg-1");

function ctx(over: Partial<JunctionContext> = {}): JunctionContext {
  return {
    spec,
    sourceHead: 1_000n,
    sourceFinal: true,
    isConsumed: () => false,
    creditTimestamp: 10_000n,
    now: 10_000n,
    ...over,
  };
}

describe("junction", () => {
  const d = debit({ messageId: ID });

  it("settles an exact match", () => {
    expect(junction(creditFor(d), d, ctx())).toEqual({ status: Status.CONSERVED, reason: Reason.OK, settledMessageId: ID });
  });

  it("matches ids and recipients case-insensitively", () => {
    const upper = creditFor(d, { messageId: ID.toUpperCase().replace("0X", "0x") as Hex, recipient: d.recipient?.toUpperCase().replace("0X", "0x") as Hex });
    expect(junction(upper, d, ctx()).status).toBe(Status.CONSERVED);
  });

  describe("no debit", () => {
    it("is DEBIT_NOT_FOUND at once when the source is final", () => {
      expect(junction(creditFor(d), null, ctx())).toEqual({ status: Status.BROKEN, reason: Reason.DEBIT_NOT_FOUND });
    });
    it("is DRIFT inside the match window when the source is not final", () => {
      const r = junction(creditFor(d), null, ctx({ sourceFinal: false, now: 10_000n + 1200n }));
      expect(r).toEqual({ status: Status.DRIFT, reason: Reason.PENDING_ATTESTATION });
    });
    it("is BROKEN once the match window ends", () => {
      const r = junction(creditFor(d), null, ctx({ sourceFinal: false, now: 10_000n + 1201n }));
      expect(r).toEqual({ status: Status.BROKEN, reason: Reason.DEBIT_NOT_FOUND });
    });
  });

  describe("condition 1: id, source and destination", () => {
    it.each([
      ["message id", { messageId: hash("other") }],
      ["claimed source chain", { claimedSrcChain: BASE }],
      ["destination chain", { dstChain: BASE }],
    ])("treats a different %s as no debit", (_label, over) => {
      expect(junction(creditFor(d, over), d, ctx()).reason).toBe(Reason.DEBIT_NOT_FOUND);
    });
  });

  it("condition 2: AMOUNT_MISMATCH", () => {
    expect(junction(creditFor(d, { amount: d.amount + 1n }), d, ctx())).toEqual({
      status: Status.BROKEN,
      reason: Reason.AMOUNT_MISMATCH,
    });
  });

  it("condition 2 compares canonical units across decimals", () => {
    const six = makeSpec({ arbDecimals: 6 });
    const burn = debit({ messageId: ID, srcChain: ARB, dstChain: HOME, amount: 2_500_000n });
    const release = creditFor(burn, { amount: 25n * 10n ** 17n });
    expect(junction(release, burn, ctx({ spec: six })).status).toBe(Status.CONSERVED);
    expect(junction({ ...release, amount: release.amount + 1n }, burn, ctx({ spec: six })).reason).toBe(
      Reason.AMOUNT_MISMATCH,
    );
  });

  describe("condition 3: recipient", () => {
    it("is RECIPIENT_MISMATCH when both sides carry different recipients", () => {
      expect(junction(creditFor(d, { recipient: BOB }), d, ctx())).toEqual({
        status: Status.BROKEN,
        reason: Reason.RECIPIENT_MISMATCH,
      });
    });
    it("is skipped when the debit does not carry a recipient", () => {
      const { recipient, ...bare } = d;
      expect(junction(creditFor(d, { recipient: BOB }), bare, ctx()).status).toBe(Status.CONSERVED);
    });
    it("is skipped when the credit does not carry a recipient", () => {
      const { recipient, ...bare } = creditFor(d);
      expect(junction(bare, d, ctx()).status).toBe(Status.CONSERVED);
    });
  });

  describe("condition 4: confidence", () => {
    it("is DRIFT while the debit is above the confident head, inside the window", () => {
      const r = junction(creditFor(d), { ...d, block: 1_001n }, ctx());
      expect(r).toEqual({ status: Status.DRIFT, reason: Reason.PENDING_ATTESTATION });
    });
    it("is BROKEN if the debit never reaches confidence inside the window", () => {
      const r = junction(creditFor(d), { ...d, block: 1_001n }, ctx({ now: 20_000n }));
      expect(r.reason).toBe(Reason.DEBIT_NOT_FOUND);
    });
  });

  it("condition 5: DOUBLE_CREDIT for a consumed id even when the debit is outside the lookup", () => {
    expect(junction(creditFor(d), null, ctx({ isConsumed: (id) => id === ID }))).toEqual({
      status: Status.BROKEN,
      reason: Reason.DOUBLE_CREDIT,
    });
  });

  it("condition 5: DOUBLE_CREDIT for an already consumed id", () => {
    expect(junction(creditFor(d), d, ctx({ isConsumed: (id) => id === ID }))).toEqual({
      status: Status.BROKEN,
      reason: Reason.DOUBLE_CREDIT,
    });
  });
});

describe("matchAll", () => {
  const sources = new Map([
    [HOME, { head: 1_000n, headTimestamp: 10_000n }],
    [ARB, { head: 1_000n, headTimestamp: 10_000n }],
    [BASE, { head: 1_000n, headTimestamp: 10_000n }],
  ]);
  const mctx = (over: Partial<MatchContext> = {}): MatchContext => ({
    now: 10_000n,
    sources,
    isConsumed: () => false,
    ...over,
  });
  const at = (c: ReturnType<typeof creditFor>, timestamp = 9_000n) => ({ credit: c, timestamp });

  it("settles matches and computes in-flight from unmatched debits by side", () => {
    const lock = debit({ messageId: hash("lock"), amount: units(3n) });
    const lockOpen = debit({ messageId: hash("lock-open"), amount: units(5n) });
    const burnOpen = debit({ messageId: hash("burn-open"), srcChain: ARB, dstChain: HOME, amount: units(7n) });
    const r = matchAll([lock, lockOpen, burnOpen], [at(creditFor(lock))], spec, mctx());
    expect(r.settled).toEqual([lock.messageId]);
    expect(r.inFlight).toEqual([lockOpen, burnOpen]);
    expect(r.inFlightOut).toBe(units(5n));
    expect(r.inFlightIn).toBe(units(7n));
    expect(r.settledFlow).toEqual([{ timestamp: 9_000n, amount: units(3n) }]);
  });

  it("flags the second credit of one debit in the same batch as DOUBLE_CREDIT", () => {
    const d = debit({ messageId: ID });
    const r = matchAll([d], [at(creditFor(d)), at(creditFor(d, { txHash: hash("replay") }))], spec, mctx());
    expect(r.verdicts.map((v) => v.result.reason)).toEqual([Reason.OK, Reason.DOUBLE_CREDIT]);
    expect(r.inFlightOut).toBe(0n);
  });

  it("flags a credit for an id consumed in an earlier batch and keeps it out of F", () => {
    const d = debit({ messageId: ID });
    const r = matchAll([d], [at(creditFor(d))], spec, mctx({ isConsumed: (id) => id === ID }));
    expect(r.verdicts[0]?.result.reason).toBe(Reason.DOUBLE_CREDIT);
    expect(r.inFlight).toEqual([]);
  });

  it("flags a credit with no debit", () => {
    const r = matchAll([], [at(creditFor(debit({ messageId: ID })))], spec, mctx());
    expect(r.verdicts[0]?.result).toEqual({ status: Status.BROKEN, reason: Reason.DEBIT_NOT_FOUND });
  });

  it("ignores an identical repeat of the same debit log", () => {
    const d = debit({ messageId: ID });
    const r = matchAll([d, { ...d }], [at(creditFor(d))], spec, mctx());
    expect(r.verdicts[0]?.result.status).toBe(Status.CONSERVED);
  });

  it("treats two different debits under one id as no unique debit", () => {
    const d = debit({ messageId: ID });
    const twin = { ...d, txHash: hash("twin") };
    const r = matchAll([d, twin], [at(creditFor(d))], spec, mctx());
    expect(r.verdicts[0]?.result.reason).toBe(Reason.DEBIT_NOT_FOUND);
  });

  it("treats a source chain with no head as not final", () => {
    const d = debit({ messageId: ID });
    const r = matchAll([d], [at(creditFor(d))], spec, mctx({ sources: new Map() }));
    expect(r.verdicts[0]?.result.status).toBe(Status.DRIFT);
    // A debit on a chain with no pin is not in the snapshot, so it is not in F either.
    expect(r.inFlightOut).toBe(-d.amount);
  });

  it("treats a source head older than the credit as not final", () => {
    const r = matchAll(
      [],
      [at(creditFor(debit({ messageId: ID })), 10_500n)],
      spec,
      mctx({ now: 10_600n }),
    );
    expect(r.verdicts[0]?.result.status).toBe(Status.DRIFT);
  });

  it("nets a credit whose matching debit is above the source pin out of F once", () => {
    const burn = debit({ messageId: ID, srcChain: ARB, dstChain: HOME, block: 1_500n });
    const release = creditFor(burn);
    const r = matchAll([burn], [at(release), at({ ...release, txHash: hash("again") })], spec, mctx());
    expect(r.verdicts.map((v) => v.result.status)).toEqual([Status.DRIFT, Status.DRIFT]);
    expect(r.inFlight).toEqual([]);
    expect(r.inFlightIn).toBe(-burn.amount);
    expect(r.inFlightOut).toBe(0n);
  });

  it("does not net a pending credit whose debit went to another destination", () => {
    const d = debit({ messageId: ID, dstChain: BASE, block: 1_500n });
    const r = matchAll([d], [at(creditFor(d, { dstChain: ARB }), 10_500n)], spec, mctx({ now: 10_600n }));
    expect(r.verdicts[0]?.result.status).toBe(Status.DRIFT);
    expect(r.inFlightOut).toBe(0n);
  });

  it("does not net a pending credit with no debit", () => {
    const r = matchAll([], [at(creditFor(debit({ messageId: ID })), 10_500n)], spec, mctx({ now: 10_600n }));
    expect(r.verdicts[0]?.result.status).toBe(Status.DRIFT);
    expect(r.inFlightOut).toBe(0n);
  });
});

describe("trailingFlow", () => {
  it("sums entries inside the trailing hour only", () => {
    const entries = [
      { timestamp: 0n, amount: 1n },
      { timestamp: 401n, amount: 2n },
      { timestamp: 4_000n, amount: 4n },
      { timestamp: 4_001n, amount: 8n },
    ];
    expect(trailingFlow(entries, 4_000n)).toBe(6n);
    expect(trailingFlow(entries, 4_000n, 10n)).toBe(4n);
  });
});
