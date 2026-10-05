import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, "query">;

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");
/** Arbitrary constant: serializes concurrent migrators (indexer and API starting together). */
const MIGRATION_LOCK = 70_710_678;

/** Hosted Postgres (Neon) needs TLS; local Docker Postgres does not. */
function sslFor(url: string): pg.PoolConfig["ssl"] {
  const host = new URL(url).hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
  return { rejectUnauthorized: true };
}

export function createDb(url: string, options: { max?: number } = {}): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    ssl: sslFor(url),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    application_name: "kirchhoff",
  });
  pool.on("error", (err) => {
    // Idle client errors (server restart, network blip) must not crash the process; the next query reconnects.
    console.error("kirchhoff db: idle client error", err.message);
  });
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch((rollbackError: unknown) => {
      console.error("kirchhoff db: rollback failed", rollbackError);
    });
    throw e;
  } finally {
    client.release();
  }
}

/** Applies every migrations/*.sql not yet applied, in name order, each in its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  const client = await db.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
  return applied;
}

/** Drops every KIRCHHOFF table. Tests only: refuses any database whose name does not end in `_test`. */
export async function resetSchema(db: Db): Promise<void> {
  const { rows } = await db.query<{ name: string }>("select current_database() as name");
  const name = rows[0]?.name ?? "";
  if (!name.endsWith("_test")) throw new Error(`refusing to reset non-test database "${name}"`);
  await db.query("drop schema if exists ask cascade");
  await db.query("drop schema public cascade");
  await db.query("create schema public");
}
