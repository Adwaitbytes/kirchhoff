/**
 * demo/verify.ts (TESTNET SIMULATION): re-runs explorer verification for every contract deploy-all created
 * (Etherscan V2 + Blockscout). Idempotent; deploy-all already runs it once.
 *
 *   pnpm --filter @kirchhoff/demo verify --network testnet
 */
import { main, parseArgs } from "./src/cli.ts";
import { stepEmitter } from "./src/events.ts";
import { network } from "./src/networks.ts";
import { verifyAll } from "./src/verify.ts";

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), { options: [], flags: [] });
  const net = network(args.network);
  const rows = await verifyAll(net, stepEmitter(net.name));
  const failed = rows.filter((r) => r.etherscan.startsWith("FAILED") || r.blockscout.startsWith("FAILED"));
  if (failed.length > 0) throw new Error(`${failed.length} of ${rows.length} contracts not verified everywhere`);
}

main(run);
