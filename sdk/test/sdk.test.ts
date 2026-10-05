import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS, World } from "../../indexer/test/world.ts";
import { CHAINS, Kirchhoff, KirchhoffApiError, chainByChainId, parseDeployments, reasonFromValue, statusFromValue, tokenIdOf, type StreamMessage, type TokenStatusResponse } from "../src/index.ts";

const HOME = "ethereum-testnet-sepolia" as const;

describe("shared API contract", () => {
  it("re-exports the frontend contract (web/lib/api/types.ts) rather than copying it", async () => {
    const web = await import("../../web/lib/api/types.ts");
    const sdk = await import("../src/index.ts");
    expect(sdk.LAB_STEP_ORDER).toBe(web.LAB_STEP_ORDER);
    expect(sdk.REASON_CODE_VALUE).toBe(web.REASON_CODE_VALUE);
    expect(readFileSync(join(import.meta.dirname, "..", "src", "api-types.ts"), "utf8")).toContain('export * from "../../web/lib/api/types.ts"');
  });

  it("enum tables match the frozen INTERFACES.md values", () => {
    expect(statusFromValue(3)).toBe("BROKEN");
    expect(reasonFromValue(14)).toBe("TOKEN_RECOVERING");
    expect(() => statusFromValue(9)).toThrow();
    expect(CHAINS[HOME].selector).toBe(16015286601757825753n);
    expect(chainByChainId(31338)?.info.alias).toBe("arb");
    expect(tokenIdOf("kETH")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("parseDeployments", () => {
  const flatHome = {
    network: "local-home",
    role: "home",
    chainId: 31337,
    tokenSymbol: "kETH",
    conservationLedger: `0x${"1".repeat(40)}`,
    quarantineController: `0x${"2".repeat(40)}`,
    conservationFeed: `0x${"3".repeat(40)}`,
    kirchhoffGuard: `0x${"4".repeat(40)}`,
    kETH: `0x${"5".repeat(40)}`,
    homeEscrowAdapter: `0x${"6".repeat(40)}`,
    weakBridge: `0x${"7".repeat(40)}`,
    kirchhoffTokenPool: `0x${"8".repeat(40)}`,
    deployedAtBlock: 12,
  };
  it("normalizes Deploy.s.sol per-chain files and filters by network mode", () => {
    const set = parseDeployments([{ name: "local-home.json", json: flatHome }, { name: "sepolia.json", json: { ...flatHome, chainId: 11155111 } }], "local");
    expect(Object.keys(set.chains)).toEqual([HOME]);
    expect(set.chains[HOME]).toMatchObject({ role: "home", token: flatHome.kETH, escrow: flatHome.homeEscrowAdapter, deployedAtBlock: 12n, onRamp: null });
    const t = parseDeployments([{ name: "sepolia.json", json: { ...flatHome, chainId: 11155111 } }], "testnet");
    expect(t.chains[HOME]?.onRamp).toBe(CHAINS[HOME].ccip.onRamp);
  });
  it("accepts the merged engine format and rejects missing addresses", () => {
    const merged = { network: "testnet", chains: { [HOME]: { chainId: 11155111, ledger: flatHome.conservationLedger, quarantine: flatHome.quarantineController, feed: flatHome.conservationFeed, tokens: { kETH: { token: flatHome.kETH, escrow: flatHome.homeEscrowAdapter, bridges: { ccip: flatHome.kirchhoffTokenPool, weakbridge: flatHome.weakBridge } } } } } };
    expect(parseDeployments([{ name: "m.json", json: merged }], "testnet").chains[HOME]?.ccipPool).toBe(flatHome.kirchhoffTokenPool);
    expect(() => parseDeployments([{ name: "bad.json", json: { ...flatHome, conservationLedger: "0x0" } }], "local")).toThrow(/conservationLedger/);
  });
});

function jsonFetch(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return ((url: string | URL) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    const r = routes[path] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "nope" } } };
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
}

describe("Kirchhoff client", () => {
  const status = {
    source: "onchain-mirror",
    servedAt: "2026-10-06T09:00:30.000Z",
    token: { symbol: "kETH", status: "CONSERVED", reason: "OK", delta: "-5", epochId: "9", stale: false, updatedAt: "2026-10-06T09:00:00.000Z" },
    chains: [],
  } as unknown as TokenStatusResponse;

  it("status() parses delta and epoch to bigint and computes age", async () => {
    const k = new Kirchhoff({ network: "testnet", apiUrl: "http://api.test/v1", fetch: jsonFetch({ "/v1/tokens/kETH/status": { status: 200, body: status } }) });
    const s = await k.status("kETH");
    expect(s).toMatchObject({ status: "CONSERVED", delta: -5n, epochId: 9n, ageSeconds: 30 });
  });

  it("surfaces ApiErrorBody as KirchhoffApiError", async () => {
    const k = new Kirchhoff({ network: "testnet", apiUrl: "http://api.test/v1", fetch: jsonFetch({}) });
    await expect(k.status("nope")).rejects.toBeInstanceOf(KirchhoffApiError);
  });

  it("subscribe() falls back to SSE and resumes with Last-Event-ID", async () => {
    const seen: (string | null)[] = [];
    let calls = 0;
    const frames = [`id: 7\ndata: ${JSON.stringify({ channel: "epoch", token: "kETH", data: { epochId: "1" } })}\n\n`, `data: ${JSON.stringify({ channel: "ping" })}\n\n`];
    const fetchSse = ((_url: string | URL, init?: RequestInit) => {
      calls++;
      seen.push((init?.headers as Record<string, string> | undefined)?.["last-event-id"] ?? null);
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          if (calls === 1) for (const f of frames) c.enqueue(new TextEncoder().encode(f));
          c.close();
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    }) as typeof fetch;
    const k = new Kirchhoff({ network: "testnet", apiUrl: "http://api.test/v1", fetch: fetchSse });
    const got: StreamMessage[] = [];
    const stop = k.subscribe("kETH", (m) => got.push(m), { transport: "sse" });
    await new Promise((r) => setTimeout(r, 1_300));
    stop();
    expect(got).toEqual([{ channel: "epoch", token: "kETH", data: { epochId: "1" } }]);
    expect(seen.slice(0, 2)).toEqual([null, "7"]);
  });
});

describe("verifyOnchain reads ConservationLedger.statusOf directly", () => {
  let world: World;
  beforeAll(async () => {
    world = await World.start(Number(process.env.WORLD_BASE_PORT_SDK ?? 28845));
  }, 300_000);
  afterAll(async () => {
    await world.stop();
  });

  it("returns UNKNOWN before any epoch and CONSERVED after one, without trusting the API", async () => {
    const k = new Kirchhoff({ network: "local", apiUrl: "http://unused.invalid/v1", deployments: world.deployments, rpcUrls: { [HOME]: world.chains[HOME].rpc } });
    expect((await k.verifyOnchain("kETH", HOME)).status).toBe("UNKNOWN");
    await world.epoch(HOME, 1n, 0n);
    const s = await k.verifyOnchain("kETH", HOME);
    expect(s).toMatchObject({ status: "CONSERVED", delta: 0n, stale: false, ledger: world.chains[HOME].dep.ledger });
    expect(ACCOUNTS.owner.address).toMatch(/^0x/);
  });
});
