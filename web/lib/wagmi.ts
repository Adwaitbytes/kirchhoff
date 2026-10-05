import { createConfig, createStorage, http, noopStorage } from "wagmi";
import { arbitrumSepolia, baseSepolia, sepolia } from "wagmi/chains";
import { CHAINS } from "@/lib/chains";

/** Read-only wagmi config: no connectors, KIRCHHOFF never asks for a wallet. */
export const wagmiConfig = createConfig({
  chains: [sepolia, arbitrumSepolia, baseSepolia],
  connectors: [],
  // Read-only: nothing to persist, and no storage access during server rendering.
  storage: createStorage({ storage: noopStorage }),
  ssr: true,
  transports: {
    [sepolia.id]: http(CHAINS["ethereum-testnet-sepolia"].rpcEnv),
    [arbitrumSepolia.id]: http(CHAINS["ethereum-testnet-sepolia-arbitrum-1"].rpcEnv),
    [baseSepolia.id]: http(CHAINS["ethereum-testnet-sepolia-base-1"].rpcEnv),
  },
});
