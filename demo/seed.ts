/**
 * demo/seed.ts (TESTNET SIMULATION): Flow A, the normal conserved traffic the demo opens on.
 *
 *   pnpm --filter @kirchhoff/demo seed --network local|testnet [--weakbridge] [--ccip] [--amount <wholeKETH>]
 *
 * --weakbridge  a WeakBridge round trip home -> arb -> home whose credits all carry a real debit (W1 matches them).
 * --ccip        (testnet) a real CCIP round trip home -> arb -> home through the KirchhoffTokenPools, native fees:
 *               the second leg is PRD Flow A (Arbitrum Sepolia -> Ethereum Sepolia), recorded with its source tx,
 *               ccip.chain.link link and destination execution. No flag runs both.
 */
import { erc20Abi, kethAbi } from "./src/abi.ts";
import { ccipTransfer } from "./src/ccip.ts";
import { account, read, send } from "./src/chain.ts";
import { main, parseArgs } from "./src/cli.ts";
import { loadContext, type Context } from "./src/context.ts";
import { weakBridgeCredit, weakBridgeSend } from "./src/bridge.ts";
import { stepEmitter, type StepEvent } from "./src/events.ts";

async function ensureDeployerKeth(ctx: Context, amount: bigint): Promise<void> {
  const have = await read<bigint>(ctx.chains.home, { to: ctx.at("home", "kETH"), abi: erc20Abi, functionName: "balanceOf", args: [account("DEPLOYER").address] });
  if (have >= amount) return;
  await send(ctx.chains.home, account("DEPLOYER"), { to: ctx.at("home", "kETH"), abi: kethAbi, functionName: "mint", args: [account("DEPLOYER").address, amount - have] }, `mint ${amount - have} kETH to deployer`);
}

/** A legitimate WeakBridge round trip: every credit carries the id of a real debit, so W1 matches and never breaches. */
async function weakBridgeRoundTrip(ctx: Context, emit: (e: Omit<StepEvent, "label" | "network" | "at">) => StepEvent, amount: bigint): Promise<void> {
  const deployer = account("DEPLOYER");
  await ensureDeployerKeth(ctx, amount);

  emit({ step: "seed-weakbridge-out", status: "started", chain: "home", title: `WeakBridge home -> arb ${amount}` });
  const out = await weakBridgeSend(ctx, "home", deployer, deployer.address, amount, "arb");
  emit({ step: "seed-weakbridge-out", status: "ok", chain: "home", title: "locked in escrow (debit)", txHash: out.sent.hash, explorerUrl: out.sent.url, detail: { id: out.id } });
  const mint = await weakBridgeCredit(ctx, "arb", out.id, deployer.address, amount, "home");
  emit({ step: "seed-weakbridge-out", status: "ok", chain: "arb", title: "minted on arb (matching credit)", txHash: mint.hash, explorerUrl: mint.url, detail: { id: out.id } });

  emit({ step: "seed-weakbridge-back", status: "started", chain: "arb", title: `WeakBridge arb -> home ${amount}` });
  const back = await weakBridgeSend(ctx, "arb", deployer, deployer.address, amount, "home");
  emit({ step: "seed-weakbridge-back", status: "ok", chain: "arb", title: "burned on arb (debit)", txHash: back.sent.hash, explorerUrl: back.sent.url, detail: { id: back.id } });
  const release = await weakBridgeCredit(ctx, "home", back.id, deployer.address, amount, "arb");
  emit({ step: "seed-weakbridge-back", status: "ok", chain: "home", title: "released on home (matching credit)", txHash: release.hash, explorerUrl: release.url, detail: { id: back.id } });
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), { options: ["amount"], flags: ["weakbridge", "ccip"] });
  const ctx = await loadContext(args.network);
  const emit = stepEmitter(ctx.net.name);
  const amount = BigInt(args.options.get("amount") ?? "1") * 10n ** 18n;
  // Neither flag: both kinds of traffic (CCIP only where a real Router exists).
  const both = !args.flags.has("weakbridge") && !args.flags.has("ccip");
  emit({ step: "seed", status: "started", title: "Flow A conserved traffic (Testnet simulation)", detail: { amount: amount.toString() } });
  if (both || args.flags.has("weakbridge")) await weakBridgeRoundTrip(ctx, emit, amount);
  if (both || args.flags.has("ccip")) {
    if (ctx.net.name === "local") {
      emit({ step: "ccip", status: "skipped", title: "no CCIP Router on Anvil" });
    } else {
      // Round trip (PRD section 17 scenario 1): home -> arb fills the home ERC20LockBox, then the Flow A leg
      // arb -> home releases from it. Each leg is a real CCIP message through the KirchhoffTokenPools.
      await ensureDeployerKeth(ctx, amount);
      const out = await ccipTransfer(ctx, emit, "home", "arb", amount);
      if (out.execution?.state !== "SUCCESS") throw new Error(`home -> arb leg not executed (${out.execution?.state ?? "pending"}); Flow A needs its lockbox liquidity`);
      await ccipTransfer(ctx, emit, "arb", "home", amount);
    }
  }
  emit({ step: "seed", status: "ok", title: "seed complete" });
}

main(run);
