#!/usr/bin/env node
import { migrate } from "@kirchhoff/indexer";
import { buildApp } from "./app.ts";
import { depsFromEnv } from "./config.ts";

/** Long-running KIRCHHOFF API: REST, WebSocket stream, SSE fallback, Attack Lab, Judge verdict sink. */
const deps = depsFromEnv(process.env, "server");
await migrate(deps.db);
const app = await buildApp({ ...deps, logger: process.env.API_LOG === "true" });
const port = Number(process.env.API_PORT ?? 8080);
const host = process.env.API_HOST ?? "0.0.0.0";
await app.listen({ port, host });
console.warn(`kirchhoff api: listening on ${host}:${port} (/v1, ws /v1/stream, sse /v1/stream/sse); lab ${deps.lab.enabled ? "on" : "off"}; ai ${deps.ai.provider ? "on" : "off"}`);

const shutdown = async (): Promise<void> => {
  await app.close();
  await deps.db.end();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
