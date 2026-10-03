import { parseEventLogs, type Address } from "viem";
import { erc20Abi, kethAbi, remoteKethAbi } from "./abi.ts";
import { account, read, send, type Sent } from "./chain.ts";
import { tokenOf, type Context } from "./context.ts";
import { parseAbi } from "viem";
import type { ChainRole } from "./networks.ts";

/** Demo seed targets, in token base units (18 decimals), matching the UI fixtures (PRD / task brief). */
export const SEED = {
  escrowed: 250_000n * 10n ** 18n,
  arb: 180_000n * 10n ** 18n,
  base: 70_000n * 10n ** 18n,
} as const;

const adminAbi = parseAbi([
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantMintRole(address minter)",
  "function mint(address account, uint256 amount)",
]);

export async function balanceOf(ctx: Context, role: ChainRole, who: Address): Promise<bigint> {
  return read<bigint>(ctx.chains[role], { to: tokenOf(ctx, role), abi: erc20Abi, functionName: "balanceOf", args: [who] });
}

export async function totalSupply(ctx: Context, role: ChainRole): Promise<bigint> {
  return read<bigint>(ctx.chains[role], { to: tokenOf(ctx, role), abi: erc20Abi, functionName: "totalSupply" });
}

/**
 * Seeds home backing: mints kETH (deployer is the kETH owner) into the HomeEscrowAdapter so a WeakBridge credit has
 * liquidity to release. Clearly labeled demo admin path. Idempotent: only tops up the shortfall.
 */
export async function seedHomeBacking(ctx: Context, target = SEED.escrowed): Promise<Sent | null> {
  const chain = ctx.chains.home;
  const escrow = ctx.at("home", "homeEscrowAdapter");
  const have = await balanceOf(ctx, "home", escrow);
  if (have >= target) return null;
  return send(chain, account("DEPLOYER"), { to: ctx.at("home", "kETH"), abi: kethAbi, functionName: "mint", args: [escrow, target - have] }, `seed escrow backing +${target - have}`);
}

/**
 * Seeds remote claims: grants the deployer the RemoteKETH MINTER_ROLE (demo admin path) and mints the demo supply to
 * the deployer treasury. Idempotent via total supply.
 */
export async function seedRemoteSupply(ctx: Context, role: "arb" | "base", target: bigint): Promise<Sent | null> {
  const chain = ctx.chains[role];
  const token = tokenOf(ctx, role);
  const deployer = account("DEPLOYER");
  const supply = await totalSupply(ctx, role);
  if (supply >= target) return null;
  const minterRole = await read<`0x${string}`>(chain, { to: token, abi: remoteKethAbi, functionName: "MINTER_ROLE" });
  const isMinter = await read<boolean>(chain, { to: token, abi: remoteKethAbi, functionName: "hasRole", args: [minterRole, deployer.address] });
  if (!isMinter) await send(chain, deployer, { to: token, abi: adminAbi, functionName: "grantMintRole", args: [deployer.address] }, `grant deployer mint role (${role})`);
  return send(chain, deployer, { to: token, abi: adminAbi, functionName: "mint", args: [deployer.address, target - supply] }, `seed ${role} supply +${target - supply}`);
}

export async function seedAll(ctx: Context): Promise<Sent[]> {
  const out: Sent[] = [];
  for (const sent of [await seedHomeBacking(ctx), await seedRemoteSupply(ctx, "arb", SEED.arb), await seedRemoteSupply(ctx, "base", SEED.base)]) {
    if (sent !== null) out.push(sent);
  }
  return out;
}

export { parseEventLogs };
