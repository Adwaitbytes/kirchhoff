import { installInfra, localChains, mineToFinality, type Alias } from "@kirchhoff/workflows/scripts/lib/local.ts";
import type { Address } from "viem";
import { REPO_ROOT } from "./env.ts";
import type { ChainRole } from "./networks.ts";

/**
 * Local Anvil infrastructure for `cre workflow simulate --target local --broadcast`: our MockKeystoneForwarder
 * bytecode at the simulator's built-in forwarder addresses plus canonical Multicall3, exactly as the CRE harness
 * does (reused from workflows/scripts/lib/local.ts, not duplicated).
 */
export async function installLocalInfra(fund: readonly Address[]): Promise<void> {
  await installInfra(localChains(), REPO_ROOT, fund);
}

/** CRE reads at `finalized`, which Anvil serves as head - 64: mine past it so every write so far is visible. */
export async function mineLocal(blocks = 70): Promise<void> {
  await mineToFinality(localChains(), blocks);
}

/** The simulator's forwarder for a local chain; ledgers must trust it or reject every simulated report. */
export function simulatorForwarder(role: ChainRole): Address {
  const chain = localChains().find((c) => c.alias === (role satisfies Alias));
  if (chain === undefined) throw new Error(`no local chain ${role}`);
  return chain.simulatorForwarder;
}
