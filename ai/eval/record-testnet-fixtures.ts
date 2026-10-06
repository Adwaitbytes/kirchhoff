/**
 * Records the live testnet RPC and explorer traffic of the Spec Copilot discovery path for kETH into
 * test/fixtures/testnet-onboarding.json, which test/testnet-onboarding.test.ts replays offline.
 *
 *   RPC_ETH_SEPOLIA_1=... RPC_ARB_SEPOLIA_1=... RPC_BASE_SEPOLIA_1=... ETHERSCAN_API_KEY=... node eval/record-testnet-fixtures.ts
 *
 * API keys never reach the fixture: explorer URLs are stored with the key redacted.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, custom, type PublicClient } from "viem";
import { CHAINS, CHAIN_KEYS, type ChainKey } from "@kirchhoff/sdk";
import { BlockscoutExplorer, CompositeExplorer, EtherscanExplorer, runCopilotTool, type CopilotEnv } from "../src/index.ts";
import { FIXTURE_LOOKBACK, KETH_TESTNET, redactUrl, rpcKey, type OnboardingFixture } from "../test/testnet-fixture.ts";

const fixture: OnboardingFixture = { recordedAt: new Date().toISOString(), rpc: {}, http: {} };

function recordingClient(chain: ChainKey, url: string): PublicClient {
  const rpc: Record<string, unknown> = {};
  fixture.rpc[chain] = rpc;
  let id = 0;
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }) });
        const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
        if (body.error) throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
        rpc[rpcKey(method, params)] = body.result;
        return body.result;
      },
    }),
  });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const pick = (o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

/** Keeps only the fields the explorers read, so the fixture stays small (verified sources are megabytes). */
function trim(url: string, body: unknown): unknown {
  if (!isObj(body)) return body;
  if (url.includes("/api/v2/smart-contracts/")) {
    const src = typeof body.source_code === "string" ? body.source_code.split("\n").slice(0, 40).join("\n") : body.source_code;
    return { ...pick(body, ["name", "is_verified", "abi"]), source_code: src };
  }
  if (url.includes("/api/v2/addresses/")) return pick(body, ["name", "creator_address_hash", "creation_transaction_hash", "is_contract"]);
  if (url.includes("action=txlist") && Array.isArray(body.result)) {
    return { ...pick(body, ["status", "message"]), result: (body.result as unknown[]).map((t) => (isObj(t) ? pick(t, ["blockNumber", "hash", "from", "to", "contractAddress", "isError"]) : t)) };
  }
  return body;
}

const recordingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const res = await fetch(input, init);
  const text = await res.text();
  if (res.ok) fixture.http[redactUrl(url)] = trim(url, JSON.parse(text) as unknown);
  return new Response(text, { status: res.status, headers: res.headers });
};

const clients: Partial<Record<ChainKey, PublicClient>> = {};
for (const c of CHAIN_KEYS) {
  const url = process.env[CHAINS[c].rpcEnv[0]];
  if (!url) throw new Error(`${CHAINS[c].rpcEnv[0]} is required`);
  clients[c] = recordingClient(c, url);
}
const key = process.env.ETHERSCAN_API_KEY;
if (!key) throw new Error("ETHERSCAN_API_KEY is required");

const env: CopilotEnv = {
  clients,
  explorer: new CompositeExplorer([new BlockscoutExplorer(recordingFetch)]),
  tokenAdminRegistry: Object.fromEntries(CHAIN_KEYS.map((c) => [c, CHAINS[c].ccip.tokenAdminRegistry])),
  ramps: Object.fromEntries(CHAIN_KEYS.map((c) => [c, { onRamp: CHAINS[c].ccip.onRamp, offRamp: CHAINS[c].ccip.offRamp }])),
  validateSpec: () => Promise.reject(new Error("not recorded")),
  backtestSpec: () => Promise.reject(new Error("not recorded")),
  logLookback: FIXTURE_LOOKBACK,
  explorerLinks: true,
};

const run = async (name: string, args: Record<string, unknown>): Promise<void> => {
  const r = await runCopilotTool(env, name, JSON.stringify(args));
  console.warn(`${name}: ${r.summary}`);
  if (!r.ok) throw new Error(`${name} failed while recording: ${JSON.stringify(r.result)}`);
};

const k = KETH_TESTNET;
await run("list_ccip_pools", { chain: k.home, token: k.token });
for (const c of CHAIN_KEYS) await run("get_contract", { chain: c, address: k.deployer });
await run("list_role_grants", { chain: k.arb, token: k.remoteToken });
// Etherscan V2 txlist, the fallback when Blockscout does not answer.
await new EtherscanExplorer(key, recordingFetch).deployedBy(k.base, k.deployer);

writeFileSync(join(import.meta.dirname, "..", "test", "fixtures", "testnet-onboarding.json"), `${JSON.stringify(fixture)}\n`);
console.warn(`recorded ${Object.values(fixture.rpc).reduce((n, r) => n + Object.keys(r).length, 0)} RPC answers and ${Object.keys(fixture.http).length} explorer answers`);
