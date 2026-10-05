import type {
  ApiErrorBody,
  CheckTransferRequest,
  CheckTransferResponse,
  IncidentResponse,
  TokensResponse,
  TokenStatusResponse,
  Verdict,
  VerdictsResponse,
} from "@kirchhoff/sdk";

/** What the MCP tools read. The HTTP implementation mirrors the public API; nothing here can write. */
export interface KirchhoffBackend {
  tokens(): Promise<TokensResponse>;
  status(token: string): Promise<TokenStatusResponse>;
  checkTransfer(req: CheckTransferRequest): Promise<CheckTransferResponse>;
  verdict(messageId: string): Promise<Verdict | null>;
  incident(id: string): Promise<IncidentResponse>;
}

export class BackendError extends Error {
  override readonly name = "BackendError";
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class HttpBackend implements KirchhoffBackend {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  private async req<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (json as ApiErrorBody | null)?.error;
      throw new BackendError(res.status, err?.code ?? "INTERNAL", err?.message ?? `KIRCHHOFF API HTTP ${res.status}`);
    }
    return json as T;
  }

  tokens(): Promise<TokensResponse> {
    return this.req("/tokens");
  }
  status(token: string): Promise<TokenStatusResponse> {
    return this.req(`/tokens/${encodeURIComponent(token)}/status`);
  }
  checkTransfer(body: CheckTransferRequest): Promise<CheckTransferResponse> {
    return this.req("/check-transfer", body);
  }
  incident(id: string): Promise<IncidentResponse> {
    return this.req(`/incidents/${encodeURIComponent(id)}`);
  }

  /** Searches recent committee verdicts of every protected token (newest first, up to 5 pages each). */
  async verdict(messageId: string): Promise<Verdict | null> {
    const id = messageId.toLowerCase();
    const { items } = await this.tokens();
    for (const t of items) {
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const q: string = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : "?limit=200";
        const res: VerdictsResponse = await this.req(`/tokens/${encodeURIComponent(t.symbol)}/verdicts${q}`);
        const hit = res.items.find((v) => v.messageId.toLowerCase() === id);
        if (hit) return hit;
        cursor = res.nextCursor;
        if (!cursor) break;
      }
    }
    return null;
  }
}
