import type { Context } from "./context.ts";
import { HOME_TESTNET_FEE } from "./chain.ts";
import { simulate, type SimulateResult, type Workflow } from "./cre.ts";
import { log } from "./events.ts";
import { mineLocal } from "./local.ts";
import { ROLES, txUrl, type ChainRole } from "./networks.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Makes everything written so far visible to CRE reads, which pin `finalized`. Anvil: mine past head - 64.
 * Testnets: snapshot each chain's head now and wait until its finalized block reaches it (Sepolia ~13-15 min,
 * the L2s follow L1 batch finality).
 */
export async function settle(ctx: Context, roles: readonly ChainRole[] = ROLES, localBlocks = 70): Promise<number> {
  const started = Date.now();
  if (ctx.net.name === "local") {
    await mineLocal(localBlocks);
    return 0;
  }
  const targets = await Promise.all(roles.map(async (role) => ({ role, block: await ctx.chains[role].client.getBlockNumber() })));
  for (const { role, block } of targets) {
    const chain = ctx.chains[role];
    for (;;) {
      const finalized = (await chain.client.getBlock({ blockTag: "finalized" })).number;
      if (finalized >= block) break;
      log(`waiting for ${chain.config.label} finality: finalized ${finalized} < ${block} (${Math.round((Date.now() - started) / 1000)}s)`);
      await sleep(30_000);
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  log(`finality reached on ${roles.join(", ")} after ${seconds}s`);
  return seconds;
}

/**
 * Testnets: waits until `role`'s finalized head is at or past `timestamp`. W1 only proves "no debit" once the claimed
 * source chain is final past the credit's time (else the debit may still be in flight: PENDING_ATTESTATION).
 */
export async function waitFinalizedPast(ctx: Context, role: ChainRole, timestamp: bigint): Promise<number> {
  const started = Date.now();
  if (ctx.net.name === "local") return 0;
  const chain = ctx.chains[role];
  for (;;) {
    const finalized = await chain.client.getBlock({ blockTag: "finalized" });
    if (finalized.timestamp >= timestamp) break;
    log(`waiting for ${chain.config.label} finalized head to pass the credit time: ${timestamp - finalized.timestamp}s to go`);
    await sleep(30_000);
  }
  return Math.round((Date.now() - started) / 1000);
}

/**
 * The CRE simulator broadcasts at the provider-suggested fee and has no gas-price flag, so on testnets each run waits
 * until the Ethereum Sepolia base fee is under the 1.3 gwei budget cap before it starts.
 */
async function feeGuard(ctx: Context): Promise<void> {
  if (ctx.net.name === "local") return;
  const ceiling = HOME_TESTNET_FEE.maxFeePerGas - HOME_TESTNET_FEE.maxPriorityFeePerGas;
  for (;;) {
    const base = (await ctx.chains.home.client.getBlock({ blockTag: "latest" })).baseFeePerGas ?? 0n;
    if (base <= ceiling) return;
    log(`Sepolia base fee ${base} wei is above the ${ceiling} wei budget; waiting before broadcasting`);
    await sleep(30_000);
  }
}

export type WorkflowWrite = { role: ChainRole; report: string; txHash: `0x${string}`; url: string | null };
export type WorkflowRun = { result: SimulateResult; writes: WorkflowWrite[] };

/** `<REPORT> -> <chain name> ledger <addr>: tx <hash>` lines the workflows log for every write (workflows/src/reports.ts). */
function parseWrites(ctx: Context, result: SimulateResult): WorkflowWrite[] {
  const out: WorkflowWrite[] = [];
  for (const line of result.userLogs) {
    const m = /^(\w+) -> (\S+) ledger \S+: tx (0x[0-9a-fA-F]{64})/.exec(line);
    if (m === null) continue;
    const role = ROLES.find((r) => ctx.net.chains[r].chainName === m[2]);
    if (role === undefined || m[1] === undefined || m[3] === undefined) continue;
    const txHash = m[3] as `0x${string}`;
    out.push({ role, report: m[1], txHash, url: txUrl(ctx.net.chains[role], txHash) });
  }
  return out;
}

export async function runWorkflow(ctx: Context, workflow: Workflow, triggerIndex: number, evm?: { txHash: `0x${string}`; eventIndex: number }): Promise<WorkflowRun> {
  await feeGuard(ctx);
  const result = await simulate(ctx.net.name, workflow, triggerIndex, evm);
  return { result, writes: parseWrites(ctx, result) };
}
