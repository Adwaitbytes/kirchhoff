import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp, type App } from "./app.ts";
import { depsFromEnv } from "./config.ts";

/**
 * Vercel serverless entry (region sin1, Neon via DATABASE_URL_HOSTED). Same routes as the server
 * minus WebSocket and the Attack Lab; live updates use GET /v1/stream/sse, which ends after
 * SSE_MAX_MS and is resumed by the client with Last-Event-ID.
 */
let ready: Promise<App> | null = null;

function app(): Promise<App> {
  ready ??= buildApp(depsFromEnv(process.env, "serverless")).then(async (a) => {
    await a.ready();
    return a;
  });
  return ready;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const a = await app();
  a.server.emit("request", req, res);
}
