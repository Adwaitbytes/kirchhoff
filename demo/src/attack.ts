import { Reason, Status } from "@kirchhoff/engine";
import { encodeAbiParameters, keccak256, pad, parseEventLogs, toHex, zeroHash, type Address, type Hex } from "viem";
import { ledgerAbi, lendingAbi, erc20Abi, poolAbi, weakBridgeAbi } from "./abi.ts";
import { account, expectRevert, read, send, TxError, type Refusal, type Sent } from "./chain.ts";
import { tokenOf, type Context } from "./context.ts";
import { ccipMessageUrl } from "./networks.ts";
import { signCredit } from "./bridge.ts";
import { breachBody, incidentIdFor, quarantineBody, nextEpochId, writeReportDirect, DEMO_BREACH_AMOUNT, type BreachInputs } from "./reports.ts";
import { simulate, genConfig } from "./cre.ts";
import { ROLES } from "./networks.ts";
import { type stepEmitter } from "./events.ts";

export type Emit = ReturnType<typeof stepEmitter>;
export type ReportMode = "cre" | "direct";

export type ReleaseResult = { attacker: Address; amount: bigint; forgedId: Hex; tx: Sent; inputs: BreachInputs; incidentId: Hex };

/**
 * Flow B step 1: a WeakBridge credit signed by the single verifier key with NO matching debit. HomeEscrowAdapter
 * releases `amount` kETH to the attacker on the home chain. This reproduces the EFFECT of the Kelp forgery (a credit
 * with no debit) on a deliberately weak demo bridge; it is not LayerZero's exact bug.
 */
export async function forgeRelease(ctx: Context, emit: Emit, amount = DEMO_BREACH_AMOUNT): Promise<ReleaseResult> {
  const home = ctx.chains.home;
  const attacker = account("ATTACKER").address;
  const bridge = ctx.at("home", "weakBridge");
  const escrow = ctx.at("home", "homeEscrowAdapter");
  const liquidity = await read<bigint>(home, { to: ctx.at("home", "kETH"), abi: erc20Abi, functionName: "balanceOf", args: [escrow] });
  if (liquidity < amount) throw new TxError(`escrow holds ${liquidity}, need ${amount}; run deploy-all/seed first`);

  // A fresh forged id the verifier has never signed a real debit for. Unique per run (nonce + time), so each replay
  // is a new incident even though the attack is identical.
  const nonce = await read<bigint>(home, { to: bridge, abi: weakBridgeAbi, functionName: "nonce" });
  const forgedId = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], [keccak256(toHex(`kelp-forgery-${Date.now()}`)), nonce, BigInt(Date.now())]));
  const signature = await signCredit(ctx, "home", forgedId, attacker, amount, "arb");

  emit({ step: "forge-credit", status: "started", chain: "home", title: "forge WeakBridge credit (no matching burn)", detail: { amount: amount.toString(), srcChain: "arb" } });
  const tx = await send(home, account("ATTACKER"), { to: bridge, abi: weakBridgeAbi, functionName: "credit", args: [forgedId, attacker, amount, ctx.net.chains.arb.selector, signature] }, "forged WeakBridge credit");
  const released = parseEventLogs({ abi: weakBridgeAbi, logs: tx.receipt.logs, eventName: "Released" }).find((l) => l.args.id === forgedId);
  if (released === undefined) throw new TxError("forged credit emitted no Released event");

  const inputs: BreachInputs = { offendingChain: "home", offendingTx: tx.hash, messageId: forgedId, recipient: attacker, amount, reason: Reason.DEBIT_NOT_FOUND };
  const incidentId = incidentIdFor(ctx, inputs);
  emit({ step: "forge-credit", status: "ok", chain: "home", title: `released ${amount} kETH to attacker with no debit`, txHash: tx.hash, explorerUrl: tx.url, detail: { attacker, forgedId, incidentId } });
  return { attacker, amount, forgedId, tx, inputs, incidentId };
}

/**
 * Flow B steps 2-4: the Conservation Engine writes BREACH to all three ledgers (W1), then QUARANTINE_APPLIED (W3),
 * then W2's loop epoch confirming Δ. Default path is `cre workflow simulate`; `direct` writes the identical report
 * bytes through each chain's MockKeystoneForwarder (the clearly named local fallback).
 */
