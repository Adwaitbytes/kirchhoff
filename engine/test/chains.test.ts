import { describe, expect, it } from "vitest";
import {
  KNOWN_CHAINS,
  bridgeForMinter,
  chainByAlias,
  chainRef,
  confidenceOn,
  decimalsOn,
  isHome,
  knownChainByName,
  specChains,
  tokenOn,
} from "../src/chains.ts";
import { EngineInputError, reasonName, statusName, toReason, describeError, Reason, Status } from "../src/types.ts";
import { ARB, BASE, CANONICAL, HOME, REMOTE_ARB, makeSpec } from "./fixtures.ts";

const spec = makeSpec({ arbDecimals: 6 });
const NOWHERE = 1n;

describe("chain registry", () => {
  it("carries the frozen CCIP selectors", () => {
    expect(KNOWN_CHAINS.map((c) => [c.name, c.selector, c.localChainId])).toEqual([
      ["ethereum-testnet-sepolia", 16015286601757825753n, 31337],
      ["ethereum-testnet-sepolia-arbitrum-1", 3478487238524512106n, 31338],
      ["ethereum-testnet-sepolia-base-1", 10344971235874465080n, 31339],
    ]);
    expect(knownChainByName("ethereum-testnet-sepolia-base-1")?.selector).toBe(BASE);
    expect(knownChainByName("nope")).toBeUndefined();
  });
});

describe("spec chain helpers", () => {
  it("lists home first", () => {
    expect(specChains(spec).map((c) => c.alias)).toEqual(["home", "arb", "base"]);
  });
  it("resolves refs, aliases and home", () => {
    expect(chainRef(spec, ARB).alias).toBe("arb");
    expect(() => chainRef(spec, NOWHERE)).toThrow(EngineInputError);
    expect(chainByAlias(spec, "base")?.selector).toBe(BASE);
    expect(chainByAlias(spec, "mars")).toBeUndefined();
    expect(isHome(spec, HOME)).toBe(true);
    expect(isHome(spec, ARB)).toBe(false);
  });
  it("finds the token and decimals per chain", () => {
    expect(tokenOn(spec, HOME)).toBe(CANONICAL);
    expect(tokenOn(spec, ARB)).toBe(REMOTE_ARB);
    expect(() => tokenOn(spec, NOWHERE)).toThrow(EngineInputError);
    expect(decimalsOn(spec, HOME)).toBe(18);
    expect(decimalsOn(spec, ARB)).toBe(6);
    expect(() => decimalsOn(spec, NOWHERE)).toThrow(EngineInputError);
  });
  it("applies confidence overrides", () => {
    expect(confidenceOn(spec, BASE)).toBe("safe");
    expect(confidenceOn(spec, ARB)).toBe("finalized");
  });
  it("maps minter names to bridges", () => {
    expect(bridgeForMinter(spec, "ccip_pool_arb", "arb")?.id).toBe("ccip");
    expect(bridgeForMinter(spec, "weakbridge_arb", "arb")?.id).toBe("weakbridge");
    expect(bridgeForMinter(spec, "weakbridge", "arb")?.id).toBe("weakbridge");
    expect(bridgeForMinter(spec, "layerzero_arb", "arb")).toBeUndefined();
  });
});

describe("enum helpers", () => {
  it("names statuses and reasons", () => {
    expect(statusName(Status.QUARANTINED)).toBe("QUARANTINED");
    expect(reasonName(Reason.TOKEN_RECOVERING)).toBe("TOKEN_RECOVERING");
    expect(toReason(13)).toBe(Reason.SPEC_MISMATCH);
    expect(() => toReason(99)).toThrow(EngineInputError);
  });
  it("matches the frozen numeric values", () => {
    expect(Status).toEqual({ UNKNOWN: 0, CONSERVED: 1, DRIFT: 2, BROKEN: 3, QUARANTINED: 4, RECOVERING: 5 });
    expect(Object.values(Reason)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(Object.keys(Reason)).toEqual([
      "OK",
      "PENDING_ATTESTATION",
      "DEBIT_NOT_FOUND",
      "AMOUNT_MISMATCH",
      "RECIPIENT_MISMATCH",
      "DOUBLE_CREDIT",
      "LOOP_DEFICIT",
      "RESERVE_SHORTFALL",
      "FLOW_LIMIT",
      "STATUS_STALE",
      "TOKEN_BROKEN",
      "TOKEN_QUARANTINED",
      "UNKNOWN_TOKEN",
      "SPEC_MISMATCH",
      "TOKEN_RECOVERING",
    ]);
  });
  it("describes thrown values", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("plain")).toBe("plain");
  });
});
