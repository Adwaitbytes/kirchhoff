import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSpec, specHash, canonicalJson, validateSpec, specAddresses, isPlaceholder, ZERO_ADDRESS, normalizeSpec } from "../src/spec/index.ts";
import { tokenId } from "../src/encoding.ts";
import type { TokenSpec } from "../src/types.ts";
import { ARB, BASE, HOME, addr, makeSpec, units } from "./fixtures.ts";

const KETH_YAML = readFileSync(new URL("../specs/kETH.yaml", import.meta.url), "utf8");

/** PRD section 6 example verbatim, except its "0xCanonical..." placeholders become real hex. */
const PRD_YAML = `
spec_version: 1
token: kETH
model: lock_release_home        # or burn_mint_multi
home:
  chain: ethereum-testnet-sepolia
  canonical: "${addr(0x1001)}"
  escrow: "${addr(0x1002)}"
remotes:
  - chain: ethereum-testnet-sepolia-arbitrum-1
    token: "${addr(0x2001)}"
    minters: [ccip_pool_arb, weakbridge_arb]
  - chain: ethereum-testnet-sepolia-base-1
    token: "${addr(0x3001)}"
    minters: [ccip_pool_base]
bridges:
  - id: ccip
    kind: ccip_v2
    pools: { home: "${addr(0x1003)}", arb: "${addr(0x2002)}", base: "${addr(0x3002)}" }
  - id: weakbridge
    kind: custom
    debit_event: "Burned(bytes32 indexed id, address indexed from, address to, uint256 amount, uint64 dstChain)"
    credit_event: "Released(bytes32 indexed id, address indexed to, uint256 amount, uint64 srcChain)"
    search_window_blocks: 50000
reserves:
  por_feed: null                # AggregatorV3 address for backed tokens
confidence:
  default: finalized
  overrides: { ethereum-testnet-sepolia-base-1: safe }
rules:
  junction: { match_window_seconds: 1200 }
  loop: { tolerance_wei: "0", breach_confirmations: 1 }
  soft:
    flow_limit_per_hour: "50000e18"
  staleness_seconds: 120
  on_stale: fail_closed
response:
  on_broken: [freeze_ccip_lanes, taint_recipient, flip_feed, page_issuer]
  replay_requires: issuer_multisig
  recovery_timelock_seconds: 3600
`;

function parsed(yaml: string): TokenSpec {
  const r = parseSpec(yaml);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.spec;
}

const errorsOf = (yaml: string): string[] => {
  const r = parseSpec(yaml);
  return r.ok ? [] : r.errors;
};

