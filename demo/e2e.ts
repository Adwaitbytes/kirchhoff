/**
 * demo/e2e.ts (TESTNET SIMULATION): the end-to-end Kelp Replay harness (PRD section 17 e2e row). Checks the
 * deployment, runs the attack, drives the Conservation Engine (default `cre workflow simulate` for W1/W3/W2,
 * `--reports direct` through the MockKeystoneForwarder while the workflows are built), asserts every Flow B outcome
 * on all three chains, and resets. Exits non-zero on any failure.
 *
 *   pnpm --filter @kirchhoff/demo e2e --network local|testnet [--reports cre|direct] [--no-reset]
 */
import { Status } from "@kirchhoff/engine";
import { ledgerAbi, quarantineAbi } from "./src/abi.ts";
import { hasCode, read } from "./src/chain.ts";
import { account } from "./src/chain.ts";
import { main, parseArgs, reportMode } from "./src/cli.ts";
import { loadContext, type Context } from "./src/context.ts";
import { log, stepEmitter } from "./src/events.ts";
import { attemptRefusals, driveContainment, forgeRelease, hookPayload, type Emit } from "./src/attack.ts";
import { resetAll } from "./src/reset.ts";
import { ROLES } from "./src/networks.ts";

class AssertionError extends Error {
  override readonly name = "AssertionError";
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new AssertionError(message);
}

async function checkDeployment(ctx: Context, emit: Emit): Promise<void> {
  emit({ step: "deploy-check", status: "started", title: "verify the deployment on all three chains" });
  for (const role of ROLES) {
    const chain = ctx.chains[role];
    for (const key of ["conservationLedger", "quarantineController", "conservationFeed", "kirchhoffTokenPool", "weakBridge"]) {
      assert(await hasCode(chain, ctx.at(role, key)), `${key} has no code on ${role}`);
    }
    const registered = await read<boolean>(chain, { to: ctx.at(role, "conservationLedger"), abi: [{ type: "function", name: "isRegistered", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] }], functionName: "isRegistered", args: [ctx.tokenId] });
    assert(registered, `kETH not registered on ${role}`);
  }
  assert(await hasCode(ctx.chains.home, ctx.at("home", "demoLendingMarket")), "lending market missing on home");
  emit({ step: "deploy-check", status: "ok", title: "deployment verified" });
}

async function assertContained(ctx: Context, incidentId: `0x${string}`, attacker: `0x${string}`, emit: Emit): Promise<void> {
  emit({ step: "assert-breach", status: "started", title: "assert BREACH + incident on all three ledgers" });
  for (const role of ROLES) {
    const chain = ctx.chains[role];
    const ledger = ctx.at(role, "conservationLedger");
    const [status] = await read<[number, bigint, bigint, boolean]>(chain, { to: ledger, abi: ledgerAbi, functionName: "statusOf", args: [ctx.tokenId] });
    assert(status === Status.BROKEN || status === Status.QUARANTINED, `${role} status is ${status}, expected BROKEN/QUARANTINED`);
    const active = await read<`0x${string}`>(chain, { to: ledger, abi: ledgerAbi, functionName: "activeIncident", args: [ctx.tokenId] });
    assert(active.toLowerCase() === incidentId.toLowerCase(), `${role} activeIncident ${active} != ${incidentId}`);
    const breach = await read<{ recipient: `0x${string}`; amount: bigint }>(chain, { to: ledger, abi: ledgerAbi, functionName: "breachOf", args: [incidentId] });
    assert(breach.recipient.toLowerCase() === attacker.toLowerCase(), `${role} breach recipient ${breach.recipient} != attacker`);
    const frozen = await read<boolean>(chain, { to: ctx.at(role, "quarantineController"), abi: quarantineAbi, functionName: "isFrozen", args: [ctx.tokenId] });
    const tainted = await read<boolean>(chain, { to: ctx.at(role, "quarantineController"), abi: quarantineAbi, functionName: "isTainted", args: [ctx.tokenId, attacker] });
    assert(frozen, `${role} lanes not frozen`);
    assert(tainted, `${role} attacker not tainted`);
    emit({ step: "assert-breach", status: "ok", chain: role, title: `${role}: BREACH recorded, lanes frozen, attacker tainted`, detail: { status, incidentId } });
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), { options: ["reports"], flags: ["no-reset"] });
  const mode = reportMode(args);
  const ctx = await loadContext(args.network);
  const emit = stepEmitter(ctx.net.name);
  const attacker = account("ATTACKER").address;
  emit({ step: "e2e", status: "started", title: "Kelp Replay end-to-end", detail: { network: ctx.net.name, reports: mode } });

  await checkDeployment(ctx, emit);

  // Attack + Conservation Engine.
  const release = await forgeRelease(ctx, emit);
  await driveContainment(ctx, emit, mode, release);

  // Assertions: BREACH + incident on all three ledgers.
  await assertContained(ctx, release.incidentId, attacker, emit);

  // Attacker's three onward moves must all be refused.
  const refusals = await attemptRefusals(ctx, emit, false);
  assert(/Tainted|Frozen|NotConserved|Quarantin/i.test(refusals.ccip.reason), `CCIP refusal reason unexpected: ${refusals.ccip.reason}`);
  assert(/SenderTainted/i.test(refusals.guard.reason), `Guard refusal reason unexpected: ${refusals.guard.reason}`);
  assert(/CollateralBroken/i.test(refusals.borrow.reason), `borrow refusal reason unexpected: ${refusals.borrow.reason}`);
  emit({ step: "assert-refusals", status: "ok", title: "every onward move refused", detail: { ccip: refusals.ccip.reason, guard: refusals.guard.reason, borrow: refusals.borrow.reason } });

  const payload = hookPayload(ctx, release);
  emit({ step: "judge-replay-payload", status: "ok", title: "policy-hook payload produced", detail: { messageId: String(payload.message_id) } });

  // Reset.
  if (!args.flags.has("no-reset")) {
    const elapsedMs = await resetAll(ctx, emit, mode);
    assert(elapsedMs < 180_000, `reset took ${elapsedMs}ms, over the 3-minute target`);
  }

  emit({ step: "e2e", status: "ok", title: "Kelp Replay end-to-end PASSED" });
  log("e2e PASSED");
}

main(run);
