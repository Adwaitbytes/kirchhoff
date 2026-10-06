import { Status } from "@kirchhoff/engine";
import { parseAbiItem, type Address } from "viem";
import { erc20Abi, ledgerAbi, quarantineAbi } from "./abi.ts";
import { account, read, send } from "./chain.ts";
import { type Context } from "./context.ts";
import { readState } from "./deployments.ts";
import { log, type stepEmitter } from "./events.ts";
import { emitWrites } from "./attack.ts";
import { runWorkflow, settle } from "./engine-run.ts";
import { ROLES, type ChainRole } from "./networks.ts";
import { nextEpochId, quarantineBody, recoveryBody, writeReportDirect } from "./reports.ts";
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

const BREACH_RECORDED = parseAbiItem(
  "event BreachRecorded(bytes32 indexed tokenId, uint16 reason, bytes32 evidenceHash, uint64 offendingChain, bytes32 offendingTx, address recipient, uint256 amount)",
);

/**
 * A run that dies between W1/W2 writing BREACH and W3 applying containment leaves ledgers BROKEN, and resolve needs
 * QUARANTINED. Each such chain is contained under its own active incident, exactly as the DON would: W3 runs on the
 * home BreachRecorded log whose evidence matches that incident (direct mode writes the same QUARANTINE_APPLIED).
 */
async function containDangling(ctx: Context, emit: Emit, mode: ReportMode): Promise<void> {
  const pending = new Map<`0x${string}`, ChainRole[]>();
  for (const role of ROLES) {
    const s = await ledgerStatus(ctx, role);
    if (s.status !== Status.BROKEN) continue;
    pending.set(s.incident, [...(pending.get(s.incident) ?? []), role]);
  }
  for (const [incident, roles] of pending) {
    const role = roles[0] ?? "home";
    const breach = await read<{ evidenceHash: `0x${string}`; recipient: Address }>(ctx.chains[role], { to: ctx.at(role, "conservationLedger"), abi: ledgerAbi, functionName: "breachOf", args: [incident] });
    if (mode === "cre") {
      const log = await findBreachLog(ctx, breach.evidenceHash);
      if (log !== null) {
        const run = await runWorkflow(ctx, "w3-responder", 0, log);
        emitWrites(emit, "contain-dangling", run);
        emit({ step: "contain-dangling", status: "ok", title: `W3 contained incident ${incident.slice(0, 10)} left BROKEN by an interrupted run`, detail: { chains: roles.join(", ") } });
        continue;
      }
    }
    const tainted = breach.recipient === "0x0000000000000000000000000000000000000000" ? [] : [breach.recipient];
    for (const r of roles) {
      const sent = await writeReportDirect(ctx, r, quarantineBody(incident, tainted), 3);
      emit({ step: "contain-dangling", status: "ok", chain: r, title: `QUARANTINE_APPLIED for incident ${incident.slice(0, 10)} on ${r}`, txHash: sent.hash, explorerUrl: sent.url });
    }
  }
}

/** The home BreachRecorded log carrying this evidence hash, as a CRE trigger reference (in-receipt log index). */
async function findBreachLog(ctx: Context, evidenceHash: `0x${string}`): Promise<{ txHash: `0x${string}`; eventIndex: number } | null> {
  const client = ctx.chains.home.client;
  const head = await client.getBlockNumber();
  const ledger = ctx.at("home", "conservationLedger");
  for (let to = head; to > head - 20_000n && to > 0n; to -= 2_000n) {
    const from = to > 1_999n ? to - 1_999n : 0n;
    const logs = await client.getLogs({ address: ledger, event: BREACH_RECORDED, args: { tokenId: ctx.tokenId }, fromBlock: from, toBlock: to });
    const hit = logs.find((l) => l.args.evidenceHash?.toLowerCase() === evidenceHash.toLowerCase());
    if (hit?.transactionHash != null) {
      const receipt = await client.getTransactionReceipt({ hash: hit.transactionHash });
      const eventIndex = receipt.logs.findIndex((l) => l.logIndex === hit.logIndex);
      return { txHash: hit.transactionHash, eventIndex };
    }
  }
  return null;
}

/** Restores all three chains to CONSERVED and returns the elapsed milliseconds (PRD recording checklist, <3 min). */
export async function resetAll(ctx: Context, emit: Emit, mode: ReportMode): Promise<number> {
  const safe = readState(ctx.net.name).safe?.address;
  if (safe === undefined) throw new Error("no issuer Safe recorded; run deploy-all first");
  const started = Date.now();
  emit({ step: "reset", status: "started", title: "restore CONSERVED state (Testnet simulation)" });

  await containDangling(ctx, emit, mode);

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
