import type {
  ApiErrorBody,
  ApiKeysResponse,
  AskEvent,
  AskRequest,
  BacktestRequest,
  BacktestResponse,
  Bytes32,
  ChainKey,
  CheckTransferRequest,
  CheckTransferResponse,
  EpochsQuery,
  EpochsResponse,
  IncidentResponse,
  LabRunResponse,
  LabStatusResponse,
  OpsResponse,
  ReplayPlanResponse,
  ScoutProposalsResponse,
  ScoutRequest,
  ScoutResponse,
  SpecProposalsResponse,
  SpecDraftEvent,
  SpecDraftRequest,
  SpecProposalResponse,
  StreamMessage,
  TokensResponse,
  TokenStatusResponse,
  VerdictsQuery,
  VerdictsResponse,
} from "@/lib/api/types";
import { getIssuerKey } from "@/lib/issuer-key";

/* ----------------------------------------------------------------------------------------------
 * Errors
 * -------------------------------------------------------------------------------------------- */

export type ApiErrorCode = ApiErrorBody["error"]["code"] | "NETWORK" | "MALFORMED";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | null;
  readonly chain: ChainKey | null;
  readonly endpoint: string;

  constructor(args: { code: ApiErrorCode; message: string; status: number | null; chain?: ChainKey | null; endpoint: string }) {
    super(args.message);
    this.name = "ApiError";
    this.code = args.code;
    this.status = args.status;
    this.chain = args.chain ?? null;
    this.endpoint = args.endpoint;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/* ----------------------------------------------------------------------------------------------
 * The client contract. Implemented by the HTTP client below and by the fixture client.
 * -------------------------------------------------------------------------------------------- */

export type StreamConnectionState = "connecting" | "live" | "reconnecting" | "offline";

export interface StreamHandlers {
  onMessage: (message: StreamMessage) => void;
  onState: (state: StreamConnectionState) => void;
}

export interface KirchhoffApi {
  readonly kind: "api" | "fixtures";
  readonly baseUrl: string;
  listTokens(signal?: AbortSignal): Promise<TokensResponse>;
  getStatus(token: string, signal?: AbortSignal): Promise<TokenStatusResponse>;
  getEpochs(token: string, query?: EpochsQuery, signal?: AbortSignal): Promise<EpochsResponse>;
  getVerdicts(token: string, query?: VerdictsQuery, signal?: AbortSignal): Promise<VerdictsResponse>;
  getIncident(id: Bytes32, signal?: AbortSignal): Promise<IncidentResponse>;
  checkTransfer(body: CheckTransferRequest, signal?: AbortSignal): Promise<CheckTransferResponse>;
  draftSpec(body: SpecDraftRequest, onEvent: (e: SpecDraftEvent) => void, signal?: AbortSignal): Promise<void>;
  backtestSpec(body: BacktestRequest, signal?: AbortSignal): Promise<BacktestResponse>;
  getSpecProposal(specHash: Bytes32, signal?: AbortSignal): Promise<SpecProposalResponse>;
  ask(body: AskRequest, onEvent: (e: AskEvent) => void, signal?: AbortSignal): Promise<void>;
  getLabStatus(signal?: AbortSignal): Promise<LabStatusResponse>;
  runKelpReplay(signal?: AbortSignal): Promise<LabRunResponse>;
  getLabRun(id: string, signal?: AbortSignal): Promise<LabRunResponse>;
  getOps(signal?: AbortSignal): Promise<OpsResponse>;
  getSpecProposals(token: string, signal?: AbortSignal): Promise<SpecProposalsResponse>;
  scout(body: ScoutRequest, signal?: AbortSignal): Promise<ScoutResponse>;
  listScoutProposals(token: string, signal?: AbortSignal): Promise<ScoutProposalsResponse>;
  getReplayPlan(incidentId: Bytes32, signal?: AbortSignal): Promise<ReplayPlanResponse>;
  listApiKeys(issuerKey: string, signal?: AbortSignal): Promise<ApiKeysResponse>;
  /** Opens the WS stream for one token with automatic reconnect. Returns a disposer. */
  subscribe(token: string, handlers: StreamHandlers): () => void;
}

/* ----------------------------------------------------------------------------------------------
 * HTTP implementation
 * -------------------------------------------------------------------------------------------- */

const REQUEST_TIMEOUT_MS = 10_000;

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const err = (value as { error: unknown }).error;
  return typeof err === "object" && err !== null && "code" in err && "message" in err;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readError(res: Response, endpoint: string): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (isErrorBody(body)) {
    return new ApiError({ code: body.error.code, message: body.error.message, status: res.status, chain: body.error.chain ?? null, endpoint });
  }
  return new ApiError({ code: "INTERNAL", message: `HTTP ${res.status} from ${endpoint}`, status: res.status, endpoint });
}

/**
 * Parses a `text/event-stream` body. Each event's `data:` lines are joined and JSON-parsed.
 * Malformed frames raise, so a broken stream surfaces as an error rather than silent gaps.
 */
