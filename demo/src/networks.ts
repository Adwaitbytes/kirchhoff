import type { Address } from "viem";
import { ConfigError, optional } from "./env.ts";

export type NetworkName = "local" | "testnet";
export type ChainRole = "home" | "arb" | "base";
export const ROLES: readonly ChainRole[] = ["home", "arb", "base"];

export type ChainConfig = {
  role: ChainRole;
  /** CRE / CCIP chain name; also the key in the engine deployments schema. */
  chainName: "ethereum-testnet-sepolia" | "ethereum-testnet-sepolia-arbitrum-1" | "ethereum-testnet-sepolia-base-1";
  label: string;
  chainId: number;
  selector: bigint;
  /** Primary RPC (provider 1). */
  rpcUrl: string;
  /** Every configured provider, in preference order; sends and forge broadcasts fall back across them. */
  rpcUrls: readonly string[];
  /** Block explorer base for tx / address links; null on Anvil. */
  explorer: string | null;
  blockscout: { api: string; web: string } | null;
  /** CCIP 2.0.0 ramps (docs/research/ccip.md section 1); null on Anvil, where the demo deployer plays the ramp. */
  ccip: { router: Address; onRamp: Address; offRamp: Address } | null;
  /** Address `cre workflow simulate --broadcast` sends through (docs/research/cre.md section 3). */
  simulationForwarder: Address;
};

export type Network = { name: NetworkName; chains: Readonly<Record<ChainRole, ChainConfig>> };

const SELECTOR = {
  home: 16_015_286_601_757_825_753n,
  arb: 3_478_487_238_524_512_106n,
  base: 10_344_971_235_874_465_080n,
} as const;

const CHAIN_NAME = {
  home: "ethereum-testnet-sepolia",
  arb: "ethereum-testnet-sepolia-arbitrum-1",
  base: "ethereum-testnet-sepolia-base-1",
} as const;

const SIM_FORWARDER: Readonly<Record<ChainRole, Address>> = {
  home: "0x15fC6ae953E024d975e77382eEeC56A9101f9F88",
  arb: "0xD41263567DdfeAd91504199b8c6c87371e83ca5d",
  base: "0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5",
};

function local(): Network {
  const chain = (role: ChainRole, chainId: number, port: number, label: string): ChainConfig => ({
    role,
    chainName: CHAIN_NAME[role],
    label,
    chainId,
    selector: SELECTOR[role],
    rpcUrl: optional(`LOCAL_RPC_${role.toUpperCase()}`) ?? `http://127.0.0.1:${port}`,
    rpcUrls: [optional(`LOCAL_RPC_${role.toUpperCase()}`) ?? `http://127.0.0.1:${port}`],
    explorer: null,
    blockscout: null,
    ccip: null,
    simulationForwarder: SIM_FORWARDER[role],
  });
  return {
    name: "local",
    chains: {
      home: chain("home", 31_337, 8545, "Anvil home (Ethereum Sepolia stand-in)"),
      arb: chain("arb", 31_338, 8546, "Anvil arb (Arbitrum Sepolia stand-in)"),
      base: chain("base", 31_339, 8547, "Anvil base (Base Sepolia stand-in)"),
    },
  };
}

/** Public keyless providers, used only when .env names none (clean clones, CI, unit tests). */
const PUBLIC_RPC = {
  ETH: "https://ethereum-sepolia-rpc.publicnode.com",
  ARB: "https://arbitrum-sepolia-rpc.publicnode.com",
  BASE: "https://base-sepolia-rpc.publicnode.com",
} as const;

/** Provider 1 and 2 from .env (the Judge's two independent providers), else the public endpoint. */
function providers(chain: "ETH" | "ARB" | "BASE"): string[] {
  const urls = [optional(`RPC_${chain}_SEPOLIA_1`), optional(`RPC_${chain}_SEPOLIA_2`)].filter((u): u is string => u !== undefined);
  return urls.length > 0 ? urls : [PUBLIC_RPC[chain]];
}

function testnet(): Network {
  return {
    name: "testnet",
    chains: {
      home: {
        role: "home",
        chainName: CHAIN_NAME.home,
        label: "Ethereum Sepolia",
        chainId: 11_155_111,
        selector: SELECTOR.home,
        rpcUrl: providers("ETH")[0] ?? PUBLIC_RPC.ETH,
        rpcUrls: providers("ETH"),
        explorer: "https://sepolia.etherscan.io",
        blockscout: { api: optional("BLOCKSCOUT_ETH_SEPOLIA_URL") ?? "https://eth-sepolia.blockscout.com/api", web: "https://eth-sepolia.blockscout.com" },
        ccip: {
          router: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59",
          onRamp: "0x8dcf17f298c881A547D91ca4aA3C2AD7568C6777",
          offRamp: "0xc6A246A9AcdAaE651708706494720F79C3E5d0A1",
        },
        simulationForwarder: SIM_FORWARDER.home,
      },
      arb: {
        role: "arb",
        chainName: CHAIN_NAME.arb,
        label: "Arbitrum Sepolia",
        chainId: 421_614,
        selector: SELECTOR.arb,
        rpcUrl: providers("ARB")[0] ?? PUBLIC_RPC.ARB,
        rpcUrls: providers("ARB"),
        explorer: "https://sepolia.arbiscan.io",
        blockscout: { api: optional("BLOCKSCOUT_ARB_SEPOLIA_URL") ?? "https://arbitrum-sepolia.blockscout.com/api", web: "https://arbitrum-sepolia.blockscout.com" },
        ccip: {
          router: "0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165",
          onRamp: "0x6B9a7cF69F90Ae2659bfe3069fba5Aa308A48cC4",
          offRamp: "0xC93218EB7B778bC0c13E5296140C8E4Fa1C440DA",
        },
        simulationForwarder: SIM_FORWARDER.arb,
      },
      base: {
        role: "base",
        chainName: CHAIN_NAME.base,
        label: "Base Sepolia",
        chainId: 84_532,
        selector: SELECTOR.base,
        rpcUrl: providers("BASE")[0] ?? PUBLIC_RPC.BASE,
        rpcUrls: providers("BASE"),
        explorer: "https://sepolia.basescan.org",
        blockscout: { api: optional("BLOCKSCOUT_BASE_SEPOLIA_URL") ?? "https://base-sepolia.blockscout.com/api", web: "https://base-sepolia.blockscout.com" },
        ccip: {
          router: "0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93",
          onRamp: "0xA33b221A8427739c76f631a995ca60544bEdD632",
          offRamp: "0xa137536A3BFd81aD6f090981268b8C2818451d41",
        },
        simulationForwarder: SIM_FORWARDER.base,
      },
    },
  };
}

export function network(name: NetworkName): Network {
  return name === "local" ? local() : testnet();
}

export function parseNetworkName(value: string | undefined): NetworkName {
  if (value === "local" || value === "testnet") return value;
  throw new ConfigError(`--network must be local or testnet (got ${value ?? "nothing"})`);
}

export function txUrl(chain: ChainConfig, hash: string): string | null {
  return chain.explorer === null ? null : `${chain.explorer}/tx/${hash}`;
}

export function addressUrl(chain: ChainConfig, address: string): string | null {
  return chain.explorer === null ? null : `${chain.explorer}/address/${address}`;
}

export function ccipMessageUrl(messageId: string): string {
  return `https://ccip.chain.link/msg/${messageId}`;
}
