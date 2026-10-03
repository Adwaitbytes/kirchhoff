import { EngineInputError, type BridgeSpec, type ChainRef, type ChainSel, type Confidence, type Hex, type TokenSpec } from "./types.ts";

export type KnownChain = {
  name: string;
  selector: ChainSel;
  /** Public testnet chain id. Local Anvil reuses the selector with `localChainId`. */
  chainId: number;
  localChainId: number;
  defaultAlias: string;
};

/** CCIP selectors from docs/INTERFACES.md. Anvil chains reuse them (31337 home, 31338 arb, 31339 base). */
export const KNOWN_CHAINS: readonly KnownChain[] = [
  {
    name: "ethereum-testnet-sepolia",
    selector: 16015286601757825753n,
    chainId: 11155111,
    localChainId: 31337,
    defaultAlias: "home",
  },
  {
    name: "ethereum-testnet-sepolia-arbitrum-1",
    selector: 3478487238524512106n,
    chainId: 421614,
    localChainId: 31338,
    defaultAlias: "arb",
  },
  {
    name: "ethereum-testnet-sepolia-base-1",
    selector: 10344971235874465080n,
    chainId: 84532,
    localChainId: 31339,
    defaultAlias: "base",
  },
];

export function knownChainByName(name: string): KnownChain | undefined {
  return KNOWN_CHAINS.find((c) => c.name === name);
}

/** Every chain in the spec, home first, in spec order. */
export function specChains(spec: TokenSpec): readonly ChainRef[] {
  return [spec.home.chain, ...spec.remotes.map((r) => r.chain)];
}

export function chainRef(spec: TokenSpec, selector: ChainSel): ChainRef {
  const found = specChains(spec).find((c) => c.selector === selector);
  if (found === undefined) {
    throw new EngineInputError(`chain selector ${selector.toString()} is not part of the ${spec.token} spec`);
  }
  return found;
}

export function chainByAlias(spec: TokenSpec, alias: string): ChainRef | undefined {
  return specChains(spec).find((c) => c.alias === alias);
}

export function isHome(spec: TokenSpec, selector: ChainSel): boolean {
  return spec.home.chain.selector === selector;
}

/** The token contract on a chain: canonical on home, the remote representation elsewhere. */
export function tokenOn(spec: TokenSpec, selector: ChainSel): Hex {
  if (isHome(spec, selector)) return spec.home.canonical;
  const remote = spec.remotes.find((r) => r.chain.selector === selector);
  if (remote === undefined) {
    throw new EngineInputError(`chain selector ${selector.toString()} is not part of the ${spec.token} spec`);
  }
  return remote.token;
}

export function decimalsOn(spec: TokenSpec, selector: ChainSel): number {
  if (isHome(spec, selector)) return spec.home.decimals;
  const remote = spec.remotes.find((r) => r.chain.selector === selector);
  if (remote === undefined) {
    throw new EngineInputError(`chain selector ${selector.toString()} is not part of the ${spec.token} spec`);
  }
  return remote.decimals;
}

export function confidenceOn(spec: TokenSpec, selector: ChainSel): Confidence {
  return spec.confidence.overrides[chainRef(spec, selector).name] ?? spec.confidence.default;
}

/** The bridge a minter name maps to: `<bridge>`, `<bridge>_<alias>` or `<bridge>_pool_<alias>`. */
export function bridgeForMinter(spec: TokenSpec, minter: string, alias: string): BridgeSpec | undefined {
  return spec.bridges.find((b) => minter === b.id || minter === `${b.id}_${alias}` || minter === `${b.id}_pool_${alias}`);
}
