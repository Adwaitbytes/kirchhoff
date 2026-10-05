#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { HttpBackend, type KirchhoffBackend } from "./backend.ts";
import { createKirchhoffMcp } from "./server.ts";

const MAX_BODY = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(b);
  }
  return chunks.length === 0 ? undefined : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * Streamable HTTP transport, stateless: every POST /mcp gets a fresh server and transport, which
 * suits read-only tools and horizontal scaling.
 */
export function createMcpHttpServer(backend: KirchhoffBackend): Server {
  return createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/healthz") { send(res, 200, { ok: true }); return; }
      if (path !== "/mcp") { send(res, 404, { error: "not found" }); return; }
      if (req.method !== "POST") { send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: stateless server, use POST" }, id: null }); return; }
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); return;
      }
      const server = createKirchhoffMcp(backend);
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      // The SDK's transport classes predate exactOptionalPropertyTypes; the shapes match at runtime.
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, body);
    })().catch((e: unknown) => {
      console.error("kirchhoff mcp: request failed", e instanceof Error ? e.message : e);
      if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    });
  });
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  const api = process.env.KIRCHHOFF_API_URL ?? "http://localhost:8080/v1";
  const port = Number(process.env.MCP_PORT ?? 8090);
  createMcpHttpServer(new HttpBackend(api)).listen(port, () => {
    console.warn(`kirchhoff mcp (streamable http) on :${port}/mcp reading ${new URL(api).host}`);
  });
}
