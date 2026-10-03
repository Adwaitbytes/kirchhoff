/**
 * demo/reset.ts (TESTNET SIMULATION): restores all three chains to a clean CONSERVED state for the next take, and
 * prints the elapsed time (target under 3 minutes, PRD section 15 recording checklist).
 *
 *   pnpm --filter @kirchhoff/demo reset --network local|testnet [--reports cre|direct]
 *
 * The issuer Safe (2-of-3) resolves the incident on each chain, the short recovery timelock elapses, a RECOVERY_CHECK
 * clears each ledger to CONSERVED, the Safe clears the attacker taint, and the stolen kETH is returned to the escrow.
 */
import { main, parseArgs, reportMode } from "./src/cli.ts";
import { loadContext } from "./src/context.ts";
import { stepEmitter } from "./src/events.ts";
import { resetAll } from "./src/reset.ts";

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), { options: ["reports"], flags: [] });
  const mode = reportMode(args);
  const ctx = await loadContext(args.network);
  await resetAll(ctx, stepEmitter(ctx.net.name), mode);
}

main(run);
