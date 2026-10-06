import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, custom, type PublicClient } from "viem";
import type { ChainKey } from "@kirchhoff/sdk";

/** kETH on the public testnets (deployments/testnet-*.raw.json), the subject of the recorded fixture. */
export const KETH_TESTNET = {
  home: "ethereum-testnet-sepolia",
  arb: "ethereum-testnet-sepolia-arbitrum-1",
  base: "ethereum-testnet-sepolia-base-1",
  token: "0xb270dcd4f512709dfaedbaab736888699bda0273",
  deployer: "0x82b34934e1d29ba416ab154234597892d85918dc",
  homePool: "0x1c60f8b189e6ea5f04c9510faef5021605a22bde",
  lockBox: "0x8fa18a722eed4ef8c40c2552b92db07ccdd6f899",
  escrow: "0xde9a6413ac2c29cd6621f93fcd872ebb46b6a3d7",
  remoteToken: "0x93eec1ba5a782ceb99e76eec6736d900c1cb002d",
  remotePool: "0x98ec613f16cf077de8b34a7c32f4b767cc90840e",
  weakBridge: "0x9bb3062c74c97768b83f48ac2f2bae38a1db5d78",
} as const;

/** Log lookback the fixture was recorded with (the API's testnet value); replay must use the same so block ranges match. */
export const FIXTURE_LOOKBACK = 100_000n;

export type OnboardingFixture = {
  recordedAt: string;
  rpc: Partial<Record<ChainKey, Record<string, unknown>>>;
  http: Record<string, unknown>;
};

export const rpcKey = (method: string, params: unknown): string => `${method} ${JSON.stringify(params ?? [])}`;
export const redactUrl = (url: string): string => url.replace(/apikey=[^&]*/i, "apikey=REDACTED");

export function loadFixture(): OnboardingFixture {
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "testnet-onboarding.json"), "utf8")) as OnboardingFixture;
}

/** A viem client that answers only from recorded traffic; an unrecorded request fails loudly. */
export function replayClient(fx: OnboardingFixture, chain: ChainKey): PublicClient {
  const rpc = fx.rpc[chain] ?? {};
  return createPublicClient({
    transport: custom({
      request({ method, params }: { method: string; params?: unknown }) {
        const k = rpcKey(method, params);
        if (!(k in rpc)) return Promise.reject(new Error(`unrecorded RPC on ${chain}: ${k.slice(0, 160)}`));
        return Promise.resolve(rpc[k]);
      },
    }),
  });
}

/** A fetch that answers only from recorded explorer responses (keys redacted on both sides). */
export function replayFetch(fx: OnboardingFixture, seen: string[] = []): typeof fetch {
  return (input) => {
    const url = redactUrl(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push(url);
    if (!(url in fx.http)) return Promise.resolve(new Response("not recorded", { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(fx.http[url]), { status: 200, headers: { "content-type": "application/json" } }));
  };
}
