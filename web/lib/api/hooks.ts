"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useApi } from "@/lib/api/provider";
import type { StreamConnectionState } from "@/lib/api/client";
import type {
  Bytes32,
  EpochsResponse,
  Incident,
  LabStatusResponse,
  LaneTransfer,
  StreamMessage,
  TokenStatusResponse,
  VerdictsResponse,
} from "@/lib/api/types";

export const queryKeys = {
  tokens: ["tokens"] as const,
  status: (token: string) => ["status", token] as const,
  epochs: (token: string) => ["epochs", token] as const,
  verdicts: (token: string) => ["verdicts", token] as const,
  incident: (id: string) => ["incident", id] as const,
  lab: ["lab"] as const,
  ops: ["ops"] as const,
};

const DAY_MS = 24 * 3_600_000;

const noopSubscribe = () => () => undefined;

/** False on the server and during hydration, true after. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/**
 * Every query renders its pending state until hydration finishes. A subtree that hydrates late
 * (its chunk loaded after the shell committed) could otherwise see cached data and render a tree
 * that differs from the server HTML, which is a hydration mismatch.
 */
function hydrationSafe<T>(q: UseQueryResult<T>, hydrated: boolean): UseQueryResult<T> {
  if (hydrated) return q;
  return { ...q, data: undefined, error: null, isPending: true, isSuccess: false, isError: false, status: "pending" } as UseQueryResult<T>;
}

export function useTokens() {
  const api = useApi();
  const hydrated = useHydrated();
  const q = useQuery({ queryKey: queryKeys.tokens, queryFn: ({ signal }) => api.listTokens(signal) });
  return hydrationSafe(q, hydrated);
}

export function useTokenStatus(token: string) {
  const api = useApi();
  const hydrated = useHydrated();
  const q = useQuery({ queryKey: queryKeys.status(token), queryFn: ({ signal }) => api.getStatus(token, signal), refetchInterval: 30_000 });
  return hydrationSafe(q, hydrated);
}

export function useEpochs24h(token: string) {
  const api = useApi();
  const hydrated = useHydrated();
  const q = useQuery({
    queryKey: queryKeys.epochs(token),
    queryFn: ({ signal }) => api.getEpochs(token, { limit: 500, since: new Date(Date.now() - DAY_MS).toISOString() }, signal),
  });
  return hydrationSafe(q, hydrated);
}

export function useVerdicts(token: string) {
  const api = useApi();
  const hydrated = useHydrated();
  const q = useQuery({ queryKey: queryKeys.verdicts(token), queryFn: ({ signal }) => api.getVerdicts(token, { limit: 100 }, signal) });
  return hydrationSafe(q, hydrated);
}

export function useIncident(id: Bytes32) {
  const api = useApi();
  const hydrated = useHydrated();
  const q = useQuery({ queryKey: queryKeys.incident(id), queryFn: ({ signal }) => api.getIncident(id, signal), refetchInterval: 5_000 });
  return hydrationSafe(q, hydrated);
}

export function useLabStatus() {
  const api = useApi();
  const hydrated = useHydrated();
  const q = useQuery({ queryKey: queryKeys.lab, queryFn: ({ signal }) => api.getLabStatus(signal), refetchInterval: 4_000 });
  return hydrationSafe(q, hydrated);
}

export function useOps() {
  const api = useApi();
  const hydrated = useHydrated();
  const q = useQuery({ queryKey: queryKeys.ops, queryFn: ({ signal }) => api.getOps(signal), refetchInterval: 15_000 });
  return hydrationSafe(q, hydrated);
}

/* ----------------------------------------------------------------------------------------------
 * Transfer bus: settled and forged transfers drive the 600ms wire pulse. Kept outside React
 * Query because pulses are events, not state.
 * -------------------------------------------------------------------------------------------- */

export type TransferEvent = LaneTransfer & { laneId: string };
type TransferListener = (e: TransferEvent) => void;
const transferListeners = new Map<string, Set<TransferListener>>();

export function onTransfer(token: string, listener: TransferListener): () => void {
  const set = transferListeners.get(token) ?? new Set<TransferListener>();
  set.add(listener);
  transferListeners.set(token, set);
  return () => set.delete(listener);
}

function emitTransfer(token: string, e: TransferEvent): void {
  transferListeners.get(token)?.forEach((l) => l(e));
}

/* ----------------------------------------------------------------------------------------------
 * Incident bus: new incidents trigger the breach toast exactly once per incident id.
 * -------------------------------------------------------------------------------------------- */

type IncidentListener = (i: Incident) => void;
const incidentListeners = new Set<IncidentListener>();

export function onIncident(listener: IncidentListener): () => void {
  incidentListeners.add(listener);
  return () => incidentListeners.delete(listener);
}

function applyStreamMessage(qc: QueryClient, msg: StreamMessage): void {
  switch (msg.channel) {
    case "status":
      qc.setQueryData<TokenStatusResponse>(queryKeys.status(msg.token), msg.data);
      break;
    case "epoch":
      qc.setQueryData<EpochsResponse>(queryKeys.epochs(msg.token), (prev) =>
        prev ? { ...prev, items: [msg.data, ...prev.items.filter((e) => e.epochId !== msg.data.epochId)] } : prev,
      );
      break;
    case "verdict":
      qc.setQueryData<VerdictsResponse>(queryKeys.verdicts(msg.token), (prev) =>
        prev ? { ...prev, items: [msg.data, ...prev.items.filter((v) => v.id !== msg.data.id)].slice(0, 500) } : prev,
      );
      break;
    case "incident":
      void qc.invalidateQueries({ queryKey: queryKeys.incident(msg.data.id) });
      incidentListeners.forEach((l) => l(msg.data));
      break;
    case "transfer":
      emitTransfer(msg.token, msg.data);
      break;
    case "lab":
      qc.setQueryData<LabStatusResponse>(queryKeys.lab, (prev) => (prev ? { ...prev, run: msg.data } : prev));
      break;
    case "ping":
      break;
  }
}

/** Subscribes Mission Control to WS /stream for one token, merging frames into the query cache. */
export function useTokenStream(token: string): StreamConnectionState {
  const api = useApi();
  const qc = useQueryClient();
  const [state, setState] = useState<StreamConnectionState>("connecting");
  useEffect(() => api.subscribe(token, { onMessage: (m) => applyStreamMessage(qc, m), onState: setState }), [api, qc, token]);
  return state;
}

/* ----------------------------------------------------------------------------------------------
 * Clock: one shared 1s ticker so every age readout updates together.
 * -------------------------------------------------------------------------------------------- */

let nowMs = typeof window === "undefined" ? 0 : Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(cb: () => void): () => void {
  clockListeners.add(cb);
  if (!clockTimer) {
    nowMs = Date.now();
    clockTimer = setInterval(() => {
      nowMs = Date.now();
      clockListeners.forEach((l) => l());
    }, 1_000);
  }
  return () => {
    clockListeners.delete(cb);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribeClock, () => nowMs, () => 0);
}