describe("parseSpec", () => {
  it("parses the PRD section 6 example with defaults applied", () => {
    const spec = parsed(PRD_YAML);
    expect(spec.tokenId).toBe(tokenId("kETH"));
    expect(spec.unit).toBe("tokens");
    expect(spec.home.chain).toEqual({ name: "ethereum-testnet-sepolia", selector: HOME, alias: "home" });
    expect(spec.remotes.map((r) => [r.chain.selector, r.chain.alias, r.decimals])).toEqual([
      [ARB, "arb", 18],
      [BASE, "base", 18],
    ]);
    expect(spec.rules.soft.flowLimitPerHour).toBe(units(50000n));
    expect(spec.rules.junction.matchWindowSeconds).toBe(1200n);
    const [ccip, wb] = spec.bridges;
    expect(ccip).toMatchObject({ kind: "ccip_v2", onramps: {}, offramps: {}, lockbox: null, searchWindowBlocks: 100n, maxDeliverySeconds: 1200 });
    expect(wb).toMatchObject({ kind: "custom", contracts: {}, events: { debitFields: { messageId: "id" } } });
    expect(spec.reserves).toEqual({ porFeed: null, decimals: 18 });
  });

  it("parses specs/kETH.yaml", () => {
    const spec = parsed(KETH_YAML);
    expect(spec.bridges[1]?.kind === "custom" && Object.keys(spec.bridges[1].contracts)).toEqual(["home", "arb", "base"]);
  });

  it("parses every optional extension", () => {
    const yaml = PRD_YAML.replace("model: lock_release_home", "model: burn_mint_multi\nunit: shares")
      .replace(`  escrow: "${addr(0x1002)}"`, "  escrow: null\n  decimals: 6")
      .replace("    minters: [ccip_pool_base]", "    minters: [ccip_pool_base]\n    alias: b\n    decimals: 8")
      .replace(
        "  - id: weakbridge",
        `  - id: weakbridge
    max_delivery_seconds: 99
    debit_fields: { message_id: id, amount: amount, recipient: null, remote_chain: dstChain }
    credit_fields: { message_id: id, amount: amount, recipient: to, remote_chain: srcChain }`,
      )
      .replace(
        "    pools: {",
        `    onramps: { arb: "${addr(0x2004)}" }
    offramps: { arb: "${addr(0x2005)}" }
    lockbox: "${addr(0x1006)}"
    pools: {`,
      )
      .replace("  por_feed: null ", `  por_feed: "${addr(0xfeed)}"\n  decimals: 8 `)
      .replace('    flow_limit_per_hour: "50000e18"', "    flow_limit_per_hour: null");
    const spec = parsed(yaml);
    expect(spec.model).toBe("burn_mint_multi");
    expect(spec.unit).toBe("shares");
    expect(spec.home).toMatchObject({ escrow: null, decimals: 6 });
    expect(spec.remotes[1]).toMatchObject({ decimals: 8, chain: { alias: "b" } });
    expect(spec.bridges[0]).toMatchObject({ onramps: { arb: addr(0x2004) }, offramps: { arb: addr(0x2005) }, lockbox: addr(0x1006) });
    expect(spec.bridges[1]).toMatchObject({ maxDeliverySeconds: 99, events: { debitFields: { recipient: null } } });
    expect(spec.reserves).toEqual({ porFeed: addr(0xfeed), decimals: 8 });
    expect(spec.rules.soft.flowLimitPerHour).toBeNull();
  });

  it("defaults reserve decimals to home decimals and accepts an omitted soft block", () => {
    const yaml = PRD_YAML.replace(`  escrow: "${addr(0x1002)}"`, `  escrow: "${addr(0x1002)}"\n  decimals: 6`)
      .replace("reserves:\n  por_feed: null                # AggregatorV3 address for backed tokens\n", "")
      .replace('  soft:\n    flow_limit_per_hour: "50000e18"\n', "");
    const spec = parsed(yaml);
    expect(spec.reserves).toEqual({ porFeed: null, decimals: 6 });
    expect(spec.rules.soft.flowLimitPerHour).toBeNull();
  });

  it.each([
    ["invalid YAML", "a: [", /YAML/],
    ["duplicate keys", "a: 1\na: 2", /YAML/],
    ["YAML aliases", "a: &x 1\nb: *x", /YAML/],
    ["a non-object document", "42", /^spec must be object/],
    ["an unknown field", PRD_YAML + "\nextra: 1\n", /additional properties/],
    ["a bad address", PRD_YAML.replace(addr(0x2001), "0xRemoteArb..."), /pattern/],
    ["a numeric amount", PRD_YAML.replace('tolerance_wei: "0"', "tolerance_wei: 0"), /must be string/],
    ["a guessed CCIP event ABI", PRD_YAML.replace("    kind: ccip_v2", '    kind: ccip_v2\n    debit_event: "L(bytes32 indexed id)"'), /additional properties/],
    ["an unknown chain", PRD_YAML.replace("chain: ethereum-testnet-sepolia-base-1", "chain: solana-devnet"), /unknown chain "solana-devnet"/],
    ["an unknown home chain", PRD_YAML.replace("  chain: ethereum-testnet-sepolia\n", "  chain: mars\n"), /unknown chain "mars"/],
    ["a fractional amount", PRD_YAML.replace('"50000e18"', '"1.5"'), /flow_limit_per_hour/],
    ["a fractional tolerance", PRD_YAML.replace('tolerance_wei: "0"', 'tolerance_wei: "0.5"'), /tolerance_wei/],
  ])("rejects %s", (_label, yaml, pattern) => {
    expect(errorsOf(yaml).join("\n")).toMatch(pattern);
  });

  it("defaults confidence overrides to none", () => {
    const spec = parsed(PRD_YAML.replace("  overrides: { ethereum-testnet-sepolia-base-1: safe }\n", ""));
    expect(spec.confidence.overrides).toEqual({});
  });

  it("rejects an oversized document before parsing", () => {
    expect(errorsOf(`a: "${"x".repeat(300 * 1024)}"`)[0]).toMatch(/exceeds/);
  });

  it("normalizeSpec reports amount errors from a raw document", () => {
    const r = parseSpec(PRD_YAML);
    if (!r.ok) throw new Error("fixture");
    const bad = normalizeSpec({ ...r.raw, rules: { ...r.raw.rules, loop: { ...r.raw.rules.loop, tolerance_wei: "1.5" } } });
    expect(bad.ok).toBe(false);
  });
});

