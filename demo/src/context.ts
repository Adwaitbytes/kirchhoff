import { tokenId as engineTokenId } from "@kirchhoff/engine";
import type { Address, Hex } from "viem";
import { connect, type Chain } from "./chain.ts";
import { addr, loadSet, TOKEN_SYMBOL, type DeploymentSet } from "./deployments.ts";
import { ConfigError } from "./env.ts";
import { network, ROLES, type ChainRole, type Network, type NetworkName } from "./networks.ts";

export type Context = {
  net: Network;
  chains: Readonly<Record<ChainRole, Chain>>;
  set: DeploymentSet;
  tokenId: Hex;
  /** Address on `role` of a key in the forge record (contracts/README.md keys). */
  at: (role: ChainRole, key: string) => Address;
};

export function connectAll(net: Network): Readonly<Record<ChainRole, Chain>> {
  return { home: connect(net.chains.home), arb: connect(net.chains.arb), base: connect(net.chains.base) };
}

/** Checks every RPC answers with the chain id the network expects (a wrong RPC is a costly mistake on testnets). */
export async function checkChainIds(chains: Readonly<Record<ChainRole, Chain>>): Promise<void> {
  for (const role of ROLES) {
    const chain = chains[role];
    const id = await chain.client.getChainId();
    if (id !== chain.config.chainId) throw new ConfigError(`${role} RPC returned chain id ${id}, expected ${chain.config.chainId}`);
  }
}

export async function loadContext(name: NetworkName): Promise<Context> {
  const net = network(name);
  const chains = connectAll(net);
  await checkChainIds(chains);
  const set = loadSet(name);
  return { net, chains, set, tokenId: engineTokenId(TOKEN_SYMBOL), at: (role, key) => addr(set[role], key) };
}

/** The token on each chain: canonical kETH on home, RemoteKETH elsewhere. */
export function tokenOf(ctx: Context, role: ChainRole): Address {
  return ctx.at(role, role === "home" ? "kETH" : "remoteKETH");
}
