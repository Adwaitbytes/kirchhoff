import { describe, expect, it } from "vitest";
import { reviveSpec, toSpecJson } from "../src/index.ts";
import { makeSpec } from "./fixtures.ts";

describe("toSpecJson / reviveSpec", () => {
  it.each([
    ["the demo spec", makeSpec()],
    ["a spec with no flow limit", makeSpec({ model: "burn_mint_multi", flowLimit: null })],
  ])("round-trips %s through JSON text", (_label, spec) => {
    const text = JSON.stringify(toSpecJson(spec));
    expect(reviveSpec(JSON.parse(text) as ReturnType<typeof toSpecJson>)).toEqual(spec);
  });

  it("carries selectors as decimal strings", () => {
    const json = toSpecJson(makeSpec());
    expect(json.home.chain.selector).toBe("16015286601757825753");
    expect(json.rules.soft.flowLimitPerHour).toBe("50000000000000000000000");
  });

  it("refuses a non-integer string instead of guessing", () => {
    const json = toSpecJson(makeSpec());
    expect(() => reviveSpec({ ...json, rules: { ...json.rules, stalenessSeconds: "1.5" } })).toThrow(SyntaxError);
  });
});
