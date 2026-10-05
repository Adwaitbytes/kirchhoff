import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CheckTransferRequest, CheckTransferResponse, IncidentResponse, MirrorMeta, TokensResponse, TokenStatusResponse, Verdict } from "@kirchhoff/sdk";
import { BackendError, HttpBackend, createKirchhoffMcp, createMcpHttpServer, type KirchhoffBackend } from "../src/index.ts";

const HOME = "ethereum-testnet-sepolia" as const;
const BASE = "ethereum-testnet-sepolia-base-1" as const;
const H = (c: string): `0x${string}` => `0x${c.repeat(64)}`;
const A = (c: string): `0x${string}` => `0x${c.repeat(40)}`;
const meta: MirrorMeta = { source: "onchain-mirror", ledger: { chain: HOME, address: A("1") }, block: { chain: HOME, number: "100", timestamp: "2026-10-06T09:00:00.000Z" }, servedAt: "2026-10-06T09:00:12.000Z" };
const summary = { symbol: "kETH", tokenId: H("a"), name: "Kirchhoff ETH", decimals: 18, model: "lock_release_home" as const, homeChain: HOME, chains: [HOME, BASE], status: "BROKEN" as const, reason: "DEBIT_NOT_FOUND" as const, delta: "-116500000000000000000000", epochId: "7", updatedAt: "2026-10-06T09:00:00.000Z", stale: false, activeIncidentId: H("b"), specHash: H("c"), simulation: true };

const verdict: Verdict = {
  id: `ccv:${H("d")}`,
  messageId: H("d"),
  evaluatedAt: "2026-10-06T09:01:00.000Z",
  bridge: "ccip",
  srcChain: HOME,
  dstChain: BASE,
  amount: "1",
  sender: A("2"),
  receiver: A("2"),
  decision: "FAIL",
  reason: "TOKEN_BROKEN",
  note: "attacker transfer to Base Sepolia",
  cells: [{ cellId: "cell-1", decision: "FAIL", latencyMs: 12 }],
  sourceTx: { chain: HOME, hash: H("e"), block: "101", timestamp: "2026-10-06T09:00:30.000Z" },
  executionTx: null,
  incidentId: H("b"),
};

class FakeBackend implements KirchhoffBackend {
  readonly checks: CheckTransferRequest[] = [];
  tokens(): Promise<TokensResponse> {
    return Promise.resolve({ ...meta, items: [summary] });
  }
  status(token: string): Promise<TokenStatusResponse> {
    if (token !== "kETH") return Promise.reject(new BackendError(404, "NOT_FOUND", `token ${token} not found`));
    return Promise.resolve({ ...meta, token: summary, epoch: null, backing: "0", claims: { remoteSupply: "0", inFlightOut: "0", inFlightIn: "0", total: "0" }, tolerance: "0", unclaimedSurplus: "0", stalenessSeconds: 120, onStale: "fail_closed", chains: [], bridges: [], lanes: [] });
  }
  checkTransfer(req: CheckTransferRequest): Promise<CheckTransferResponse> {
    this.checks.push(req);
    return Promise.resolve({ ...meta, wouldPass: false, reason: "TOKEN_BROKEN", advice: "Do not move kETH.", status: "BROKEN" });
  }
  verdict(id: string): Promise<Verdict | null> {
    return Promise.resolve(id === verdict.messageId ? verdict : null);
  }
  incident(id: string): Promise<IncidentResponse> {
    return Promise.reject(new BackendError(404, "NOT_FOUND", `incident ${id} not found`));
  }
}

