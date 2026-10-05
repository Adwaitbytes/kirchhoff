import { describe, expect, it } from "vitest";
import { ScriptedProvider, runTopologyScout, type CandidateSource } from "../src/index.ts";

const known: `0x${string}` = `0x${"1".repeat(40)}`;
const source: CandidateSource = {
  id: "fake",
  search: () =>
    Promise.resolve([
      { chain: "ethereum-testnet-sepolia-base-1", address: known, name: "Kirchhoff ETH", symbol: "kETH", source: "fake" },
      { chain: "ethereum-testnet-sepolia-base-1", address: `0x${"2".repeat(40)}`, name: "Kirchhoff ETH (bridged)", symbol: "kETH", source: "fake" },
      { chain: "ethereum-testnet-sepolia-arbitrum-1", address: `0x${"3".repeat(40)}`, name: "kETH Index", symbol: "KIDX", source: "fake" },
      { chain: "ethereum-testnet-sepolia-base-1", address: `0x${"2".repeat(40)}`, name: "dup", symbol: "kETH", source: "fake" },
    ]),
};

describe("Topology Scout", () => {
  it("drops known and duplicate deployments and assesses the rest deterministically without a model", async () => {
    const p = await runTopologyScout({ symbol: "kETH", name: "Kirchhoff", known: new Set([known]), sources: [source], provider: null, model: "none" });
    expect(p.map((x) => [x.address.slice(0, 4), x.assessment, x.generator])).toEqual([
      ["0x22", "needs_review", "rule"],
      ["0x33", "same_symbol_unrelated", "rule"],
    ]);
  });

  it("uses model triage when valid, keeping candidates as untrusted data", async () => {
    const provider = new ScriptedProvider([{ content: JSON.stringify({ items: [{ index: 0, assessment: "likely_bridged_variant", why: "Same name with a bridged suffix — review its minter." }] }) }]);
    const p = await runTopologyScout({ symbol: "kETH", name: "Kirchhoff", known: new Set([known]), sources: [source], provider, model: "m" });
    expect(p[0]).toMatchObject({ assessment: "likely_bridged_variant", generator: "model", why: "Same name with a bridged suffix, review its minter." });
    expect(p[1]?.generator).toBe("rule");
    expect(provider.requests[0]?.messages[1]?.content).toContain('{"untrusted_data":');
  });
});
