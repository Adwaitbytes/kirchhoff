import { Status } from "@kirchhoff/engine";
import { erc20Abi, ledgerAbi, quarantineAbi } from "./abi.ts";
import { account, read, send } from "./chain.ts";
import { type Context } from "./context.ts";
import { readState } from "./deployments.ts";
import { log, type stepEmitter } from "./events.ts";
import { emitWrites } from "./attack.ts";
import { runWorkflow, settle } from "./engine-run.ts";
import { ROLES, type ChainRole } from "./networks.ts";
import { nextEpochId, recoveryBody, writeReportDirect } from "./reports.ts";
import { execSafe } from "./safe.ts";
import { balanceOf } from "./supply.ts";

type Emit = ReturnType<typeof stepEmitter>;
export type ReportMode = "cre" | "direct";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function ledgerStatus(ctx: Context, role: ChainRole): Promise<{ status: number; incident: `0x${string}`; recoveryEndsAt: bigint; frozen: boolean }> {
  const chain = ctx.chains[role];
  const ledger = ctx.at(role, "conservationLedger");
  const [status] = await read<[number, bigint, bigint, boolean]>(chain, { to: ledger, abi: ledgerAbi, functionName: "statusOf", args: [ctx.tokenId] });
  const incident = await read<`0x${string}`>(chain, { to: ledger, abi: ledgerAbi, functionName: "activeIncident", args: [ctx.tokenId] });
  const recoveryEndsAt = await read<bigint>(chain, { to: ledger, abi: ledgerAbi, functionName: "recoveryEndsAt", args: [ctx.tokenId] });
  const frozen = await read<boolean>(chain, { to: ctx.at(role, "quarantineController"), abi: quarantineAbi, functionName: "isFrozen", args: [ctx.tokenId] });
  return { status, incident, recoveryEndsAt, frozen };
}

/**
 * Blocks until every ledger's recoveryEndsAt has passed on its chain. Testnets: real waiting. Anvil only: the three
 * clocks are fast-forwarded together (evm_increaseTime), keeping them in sync for W1's cross-chain time checks.
 */
async function waitRecoveryTimelock(ctx: Context, emit: Emit): Promise<void> {
  const remaining = async (): Promise<bigint> => {
    let worst = 0n;
    for (const role of ROLES) {
      const { recoveryEndsAt } = await ledgerStatus(ctx, role);
      if (recoveryEndsAt === 0n) continue;
      const now = (await ctx.chains[role].client.getBlock({ blockTag: "latest" })).timestamp;
      if (recoveryEndsAt - now > worst) worst = recoveryEndsAt - now;
    }
    return worst;
  };
  let left = await remaining();
  if (left <= 0n) return;
  if (ctx.net.name === "local") {
    emit({ step: "timelock", status: "started", title: `Anvil: fast-forwarding all three clocks ${left + 1n}s past the recovery timelock` });
    for (const chain of Object.values(ctx.chains)) {
      await chain.client.request({ method: "evm_increaseTime" as never, params: [Number(left + 1n)] as never });
      await chain.client.request({ method: "evm_mine" as never, params: [] as never });
    }
  } else {
    emit({ step: "timelock", status: "started", title: `waiting ${left}s recovery timelock` });
    while (left > 0n) {
      await sleep(Math.min(Number(left) * 1000 + 2000, 30_000));
      left = await remaining();
    }
  }
  emit({ step: "timelock", status: "ok", title: "recovery timelock elapsed" });
}

