/**
 * demo/attack-kelp-replay.ts (TESTNET SIMULATION): the full Kelp Replay (PRD section 5 Flow B) as a self-contained
 * run that streams JSON-lines step events on stdout for the Attack Lab.
 *
 *   pnpm --filter @kirchhoff/demo attack --network local|testnet [--reports cre|direct] [--no-broadcast]
 *
 * Steps: forge a WeakBridge credit with no matching burn (116,500 kETH released to the attacker); the Conservation
 * Engine writes BREACH + QUARANTINE_APPLIED to all three ledgers; then the attacker's three onward moves are each
 * refused (CCIP to Base, home kETH transfer, lending borrow). The Judge-replay hook payload is printed too.
 *
 * Default report path is `cre workflow simulate`; `--reports direct` uses the MockKeystoneForwarder with the same
 * engine encoding. Do not run on testnet until the CRE workflows exist.
 */
import { main, parseArgs, reportMode } from "./src/cli.ts";
import { loadContext } from "./src/context.ts";
import { stepEmitter } from "./src/events.ts";
import { attemptRefusals, baselineEpoch, deficitEpoch, driveContainment, forgeRelease, hookPayload, refusalBlock } from "./src/attack.ts";
import { ledgerStatus } from "./src/reset.ts";
import { Status } from "@kirchhoff/engine";
import { writeState, readState } from "./src/deployments.ts";

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), { options: ["reports"], flags: ["no-broadcast"] });
  const mode = reportMode(args);
  const broadcast = !args.flags.has("no-broadcast");
  const ctx = await loadContext(args.network);
  const emit = stepEmitter(ctx.net.name);
  emit({ step: "attack", status: "started", title: "Kelp Replay (Testnet simulation)", detail: { reports: mode, broadcast } });

  // A fresh deployment starts UNKNOWN: give it the W2 baseline epoch so the demo opens on CONSERVED.
  if ((await ledgerStatus(ctx, "home")).status === Status.UNKNOWN) await baselineEpoch(ctx, emit, mode);
  const release = await forgeRelease(ctx, emit);
  await driveContainment(ctx, emit, mode, release);
  const refusals = await attemptRefusals(ctx, emit, broadcast);
  await deficitEpoch(ctx, emit, mode, release);

  const payload = hookPayload(ctx, release, await refusalBlock(ctx, refusals.ccipPool ?? refusals.ccip));
  emit({ step: "judge-replay-payload", status: "ok", title: "policy-hook v1 payload for the Judge replay path", detail: { messageId: String(payload.message_id) } });
  process.stdout.write(`${JSON.stringify({ label: "Testnet simulation", step: "hook-payload", payload })}\n`);

  const state = readState(ctx.net.name);
  state.lastIncident = { incidentId: release.incidentId, attackTx: release.tx.hash, amount: release.amount.toString(), at: new Date().toISOString() };
  writeState(state);

  emit({
    step: "attack",
    status: "ok",
    title: "Kelp Replay complete: released, contained, every onward move refused",
    detail: { incidentId: release.incidentId, ccip: refusals.ccip.reason, ccipPool: refusals.ccipPool?.reason ?? null, guard: refusals.guard.reason, borrow: refusals.borrow.reason },
  });
}

main(run);
