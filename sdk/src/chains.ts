import { CHAIN_KEYS, type ChainKey, type TokenStatus, type ReasonCode, type Hex } from "./api-types.ts";

/** Where a KIRCHHOFF deployment runs: three local Anvil chains or the three public testnets. */
export type NetworkMode = "local" | "testnet";

export type ChainInfo = {
  key: ChainKey;
  /** CCIP chain selector (docs/INTERFACES.md). Local Anvil chains reuse it. */
  selector: bigint;
  testnetChainId: number;
  localChainId: number;
  /** Short alias used by KIRCH-SPEC bridge maps. */
  alias: "home" | "arb" | "base";
  label: string;
  /** Etherscan-family explorer for the public testnet (docs/research/explorers.md). */
  explorer: string;
  blockscout: string;
  /** Env names of the two independent RPC providers. */
  rpcEnv: readonly [string, string];
  localRpc: string;
  /** Live CCIP 2.0 testnet contracts (docs/research/ccip.md, checked with typeAndVersion). */
  ccip: { router: Hex; onRamp: Hex; offRamp: Hex; tokenAdminRegistry: Hex };
};

export const CHAINS: Readonly<Record<ChainKey, ChainInfo>> = {
  "ethereum-testnet-sepolia": {
    key: "ethereum-testnet-sepolia",
    selector: 16015286601757825753n,
    testnetChainId: 11155111,
    localChainId: 31337,
    alias: "home",
    label: "Ethereum Sepolia",
    explorer: "https://sepolia.etherscan.io",
    blockscout: "https://eth-sepolia.blockscout.com",
    rpcEnv: ["RPC_ETH_SEPOLIA_1", "RPC_ETH_SEPOLIA_2"],
    localRpc: "http://127.0.0.1:8545",
    ccip: {
      router: "0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59",
      onRamp: "0x8dcf17f298c881a547d91ca4aa3c2ad7568c6777",
      offRamp: "0xc6a246a9acdaae651708706494720f79c3e5d0a1",
      tokenAdminRegistry: "0x95f29fee11c5c55d26cccf1db6772de953b37b82",
    },
  },
  "ethereum-testnet-sepolia-arbitrum-1": {
    key: "ethereum-testnet-sepolia-arbitrum-1",
    selector: 3478487238524512106n,
    testnetChainId: 421614,
    localChainId: 31338,
    alias: "arb",
    label: "Arbitrum Sepolia",
    explorer: "https://sepolia.arbiscan.io",
    blockscout: "https://arbitrum-sepolia.blockscout.com",
    rpcEnv: ["RPC_ARB_SEPOLIA_1", "RPC_ARB_SEPOLIA_2"],
    localRpc: "http://127.0.0.1:8546",
    ccip: {
      router: "0x2a9c5afb0d0e4bab2bcdae109ec4b0c4be15a165",
      onRamp: "0x6b9a7cf69f90ae2659bfe3069fba5aa308a48cc4",
      offRamp: "0xc93218eb7b778bc0c13e5296140c8e4fa1c440da",
      tokenAdminRegistry: "0x8126be56454b628a88c17849b9ed99dd5a11bd2f",
    },
  },
  "ethereum-testnet-sepolia-base-1": {
    key: "ethereum-testnet-sepolia-base-1",
    selector: 10344971235874465080n,
    testnetChainId: 84532,
    localChainId: 31339,
    alias: "base",
    label: "Base Sepolia",
    explorer: "https://sepolia.basescan.org",
    blockscout: "https://base-sepolia.blockscout.com",
    rpcEnv: ["RPC_BASE_SEPOLIA_1", "RPC_BASE_SEPOLIA_2"],
    localRpc: "http://127.0.0.1:8547",
    ccip: {
      router: "0xd3b06cebf099ce7da4accf578aaebfdbd6e88a93",
      onRamp: "0xa33b221a8427739c76f631a995ca60544bedd632",
      offRamp: "0xa137536a3bfd81ad6f090981268b8c2818451d41",
      tokenAdminRegistry: "0x736d0bbb318c1b27ff686cd19804094e66250e17",
    },
  },
};

export function isChainKey(value: unknown): value is ChainKey {
  return typeof value === "string" && (CHAIN_KEYS as readonly string[]).includes(value);
}

export function chainBySelector(selector: bigint): ChainInfo | undefined {
  return Object.values(CHAINS).find((c) => c.selector === selector);
}

export function chainByChainId(chainId: number): { info: ChainInfo; mode: NetworkMode } | undefined {
  for (const info of Object.values(CHAINS)) {
    if (info.testnetChainId === chainId) return { info, mode: "testnet" };
    if (info.localChainId === chainId) return { info, mode: "local" };
  }
  return undefined;
}

export function chainIdFor(key: ChainKey, mode: NetworkMode): number {
  return mode === "local" ? CHAINS[key].localChainId : CHAINS[key].testnetChainId;
}

export function txUrl(chain: ChainKey, hash: Hex): string {
  return `${CHAINS[chain].explorer}/tx/${hash}`;
}

export function addressUrl(chain: ChainKey, address: Hex): string {
  return `${CHAINS[chain].explorer}/address/${address}`;
}

export const STATUS_BY_VALUE: readonly TokenStatus[] = ["UNKNOWN", "CONSERVED", "DRIFT", "BROKEN", "QUARANTINED", "RECOVERING"];

export const REASON_BY_VALUE: readonly ReasonCode[] = [
  "OK",
  "PENDING_ATTESTATION",
  "DEBIT_NOT_FOUND",
  "AMOUNT_MISMATCH",
  "RECIPIENT_MISMATCH",
  "DOUBLE_CREDIT",
  "LOOP_DEFICIT",
  "RESERVE_SHORTFALL",
  "FLOW_LIMIT",
  "STATUS_STALE",
  "TOKEN_BROKEN",
  "TOKEN_QUARANTINED",
  "UNKNOWN_TOKEN",
  "SPEC_MISMATCH",
  "TOKEN_RECOVERING",
];

export function statusFromValue(value: number): TokenStatus {
  const s = STATUS_BY_VALUE[value];
  if (s === undefined) throw new RangeError(`unknown status value ${value}`);
  return s;
}

export function reasonFromValue(value: number): ReasonCode {
  const r = REASON_BY_VALUE[value];
  if (r === undefined) throw new RangeError(`unknown reason value ${value}`);
  return r;
}
