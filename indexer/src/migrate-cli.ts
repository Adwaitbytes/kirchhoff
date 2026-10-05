#!/usr/bin/env node
import { createDb, migrate } from "./db.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const db = createDb(url, { max: 1 });
try {
  const applied = await migrate(db);
  console.warn(applied.length > 0 ? `applied ${applied.join(", ")}` : "schema up to date");
} finally {
  await db.end();
}
