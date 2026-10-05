import { createPublicClient, http, keccak256, stringToBytes, type PublicClient } from "viem";
import { ledgerAbi } from "./abis.ts";
import type {
  ApiErrorBody,
  Address,
  ChainKey,
  CheckTransferRequest,
  CheckTransferResponse,
  ReasonCode,
  StreamMessage,
  TokenStatus,
  TokenStatusResponse,
  TokensResponse,
} from "./api-types.ts";
import { CHAINS, chainIdFor, statusFromValue, type NetworkMode } from "./chains.ts";
import type { DeploymentSet } from "./deployments.ts";

export type KirchhoffOptions = {
  network: NetworkMode;
  /** REST base including `/v1`. */
  apiUrl?: string;
  /** Per-chain RPC for verifyOnchain. Defaults to the local Anvil ports in local mode. */
  rpcUrls?: Partial<Record<ChainKey, string>>;
  /** Ledger addresses for verifyOnchain without trusting the API. */
  deployments?: DeploymentSet;
  fetch?: typeof fetch;
  /** WebSocket constructor; defaults to the global one (browsers, Node 22+). */
  WebSocket?: typeof WebSocket;
  requestTimeoutMs?: number;
};

export type StatusResult = {
  token: string;
  status: TokenStatus;
  reason: ReasonCode;
  /** Backing minus claims, base units. */
  delta: bigint;
  epochId: bigint;
  stale: boolean;
  updatedAt: string;
  /** Seconds since the last status write, measured against the server clock. */
  ageSeconds: number;
  raw: TokenStatusResponse;
};

export type OnchainStatus = {
  chain: ChainKey;
  ledger: Address;
  status: TokenStatus;
  delta: bigint;
  updatedAt: bigint;
  stale: boolean;
  block: bigint;
};

export type SubscribeOptions = {
  /** "auto" tries WebSocket first and falls back to SSE. */
  transport?: "auto" | "ws" | "sse";
  onError?: (error: Error) => void;
};

export class KirchhoffApiError extends Error {
  override readonly name = "KirchhoffApiError";
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_API: Readonly<Record<NetworkMode, string>> = {
  local: "http://localhost:8080/v1",
  testnet: "https://api.kirchhoff.xyz/v1",
};

export function tokenIdOf(symbol: string): `0x${string}` {
  return keccak256(stringToBytes(symbol));
}

function isErrorBody(v: unknown): v is ApiErrorBody {
  return typeof v === "object" && v !== null && "error" in v && typeof v.error === "object";
}

function isStreamMessage(v: unknown): v is StreamMessage {
  return typeof v === "object" && v !== null && typeof (v as { channel?: unknown }).channel === "string";
}

export class Kirchhoff {
  readonly network: NetworkMode;
  readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly ws: typeof WebSocket | undefined;
  private readonly rpcUrls: Partial<Record<ChainKey, string>>;
  private readonly deployments: DeploymentSet | undefined;
  private readonly timeoutMs: number;
  private readonly clients = new Map<ChainKey, PublicClient>();

  constructor(options: KirchhoffOptions) {
    this.network = options.network;
    this.apiUrl = (options.apiUrl ?? DEFAULT_API[options.network]).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.ws = options.WebSocket ?? (typeof WebSocket === "undefined" ? undefined : WebSocket);
    this.rpcUrls = options.rpcUrls ?? {};
    this.deployments = options.deployments;
    this.timeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  private async request<T>(path: string, init?: { method: "POST"; body: unknown }): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: init?.method ?? "GET",
      headers: init ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(init ? { body: JSON.stringify(init.body) } : {}),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      if (isErrorBody(body)) throw new KirchhoffApiError(res.status, body.error.code, body.error.message);
      throw new KirchhoffApiError(res.status, "INTERNAL", `HTTP ${res.status} from ${path}`);
    }
    return body as T;
  }

  tokens(): Promise<TokensResponse> {
    return this.request<TokensResponse>("/tokens");
  }

  /** Mirrored status from the API, with Δ parsed to bigint. */
  async status(token: string): Promise<StatusResult> {
    const raw = await this.request<TokenStatusResponse>(`/tokens/${encodeURIComponent(token)}/status`);
    const t = raw.token;
    const age = Math.max(0, Math.round((Date.parse(raw.servedAt) - Date.parse(t.updatedAt)) / 1000));
    return {
      token: t.symbol,
      status: t.status,
      reason: t.reason,
      delta: BigInt(t.delta),
      epochId: BigInt(t.epochId),
      stale: t.stale,
      updatedAt: t.updatedAt,
      ageSeconds: Number.isFinite(age) ? age : 0,
      raw,
    };
  }

  /** Dry run of a CCIP transfer against current onchain status (PRD section 13). */
  checkTransfer(body: CheckTransferRequest): Promise<CheckTransferResponse> {
    return this.request<CheckTransferResponse>("/check-transfer", { method: "POST", body });
  }

