import { createHash } from "node:crypto";
import type { Queryable } from "@kirchhoff/indexer";
import type { ChatRequest, ChatResponse, LlmProvider, Usage } from "./provider.ts";

export interface ResponseCache {
  get(key: string): Promise<ChatResponse | null>;
  set(key: string, kind: string, value: ChatResponse): Promise<void>;
}

/** Deterministic key over the full request: same model, prompt, tools and schema reuse the stored answer. */
export function requestKey(req: ChatRequest): string {
  return createHash("sha256").update(JSON.stringify(req)).digest("hex");
}

export class MemoryCache implements ResponseCache {
  readonly entries = new Map<string, ChatResponse>();
  get(key: string): Promise<ChatResponse | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }
  set(key: string, _kind: string, value: ChatResponse): Promise<void> {
    this.entries.set(key, value);
    return Promise.resolve();
  }
}

/** The `ai_cache` table: every paid answer is stored once and replayed for identical inputs. */
export class PostgresCache implements ResponseCache {
  private readonly db: Queryable;
  constructor(db: Queryable) {
    this.db = db;
  }
  async get(key: string): Promise<ChatResponse | null> {
    const r = await this.db.query<{ response: ChatResponse }>("select response from ai_cache where key = $1", [key]);
    return r.rows[0]?.response ?? null;
  }
  async set(key: string, kind: string, value: ChatResponse): Promise<void> {
    await this.db.query(
      `insert into ai_cache (key, kind, model, response, tokens_in, tokens_out, cost_usd) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (key) do nothing`,
      [key, kind, value.model, JSON.stringify(value), value.usage.inputTokens, value.usage.outputTokens, value.usage.costUsd.toFixed(6)],
    );
  }
}

/** Wraps a provider with the cache and a running spend meter. */
export class CachedProvider implements LlmProvider {
  readonly name: string;
  readonly spend: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  private readonly inner: LlmProvider;
  private readonly cache: ResponseCache;
  private readonly kind: string;

  constructor(inner: LlmProvider, cache: ResponseCache, kind = "chat") {
    this.inner = inner;
    this.cache = cache;
    this.kind = kind;
    this.name = `cached(${inner.name})`;
  }

  /** Same provider, cache and spend meter, with a different cache `kind` label. */
  withKind(kind: string): CachedProvider {
    const p = new CachedProvider(this.inner, this.cache, kind);
    (p as { spend: Usage }).spend = this.spend;
    return p;
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const key = requestKey(req);
    const hit = await this.cache.get(key);
    if (hit) return { ...hit, cached: true };
    const res = await this.inner.chat(req, signal);
    this.spend.inputTokens += res.usage.inputTokens;
    this.spend.outputTokens += res.usage.outputTokens;
    this.spend.costUsd += res.usage.costUsd;
    await this.cache.set(key, this.kind, res);
    return res;
  }
}