/** Restores all three chains to CONSERVED and returns the elapsed milliseconds (PRD recording checklist, <3 min). */
export async function resetAll(ctx: Context, emit: Emit, mode: ReportMode): Promise<number> {
  const safe = readState(ctx.net.name).safe?.address;
  if (safe === undefined) throw new Error("no issuer Safe recorded; run deploy-all first");
  const started = Date.now();
  emit({ step: "reset", status: "started", title: "restore CONSERVED state (Testnet simulation)" });

  const endsAt: bigint[] = [];
  for (const role of ROLES) {
    const s = await ledgerStatus(ctx, role);
    if (s.status === Status.CONSERVED || s.status === Status.UNKNOWN) {
      emit({ step: "resolve", status: "skipped", chain: role, title: `${role} already clear` });
      continue;
    }
    if (s.status !== Status.QUARANTINED && s.status !== Status.RECOVERING) {
      throw new Error(`${role} is status ${s.status}, not QUARANTINED; apply W3 quarantine first`);
    }
    if (s.status === Status.QUARANTINED) {
      const sent = await execSafe(ctx.chains[role], safe, { to: ctx.at(role, "quarantineController"), abi: quarantineAbi, functionName: "resolve", args: [ctx.tokenId, s.incident] }, `resolve incident on ${role}`);
      emit({ step: "resolve", status: "ok", chain: role, title: `issuer Safe resolved incident on ${role}`, txHash: sent.hash, explorerUrl: sent.url });
    }
    endsAt.push((await ledgerStatus(ctx, role)).recoveryEndsAt);
  }

  // 2. Issuer Safe clears the attacker taint, so the stolen kETH can move again (KirchhoffGuard).
  const attacker = account("ATTACKER").address;
  for (const role of ROLES) {
    const tainted = await read<boolean>(ctx.chains[role], { to: ctx.at(role, "quarantineController"), abi: quarantineAbi, functionName: "isTainted", args: [ctx.tokenId, attacker] });
    if (!tainted) continue;
    const sent = await execSafe(ctx.chains[role], safe, { to: ctx.at(role, "quarantineController"), abi: quarantineAbi, functionName: "untaint", args: [ctx.tokenId, [attacker]] }, `untaint attacker on ${role}`);
    emit({ step: "untaint", status: "ok", chain: role, title: `attacker untainted on ${role}`, txHash: sent.hash, explorerUrl: sent.url });
  }

  // 3. Rebalance before the recovery check: RECOVERY_CHECK needs Δ >= 0, so the stolen kETH goes back to the escrow
  //    (demo admin path; the attacker key is ours). Δ returns to 0.
  const escrow = ctx.at("home", "homeEscrowAdapter");
  const stolen = await balanceOf(ctx, "home", attacker);
  if (stolen > 0n) {
    const sent = await send(ctx.chains.home, account("ATTACKER"), { to: ctx.at("home", "kETH"), abi: erc20Abi, functionName: "transfer", args: [escrow, stolen] }, `return ${stolen} kETH to escrow`);
    emit({ step: "rebalance", status: "ok", chain: "home", title: `returned ${stolen} kETH to escrow; Δ back to 0`, txHash: sent.hash, explorerUrl: sent.url });
  } else {
    emit({ step: "rebalance", status: "skipped", chain: "home", title: "attacker holds no kETH" });
  }

  // 4. Wait out the recovery timelock, measured on each chain's own clock (Anvil clocks can run ahead of wall time).
  if (endsAt.length > 0) await waitRecoveryTimelock(ctx, emit);

  // 5. RECOVERY_CHECK clears each RECOVERING ledger to CONSERVED. CRE: one W2 run writes it to every chain. Locally
  //    the chains are mined past the finalized pin and past W2's 2 x 100-block windows, so the attack's forged
  //    credit is history, not in-flight value.
  const recovering: ChainRole[] = [];
  for (const role of ROLES) if ((await ledgerStatus(ctx, role)).status === Status.RECOVERING) recovering.push(role);
  if (recovering.length > 0 && mode === "cre") {
    // Every chain's resolve and the home rebalance must be final before W2 (it reads ledgers and balances at the
    // finalized pin). Anvil: also mine past W2's 2 x 100-block windows.
    await settle(ctx, ROLES, 300);
    const w2 = await runWorkflow(ctx, "w2-loop", 0);
    emitWrites(emit, "recovery-check", w2);
    emit({ step: "recovery-check", status: "ok", title: `W2 RECOVERY_CHECK via CRE on ${recovering.join(", ")}`, detail: { result: w2.result.result } });
  } else {
    for (const role of recovering) {
      const sent = await writeReportDirect(ctx, role, recoveryBody(await nextEpochId(ctx, role)), 4);
      emit({ step: "recovery-check", status: "ok", chain: role, title: `RECOVERY_CHECK cleared ${role} to CONSERVED`, txHash: sent.hash, explorerUrl: sent.url });
    }
  }

  for (const role of ROLES) {
    const s = await ledgerStatus(ctx, role);
    if (s.status !== Status.CONSERVED || s.frozen) throw new Error(`${role} not clean after reset: status ${s.status} frozen ${s.frozen}`);
  }

  const elapsedMs = Date.now() - started;
  emit({ step: "reset", status: "ok", title: "all three chains CONSERVED", detail: { elapsedSeconds: Math.round(elapsedMs / 100) / 10, underThreeMinutes: elapsedMs < 180_000 } });
  log(`reset completed in ${(elapsedMs / 1000).toFixed(1)}s (${elapsedMs < 180_000 ? "under" : "OVER"} the 3-minute target)`);
  return elapsedMs;
}
