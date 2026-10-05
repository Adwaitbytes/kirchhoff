/**
 * demo/spec-activate.ts (TESTNET SIMULATION): the PRD section 6 spec lifecycle on its own (deploy-all runs it too).
 * The issuer Safe (2-of-3) proposes the resolved KIRCH-SPEC hash and URI on KirchhoffRegistry, the registry timelock
 * elapses, then activateSpec. Idempotent.
 *
 *   pnpm --filter @kirchhoff/demo spec --network local|testnet
 */
import { main, parseArgs } from "./src/cli.ts";
import { loadContext } from "./src/context.ts";
import { stepEmitter } from "./src/events.ts";
import { activateSpec } from "./src/spec.ts";

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), { options: [], flags: [] });
  const ctx = await loadContext(args.network);
  await activateSpec(ctx, stepEmitter(ctx.net.name));
}

main(run);