describe("validateSpec", () => {
  it("accepts the demo spec, warning only about placeholders", async () => {
    const r = await validateSpec(parsed(KETH_YAML));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(17);
    expect(r.warnings.every((w) => w.includes("placeholder"))).toBe(true);
  });

  it("flags what the PRD example leaves out: the weakbridge address, CCIP ramps and the lock box", async () => {
    const r = await validateSpec(parsed(PRD_YAML));
    expect(r.errors).toEqual([
      "minter weakbridge_arb maps to bridge weakbridge, which has no address on ethereum-testnet-sepolia-arbitrum-1",
      "ccip_v2 bridge ccip has a home pool but no lockbox; the lock-release escrow is the ERC20LockBox balance",
    ]);
    expect(r.warnings.filter((w) => w.includes("no onramps entry"))).toHaveLength(3);
    expect(r.warnings.filter((w) => w.includes("no offramps entry"))).toHaveLength(3);
  });

  it("reports every semantic error", async () => {
    const base = makeSpec();
    const remote = base.remotes[0];
    if (remote === undefined) throw new Error("fixture");
    const spec: TokenSpec = {
      ...base,
      home: { ...base.home, escrow: null },
      remotes: [
        { ...remote, minters: [] },
        { ...remote, minters: ["layerzero_arb"] },
      ],
      bridges: [
        ...base.bridges,
        { ...base.bridges[1], id: "weakbridge", kind: "custom", contracts: { mars: addr(1) } } as TokenSpec["bridges"][number],
        {
          id: "broken",
          kind: "custom",
          contracts: {},
          events: {
            debitEvent: "Burned(bytes32 indexed id, address to, uint256 amount, uint64 dstChain)",
            creditEvent: "Released(address indexed to, bytes32 indexed id, uint256 amount, uint64 srcChain)",
            debitFields: { messageId: "id", amount: "amount", recipient: "to", remoteChain: "dstChain" },
            creditFields: { messageId: "id", amount: "amount", recipient: "to", remoteChain: "srcChain" },
          },
          searchWindowBlocks: 1n,
          maxDeliverySeconds: 1,
        },
        {
          id: "unparsable",
          kind: "custom",
          contracts: {},
          events: {
            debitEvent: "((",
            creditEvent: "((",
            debitFields: { messageId: "id", amount: "amount", recipient: null, remoteChain: "dst" },
            creditFields: { messageId: "id", amount: "amount", recipient: null, remoteChain: "src" },
          },
          searchWindowBlocks: 1n,
          maxDeliverySeconds: 1,
        },
      ],
      confidence: { default: "finalized", overrides: { "ethereum-testnet-sepolia-base-1": "safe", venus: "latest" } },
    };
    const r = await validateSpec(spec);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(
      expect.arrayContaining([
        "chain ethereum-testnet-sepolia-arbitrum-1 appears more than once",
        "chain alias arb appears more than once",
        "bridge id weakbridge appears more than once",
        "confidence override for venus, which is not in the spec",
        "lock_release_home needs home.escrow",
        "remote ethereum-testnet-sepolia-arbitrum-1 has no minter",
        "minter layerzero_arb on ethereum-testnet-sepolia-arbitrum-1 maps to no bridge",
        "bridge weakbridge contracts names unknown chain alias mars",
        "bridge broken: debit and credit must carry the message id in the same topic",
      ]),
    );
    expect(r.errors.some((e) => e.startsWith("bridge unparsable: invalid event signature"))).toBe(true);
  });

  it("runs the injected bytecode check on every real address", async () => {
    const spec = makeSpec({ porFeed: addr(0xfeed) });
    const seen: string[] = [];
    const ok = await validateSpec(spec, (chain, address) => {
      seen.push(`${chain.alias}:${address}`);
      return Promise.resolve(true);
    });
    expect(ok.ok).toBe(true);
    expect(seen).toHaveLength(specAddresses(spec).length);
    expect(seen).toContain(`home:${addr(0xfeed)}`);

    const missing = await validateSpec(spec, (_chain, address) => Promise.resolve(address !== addr(0x2001)));
    expect(missing.errors).toEqual([`remotes.arb.token ${addr(0x2001)} has no bytecode on ethereum-testnet-sepolia-arbitrum-1`]);

    const failing = await validateSpec(spec, () => Promise.reject(new Error("rpc down")));
    expect(failing.errors[0]).toMatch(/bytecode check failed on .*: rpc down/);
  });

  it("does not run the bytecode check on placeholders", async () => {
    let calls = 0;
    await validateSpec(parsed(KETH_YAML), () => {
      calls++;
      return Promise.resolve(true);
    });
    expect(calls).toBe(0);
    expect(isPlaceholder(ZERO_ADDRESS)).toBe(true);
  });

  it("lists the escrow only when the spec has one", () => {
    expect(specAddresses(makeSpec({ model: "burn_mint_multi" })).some((a) => a.label === "home.escrow")).toBe(false);
  });
});

describe("specHash", () => {
  it("ignores YAML formatting and comments but not meaning", () => {
    const reformatted = PRD_YAML.replace(/ +#.*$/gm, "").replace("  overrides: { ethereum-testnet-sepolia-base-1: safe }", "  overrides:\n    ethereum-testnet-sepolia-base-1: safe");
    expect(specHash(parsed(reformatted))).toBe(specHash(parsed(PRD_YAML)));
    expect(specHash(parsed(PRD_YAML.replace("staleness_seconds: 120", "staleness_seconds: 121")))).not.toBe(
      specHash(parsed(PRD_YAML)),
    );
  });
  it("serializes canonically with sorted keys and bigints as strings", () => {
    const json = canonicalJson(makeSpec());
    expect(json.startsWith('{"bridges":')).toBe(true);
    expect(json).toContain('"selector":"16015286601757825753"');
    expect(specHash(makeSpec())).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