type TextResult = { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

describe("MCP server over in-memory transport", () => {
  const backend = new FakeBackend();
  let client: Client;

  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createKirchhoffMcp(backend).connect(a);
    client = new Client({ name: "test", version: "1" });
    await client.connect(b);
  });

  it("exposes exactly the five read-only PRD tools with the check-before-move instruction", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["kirchhoff_check_transfer", "kirchhoff_explain_verdict", "kirchhoff_incident", "kirchhoff_list_tokens", "kirchhoff_status"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    const check = tools.find((t) => t.name === "kirchhoff_check_transfer");
    expect(check?.description).toMatch(/BEFORE ANY CROSS-CHAIN MOVE/);
    expect(check?.description).toMatch(/would_pass is false, STOP/);
    expect(client.getInstructions()).toMatch(/kirchhoff_check_transfer/);
  });

  it("kirchhoff_check_transfer maps snake_case input and tells the agent to stop", async () => {
    const r = (await client.callTool({ name: "kirchhoff_check_transfer", arguments: { token: "kETH", src_chain: HOME, dst_chain: BASE, amount: "1000", sender: A("F") } })) as TextResult;
    expect(r.structuredContent).toMatchObject({ would_pass: false, reason: "TOKEN_BROKEN" });
    expect(r.content[0]?.text).toMatch(/^would_pass: false\. STOP/);
    expect(backend.checks[0]).toEqual({ token: "kETH", srcChain: HOME, dstChain: BASE, amount: "1000", sender: A("f") });
  });

  it("rejects malformed input before reaching the backend", async () => {
    const r = (await client.callTool({ name: "kirchhoff_check_transfer", arguments: { token: "kETH", src_chain: "mainnet", dst_chain: BASE, amount: "1e18", sender: "x" } })) as TextResult;
    expect(r.isError).toBe(true);
    expect(backend.checks).toHaveLength(1);
  });

  it("status, list_tokens and explain_verdict return mirrored data; errors are flagged and advise caution", async () => {
    const s = (await client.callTool({ name: "kirchhoff_status", arguments: { token: "kETH" } })) as TextResult;
    expect(s.structuredContent).toMatchObject({ status: "BROKEN", ageSeconds: 12 });
    const l = (await client.callTool({ name: "kirchhoff_list_tokens", arguments: {} })) as TextResult;
    expect((l.structuredContent?.tokens as unknown[]).length).toBe(1);
    const v = (await client.callTool({ name: "kirchhoff_explain_verdict", arguments: { message_id: H("d") } })) as TextResult;
    expect(v.structuredContent).toMatchObject({ found: true, decision: "FAIL", reason: "TOKEN_BROKEN" });
    const i = (await client.callTool({ name: "kirchhoff_incident", arguments: { incident_id: H("9") } })) as TextResult;
    expect(i.isError).toBe(true);
    expect(i.content[0]?.text).toMatch(/unsafe to move/);
  });
});

describe("MCP transports", () => {
  let api: Server;
  let apiUrl: string;
  let mcpHttp: Server;
  let mcpUrl: string;

  beforeAll(async () => {
    // A stub of the public API so the HTTP backend and both transports are exercised end to end.
    api = createServer((req, res) => {
      if (req.url === "/v1/tokens") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...meta, items: [summary] }));
      else res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "NOT_FOUND", message: "nope" } }));
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    const a = api.address();
    apiUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/v1`;
    mcpHttp = createMcpHttpServer(new HttpBackend(apiUrl));
    await new Promise<void>((r) => mcpHttp.listen(0, "127.0.0.1", r));
    const m = mcpHttp.address();
    mcpUrl = `http://127.0.0.1:${typeof m === "object" && m ? m.port : 0}/mcp`;
  });

  afterAll(async () => {
    await new Promise((r) => mcpHttp.close(r));
    await new Promise((r) => api.close(r));
  });

  it("Streamable HTTP: lists tools and calls kirchhoff_list_tokens through the API", async () => {
    const client = new Client({ name: "http-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)) as unknown as Transport);
    expect((await client.listTools()).tools).toHaveLength(5);
    const r = (await client.callTool({ name: "kirchhoff_list_tokens", arguments: {} })) as TextResult;
    expect(r.content[0]?.text).toMatch(/1 protected token/);
    await client.close();
  });

  it("stdio: the bin speaks MCP over stdin/stdout", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "..", "src", "stdio.ts")], env: { ...process.env, KIRCHHOFF_API_URL: apiUrl }, stderr: "ignore" });
    const client = new Client({ name: "stdio-test", version: "1" });
    await client.connect(transport);
    const r = (await client.callTool({ name: "kirchhoff_status", arguments: { token: "kETH" } })) as TextResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/NOT_FOUND/);
    await client.close();
  });
});
