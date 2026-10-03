/**
 * Two independent RPC providers per chain. Every read is issued to both; callers decide what
 * agreement means. JSON-RPC batching folds all reads one message needs from one provider into a
 * single HTTP round trip, and retries are off because the 2 s budget leaves no room for them.
 */
import type { Read, ReadPair } from "@kirchhoff/engine";
import { createPublicClient, http, type PublicClient } from "viem";

export type { Read, ReadPair };

export type Provider = { label: "1" | "2"; client: PublicClient };

export type ChainProviders = { name: string; providers: readonly [Provider, Provider] };

export function createProviders(name: string, urls: readonly [string, string], timeoutMs: number): ChainProviders {
  const make = (url: string): PublicClient =>
    createPublicClient({ transport: http(url, { batch: { wait: 0 }, retryCount: 0, timeout: timeoutMs }) });
  return {
    name,
    providers: [
      { label: "1", client: make(urls[0]) },
      { label: "2", client: make(urls[1]) },
    ],
  };
}

function shortError(e: unknown): string {
  const message = e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message : String(e);
  return message.split("\n")[0]?.slice(0, 200) ?? "error";
}

export async function settle<T>(promise: Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (e) {
    return { ok: false, error: shortError(e) };
  }
}

export function readBoth<T>(chain: ChainProviders, read: (client: PublicClient) => Promise<T>): Promise<ReadPair<T>> {
  const [a, b] = chain.providers;
  return Promise.all([settle(read(a.client)), settle(read(b.client))]);
}

export type Agreement<T> = { ok: true; value: T } | { ok: false; note: string };

/** Both providers answered and the answers are equal. */
export function agreeOn<T>(pair: ReadPair<T>, equal: (a: T, b: T) => boolean, what: string): Agreement<T> {
  const [a, b] = pair;
  if (!a.ok || !b.ok) return { ok: false, note: `${what} read failed` };
  if (!equal(a.value, b.value)) return { ok: false, note: `providers disagree on ${what}` };
  return { ok: true, value: a.value };
}
