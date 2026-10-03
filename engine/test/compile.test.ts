import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { compileWorkflows, creConfidence, resolveSpec, type Deployments } from "../src/compile.ts";
import { reviveSpec } from "../src/spec-json.ts";
import { CCIP_TOPICS } from "../src/adapters/ccip.ts";
import { CONTRACT_EVENTS } from "../src/contract-events.ts";
import { compileSpecDocuments, parseSpec } from "../src/spec/index.ts";
import type { TokenSpec } from "../src/types.ts";
import { addr, hash, makeSpec } from "./fixtures.ts";

const ENGINE = new URL("..", import.meta.url).pathname;
const SPEC_YAML = readFileSync(join(ENGINE, "specs/kETH.yaml"), "utf8");
const DEPLOYMENTS_JSON = readFileSync(join(ENGINE, "test/fixtures/deployments.local.json"), "utf8");
const DEPLOYMENTS = JSON.parse(DEPLOYMENTS_JSON) as Deployments;

describe("compileSpecDocuments golden files", () => {
  it("generates all four workflow configs from specs/kETH.yaml", async () => {
    const r = await compileSpecDocuments(SPEC_YAML, DEPLOYMENTS_JSON, "staging");
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(Object.keys(r.files).sort()).toEqual([
      "spec.resolved.json",
      "w1-junction/config.staging.json",
      "w2-loop/config.staging.json",
      "w3-responder/config.staging.json",
      "w4-topology/config.staging.json",
    ]);
    for (const [path, content] of Object.entries(r.files)) {
      await expect(content).toMatchFileSnapshot(`./golden/${path}`);
    }
    expect(r.warnings).toEqual([]);
  });

  it.each([
    ["an invalid target", SPEC_YAML, DEPLOYMENTS_JSON, "Staging!", /invalid target/],
    ["an invalid spec", "spec_version: 2", DEPLOYMENTS_JSON, "staging", /spec_version/],
    ["unparsable deployments", SPEC_YAML, "{", "staging", /deployments: /],
    ["schema-invalid deployments", SPEC_YAML, '{"network":"x","chains":{"a":{}}}', "staging", /deployments\/chains\/a must have required property/],
    [
      "a deployment missing a token",
      SPEC_YAML,
      DEPLOYMENTS_JSON.replace('"token": "0x0000000000000000000000000000000000003001"', '"token": "0x0000000000000000000000000000000000003001", "escrow": "0x0000000000000000000000000000000000000001"').replace(/"kETH": \{\s*"token": "0x0000000000000000000000000000000000002001",/, '"kXYZ": { "token": "0x0000000000000000000000000000000000002001",'),
      "staging",
      /remotes.arb.token: placeholder address and no deployment entry/,
    ],
    [
      "a spec that fails semantic validation",
      SPEC_YAML.replace("minters: [ccip_pool_base, weakbridge_base]", "minters: []"),
      DEPLOYMENTS_JSON,
      "staging",
      /has no minter/,
    ],
    [
      "a deployment with no registry",
      SPEC_YAML,
      DEPLOYMENTS_JSON.replace('"registry": "0x00000000000000000000000000000000000a0004",', ""),
      "staging",
      /no registry deployment/,
    ],
  ])("fails on %s", async (_label, yaml, deployments, target, pattern) => {
    const r = await compileSpecDocuments(yaml, deployments, target);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(pattern);
  });
});

describe("resolveSpec", () => {
  it("keeps a real spec address that agrees with the deployment and rejects one that does not", () => {
    const spec = makeSpec();
    const agree = resolveSpec(spec, DEPLOYMENTS);
    expect(agree.errors).toEqual([]);
    const disagree = resolveSpec({ ...spec, home: { ...spec.home, canonical: addr(0x9999) } }, DEPLOYMENTS);
    expect(disagree.errors).toEqual([`home.canonical: spec has ${addr(0x9999)} but deployments has ${addr(0x1001)}`]);
  });
  it("keeps real addresses when the deployment has no entry", () => {
    const r = resolveSpec(makeSpec({ model: "burn_mint_multi" }), { network: "none", chains: {} });
    expect(r.errors).toEqual([]);
  });
  it("leaves aliases that name no chain to validation", () => {
    const spec = makeSpec();
    const odd: TokenSpec = {
      ...spec,
      bridges: spec.bridges.map((b) => (b.kind === "custom" ? { ...b, contracts: { ...b.contracts, mars: addr(7) } } : b)),
    };
    expect(resolveSpec(odd, DEPLOYMENTS).errors).toEqual([]);
  });
});

describe("compileWorkflows", () => {
  const spec = makeSpec();
  it("fails when a chain has no deployment", () => {
    const { "ethereum-testnet-sepolia-base-1": _base, ...rest } = DEPLOYMENTS.chains;
    const r = compileWorkflows(spec, { ...DEPLOYMENTS, chains: rest }, hash("h"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("deployments has no entry for chain ethereum-testnet-sepolia-base-1");
  });
  it("fails when a minter resolves to no bridge address", () => {
    const remote = spec.remotes[1];
    if (remote === undefined) throw new Error("fixture");
    const r = compileWorkflows({ ...spec, remotes: [spec.remotes[0], { ...remote, minters: ["unknown_base"] }] as TokenSpec["remotes"] }, DEPLOYMENTS, hash("h"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("minter unknown_base on ethereum-testnet-sepolia-base-1 has no bridge address");
  });
  it("reads shares for rebasing tokens, skips escrow holders for burn-and-mint and paging when not requested", () => {
    const shares: TokenSpec = {
      ...makeSpec({ model: "burn_mint_multi" }),
      unit: "shares",
      response: { ...spec.response, onBroken: ["freeze_ccip_lanes"] },
      rules: { ...spec.rules, soft: { flowLimitPerHour: null } },
    };
    const r = compileWorkflows(shares, DEPLOYMENTS, hash("h"));
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.configs["w2-loop"].reads).toEqual({ supply: "getTotalShares()", balance: "sharesOf(address)" });
    expect(r.configs["w2-loop"].escrowHolders).toEqual([]);
    expect(r.configs["w2-loop"].flowLimitPerHour).toBeNull();
    expect(r.configs["w3-responder"].notifySecrets).toEqual([]);
  });
  it("watches CCIP ramps paired with pool events, counts the lock box as escrow and caps log windows", () => {
    const spec = makeSpec();
    const wide: TokenSpec = {
      ...spec,
      bridges: spec.bridges.map((b) =>
        b.kind === "ccip_v2"
          ? { ...b, searchWindowBlocks: 50000n, pools: { ...b.pools, mars: addr(7) }, offramps: { home: b.offramps.home ?? addr(0) } }
          : { ...b, contracts: { ...b.contracts, mars: addr(8) } },
      ),
    };
    const r = compileWorkflows(wide, DEPLOYMENTS, hash("h"));
    if (!r.ok) throw new Error(r.errors.join("\n"));
    const w1 = r.configs["w1-junction"];
    expect(w1.creditTriggers.map((t) => `${t.bridgeId}:${t.chain}:${t.address}`)).toEqual([
      `ccip:ethereum-testnet-sepolia:${addr(0x1005)}`,
      `weakbridge:ethereum-testnet-sepolia:${addr(0x1002)}`,
      `weakbridge:ethereum-testnet-sepolia-arbitrum-1:${addr(0x2003)}`,
      `weakbridge:ethereum-testnet-sepolia-base-1:${addr(0x3003)}`,
    ]);
    expect(w1.debitLookups[0]).toMatchObject({
      address: addr(0x1004),
      topic0: CCIP_TOPICS.CCIPMessageSent,
      pairWith: { address: addr(0x1003), topic0: CCIP_TOPICS.LockedOrBurned },
      messageIdTopicIndex: 3,
      searchWindowBlocks: "100",
      registry: null,
    });
    expect(w1.debitLookups[1]?.registry).toEqual({
      debitOf: toFunctionSelector("debitOf(bytes32)"),
      creditOf: toFunctionSelector("creditOf(bytes32)"),
    });
    expect(r.configs["w2-loop"].escrowHolders).toEqual([addr(0x1002), addr(0x1006)]);
    expect(r.warnings).toEqual([
      "bridge ccip: search_window_blocks 50000 exceeds CRE's 100-block filterLogs limit; queries use 100",
    ]);
  });
});

describe("W2 supply triggers and registry flags (workflows R3, R6)", () => {
  const ZERO_TOPIC = `0x${"0".repeat(64)}`;
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const padded = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;

  it("filters mints and burns on remotes and escrow-holder transfers on home, one trigger per side", () => {
    const r = compileWorkflows(makeSpec(), DEPLOYMENTS, hash("h"));
    if (!r.ok) throw new Error(r.errors.join("\n"));
    const holders = [padded(addr(0x1002)), padded(addr(0x1006))];
    expect(r.configs["w2-loop"].supplyTriggers.map((t) => [t.chain, t.side, t.topics])).toEqual([
      ["ethereum-testnet-sepolia", "escrow_in", [[TRANSFER], [], holders]],
      ["ethereum-testnet-sepolia", "escrow_out", [[TRANSFER], holders, []]],
      ["ethereum-testnet-sepolia-arbitrum-1", "mint", [[TRANSFER], [ZERO_TOPIC], []]],
      ["ethereum-testnet-sepolia-arbitrum-1", "burn", [[TRANSFER], [], [ZERO_TOPIC]]],
      ["ethereum-testnet-sepolia-base-1", "mint", [[TRANSFER], [ZERO_TOPIC], []]],
      ["ethereum-testnet-sepolia-base-1", "burn", [[TRANSFER], [], [ZERO_TOPIC]]],
    ]);
  });

  it("treats the home chain as a minting chain for burn-and-mint tokens", () => {
    const r = compileWorkflows(makeSpec({ model: "burn_mint_multi" }), DEPLOYMENTS, hash("h"));
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.configs["w2-loop"].supplyTriggers.slice(0, 2).map((t) => t.side)).toEqual(["mint", "burn"]);
  });

  it("flags which W2 debit watches can be confirmed through debitOf, and embeds the revivable spec", () => {
    const spec = makeSpec();
    const r = compileWorkflows(spec, DEPLOYMENTS, hash("h"));
    if (!r.ok) throw new Error(r.errors.join("\n"));
    const w2 = r.configs["w2-loop"];
    expect(w2.debitEvents.map((d) => [d.adapter, d.registry !== null])).toEqual([
      ["ccip_v2", false],
      ["ccip_v2", false],
      ["ccip_v2", false],
      ["weakbridge", true],
      ["weakbridge", true],
      ["weakbridge", true],
    ]);
    expect(reviveSpec(r.configs["w1-junction"].spec)).toEqual(r.spec);
    expect(reviveSpec(w2.spec)).toEqual(r.spec);
  });
});

describe("creConfidence", () => {
  it("maps spec confidence to CRE trigger and read levels", () => {
    expect(creConfidence("latest")).toEqual({ trigger: "LATEST", read: "latest" });
    expect(creConfidence("safe")).toEqual({ trigger: "SAFE", read: "finalized" });
    expect(creConfidence("finalized")).toEqual({ trigger: "FINALIZED", read: "finalized" });
  });
});

/** `(uint8 indexed,...)`-style shape of an event: parameter types and indexed flags, names dropped. */
function eventShape(params: string): string {
  return params
    .split(",")
    .map((p) => p.trim().split(/\s+/).filter((w, i, all) => i < all.length - 1 || all.length === 1))
    .map((words) => words.join(" ").replace(/^Status\b/, "uint8"))
    .join(",");
}

describe("contract event signatures", () => {
  const interfaces = join(ENGINE, "../contracts/src/interfaces");
  it.skipIf(!existsSync(interfaces))("match contracts/src/interfaces", () => {
    const solidity = readdirSync(interfaces)
      .filter((f) => f.endsWith(".sol"))
      .map((f) => readFileSync(join(interfaces, f), "utf8"))
      .join("\n");
    for (const name of ["BreachRecorded", "EpochRecorded", "StatusChanged", "SpecActivated"] as const) {
      const ours = /\((.*)\)/.exec(CONTRACT_EVENTS[name])?.[1] ?? "";
      const theirs = new RegExp(`event\\s+${name}\\s*\\(([^)]*)\\)`).exec(solidity)?.[1];
      expect(theirs, `${name} declared in contracts/src/interfaces`).toBeDefined();
      expect(eventShape(theirs ?? ""), name).toBe(eventShape(ours));
    }
  });
});

describe("bin/compile.ts", () => {
  it("writes every config to disk", async () => {
    const out = mkdtempSync(join(tmpdir(), "kirchhoff-compile-"));
    const stdout = execFileSync(
      process.execPath,
      [join(ENGINE, "bin/compile.ts"), join(ENGINE, "specs/kETH.yaml"), join(ENGINE, "test/fixtures/deployments.local.json"), out],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(stdout.trim().split("\n")).toHaveLength(5);
    const w1 = JSON.parse(readFileSync(join(out, "w1-junction/config.staging.json"), "utf8")) as { workflow: string };
    expect(w1.workflow).toBe("w1-junction");
    const expected = await compileSpecDocuments(SPEC_YAML, DEPLOYMENTS_JSON, "staging");
    expect(expected.ok && expected.files["w2-loop/config.staging.json"]).toBe(readFileSync(join(out, "w2-loop/config.staging.json"), "utf8"));
  });
  it("exits non-zero with usage on missing arguments and with errors on a bad spec", () => {
    expect(() => execFileSync(process.execPath, [join(ENGINE, "bin/compile.ts")], { stdio: "pipe" })).toThrow();
    const out = mkdtempSync(join(tmpdir(), "kirchhoff-compile-"));
    expect(() =>
      execFileSync(process.execPath, [join(ENGINE, "bin/compile.ts"), join(ENGINE, "package.json"), join(ENGINE, "package.json"), out], {
        stdio: "pipe",
      }),
    ).toThrow(/error: /);
  });
});

it("parseSpec of the demo spec is stable", () => {
  expect(parseSpec(SPEC_YAML).ok).toBe(true);
});
