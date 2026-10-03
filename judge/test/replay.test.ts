/**
 * Recorded payloads: crafted ones from the spec examples, and real CCIP 2.0 sends captured from
 * Ethereum Sepolia by scripts/capture-real.ts (labeled with their source in each file).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { evmAddress } from "@kirchhoff/engine";
import { lookupDebit } from "../src/evaluate.ts";
import { createProviders } from "../src/rpc.ts";
import { compileValidators, type EvaluateRequest } from "../src/schema.ts";
import type { ChainContracts } from "../src/spec-cache.ts";
import { HOME, contractsOn, post, startHarness, type Harness } from "./helpers/harness.ts";
import { RpcStub } from "./helpers/rpc-stub.ts";

type RealFixture = {
  source: { kind: "real"; chain: string; txHash: Hex; explorer: string };
  logs: { address: Hex; topics: Hex[]; data: Hex; logIndex: number; blockNumber: string }[];
  request: EvaluateRequest;
};

const dir = (sub: string): string => fileURLToPath(new URL(`./fixtures/${sub}/`, import.meta.url));
const crafted = readdirSync(dir("crafted"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ name: f, request: JSON.parse(readFileSync(`${dir("crafted")}${f}`, "utf8")) as EvaluateRequest }));
const real = readdirSync(dir("real"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ name: f, fixture: JSON.parse(readFileSync(`${dir("real")}${f}`, "utf8")) as RealFixture }));
const realWithToken = real.filter((r) => r.fixture.request.message.token_transfer !== undefined);
const validators = compileValidators();

function sourceContracts(req: EvaluateRequest): ChainContracts {
  const tt = req.message.token_transfer;
  if (tt === undefined) throw new Error("no token transfer");
  const pool = evmAddress(tt.source_pool_address);
  const token = evmAddress(tt.source_token_address);
  const onRamp = evmAddress(req.message.on_ramp_address);
  if (pool === null || token === null || onRamp === null) throw new Error("non-EVM addresses");
  return { selector: BigInt(req.message.source_chain_selector), name: "ethereum-testnet-sepolia", ledger: "0x00", quarantine: "0x00", token, pool, onRamp };
}

function stubLogs(fixture: RealFixture, stub: RpcStub): void {
  stub.state.logs = fixture.logs.map((l) => ({
    address: l.address,
    topics: l.topics,
    data: l.data,
    blockNumber: BigInt(l.blockNumber),
    transactionHash: fixture.source.txHash,
    logIndex: l.logIndex,
  }));
}

describe("fixture inventory", () => {
  it("has crafted and real payloads, all valid EvaluateRequests, real ones labeled", () => {
    expect(crafted.length).toBeGreaterThanOrEqual(3);
    expect(real.length).toBeGreaterThanOrEqual(3);
    for (const r of real) {
      expect(r.fixture.source.kind).toBe("real");
      expect(r.fixture.source.explorer).toMatch(/^https:\/\/sepolia\.etherscan\.io\/tx\/0x/);
      expect(validators.request(r.fixture.request), `${r.name} ${JSON.stringify(validators.request.errors)}`).toBe(true);
    }
  });
});

describe("replay through a running Judge", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it.each([...crafted.map((c) => [c.name, c.request] as const), ...real.map((r) => [r.name, r.fixture.request] as const)])(
    "%s is out of kETH's scope and passes",
    async (_name, request) => {
      const res = await post(h.url, request);
      expect(res.status).toBe(200);
      expect(validators.response(res.body)).toBe(true);
      expect(res.body).toEqual({ decision: "PASS", message_id: request.message_id, reason: "OK no protected token" });
    },
  );
});

describe("source debit matching on real CCIP 2.0 log bytes (offline)", () => {
  const stub = new RpcStub();
  beforeAll(async () => {
    await stub.start();
  });
  afterAll(async () => {
    await stub.stop();
  });

  it.each(realWithToken.map((r) => [r.name, r.fixture] as const))("%s: pool debit equals the message amount", async (_name, fixture) => {
    stubLogs(fixture, stub);
    const req = fixture.request;
    const client = createProviders("sepolia", [stub.url, `${stub.url}/2`], 2000).providers[0].client;
    const debit = await lookupDebit(client, sourceContracts(req), BigInt(req.message.dest_chain_selector), req.message_id as Hex, req.source_tx_hash as Hex, req.source_block_number);
    expect(debit).toMatchObject({ kind: "found", amount: BigInt(req.message.token_transfer?.amount ?? "0") });
  });

  it("does not match the debit to another message id, destination or token", async () => {
    const first = realWithToken[0];
    if (first === undefined) throw new Error("no real token fixture");
    stubLogs(first.fixture, stub);
    const req = first.fixture.request;
    const client = createProviders("sepolia", [stub.url, `${stub.url}/2`], 2000).providers[0].client;
    const src = sourceContracts(req);
    const dst = BigInt(req.message.dest_chain_selector);
    expect(await lookupDebit(client, src, dst, `0x${"ee".repeat(32)}`, req.source_tx_hash as Hex, req.source_block_number)).toMatchObject({ kind: "missing" });
    expect(await lookupDebit(client, src, 1n, req.message_id as Hex, req.source_tx_hash as Hex, req.source_block_number)).toMatchObject({ kind: "missing" });
    expect(await lookupDebit(client, { ...src, token: "0x00000000000000000000000000000000deadbeef" }, dst, req.message_id as Hex, req.source_tx_hash as Hex, req.source_block_number)).toMatchObject({ kind: "missing" });
    expect(await lookupDebit(client, src, dst, req.message_id as Hex, `0x${"12".repeat(32)}`, req.source_block_number)).toMatchObject({ kind: "missing" });
  });
});

describe("a real Sepolia send judged as if its token were protected", () => {
  const fixture = real.find((r) => r.name === "sepolia-dca61a6f.json")?.fixture;
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ deploymentsPath: fileURLToPath(new URL("./fixtures/deployments.real-sepolia.json", import.meta.url)) });
    if (fixture === undefined) throw new Error("missing sepolia-dca61a6f.json");
    for (const s of h.stubs.get(HOME) ?? []) stubLogs(fixture, s);
  });
  afterAll(async () => {
    await h.close();
  });

  it("passes with the real pool debit and fails AMOUNT_MISMATCH when the amount is altered", async () => {
    if (fixture === undefined) throw new Error("missing fixture");
    expect(contractsOn(h.token, HOME).pool).toBe("0x84c3ffabb258503a27d58ddab7b1787dce2bd829");
    const ok = await post(h.url, fixture.request);
    expect(ok.body).toEqual({ decision: "PASS", message_id: fixture.request.message_id, reason: "OK kETH CONSERVED delta=0 epoch=4182" });
    const altered = structuredClone(fixture.request);
    if (altered.message.token_transfer) altered.message.token_transfer.amount = "5000000000000000000001";
    const bad = await post(h.url, altered);
    expect(bad.body.reason).toBe("AMOUNT_MISMATCH kETH debit=5000000000000000000000 transfer=5000000000000000000001");
  });
});

const live = process.env.JUDGE_LIVE === "1" && process.env.RPC_ETH_SEPOLIA_1 !== undefined && process.env.RPC_ETH_SEPOLIA_2 !== undefined;

describe.skipIf(!live)("live Sepolia (JUDGE_LIVE=1, both RPC_ETH_SEPOLIA providers)", () => {
  it.each(realWithToken.map((r) => [r.name, r.fixture] as const))("%s: both providers find the same debit", async (_name, fixture) => {
    const req = fixture.request;
    const providers = createProviders("sepolia", [process.env.RPC_ETH_SEPOLIA_1 ?? "", process.env.RPC_ETH_SEPOLIA_2 ?? ""], 10_000);
    const results = await Promise.all(
      providers.providers.map((p) =>
        lookupDebit(p.client, sourceContracts(req), BigInt(req.message.dest_chain_selector), req.message_id as Hex, req.source_tx_hash as Hex, req.source_block_number),
      ),
    );
    for (const r of results) expect(r).toMatchObject({ kind: "found", amount: BigInt(req.message.token_transfer?.amount ?? "0") });
  });
});
