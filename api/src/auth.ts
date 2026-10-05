import { createHash, timingSafeEqual } from "node:crypto";
import type { Queryable } from "@kirchhoff/indexer";
import type { ApiKeyInfo } from "@kirchhoff/sdk";
import { ApiFailure } from "./errors.ts";

export type Scope = ApiKeyInfo["scopes"][number];
const ALL_SCOPES: Scope[] = ["specs:draft", "specs:backtest", "keys:manage"];

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/**
 * Issuer keys: the env ISSUER_API_KEY (all scopes) plus rows in `api_keys`, stored only as
 * SHA-256 hashes. Comparison is constant-time over the hashes.
 */
export class IssuerAuth {
  private readonly db: Queryable;
  private readonly envKeyHash: Buffer | null;

  constructor(db: Queryable, envKey: string | undefined) {
    this.db = db;
    this.envKeyHash = envKey && envKey.length >= 16 ? sha256(envKey) : null;
  }

  /** Registers the env key in api_keys (hash and 8-char prefix only) so the Integrations panel can list it. */
  async seed(envKey: string | undefined): Promise<void> {
    if (!envKey || envKey.length < 16) return;
    await this.db.query(
      `insert into api_keys (id, label, prefix, key_hash, scopes) values ('env-issuer', 'Issuer key (env)', $1, $2, $3)
       on conflict (id) do update set prefix = excluded.prefix, key_hash = excluded.key_hash, scopes = excluded.scopes`,
      [envKey.slice(0, 8), sha256(envKey).toString("hex"), ALL_SCOPES],
    );
  }

  async require(authorization: string | undefined, scope: Scope): Promise<void> {
    const m = /^Bearer\s+(\S{16,256})$/i.exec(authorization ?? "");
    if (!m?.[1]) throw new ApiFailure(401, "UNAUTHORIZED", "issuer key required (Authorization: Bearer <key>)");
    const hash = sha256(m[1]);
    if (this.envKeyHash && timingSafeEqual(hash, this.envKeyHash)) {
      await this.touch(hash);
      return;
    }
    const r = await this.db.query<{ key_hash: string; scopes: Scope[] }>("select key_hash, scopes from api_keys where key_hash = $1", [hash.toString("hex")]);
    const row = r.rows[0];
    if (!row || !timingSafeEqual(Buffer.from(row.key_hash, "hex"), hash)) throw new ApiFailure(401, "UNAUTHORIZED", "invalid issuer key");
    if (!row.scopes.includes(scope)) throw new ApiFailure(401, "UNAUTHORIZED", `issuer key lacks scope ${scope}`);
    await this.touch(hash);
  }

  private async touch(hash: Buffer): Promise<void> {
    await this.db.query("update api_keys set last_used_at = now() where key_hash = $1", [hash.toString("hex")]);
  }

  async list(): Promise<ApiKeyInfo[]> {
    const r = await this.db.query<{ id: string; label: string; prefix: string; scopes: Scope[]; created_at: Date; last_used_at: Date | null }>(
      "select id, label, prefix, scopes, created_at, last_used_at from api_keys order by created_at",
    );
    return r.rows.map((k) => ({ id: k.id, label: k.label, prefix: k.prefix, scopes: k.scopes, createdAt: k.created_at.toISOString(), lastUsedAt: k.last_used_at?.toISOString() ?? null }));
  }
}

/** Shared-key check for the internal Judge verdict sink (POST /internal/verdicts). */
export function requireInternalKey(header: string | undefined, key: string | undefined): void {
  if (!key || key.length < 16) throw new ApiFailure(401, "UNAUTHORIZED", "internal ingest is not configured");
  if (!header || !timingSafeEqual(sha256(header), sha256(key))) throw new ApiFailure(401, "UNAUTHORIZED", "invalid internal key");
}
