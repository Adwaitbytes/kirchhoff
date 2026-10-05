import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import type { ChainKey, SpecDraftEvent } from "@kirchhoff/sdk";
import { ACCOUNTS, World } from "../../indexer/test/world.ts";
import { LocalArtifactExplorer, ScriptedProvider, addressProvenanceCoverage, backtestYaml, draftSpec, runCopilotTool, validateYaml, type CopilotEnv, type DraftStructure } from "../src/index.ts";

const HOME = "ethereum-testnet-sepolia" as const;
const ARB = "ethereum-testnet-sepolia-arbitrum-1" as const;
const BASE = "ethereum-testnet-sepolia-base-1" as const;

let world: World;
let env: CopilotEnv;

beforeAll(async () => {
  world = await World.start(Number(process.env.WORLD_BASE_PORT_AI ?? 28745));
  const clients: Partial<Record<ChainKey, PublicClient>> = {};
  for (const c of [HOME, ARB, BASE]) clients[c] = world.chains[c].pub;
  env = {
    clients,
    explorer: new LocalArtifactExplorer(clients),
    tokenAdminRegistry: {},
    ramps: {},
    validateSpec: (y) => validateYaml(y, clients),
    backtestSpec: (y, from) => backtestYaml(y, from === null ? {} : { [HOME]: from }, { clients, defaultLookback: null }),
    logLookback: 100_000n,
    explorerLinks: false,
  };
}, 300_000);

afterAll(async () => {
  await world.stop();
});

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: JSON.stringify(args) });

describe("Spec Copilot tools against real contracts", () => {
  it("get_contract identifies verified contracts, getters and the deployer's contracts", async () => {
    const home = world.chains[HOME].dep;
    const r = await runCopilotTool(env, "get_contract", JSON.stringify({ chain: HOME, address: home.token }));
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ kind: "contract", verifiedName: "KETH", erc20: { symbol: "kETH", decimals: 18 }, deployer: ACCOUNTS.owner.address.toLowerCase() });
    const eoa = await runCopilotTool(env, "get_contract", JSON.stringify({ chain: ARB, address: ACCOUNTS.owner.address }));
    const names = (eoa.result as { contractsDeployed: { name: string | null }[] }).contractsDeployed.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["RemoteKETH", "WeakBridge", "KirchhoffBurnMintTokenPool"]));
  });

  it("list_role_grants surfaces both active minters on a remote; list_ccip_pools finds the pool without a registry", async () => {
    const arb = world.chains[ARB].dep;
    const r = await runCopilotTool(env, "list_role_grants", JSON.stringify({ chain: ARB, token: arb.token }));
    const holders = (r.result as { activeHolders: { account: string; capabilities: string[] }[] }).activeHolders.filter((h) => h.capabilities.includes("mint")).map((h) => h.account);
    expect(holders.sort()).toEqual([arb.ccipPool, arb.weakBridge].sort());
    const pools = await runCopilotTool(env, "list_ccip_pools", JSON.stringify({ chain: ARB, token: arb.token }));
    expect(pools.result).toMatchObject({ pool: arb.ccipPool });
  });

  it("get_contract shows which home contract emits the bridge events and holds escrow; validate flags the wrong one", async () => {
    await world.bridgeSend(HOME, ARB, 10n ** 18n);
    const h = world.chains[HOME].dep;
    const escrow = await runCopilotTool(env, "get_contract", JSON.stringify({ chain: HOME, address: h.escrow }));
    const er = escrow.result as { emittedEvents: { signature: string }[]; tokenHoldings: { symbol: string; balance: string }[] };
    expect(er.emittedEvents.map((e) => e.signature)).toContain("Burned(bytes32 indexed id, address indexed from, address to, uint256 amount, uint64 dstChain)");
    expect(er.tokenHoldings).toEqual([expect.objectContaining({ symbol: "kETH", balance: (10n ** 18n).toString() })]);
    const wb = (await runCopilotTool(env, "get_contract", JSON.stringify({ chain: HOME, address: h.weakBridge }))).result as { emittedEvents: unknown[] };
    expect(wb.emittedEvents).toEqual([]);
    const yamlFor = (homeAddr: string): string =>
      readFileSync(join(import.meta.dirname, "..", "..", "engine", "specs", "kETH.yaml"), "utf8").replace(/(contracts:\n\s+home: )"0x0+"/, `$1"${homeAddr}"`);
    const wrong = await validateYaml(yamlFor(h.weakBridge ?? ""), env.clients);
    expect(wrong.errors.some((e) => /weakbridge home: .* never emitted .* did \(1 events\)/.test(e))).toBe(true);
    const right = await validateYaml(yamlFor(h.escrow ?? ""), env.clients);
    expect(right.errors.some((e) => e.includes('never emitted'))).toBe(false);
  });

  it("refuses unknown and write-like tools as data, and validates arguments", async () => {
    const w = await runCopilotTool(env, "propose_spec_onchain", "{}");
    expect(w.ok).toBe(false);
    expect(JSON.stringify(w.result)).toMatch(/only get_contract.*read-only/);
    const bad = await runCopilotTool(env, "get_contract", JSON.stringify({ chain: "mainnet", address: "0x1" }));
    expect(bad.ok).toBe(false);
  });
});

