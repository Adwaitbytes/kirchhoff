import { describe, expect, it } from "vitest";
import { createPublicClient, custom, type Address, type PublicClient } from "viem";
import { CHAINS, CHAIN_KEYS, type ChainKey, type SpecDraftEvent } from "@kirchhoff/sdk";
import { BlockscoutExplorer, CompositeExplorer, EtherscanExplorer, ScriptedProvider, creationsFromTxlist, draftSpec, runCopilotTool, type CopilotEnv, type DraftStructure, type Explorer } from "../src/index.ts";
import { FIXTURE_LOOKBACK, KETH_TESTNET as K, loadFixture, replayClient, replayFetch } from "./testnet-fixture.ts";

/**
 * Regression for the 2026-10-06 testnet onboarding failure: a draft for kETH from the canonical
 * token alone came back with empty remotes and bridges. Replays recorded Sepolia, Arbitrum Sepolia
 * and Base Sepolia RPC and Blockscout/Etherscan answers; no network is touched.
 */

const fx = loadFixture();

function testnetEnv(explorer: Explorer, validateSpec: CopilotEnv["validateSpec"] = () => Promise.resolve({ ok: true, errors: [], warnings: [] })): CopilotEnv {
  const clients: Partial<Record<ChainKey, PublicClient>> = {};
  for (const c of CHAIN_KEYS) clients[c] = replayClient(fx, c);
  return {
    clients,
    explorer,
    tokenAdminRegistry: Object.fromEntries(CHAIN_KEYS.map((c) => [c, CHAINS[c].ccip.tokenAdminRegistry])),
    ramps: Object.fromEntries(CHAIN_KEYS.map((c) => [c, { onRamp: CHAINS[c].ccip.onRamp, offRamp: CHAINS[c].ccip.offRamp }])),
    validateSpec,
    backtestSpec: () => Promise.reject(new Error("not used")),
    logLookback: FIXTURE_LOOKBACK,
    explorerLinks: true,
  };
}

const blockscout = (): CompositeExplorer => new CompositeExplorer([new BlockscoutExplorer(replayFetch(fx))]);

type Lane = {
  chain: string | null;
  remoteToken: string | null;
  remotePools: string[];
  onRamp: string | null;
  offRamp: string | null;
  remoteTokenMeta: { symbol: string | null; decimals: number | null } | null;
  remoteCheck: { registryPool: string | null; consistent: boolean } | null;
};

describe("list_ccip_pools follows the pool's remote configuration (recorded testnet)", () => {
  it("discovers both remote chains, their token, pool and ramps, and the home lock box from the canonical token alone", async () => {
    const r = await runCopilotTool(testnetEnv(blockscout()), "list_ccip_pools", JSON.stringify({ chain: K.home, token: K.token }));
    expect(r.ok).toBe(true);
    const res = r.result as { pool: string; lockBox: string; registry: string; poolTypeAndVersion: string; remotes: Lane[] };
    expect(res.pool).toBe(K.homePool);
    expect(res.registry).toBe(CHAINS[K.home].ccip.tokenAdminRegistry);
    expect(res.lockBox).toBe(K.lockBox);
    expect(res.poolTypeAndVersion).toMatch(/LockReleaseTokenPool 2\.0\.0/);
    expect(res.remotes.map((l) => l.chain).sort()).toEqual([K.arb, K.base].sort());
    for (const lane of res.remotes) {
      const chain = lane.chain as ChainKey;
      expect(lane).toMatchObject({ remoteToken: K.remoteToken, remotePools: [K.remotePool], onRamp: CHAINS[chain].ccip.onRamp, offRamp: CHAINS[chain].ccip.offRamp });
      // Cross-checked on the remote chain: its registry names the same pool and that pool points back at the canonical token.
      expect(lane.remoteCheck).toMatchObject({ registryPool: K.remotePool, consistent: true });
      expect(lane.remoteTokenMeta).toEqual({ symbol: "kETH", decimals: 18 });
    }
    expect(r.summary).toMatch(/2 remote lanes \(Arbitrum Sepolia, Base Sepolia\)/);
  });

  it("says plainly when the registry has no pool for a token, and an RPC failure is a failure, not 'no pool'", async () => {
    const env = testnetEnv(blockscout());
    const zero = createPublicClient({ transport: custom({ request: ({ method }: { method: string }) => Promise.resolve(method === "eth_call" ? `0x${"0".repeat(64)}` : "0x1") }) });
    const none = await runCopilotTool({ ...env, clients: { ...env.clients, [K.arb]: zero } }, "list_ccip_pools", JSON.stringify({ chain: K.arb, token: K.weakBridge }));
    expect(none).toMatchObject({ ok: true, summary: "no CCIP pool registered for this token on Arbitrum Sepolia", result: { pool: null, remotes: [] } });
    // Not recorded for this token: the replay RPC errors, and the tool reports the failure.
    const failed = await runCopilotTool(env, "list_ccip_pools", JSON.stringify({ chain: K.arb, token: K.weakBridge }));
    expect(failed.ok).toBe(false);
    expect(failed.summary).toMatch(/^tool failed: /);
  });
});