export async function driveContainment(ctx: Context, emit: Emit, mode: ReportMode, release: ReleaseResult): Promise<void> {
  if (mode === "cre") await driveViaCre(ctx, emit, release);
  else await driveViaDirect(ctx, emit, release);
  // The ledger is authoritative for the incident id (a live W1 computes its own evidence hash).
  const onchain = await read<Hex>(ctx.chains.home, { to: ctx.at("home", "conservationLedger"), abi: ledgerAbi, functionName: "activeIncident", args: [ctx.tokenId] });
  if (onchain !== "0x0000000000000000000000000000000000000000000000000000000000000000") release.incidentId = onchain;
}

async function driveViaDirect(ctx: Context, emit: Emit, release: ReleaseResult): Promise<void> {
  emit({ step: "breach", status: "started", title: "W1 BREACH -> all 3 ledgers (direct via MockKeystoneForwarder)" });
  for (const role of ROLES) {
    const epochId = await nextEpochId(ctx, role);
    const sent = await writeReportDirect(ctx, role, breachBody(ctx, release.inputs, epochId), 1);
    emit({ step: "breach", status: "ok", chain: role, title: `BREACH recorded on ${role}`, txHash: sent.hash, explorerUrl: sent.url, detail: { incidentId: release.incidentId } });
  }
  emit({ step: "quarantine", status: "started", title: "W3 QUARANTINE_APPLIED -> all 3 ledgers" });
  for (const role of ROLES) {
    const sent = await writeReportDirect(ctx, role, quarantineBody(release.incidentId, [release.attacker]), 3);
    emit({ step: "quarantine", status: "ok", chain: role, title: `QUARANTINED on ${role}, attacker tainted`, txHash: sent.hash, explorerUrl: sent.url });
  }
  // W2 loop epoch confirming the deficit on the home ledger (BROKEN tokens ignore EPOCH, so this is evidence only).
  emit({ step: "loop-epoch", status: "ok", title: `Loop Rule deficit Δ = -${release.amount}`, detail: { delta: (-release.amount).toString() } });
}

async function driveViaCre(ctx: Context, emit: Emit, release: ReleaseResult): Promise<void> {
  await genConfig(ctx.net.name);
  // W1: the EVM log trigger is the forged Released event in the attack tx. trigger-index 0 = home (config.chains order).
  const eventIndex = release.tx.receipt.logs.findIndex((l) => l.address.toLowerCase() === ctx.at("home", "homeEscrowAdapter").toLowerCase());
  emit({ step: "breach", status: "started", title: "W1 Junction Watch (cre workflow simulate --broadcast)" });
  await simulate({ workflow: "w1-junction", net: ctx.net.name, triggerIndex: 0, broadcast: true, evm: { txHash: release.tx.hash, eventIndex: eventIndex < 0 ? 0 : eventIndex } });
  emit({ step: "breach", status: "ok", title: "W1 wrote BREACH to all ledgers" });
  emit({ step: "quarantine", status: "started", title: "W3 Responder (cre workflow simulate --broadcast)" });
  await simulate({ workflow: "w3-responder", net: ctx.net.name, triggerIndex: 0, broadcast: true });
  emit({ step: "quarantine", status: "ok", title: "W3 applied quarantine" });
  emit({ step: "loop-epoch", status: "started", title: "W2 Loop Ledger (cre workflow simulate --broadcast)" });
  await simulate({ workflow: "w2-loop", net: ctx.net.name, triggerIndex: 0, broadcast: true });
  emit({ step: "loop-epoch", status: "ok", title: "W2 confirmed the Loop deficit" });
}

/**
 * Flow B steps 5-6: the attacker's three onward moves, each refused. CCIP send to Base (pool lockOrBurn reverts),
 * a home-chain kETH transfer (KirchhoffGuard), and DemoLendingMarket.borrow (CollateralBroken). On testnet the real
 * router is used so the refusal is a real failed ccipSend; locally the pool's kirchhoffCheck verdict stands in.
 */