export async function readSse<T>(body: ReadableStream<Uint8Array>, onEvent: (event: T) => void, endpoint: string): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      const data = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data.length > 0) {
        try {
          onEvent(JSON.parse(data) as T);
        } catch (cause) {
          throw new ApiError({ code: "MALFORMED", message: `Malformed event from ${endpoint}: ${String(cause)}`, status: null, endpoint });
        }
      }
      boundary = buffer.search(/\r?\n\r?\n/);
    }
  }
}

export interface HttpClientOptions {
  baseUrl: string;
  /** Issuer key for /specs/* (sent as Authorization: Bearer). */
  issuerKey?: string;
}

export function createHttpClient({ baseUrl, issuerKey }: HttpClientOptions): KirchhoffApi {
  const root = baseUrl.replace(/\/+$/, "");

  interface RequestOpts {
    method?: "GET" | "POST";
    body?: string;
    signal?: AbortSignal | undefined;
    auth?: string | undefined;
  }

  async function request<T>(path: string, init: RequestOpts = {}): Promise<T> {
    const endpoint = `${init.method ?? "GET"} ${path}`;
    const headers = new Headers({ Accept: "application/json" });
    if (init.body) headers.set("Content-Type", "application/json");
    if (init.auth) headers.set("Authorization", `Bearer ${init.auth}`);
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        method: init.method ?? "GET",
        headers,
        signal: withTimeout(init.signal, REQUEST_TIMEOUT_MS),
        cache: "no-store",
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (cause) {
      if (init.signal?.aborted) throw cause;
      throw new ApiError({ code: "NETWORK", message: `KIRCHHOFF API unreachable (${endpoint})`, status: null, endpoint });
    }
    if (!res.ok) throw await readError(res, endpoint);
    try {
      return (await res.json()) as T;
    } catch {
      throw new ApiError({ code: "MALFORMED", message: `Response from ${endpoint} is not JSON`, status: res.status, endpoint });
    }
  }

  async function stream<T>(path: string, body: unknown, onEvent: (e: T) => void, signal: AbortSignal | undefined, auth: string | undefined): Promise<void> {
    const endpoint = `POST ${path}`;
    const headers = new Headers({ Accept: "text/event-stream", "Content-Type": "application/json" });
    if (auth) headers.set("Authorization", `Bearer ${auth}`);
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, { method: "POST", headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new ApiError({ code: "NETWORK", message: `KIRCHHOFF API unreachable (${endpoint})`, status: null, endpoint });
    }
    if (!res.ok) throw await readError(res, endpoint);
    if (!res.body) throw new ApiError({ code: "MALFORMED", message: `Empty stream from ${endpoint}`, status: res.status, endpoint });
    await readSse<T>(res.body, onEvent, endpoint);
  }

  const qs = (params: Record<string, string | number | undefined>): string => {
    const entries = Object.entries(params).filter((e): e is [string, string | number] => e[1] !== undefined);
    return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}` : "";
  };
  const enc = encodeURIComponent;

  return {
    kind: "api",
    baseUrl: root,
    listTokens: (signal) => request("/tokens", { signal }),
    getStatus: (token, signal) => request(`/tokens/${enc(token)}/status`, { signal }),
    getEpochs: (token, q = {}, signal) => request(`/tokens/${enc(token)}/epochs${qs({ limit: q.limit, cursor: q.cursor, since: q.since })}`, { signal }),
    getVerdicts: (token, q = {}, signal) => request(`/tokens/${enc(token)}/verdicts${qs({ cursor: q.cursor, limit: q.limit })}`, { signal }),
    getIncident: (id, signal) => request(`/incidents/${enc(id)}`, { signal }),
    checkTransfer: (body, signal) => request("/check-transfer", { method: "POST", body: JSON.stringify(body), signal }),
    draftSpec: (body, onEvent, signal) => stream("/specs/draft", body, onEvent, signal, issuerKey ?? getIssuerKey()),
    backtestSpec: (body, signal) => request("/specs/backtest", { method: "POST", body: JSON.stringify(body), signal, auth: issuerKey ?? getIssuerKey() }),
    getSpecProposal: (specHash, signal) => request(`/specs/${enc(specHash)}`, { signal }),
    ask: (body, onEvent, signal) => stream("/ask", body, onEvent, signal, undefined),
    getLabStatus: (signal) => request("/lab/status", { signal }),
    runKelpReplay: (signal) => request("/lab/kelp-replay", { method: "POST", body: "{}", signal }),
    getLabRun: (id, signal) => request(`/lab/runs/${enc(id)}`, { signal }),
    getOps: (signal) => request("/ops", { signal }),
    getSpecProposals: (token, signal) => request(`/tokens/${enc(token)}/spec-proposals`, { signal }),
    scout: (body, signal) => request("/specs/scout", { method: "POST", body: JSON.stringify(body), signal, auth: issuerKey ?? getIssuerKey() }),
    listScoutProposals: (token, signal) => request(`/specs/proposals${qs({ token })}`, { signal, auth: issuerKey ?? getIssuerKey() }),
    getReplayPlan: (id, signal) => request(`/incidents/${enc(id)}/replay-plan`, { method: "POST", body: "{}", signal }),
    listApiKeys: (key, signal) => request("/keys", { signal, auth: key }),
    subscribe: (token, handlers) => connectLive(`${root.replace(/^http/, "ws")}/stream?token=${enc(token)}`, `${root}/stream/sse?token=${enc(token)}`, handlers),
  };
}

/* ----------------------------------------------------------------------------------------------
 * WebSocket with reconnect (exponential backoff with jitter, silence watchdog)
 * -------------------------------------------------------------------------------------------- */

const SILENCE_MS = 40_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;

function isStreamMessage(value: unknown): value is StreamMessage {
  return typeof value === "object" && value !== null && "channel" in value && typeof (value as { channel: unknown }).channel === "string";
}

export function connectStream(url: string, { onMessage, onState }: StreamHandlers): () => void {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;

  const armSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => socket?.close(4000, "silence"), SILENCE_MS);
  };

  const scheduleReconnect = () => {
    if (disposed) return;
    onState(attempt > 3 ? "offline" : "reconnecting");
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    attempt += 1;
    retryTimer = setTimeout(open, delay);
  };

  function open() {
    if (disposed) return;
    onState(attempt === 0 ? "connecting" : "reconnecting");
    try {
      socket = new WebSocket(url);
    } catch (e) {
      console.error("KIRCHHOFF stream: cannot open", e);
      scheduleReconnect();
      return;
    }
    socket.onopen = () => {
      attempt = 0;
      onState("live");
      armSilence();
    };
    socket.onmessage = (ev) => {
      armSilence();
      if (typeof ev.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        console.error("KIRCHHOFF stream: dropped non-JSON frame");
        return;
      }
      if (!isStreamMessage(parsed)) {
        console.error("KIRCHHOFF stream: dropped frame without channel");
        return;
      }
      if (parsed.channel !== "ping") onMessage(parsed);
    };
    socket.onclose = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      socket = null;
      scheduleReconnect();
    };
    socket.onerror = () => socket?.close();
  }

  open();
  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (silenceTimer) clearTimeout(silenceTimer);
    if (socket) {
      const s = socket;
      s.onclose = null;
      s.onmessage = null;
      s.onerror = null;
      // Closing a socket that is still connecting logs a browser warning; close it once open instead.
      if (s.readyState === WebSocket.CONNECTING) s.onopen = () => s.close(1000, "disposed");
      else s.close(1000, "disposed");
    }
  };
}

/**
 * WebSocket first; if it never opens (serverless hosting cannot hold sockets), fall back to the
 * API's SSE stream, which carries the same frames and resumes with Last-Event-ID.
 */
export function connectLive(wsUrl: string, sseUrl: string, handlers: StreamHandlers): () => void {
  // Serverless hosts (Vercel) cannot upgrade to WebSocket: go straight to SSE instead of logging failed handshakes.
  const transport = process.env.NEXT_PUBLIC_STREAM_TRANSPORT ?? "auto";
  const sseOnly = transport === "sse" || (transport === "auto" && /\.vercel\.app$/.test(new URL(sseUrl).hostname));
  let opened = false;
  let failures = 0;
  let disposeWs: (() => void) | null = null;
  let source: EventSource | null = null;

  const startSse = () => {
    disposeWs?.();
    disposeWs = null;
    handlers.onState("connecting");
    source = new EventSource(sseUrl);
    source.onopen = () => handlers.onState("live");
    source.onerror = () => handlers.onState(source?.readyState === EventSource.CLOSED ? "offline" : "reconnecting");
    source.onmessage = (ev: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        console.error("KIRCHHOFF stream: dropped non-JSON SSE frame");
        return;
      }
      if (isStreamMessage(parsed) && parsed.channel !== "ping") handlers.onMessage(parsed);
    };
  };

  if (sseOnly && typeof EventSource !== "undefined") {
    startSse();
    return () => source?.close();
  }

  disposeWs = connectStream(wsUrl, {
    onMessage: handlers.onMessage,
    onState: (state) => {
      if (state === "live") opened = true;
      if (!opened && state === "reconnecting") {
        failures += 1;
        if (failures >= 2 && typeof EventSource !== "undefined") {
          startSse();
          return;
        }
      }
      handlers.onState(state);
    },
  });

  return () => {
    disposeWs?.();
    source?.close();
  };
}

/* ----------------------------------------------------------------------------------------------
 * Configuration
 * -------------------------------------------------------------------------------------------- */

export type DataSource = "api" | "fixtures";

export const DATA_SOURCE: DataSource = process.env.NEXT_PUBLIC_DATA_SOURCE === "fixtures" ? "fixtures" : "api";

/** REST base. The API mounts everything under /v1; a bare origin gets it appended. */
export function apiBase(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export const API_URL: string = apiBase(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080");
