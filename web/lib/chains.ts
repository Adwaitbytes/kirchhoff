import type { ChainKey, ChainSelector } from "@/lib/api/types";

export interface ChainMeta {
  key: ChainKey;
  /** EVM chain id. */
  id: number;
  name: string;
  short: string;
  selector: ChainSelector;
  explorer: string;
  /** Safe{Wallet} short name used in app.safe.global URLs. */
  safePrefix: string;
  rpcEnv: string | undefined;
}

export const CHAINS: Readonly<Record<ChainKey, ChainMeta>> = {
  "ethereum-testnet-sepolia": {
    key: "ethereum-testnet-sepolia",
    id: 11155111,
    name: "Ethereum Sepolia",
    short: "Sepolia",
    selector: "16015286601757825753",
    explorer: "https://sepolia.etherscan.io",
    safePrefix: "sep",
    rpcEnv: process.env.NEXT_PUBLIC_RPC_ETH_SEPOLIA,
  },
  "ethereum-testnet-sepolia-arbitrum-1": {
    key: "ethereum-testnet-sepolia-arbitrum-1",
    id: 421614,
    name: "Arbitrum Sepolia",
    short: "Arb Sepolia",
    selector: "3478487238524512106",
    explorer: "https://sepolia.arbiscan.io",
    safePrefix: "arb-sep",
    rpcEnv: process.env.NEXT_PUBLIC_RPC_ARB_SEPOLIA,
  },
  "ethereum-testnet-sepolia-base-1": {
    key: "ethereum-testnet-sepolia-base-1",
    id: 84532,
    name: "Base Sepolia",
    short: "Base Sepolia",
    selector: "10344971235874465080",
    explorer: "https://sepolia.basescan.org",
    safePrefix: "basesep",
    rpcEnv: process.env.NEXT_PUBLIC_RPC_BASE_SEPOLIA,
  },
};

export function chainMeta(key: ChainKey): ChainMeta {
  return CHAINS[key];
}

export function chainName(key: ChainKey): string {
  return CHAINS[key].name;
}