  private client(chain: ChainKey): PublicClient {
    const existing = this.clients.get(chain);
    if (existing) return existing;
    const url = this.rpcUrls[chain] ?? (this.network === "local" ? CHAINS[chain].localRpc : undefined);
    if (url === undefined) throw new Error(`no RPC URL configured for ${chain}`);
    const id = chainIdFor(chain, this.network);
    const client = createPublicClient({
      chain: { id, name: chain, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } },
      transport: http(url, { timeout: this.timeoutMs }),
      // Verification must see the newest block, never a cached block number.
      cacheTime: 0,
    });
    this.clients.set(chain, client);
    return client;
  }

  private async ledgerFor(token: string, chain: ChainKey): Promise<Address> {
    const local = this.deployments?.chains[chain]?.ledger;
    if (local) return local;
    const status = await this.request<TokenStatusResponse>(`/tokens/${encodeURIComponent(token)}/status`);
    const found = status.chains.find((c) => c.chain === chain);
    if (!found) throw new Error(`${token} is not deployed on ${chain}`);
    return found.contracts.ledger;
  }

  /**
   * Reads ConservationLedger.statusOf directly over RPC: trusts the chain, not the API. Pass
   * `deployments` to also avoid trusting the API for the ledger address.
   */
  async verifyOnchain(token: string, chain: ChainKey): Promise<OnchainStatus> {
    const ledger = await this.ledgerFor(token, chain);
    const client = this.client(chain);
    const block = await client.getBlockNumber();
    const [status, delta, updatedAt, stale] = await client.readContract({
      address: ledger,
      abi: ledgerAbi,
      functionName: "statusOf",
      args: [tokenIdOf(token)],
      blockNumber: block,
    });
    return { chain, ledger, status: statusFromValue(status), delta, updatedAt, stale, block };
  }

  /**
   * Live epochs, verdicts, incidents and status for one token. WebSocket first; Server-Sent Events
   * when WebSocket is unavailable (serverless deployments). Returns an unsubscribe function.
   */
  subscribe(token: string, onMessage: (message: StreamMessage) => void, options: SubscribeOptions = {}): () => void {
    const transport = options.transport ?? "auto";
    const onError = options.onError ?? (() => undefined);
    if (transport !== "sse" && this.ws !== undefined) {
      const WS = this.ws;
      let fellBack = false;
      let stopSse: (() => void) | null = null;
      const socket = new WS(`${this.apiUrl.replace(/^http/, "ws")}/stream?token=${encodeURIComponent(token)}`);
      let opened = false;
      socket.onopen = () => {
        opened = true;
      };
      socket.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== "string") return;
        try {
          const parsed: unknown = JSON.parse(ev.data);
          if (isStreamMessage(parsed) && parsed.channel !== "ping") onMessage(parsed);
        } catch (e) {
          onError(e instanceof Error ? e : new Error(String(e)));
        }
      };
      socket.onerror = () => {
        if (!opened && transport === "auto" && !fellBack) {
          fellBack = true;
          stopSse = this.subscribeSse(token, onMessage, onError);
        }
      };
      return () => {
        socket.onclose = null;
        socket.close();
        stopSse?.();
      };
    }
    return this.subscribeSse(token, onMessage, onError);
  }

  private subscribeSse(token: string, onMessage: (m: StreamMessage) => void, onError: (e: Error) => void): () => void {
    const controller = new AbortController();
    const aborted = (): boolean => controller.signal.aborted;
    let lastEventId: string | null = null;
    const run = async (): Promise<void> => {
      while (!aborted()) {
        try {
          const headers: Record<string, string> = { accept: "text/event-stream" };
          if (lastEventId !== null) headers["last-event-id"] = lastEventId;
          const res = await this.fetchImpl(`${this.apiUrl}/stream/sse?token=${encodeURIComponent(token)}`, { headers, signal: controller.signal });
          if (!res.ok || !res.body) throw new KirchhoffApiError(res.status, "INTERNAL", `SSE HTTP ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx = buffer.indexOf("\n\n");
            while (idx !== -1) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const id = /^id: ?(.*)$/m.exec(frame)?.[1];
              if (id !== undefined) lastEventId = id;
              const data = frame
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trimStart())
                .join("\n");
              if (data) {
                const parsed: unknown = JSON.parse(data);
                if (isStreamMessage(parsed) && parsed.channel !== "ping") onMessage(parsed);
              }
              idx = buffer.indexOf("\n\n");
            }
          }
          // The server ends SSE responses periodically (serverless); resume after its retry delay.
          await new Promise((r) => setTimeout(r, 1_000));
        } catch (e) {
          if (aborted()) return;
          onError(e instanceof Error ? e : new Error(String(e)));
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
    };
    void run();
    return () => {
      controller.abort();
    };
  }
}

