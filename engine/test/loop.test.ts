import { describe, expect, it } from "vitest";
import { loop } from "../src/loop.ts";
import { EngineInputError, Reason, Status, type BurnMintSnapshot, type LockReleaseSnapshot } from "../src/types.ts";
import { ARB, BASE, HOME, addr, makeSpec, units } from "./fixtures.ts";

function lockRelease(over: Partial<LockReleaseSnapshot> = {}): LockReleaseSnapshot {
  return {
    model: "lock_release_home",
    epochId: 1n,
    pinned: [],
    escrow: units(100n),
    supplies: [
      { chain: ARB, supply: units(60n) },
      { chain: BASE, supply: units(30n) },
    ],
    inFlightOut: units(6n),
    inFlightIn: units(4n),
    flowLastHour: 0n,
    priorDeficitEpochs: 0,
    ...over,
  };
}

function burnMint(over: Partial<BurnMintSnapshot> = {}): BurnMintSnapshot {
  return {
    model: "burn_mint_multi",
    epochId: 1n,
    pinned: [],
    issuanceNet: units(100n),
    reserve: null,
    supplies: [
      { chain: HOME, supply: units(50n) },
      { chain: ARB, supply: units(30n) },
      { chain: BASE, supply: units(10n) },
    ],
    inFlightOut: units(5n),
    inFlightIn: units(5n),
    flowLastHour: 0n,
    priorDeficitEpochs: 0,
    ...over,
  };
}

describe("loop: lock_release_home", () => {
  const spec = makeSpec();

  it("is CONSERVED at exactly zero delta", () => {
    expect(loop(lockRelease(), spec)).toEqual({
      status: Status.CONSERVED,
      reason: Reason.OK,
      delta: 0n,
      backing: units(100n),
      claims: units(100n),
      surplus: 0n,
      deficit: false,
    });
  });

  it("counts an escrow donation as surplus, never as a breach", () => {
    const r = loop(lockRelease({ escrow: units(105n) }), spec);
    expect(r.status).toBe(Status.CONSERVED);
    expect(r.delta).toBe(units(5n));
    expect(r.surplus).toBe(units(5n));
  });

  it("is BROKEN with LOOP_DEFICIT below minus tolerance", () => {
    const r = loop(lockRelease({ escrow: units(100n) - 1n }), spec);
    expect(r).toMatchObject({ status: Status.BROKEN, reason: Reason.LOOP_DEFICIT, delta: -1n, deficit: true, surplus: 0n });
  });

  it("absorbs a deficit inside the tolerance", () => {
    const r = loop(lockRelease({ escrow: units(100n) - 5n }), makeSpec({ tolerance: 5n }));
    expect(r.status).toBe(Status.CONSERVED);
    expect(loop(lockRelease({ escrow: units(100n) - 6n }), makeSpec({ tolerance: 5n })).status).toBe(Status.BROKEN);
  });

  it("waits for breach_confirmations consecutive deficit epochs", () => {
    const spec2 = makeSpec({ breachConfirmations: 2 });
    const short = lockRelease({ escrow: units(99n) });
    expect(loop(short, spec2)).toMatchObject({ status: Status.DRIFT, reason: Reason.LOOP_DEFICIT, deficit: true });
    expect(loop({ ...short, priorDeficitEpochs: 1 }, spec2).status).toBe(Status.BROKEN);
  });

  it("normalizes remote supplies with other decimals", () => {
    const six = makeSpec({ arbDecimals: 6, baseDecimals: 24 });
    const r = loop(
      lockRelease({
        supplies: [
          { chain: ARB, supply: 60_000_000n },
          { chain: BASE, supply: units(30n) * 1_000_000n + 999_999n },
        ],
      }),
      six,
    );
    expect(r.delta).toBe(0n);
  });

  it("raises FLOW_LIMIT as DRIFT above the hourly limit only", () => {
    expect(loop(lockRelease({ flowLastHour: units(50000n) }), spec).status).toBe(Status.CONSERVED);
    expect(loop(lockRelease({ flowLastHour: units(50000n) + 1n }), spec)).toMatchObject({
      status: Status.DRIFT,
      reason: Reason.FLOW_LIMIT,
      deficit: false,
    });
    expect(loop(lockRelease({ flowLastHour: units(10n ** 9n) }), makeSpec({ flowLimit: null })).status).toBe(
      Status.CONSERVED,
    );
  });

  it("rejects malformed snapshots", () => {
    expect(() => loop(lockRelease({ supplies: [{ chain: ARB, supply: 1n }] }), spec)).toThrow(EngineInputError);
    expect(() =>
      loop(lockRelease({ supplies: [...lockRelease().supplies, { chain: ARB, supply: 1n }] }), spec),
    ).toThrow(EngineInputError);
    expect(() => loop(burnMint(), spec)).toThrow(EngineInputError);
  });
});

describe("loop: burn_mint_multi", () => {
  const spec = makeSpec({ model: "burn_mint_multi" });
  const backed = makeSpec({ model: "burn_mint_multi", porFeed: addr(0xfeed), reserveDecimals: 8 });

  it("counts every chain's supply against net issuance", () => {
    expect(loop(burnMint(), spec)).toMatchObject({ status: Status.CONSERVED, delta: 0n, backing: units(100n) });
    expect(loop(burnMint({ issuanceNet: units(99n) }), spec)).toMatchObject({
      status: Status.BROKEN,
      reason: Reason.LOOP_DEFICIT,
    });
  });

  it("is RESERVE_SHORTFALL when the reserve binds", () => {
    const r = loop(burnMint({ reserve: 99n * 10n ** 8n }), backed);
    expect(r).toMatchObject({ status: Status.BROKEN, reason: Reason.RESERVE_SHORTFALL, backing: units(99n) });
  });

  it("is LOOP_DEFICIT when issuance binds, including a tie with the reserve", () => {
    const tie = loop(burnMint({ issuanceNet: units(99n), reserve: 99n * 10n ** 8n }), backed);
    expect(tie.reason).toBe(Reason.LOOP_DEFICIT);
    const ample = loop(burnMint({ reserve: 200n * 10n ** 8n }), backed);
    expect(ample).toMatchObject({ status: Status.CONSERVED, backing: units(100n) });
  });

  it("needs a reserve answer when the spec has a PoR feed", () => {
    expect(() => loop(burnMint(), backed)).toThrow(EngineInputError);
  });
});