describe("Spec Copilot agent loop (scripted model)", () => {
  it("streams the tool trace and renders YAML whose provenance is verified against tool results", async () => {
    const h = world.chains[HOME].dep;
    const a = world.chains[ARB].dep;
    const b = world.chains[BASE].dep;
    const s = (value: string, source: string) => ({ value, source });
    const draft: DraftStructure = {
      token: s("kETH", "c1"),
      model: "lock_release_home",
      home: { chain: s(HOME, "issuer"), canonical: s(h.token, "c1"), escrow: s(h.escrow ?? "", "c4"), decimals: s("18", "c1") },
      remotes: [
        { chain: s(ARB, "issuer"), token: s(a.token, "c2"), decimals: s("18", "c5"), minters: [{ name: "ccip_pool_arb", address: s(a.ccipPool ?? "", "c5"), why: "CCIP pool holds the mint role" }, { name: "weakbridge_arb", address: s(a.weakBridge ?? "", "c5"), why: "WeakBridge holds the mint role" }] },
        // A fabricated value cited to a call that never returned it must render red.
        { chain: s(BASE, "issuer"), token: s(b.token, "c3"), decimals: s("18", "c3"), minters: [{ name: "ccip_pool_base", address: s("0x000000000000000000000000000000000000dead", "c3"), why: "made up" }] },
      ],
      bridges: [
        { id: "weakbridge", kind: "custom", contracts: [{ chain: HOME, address: s(h.escrow ?? "", "c4") }, { chain: ARB, address: s(a.weakBridge ?? "", "c2") }, { chain: BASE, address: s(b.weakBridge ?? "", "c3") }], onramps: [], offramps: [], lockbox: null, debit_event: s("Burned(bytes32 indexed id, address indexed from, address to, uint256 amount, uint64 dstChain)", "c6"), credit_event: s("Released(bytes32 indexed id, address indexed to, uint256 amount, uint64 srcChain)", "c6") },
      ],
      notes: "",
    };
    const provider = new ScriptedProvider([
      { content: "Reading the canonical token.", toolCalls: [call("c1", "get_contract", { chain: HOME, address: h.token })] },
      {
        toolCalls: [
          call("c2", "get_contract", { chain: ARB, address: ACCOUNTS.owner.address }),
          call("c3", "get_contract", { chain: BASE, address: ACCOUNTS.owner.address }),
          call("c4", "get_contract", { chain: HOME, address: ACCOUNTS.owner.address }),
          call("c5", "list_role_grants", { chain: ARB, token: a.token }),
          call("c6", "get_contract", { chain: HOME, address: h.escrow }),
        ],
      },
      { content: JSON.stringify(draft) },
      // The automatic validation repair turn (the draft above has no CCIP pools, so validation complains).
      { content: JSON.stringify(draft) },
    ]);
    const events: SpecDraftEvent[] = [];
    const run = await draftSpec({ description: `kETH home on ${HOME}, remotes on ${ARB} and ${BASE}, bridged with CCIP and WeakBridge`, canonical: { chain: HOME, address: h.token } }, { provider, model: "m", env, emit: (e) => events.push(e) });
    expect(events.filter((e) => e.type === "tool_call").map((e) => (e as { id: string }).id)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(events.filter((e) => e.type === "tool_result").every((e) => (e as { ok: boolean }).ok)).toBe(true);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["thinking", "draft", "validation", "done"]));
    expect(events.filter((e) => e.type === "validation")).toHaveLength(2);
    expect(provider.requests[3]?.messages.at(-1)?.content).toMatch(/validate_spec rejected/);
    const red = run.lines.filter((l) => l.provenance === null).map((l) => l.text.trim());
    expect(red).toEqual(["- ccip_pool_base"]);
    const canonical = run.lines.find((l) => l.text.includes("canonical:"));
    expect(canonical?.provenance).toMatchObject({ kind: "tool", toolCallId: "c1", tool: "get_contract" });
    expect(run.lines.find((l) => l.text.includes("weakbridge_arb"))?.provenance?.why).toBe("WeakBridge holds the mint role");
    const cov = addressProvenanceCoverage(run.lines);
    expect(cov.covered).toBe(cov.total - 1);
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toEqual(["get_contract", "list_role_grants", "list_ccip_pools", "list_oft_peers", "sample_events", "validate_spec", "backtest_spec"]);
  });
});
