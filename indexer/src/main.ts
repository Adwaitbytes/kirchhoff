#!/usr/bin/env node
import { loadIndexerConfig } from "./config.ts";
import { createDb, migrate } from "./db.ts";
import { runIndexer } from "./indexer.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const db = createDb(url);
const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { controller.abort(); });

try {
  const applied = await migrate(db);
  if (applied.length > 0) console.warn(`kirchhoff indexer: applied ${applied.join(", ")}`);
  const cfg = await loadIndexerConfig();
  console.warn(
    `kirchhoff indexer: ${cfg.symbol} on ${cfg.mode} (${cfg.token.chains.length} chains, follow ${cfg.followTag}); pages are sent by the API's incident pager`,
  );
  await runIndexer(db, cfg, {}, controller.signal);
} catch (e) {
  console.error("kirchhoff indexer: fatal", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.end();
}
