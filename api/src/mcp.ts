import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BackendError, createKirchhoffMcp, type KirchhoffBackend } from "@kirchhoff/mcp";
import type { CheckTransferRequest, CheckTransferResponse, IncidentResponse, TokensResponse, TokenStatusResponse, Verdict } from "@kirchhoff/sdk";
import { ApiFailure } from "./errors.ts";

/** In-process MCP backend: same read model and onchain check as REST, no HTTP hop. */
export function inProcessBackend(fns: {
  tokens: () => Promise<TokensResponse>;
  status: (token: string) => Promise<TokenStatusResponse>;
  checkTransfer: (req: CheckTransferRequest) => Promise<CheckTransferResponse>;
  verdict: (messageId: string) => Promise<Verdict | null>;
  incident: (id: string) => Promise<IncidentResponse>;
}): KirchhoffBackend {
  const wrap = async <T>(p: () => Promise<T>): Promise<T> => {
    try {
      return await p();
    } catch (e) {
      if (e instanceof ApiFailure) throw new BackendError(e.status, e.code, e.message);
      throw e;
    }
  };
  return {
    tokens: () => wrap(fns.tokens),
    status: (t) => wrap(() => fns.status(t)),
    checkTransfer: (r) => wrap(() => fns.checkTransfer(r)),
    verdict: (m) => wrap(() => fns.verdict(m)),
    incident: (i) => wrap(() => fns.incident(i)),
  };
}

/** MCP Streamable HTTP at POST /mcp (stateless: a fresh server and transport per request). */
export function registerMcp(app: FastifyInstance, backend: KirchhoffBackend): void {
  app.post("/mcp", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    for (const [k, val] of Object.entries(reply.getHeaders())) if (val !== undefined) reply.raw.setHeader(k, val);
    reply.hijack();
    const server = createKirchhoffMcp(backend);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    // The SDK's transport classes predate exactOptionalPropertyTypes; the shapes match at runtime.
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const notAllowed = { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: stateless MCP server, use POST /mcp" }, id: null };
  app.get("/mcp", async (_req, reply) => reply.status(405).send(notAllowed));
  app.delete("/mcp", async (_req, reply) => reply.status(405).send(notAllowed));
}
