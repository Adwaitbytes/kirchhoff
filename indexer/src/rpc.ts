import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { CHAINS, chainIdFor, type ChainKey, type NetworkMode } from "@kirchhoff/sdk";

/**
 * One viem client per chain over the configured providers, in order. Read model only: the Judge
 * and CRE do their own independent reads, so a lying provider here can only mislead the UI.
 */
export function createChainClient(chain: ChainKey, mode: NetworkMode, urls: readonly string[], timeoutMs = 8_000): PublicClient {
  if (urls.length === 0) throw new Error(`no RPC provider configured for ${chain} (${CHAINS[chain].rpcEnv.join(" or ")})`);
  const transports = urls.map((u) => http(u, { timeout: timeoutMs, retryCount: 1 }));
  return createPublicClient({
    chain: {
      id: chainIdFor(chain, mode),
      name: CHAINS[chain].label,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [...urls] } },
    },
    transport: transports.length === 1 && transports[0] ? transports[0] : fallback(transports, { rank: false }),
  });
}

/** Strips URLs (which may embed provider keys) from RPC error messages before they reach logs or the API. */
export function redactRpcError(e: unknown): string {
  const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
  return msg
    .replace(/https?:\/\/[^\s"')]+/g, "<rpc>")
    .split("\n")[0]
    ?.slice(0, 240) ?? "RPC error";
}