describe("EOA deployments on testnets", () => {
  it("lists every contract the deployer created on each chain, named, with the creation tx as provenance", async () => {
    const env = testnetEnv(blockscout());
    const counts: Record<string, number> = {};
    for (const c of CHAIN_KEYS) {
      const r = await runCopilotTool(env, "get_contract", JSON.stringify({ chain: c, address: K.deployer }));
      expect(r.ok).toBe(true);
      const list = (r.result as { kind: string; contractsDeployed: { address: string; name: string | null; tx: string | null }[] }).contractsDeployed;
      counts[c] = list.length;
      expect(list.every((d) => d.tx !== null && /^0x[0-9a-f]{64}$/.test(d.tx))).toBe(true);
      if (c === K.home) {
        expect(list.map((d) => d.address)).toEqual(expect.arrayContaining([K.token, K.escrow, K.homePool, K.lockBox]));
        expect(list.find((d) => d.address === K.escrow)?.name).toBe("HomeEscrowAdapter");
      } else {
        expect(list.map((d) => d.address)).toEqual(expect.arrayContaining([K.remoteToken, K.remotePool, K.weakBridge]));
        expect(list.find((d) => d.address === K.weakBridge)?.name).toBe("WeakBridge");
      }
    }
    expect(counts[K.home]).toBe(11);
    expect(counts[K.arb]).toBeGreaterThanOrEqual(7);
    expect(counts[K.base]).toBeGreaterThanOrEqual(7);
  });

  it("reports an explorer outage as a tool failure, never as 'deployed 0 contracts'", async () => {
    const down: typeof fetch = () => Promise.resolve(new Response("bad gateway", { status: 502 }));
    const r = await runCopilotTool(testnetEnv(new CompositeExplorer([new BlockscoutExplorer(down)])), "get_contract", JSON.stringify({ chain: K.home, address: K.deployer }));
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/no explorer answered: blockscout: explorer HTTP 502/);
  });

  it("falls back to Etherscan V2 txlist (recorded) when Blockscout fails", async () => {
    const down: typeof fetch = () => Promise.resolve(new Response("bad gateway", { status: 502 }));
    const seen: string[] = [];
    const ex = new CompositeExplorer([new BlockscoutExplorer(down), new EtherscanExplorer("test-key", replayFetch(fx, seen))]);
    const list = await ex.deployedBy(K.base, K.deployer);
    expect(list.map((d) => d.address)).toEqual(expect.arrayContaining([K.remoteToken, K.remotePool, K.weakBridge]));
    expect(seen[0]).toMatch(/^https:\/\/api\.etherscan\.io\/v2\/api\?chainid=84532&module=account&action=txlist&.*apikey=REDACTED$/);
  });

  it("parses txlist creations and skips failed ones, other senders and non-creations", () => {
    const d = K.deployer as Address;
    const body = {
      status: "1",
      message: "OK",
      result: [
        { from: d, to: "", contractAddress: K.token, hash: `0x${"a".repeat(64)}`, blockNumber: "10", isError: "0" },
        { from: d, to: "", contractAddress: K.escrow, hash: `0x${"b".repeat(64)}`, blockNumber: "11", isError: "1" },
        { from: d, to: K.token, contractAddress: "", hash: `0x${"c".repeat(64)}`, blockNumber: "12", isError: "0" },
        { from: K.escrow, to: "", contractAddress: K.lockBox, hash: `0x${"d".repeat(64)}`, blockNumber: "13", isError: "0" },
      ],
    };
    expect(creationsFromTxlist(body, d)).toEqual({ rows: 4, creations: [{ address: K.token, name: null, tx: `0x${"a".repeat(64)}`, block: "10" }] });
    expect(creationsFromTxlist({ status: "0", message: "No transactions found", result: [] }, d)).toEqual({ creations: [], rows: 0 });
    expect(creationsFromTxlist({ status: "0", message: "NOTOK", result: "Invalid API Key" }, d)).toBeNull();
  });
});

