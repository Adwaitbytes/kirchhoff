/**
 * demo/seed.ts (TESTNET SIMULATION): the Flow A "normal, conserved" traffic the demo opens on. A WeakBridge round
 * trip (home -> arb -> home) with matching debits and credits that the Junction Rule accepts, plus (testnet only) a
 * real CCIP token transfer Arbitrum Sepolia -> Ethereum Sepolia through our KirchhoffTokenPool lanes, native fees.
 *
 *   pnpm --filter @kirchhoff/demo seed --network local|testnet [--amount <wholeKETH>]
 */
import { parseEventLogs, type Address } from "viem";
import { erc20Abi, kethAbi, routerAbi } from "./src/abi.ts";
import { account, read, send } from "./src/chain.ts";
import { main, parseArgs } from "./src/cli.ts";
import { loadContext, tokenOf, type Context } from "./src/context.ts";
import { approveToken, weakBridgeCredit, weakBridgeSend } from "./src/bridge.ts";
import { ccipMessageUrl, type ChainRole } from "./src/networks.ts";
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

/** A real CCIP token transfer through the Router (testnet only; native fee). Best effort on a small budget. */
async function ccipTransfer(ctx: Context, emit: (e: Omit<StepEvent, "label" | "network" | "at">) => StepEvent, amount: bigint): Promise<void> {
  if (ctx.net.name !== "testnet") {
    emit({ step: "seed-ccip", status: "skipped", title: "CCIP transfer skipped on local (no real Router)" });
    return;
  }
  const from: ChainRole = "arb";
  const chain = ctx.chains[from];
  const router = chain.config.ccip?.router;
  if (router === undefined) throw new Error("no CCIP router for arb");
  const deployer = account("DEPLOYER");
  const token = tokenOf(ctx, from);
  const have = await read<bigint>(chain, { to: token, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] });
  if (have < amount) {
    emit({ step: "seed-ccip", status: "skipped", title: `deployer holds ${have} kETH on arb, need ${amount}` });
    return;
  }
  const message = {
    receiver: `0x${deployer.address.slice(2).padStart(64, "0")}`,
    data: "0x" as const,
    tokenAmounts: [{ token, amount }],
    feeToken: "0x0000000000000000000000000000000000000000" as Address,
    extraArgs: "0x" as const,
  };
  const fee = await read<bigint>(chain, { to: router, abi: routerAbi, functionName: "getFee", args: [ctx.net.chains.home.selector, message] });
  await approveToken(ctx, from, deployer, router, amount);
  emit({ step: "seed-ccip", status: "started", chain: "arb", title: `CCIP arb -> home ${amount} (fee ${fee} wei native)` });
  const sent = await send(chain, deployer, { to: router, abi: routerAbi, functionName: "ccipSend", args: [ctx.net.chains.home.selector, message], value: fee }, "ccipSend arb -> home");
  const msg = parseEventLogs({ abi: routerAbi, logs: sent.receipt.logs, eventName: "CCIPMessageSent" })[0];
  const messageId = msg?.args.messageId ?? "0x0";
  emit({ step: "seed-ccip", status: "ok", chain: "arb", title: "CCIP message sent (Flow A)", txHash: sent.hash, explorerUrl: sent.url, detail: { messageId, ccip: ccipMessageUrl(messageId) } });
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), { options: ["amount"], flags: [] });
  const ctx = await loadContext(args.network);
  const emit = stepEmitter(ctx.net.name);
  const whole = BigInt(args.options.get("amount") ?? "10");
  const amount = whole * 10n ** 18n;
  emit({ step: "seed", status: "started", title: "Flow A conserved traffic (Testnet simulation)", detail: { amount: amount.toString() } });
  await weakBridgeRoundTrip(ctx, emit, amount);
  await ccipTransfer(ctx, emit, amount).catch((e: unknown) => {
    emit({ step: "seed-ccip", status: "failed", title: "CCIP transfer failed (non-fatal)", revertReason: e instanceof Error ? e.message : String(e) });
  });
  emit({ step: "seed", status: "ok", title: "seed complete" });
}

main(run);
