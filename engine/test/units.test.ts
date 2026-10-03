import { describe, expect, it } from "vitest";
import { parseAmount, rescale, toCanonical } from "../src/units.ts";
import { EngineInputError } from "../src/types.ts";
import { ARB, HOME, makeSpec } from "./fixtures.ts";

describe("rescale", () => {
  it("is the identity at equal precision", () => {
    expect(rescale(123n, 18, 18)).toBe(123n);
  });
  it("scales up exactly", () => {
    expect(rescale(5n, 6, 18)).toBe(5_000_000_000_000n);
  });
  it("floors when scaling down", () => {
    expect(rescale(1_999_999n, 18, 12)).toBe(1n);
    expect(rescale(2_000_000n, 18, 12)).toBe(2n);
  });
  it("floors negatives toward minus infinity", () => {
    expect(rescale(-1_500_000n, 18, 12)).toBe(-2n);
    expect(rescale(-2_000_000n, 18, 12)).toBe(-2n);
  });
});

describe("toCanonical", () => {
  it("normalizes a 6-decimal remote amount to home base units", () => {
    const spec = makeSpec({ arbDecimals: 6 });
    expect(toCanonical(spec, ARB, 1_000_000n)).toBe(10n ** 18n);
    expect(toCanonical(spec, HOME, 7n)).toBe(7n);
  });
});

describe("parseAmount", () => {
  it.each([
    ["0", 0n],
    ["1200", 1200n],
    ["50000e18", 50000n * 10n ** 18n],
    ["1.5e18", 15n * 10n ** 17n],
    ["1.5e1", 15n],
  ])("parses %s", (text, expected) => {
    expect(parseAmount(text)).toBe(expected);
  });
  it.each(["", "-1", "1e", "abc", "0x10", "1.5"])("rejects %s", (text) => {
    expect(() => parseAmount(text)).toThrow(EngineInputError);
  });
});