describe("custom bridge discovery from the remote token's minters (recorded testnet)", () => {
  it("list_role_grants on the remote token surfaces the CCIP pool and the WeakBridge as active minters", async () => {
    const r = await runCopilotTool(testnetEnv(blockscout()), "list_role_grants", JSON.stringify({ chain: K.arb, token: K.remoteToken }));
    expect(r.ok).toBe(true);
    const holders = (r.result as { activeHolders: { account: string; capabilities: string[]; name: string | null }[] }).activeHolders.filter((h) => h.capabilities.includes("mint"));
    expect(holders.map((h) => h.account).sort()).toEqual([K.remotePool, K.weakBridge].sort());
    expect(holders.find((h) => h.account === K.weakBridge)?.name).toBe("WeakBridge");
  });
});

describe("agent loop continues discovery when a draft is structurally empty", () => {
  const s = (value: string, source: string) => ({ value, source });
  const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: JSON.stringify(args) });
  const empty: DraftStructure = {
    token: s("kETH", "c1"),
    model: "lock_release_home",
    home: { chain: s(K.home, "issuer"), canonical: s(K.token, "issuer"), escrow: null, decimals: s("18", "c1") },
    remotes: [],
    bridges: [],
    notes: "",
  };
  const full: DraftStructure = {
    ...empty,
    remotes: [K.arb, K.base].map((chain) => ({ chain: s(chain, "c2"), token: s(K.remoteToken, "c2"), decimals: s("18", "c2"), minters: [{ name: `ccip_pool_${CHAINS[chain].alias}`, address: s(K.remotePool, "c2"), why: "CCIP pool on the lane" }] })),
    bridges: [
      {
        id: "ccip",
        kind: "ccip_v2",
        contracts: [{ chain: K.home, address: s(K.homePool, "c2") }, { chain: K.arb, address: s(K.remotePool, "c2") }, { chain: K.base, address: s(K.remotePool, "c2") }],
        onramps: [],
        offramps: [],
        lockbox: s(K.lockBox, "c2"),
        debit_event: null,
        credit_event: null,
      },
    ],
  };

  it("goes back to the tools after an empty draft fails validation, then publishes a draft whose remotes cite the new call", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [call("c1", "get_contract", { chain: K.home, address: K.deployer })] },
      { content: JSON.stringify(empty) },
      // Continuation round: the model now follows the pool's remote lanes.
      { toolCalls: [call("c2", "list_ccip_pools", { chain: K.home, token: K.token })] },
      { content: JSON.stringify(full) },
    ]);
    const validations: string[] = [];
    const env = testnetEnv(blockscout(), (yaml) => {
      validations.push(yaml);
      const ok = !/^remotes: \[\]$/m.test(yaml) && !/^bridges: \[\]$/m.test(yaml);
      return Promise.resolve({ ok, errors: ok ? [] : ["spec/remotes must NOT have fewer than 1 items"], warnings: [] });
    });
    const events: SpecDraftEvent[] = [];
    const run = await draftSpec({ description: "kETH, home Ethereum Sepolia, CCIP", canonical: { chain: K.home, address: K.token } }, { provider, model: "m", env, emit: (e) => events.push(e) });
    expect(events.filter((e) => e.type === "tool_call").map((e) => (e as { id: string }).id)).toEqual(["c1", "c2"]);
    expect(events.filter((e) => e.type === "validation").map((e) => (e as { ok: boolean }).ok)).toEqual([false, true]);
    expect(validations[0]).toMatch(/^remotes: \[\]$/m);
    expect(provider.requests[2]?.messages.at(-1)?.content).toMatch(/The draft has no remotes and no bridges, so validation failed .* Continue discovery/);
    expect(provider.requests[2]?.tools?.map((t) => t.name)).toContain("list_ccip_pools");
    const arbToken = run.lines.find((l) => l.text.includes(`token: "${K.remoteToken}"`));
    expect(arbToken?.provenance).toMatchObject({ kind: "tool", toolCallId: "c2", tool: "list_ccip_pools" });
    expect(run.lines.find((l) => l.text.includes("lockbox:"))?.provenance).toMatchObject({ toolCallId: "c2" });
    expect(events.at(-1)?.type).toBe("done");
  });

  it("is bounded: a model that keeps returning empty drafts gets one discovery round, then the normal repair turn", async () => {
    const provider = new ScriptedProvider([
      { content: JSON.stringify(empty) },
      { content: JSON.stringify(empty) },
      { content: JSON.stringify(empty) },
    ]);
    const env = testnetEnv(blockscout(), () => Promise.resolve({ ok: false, errors: ["spec/remotes must NOT have fewer than 1 items"], warnings: [] }));
    const events: SpecDraftEvent[] = [];
    await draftSpec({ description: "kETH", canonical: { chain: K.home, address: K.token } }, { provider, model: "m", env, emit: (e) => events.push(e) });
    expect(provider.requests).toHaveLength(3);
    expect(events.filter((e) => e.type === "validation")).toHaveLength(3);
    expect(events.at(-1)?.type).toBe("done");
  });
});