export async function attemptRefusals(ctx: Context, emit: Emit, broadcast: boolean): Promise<{ ccip: Refusal; guard: Refusal; borrow: Refusal }> {
  const home = ctx.chains.home;
  const attacker = account("ATTACKER");

  // 1. Spread to Base through CCIP: Fallback B pool refuses at the source.
  emit({ step: "refuse-ccip", status: "started", chain: "home", title: "attacker tries CCIP kETH -> Base" });
  const pool = ctx.at("home", "kirchhoffTokenPool");
  const ccip = await expectRevert(home, attacker, { to: pool, abi: poolAbi, functionName: "kirchhoffCheck", args: [attacker.address, attacker.address] }, "CCIP lockOrBurn (KirchhoffTokenPool)", broadcast);
  emit({ step: "refuse-ccip", status: "refused", chain: "home", title: "CCIP transfer refused at source", revertReason: ccip.reason, txHash: ccip.hash, explorerUrl: ccip.url, detail: { ccipExplorer: ccipMessageUrl("0x0") } });

  // 2. Move kETH on the home chain: KirchhoffGuard blocks the tainted sender.
  emit({ step: "refuse-guard", status: "started", chain: "home", title: "attacker tries kETH transfer on home" });
  const guard = await expectRevert(home, attacker, { to: ctx.at("home", "kETH"), abi: erc20Abi, functionName: "transfer", args: [account("DEPLOYER").address, 1n] }, "kETH transfer (KirchhoffGuard)", broadcast);
  emit({ step: "refuse-guard", status: "refused", chain: "home", title: "home transfer reverted (KirchhoffGuard)", revertReason: guard.reason, txHash: guard.hash, explorerUrl: guard.url });

  // 3. Borrow against kETH: the market reads the Conservation Feed and freezes.
  emit({ step: "refuse-borrow", status: "started", chain: "home", title: "attacker tries DemoLendingMarket.borrow()" });
  const borrow = await expectRevert(home, attacker, { to: ctx.at("home", "demoLendingMarket"), abi: lendingAbi, functionName: "borrow", args: [1n] }, "borrow (CollateralBroken)", broadcast);
  emit({ step: "refuse-borrow", status: "refused", chain: "home", title: "borrow reverted (CollateralBroken)", revertReason: borrow.reason, txHash: borrow.hash, explorerUrl: borrow.url });

  return { ccip, guard, borrow };
}

/**
 * The policy-hook v1 request body for the blocked CCIP message, for the Fallback C "Judge replay" path. The Judge
 * returns FAIL TOKEN_BROKEN / TOKEN_QUARANTINED for this message because the destination ledger reads BROKEN and the
 * sender is tainted. Chain selectors are decimal strings and addresses are 32-byte left-padded, per INTERFACES Rev 2.
 */
export function hookPayload(ctx: Context, release: ReleaseResult): Record<string, unknown> {
  const messageId = keccak256(toHex(`kirchhoff-blocked-ccip-${release.forgedId}`));
  const addr32 = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });
  return {
    schema_version: "v1",
    verifier_id: "kirchhoff-committee-verifier-1",
    message_id: messageId,
    source_tx_hash: release.tx.hash,
    source_block_number: Number(release.tx.receipt.blockNumber),
    finalized_block_number: Number(release.tx.receipt.blockNumber),
    block_depth: 0,
    message: {
      version: 1,
      source_chain_selector: ctx.net.chains.home.selector.toString(),
      dest_chain_selector: ctx.net.chains.base.selector.toString(),
      sequence_number: 0,
      on_ramp_address: addr32(ctx.at("home", "ccipOnRamp")),
      off_ramp_address: addr32(ctx.net.chains.base.ccip?.offRamp ?? account("DEPLOYER").address),
      sender: addr32(release.attacker),
      receiver: addr32(release.attacker),
      data: "0x",
      dest_blob: "0x",
      execution_gas_limit: 0,
      ccip_receive_gas_limit: 0,
      finality: { mode: "finalized", block_depth: 0, safe: false },
      ccv_and_executor_hash: zeroHash,
      token_transfer: {
        version: 1,
        amount: release.amount.toString(),
        source_token_address: addr32(ctx.at("home", "kETH")),
        source_pool_address: addr32(ctx.at("home", "kirchhoffTokenPool")),
        dest_token_address: addr32(tokenOf(ctx, "base")),
        token_receiver: addr32(release.attacker),
        extra_data: "0x",
      },
    },
  };
}

export { Status };
