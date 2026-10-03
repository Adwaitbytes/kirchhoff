import { Status } from "@kirchhoff/engine";
import { erc20Abi, ledgerAbi, quarantineAbi } from "./abi.ts";
import { account, read, send } from "./chain.ts";
import { type Context } from "./context.ts";
import { readState } from "./deployments.ts";
import { log, type stepEmitter } from "./events.ts";
import { genConfig, simulate } from "./cre.ts";
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

  if (endsAt.length > 0) {
    const until = endsAt.reduce((a, b) => (a > b ? a : b), 0n);
    const waitMs = Number(until) * 1000 - Date.now() + 2000;
    if (waitMs > 0) {
      emit({ step: "timelock", status: "started", title: `waiting ${Math.ceil(waitMs / 1000)}s recovery timelock` });
      await sleep(waitMs);
    }
    emit({ step: "timelock", status: "ok", title: "recovery timelock elapsed" });
  }

  if (mode === "cre" && endsAt.length > 0) await genConfig(ctx.net.name).catch(() => undefined);
  for (const role of ROLES) {
    const s = await ledgerStatus(ctx, role);
    if (s.status !== Status.RECOVERING) {
      emit({ step: "recovery-check", status: "skipped", chain: role, title: `${role} not RECOVERING (status ${s.status})` });
      continue;
    }
    if (mode === "cre") {
      await simulate({ workflow: "w2-loop", net: ctx.net.name, triggerIndex: 0, broadcast: true });
      emit({ step: "recovery-check", status: "ok", chain: role, title: `RECOVERY_CHECK via CRE on ${role}` });
    } else {
      const sent = await writeReportDirect(ctx, role, recoveryBody(await nextEpochId(ctx, role)), 4);
      emit({ step: "recovery-check", status: "ok", chain: role, title: `RECOVERY_CHECK cleared ${role} to CONSERVED`, txHash: sent.hash, explorerUrl: sent.url });
    }
  }

  const attacker = account("ATTACKER").address;
  for (const role of ROLES) {
    const tainted = await read<boolean>(ctx.chains[role], { to: ctx.at(role, "quarantineController"), abi: quarantineAbi, functionName: "isTainted", args: [ctx.tokenId, attacker] });
    if (!tainted) continue;
    const sent = await execSafe(ctx.chains[role], safe, { to: ctx.at(role, "quarantineController"), abi: quarantineAbi, functionName: "untaint", args: [ctx.tokenId, [attacker]] }, `untaint attacker on ${role}`);
    emit({ step: "untaint", status: "ok", chain: role, title: `attacker untainted on ${role}`, txHash: sent.hash, explorerUrl: sent.url });
  }

  const home = ctx.chains.home;
  const escrow = ctx.at("home", "homeEscrowAdapter");
  const stolen = await balanceOf(ctx, "home", attacker);
  if (stolen > 0n) {
    const sent = await send(home, account("ATTACKER"), { to: ctx.at("home", "kETH"), abi: erc20Abi, functionName: "transfer", args: [escrow, stolen] }, `return ${stolen} kETH to escrow`);
    emit({ step: "rebalance", status: "ok", chain: "home", title: `returned ${stolen} kETH to escrow; Δ back to 0`, txHash: sent.hash, explorerUrl: sent.url });
  } else {
    emit({ step: "rebalance", status: "skipped", chain: "home", title: "attacker holds no kETH" });
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
