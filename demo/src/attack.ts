import { Reason, Status } from "@kirchhoff/engine";
import { encodeAbiParameters, keccak256, pad, parseEventLogs, toHex, zeroAddress, zeroHash, type Address, type Hex, type TransactionReceipt } from "viem";
import { kethAbi, ledgerAbi, lendingAbi, localRouterAbi, erc20Abi, poolAbi, routerAbi, weakBridgeAbi } from "./abi.ts";
import { approveToken } from "./bridge.ts";
import { account, expectRevert, fundIfBelow, read, send, TxError, type Refusal, type Sent } from "./chain.ts";
import { tokenOf, type Context } from "./context.ts";
import { txUrl } from "./networks.ts";
import { signCredit } from "./bridge.ts";
import { breachBody, epochBody, incidentIdFor, quarantineBody, nextEpochId, writeReportDirect, DEMO_BREACH_AMOUNT, type BreachInputs } from "./reports.ts";
import { w1TriggerIndex } from "./cre.ts";
import { runWorkflow, settle, waitFinalizedPast, type WorkflowRun } from "./engine-run.ts";
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
  emit({ step: "forge-credit", status: "ok", chain: "home", title: `released ${(amount / 10n ** 18n).toLocaleString("en-US")} kETH to attacker with no debit`, txHash: tx.hash, explorerUrl: tx.url, detail: { attacker, forgedId, incidentId } });
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
  emit({ step: "quarantine", status: "started", title: "W3 QUARANTINE_APPLIED -> all 3 ledgers (direct)" });
  for (const role of ROLES) {
    const sent = await writeReportDirect(ctx, role, quarantineBody(release.incidentId, [release.attacker]), 3);
    emit({ step: "quarantine", status: "ok", chain: role, title: `QUARANTINED on ${role}, attacker tainted`, txHash: sent.hash, explorerUrl: sent.url });
  }
}

/** 0-based index of the first log in a receipt from `emitter` with `topic0` (what `--evm-event-index` wants). */
function logIndex(receipt: TransactionReceipt, emitter: Address, topic0: Hex): number {
  const i = receipt.logs.findIndex((l) => l.address.toLowerCase() === emitter.toLowerCase() && l.topics[0]?.toLowerCase() === topic0.toLowerCase());
  if (i === -1) throw new TxError(`receipt ${receipt.transactionHash} has no ${topic0} log from ${emitter}`);
  return i;
}

const RELEASED_TOPIC = keccak256(toHex("Released(bytes32,address,uint256,uint64)"));
const BREACH_RECORDED_TOPIC = keccak256(toHex("BreachRecorded(bytes32,uint16,bytes32,uint64,bytes32,address,uint256)"));

async function driveViaCre(ctx: Context, emit: Emit, release: ReleaseResult): Promise<void> {
  const net = ctx.net.name;
  // W1 and W3 pin the credit block / read at latest, so only Anvil needs mining here (no testnet finality wait).
  if (ctx.net.name === "local") await settle(ctx);
  // The forged credit claims Arbitrum as its source: W1 can prove the debit missing once that chain is final past it.
  const creditTime = (await ctx.chains.home.client.getBlock({ blockNumber: release.tx.receipt.blockNumber })).timestamp;
  await waitFinalizedPast(ctx, "arb", creditTime);
  // W1 on the forged Released log the HomeEscrowAdapter emitted in the attack tx.
  emit({ step: "breach", status: "started", title: "W1 Junction Watch: cre workflow simulate --broadcast" });
  const w1run = await runWorkflow(ctx, "w1-junction", w1TriggerIndex(net, ctx.net.chains.home), {
    txHash: release.tx.hash,
    eventIndex: logIndex(release.tx.receipt, ctx.at("home", "homeEscrowAdapter"), RELEASED_TOPIC),
  });
  const w1 = w1run.result;
  emitWrites(emit, "breach", w1run);
  if (!new RegExp(`status=${Status.BROKEN} reason=${Reason.DEBIT_NOT_FOUND} writes=3`).test(w1.result ?? "")) {
    throw new TxError(`W1 did not write BREACH DEBIT_NOT_FOUND to 3 chains: ${w1.result ?? ""}`);
  }
  emit({ step: "breach", status: "ok", title: "W1 wrote BREACH (DEBIT_NOT_FOUND) to all 3 ledgers in one run", detail: { result: w1.result } });

  // W3 on the BreachRecorded that W1's BREACH emitted on the home ledger.
  const home = ctx.chains.home;
  const ledger = ctx.at("home", "conservationLedger");
  const logs = await home.client.getLogs({ address: ledger, fromBlock: release.tx.receipt.blockNumber, toBlock: "latest" });
  const breachLog = logs.filter((l) => l.topics[0]?.toLowerCase() === BREACH_RECORDED_TOPIC).at(-1);
  if (breachLog?.transactionHash == null) throw new TxError("no BreachRecorded on the home ledger after W1");
  const breachReceipt = await home.client.getTransactionReceipt({ hash: breachLog.transactionHash });
  emit({ step: "breach", status: "ok", chain: "home", title: "BreachRecorded on home", txHash: breachLog.transactionHash, explorerUrl: txUrl(home.config, breachLog.transactionHash) });
  if (ctx.net.name === "local") await settle(ctx);
  emit({ step: "quarantine", status: "started", title: "W3 Responder: cre workflow simulate --broadcast" });
  const w3run = await runWorkflow(ctx, "w3-responder", 0, { txHash: breachLog.transactionHash, eventIndex: logIndex(breachReceipt, ledger, BREACH_RECORDED_TOPIC) });
  const w3 = w3run.result;
  emitWrites(emit, "quarantine", w3run);
  if (!(w3.result ?? "").includes("quarantined on 3 chain")) throw new TxError(`W3 did not quarantine 3 chains: ${w3.result ?? ""}`);
  emit({ step: "quarantine", status: "ok", title: "W3 applied QUARANTINE_APPLIED on all 3 ledgers", detail: { result: w3.result } });
}

/**
 * The W2 epoch that opens every run: UNKNOWN or CONSERVED ledgers get a fresh CONSERVED EPOCH (Δ = 0) before the
 * attack. Direct mode writes the same EPOCH through the mock forwarder.
 */
/** One step event per ledger write a workflow run made, with its explorer link. */
export function emitWrites(emit: Emit, step: string, run: WorkflowRun): void {
  for (const w of run.writes) emit({ step, status: "ok", chain: w.role, title: `${w.report} written on ${w.role} by CRE`, txHash: w.txHash, explorerUrl: w.url });
}

export async function baselineEpoch(ctx: Context, emit: Emit, mode: ReportMode): Promise<void> {
  emit({ step: "baseline-epoch", status: "started", title: "W2 baseline epoch" });
  if (mode === "cre") {
    // W2 reads the latest finalized pin; on testnets that is whatever is final now, no wait needed for a baseline.
    if (ctx.net.name === "local") await settle(ctx);
    const w2 = await runWorkflow(ctx, "w2-loop", 0);
    emitWrites(emit, "baseline-epoch", w2);
    emit({ step: "baseline-epoch", status: "ok", title: "W2 baseline epoch: CONSERVED", detail: { result: w2.result.result } });
    return;
  }
  for (const role of ROLES) {
    const sent = await writeReportDirect(ctx, role, epochBody(ctx, await nextEpochId(ctx, role), 0n, Status.CONSERVED, Reason.OK), 1);
    emit({ step: "baseline-epoch", status: "ok", chain: role, title: `EPOCH CONSERVED on ${role}`, txHash: sent.hash, explorerUrl: sent.url });
  }
}

/** W2's next epoch after the attack: confirms the Loop Rule deficit (Δ = -amount, LOOP_DEFICIT). */
export async function deficitEpoch(ctx: Context, emit: Emit, mode: ReportMode, release: ReleaseResult): Promise<string> {
  emit({ step: "loop-epoch", status: "started", title: "W2 Loop Ledger epoch after the attack" });
  if (mode === "direct") {
    emit({ step: "loop-epoch", status: "ok", title: `Loop Rule deficit Δ = -${release.amount} (direct mode: not re-written, ledgers are contained)` });
    return `delta=-${release.amount}`;
  }
  // W2 pins finalized blocks: the forged release must be final on home before the loop can see the deficit.
  await settle(ctx, ["home"]);
  const w2 = await runWorkflow(ctx, "w2-loop", 0);
  emitWrites(emit, "loop-epoch", w2);
  const result = w2.result.result ?? "";
  if (!new RegExp(`reason=${Reason.LOOP_DEFICIT}`).test(result)) throw new TxError(`W2 did not report LOOP_DEFICIT: ${result}`);
  emit({ step: "loop-epoch", status: "ok", title: `W2 confirmed LOOP_DEFICIT`, detail: { result, expectedDelta: (-release.amount).toString() } });
  return result;
}

export type Refusals = {
  /** The attacker's own CCIP attempt (mined, reverted). */
  ccip: Refusal;
  /** Testnet: an untainted holder's CCIP attempt during the incident, reverting inside KirchhoffTokenPool. */
  ccipPool: Refusal | null;
  guard: Refusal;
  borrow: Refusal;
};

const CCIP_PROBE_AMOUNT = 10n ** 18n;

function ccipMessage(token: Address, receiver: Address, amount: bigint): {
  receiver: Hex;
  data: Hex;
  tokenAmounts: { token: Address; amount: bigint }[];
  feeToken: Address;
  extraArgs: Hex;
} {
  return { receiver: pad(receiver, { size: 32 }), data: "0x", tokenAmounts: [{ token, amount }], feeToken: zeroAddress, extraArgs: "0x" };
}

/** Native fee for a kETH message; falls back to a fixed ceiling when the quote itself reverts during an incident. */
async function nativeFee(ctx: Context, router: Address, message: ReturnType<typeof ccipMessage>): Promise<bigint> {
  try {
    return await read<bigint>(ctx.chains.home, { to: router, abi: routerAbi, functionName: "getFee", args: [ctx.net.chains.base.selector, message] });
  } catch {
    return 2_000_000_000_000_000n;
  }
}

/**
 * Flow B steps 5-6: the attacker's onward moves, each refused by a MINED, reverted transaction (explorer evidence).
 * - CCIP to Base. Testnet: a real Router.ccipSend with a native fee and an explicit gas limit. Router 1.2.0 pulls the
 *   tokens from the sender before it reaches the OnRamp, so the tainted attacker is stopped by KirchhoffGuard
 *   (SenderTainted) one step before the pool; an untainted holder's ccipSend in the same incident then reverts inside
 *   KirchhoffTokenPool (TokenNotConserved), the Fallback B lane freeze. Anvil has no CCIP Router: the deployer is
 *   registered as the OnRamp on the LocalRouterMock and calls pool.lockOrBurn for the attacker, which reverts inside
 *   the pool the same way.
 * - A home-chain kETH transfer (KirchhoffGuard) and DemoLendingMarket.borrow (CollateralBroken).
 */
export async function attemptRefusals(ctx: Context, emit: Emit, broadcast: boolean): Promise<Refusals> {
  const home = ctx.chains.home;
  const attacker = account("ATTACKER");
  const deployer = account("DEPLOYER");
  const keth = ctx.at("home", "kETH");
  const pool = ctx.at("home", "kirchhoffTokenPool");
  let ccip: Refusal;
  let ccipPool: Refusal | null = null;

  emit({ step: "refuse-ccip", status: "started", chain: "home", title: "attacker tries CCIP kETH -> Base" });
  const router = home.config.ccip?.router;
  if (router === undefined) {
    const localRouter = ctx.at("home", "ccipRouter");
    const onRamp = await read<Address>(home, { to: localRouter, abi: localRouterAbi, functionName: "getOnRamp", args: [ctx.net.chains.base.selector] });
    if (onRamp.toLowerCase() !== deployer.address.toLowerCase()) {
      await send(home, deployer, { to: localRouter, abi: localRouterAbi, functionName: "setOnRamp", args: [ctx.net.chains.base.selector, deployer.address] }, "register OnRamp stand-in (Anvil)");
    }
    const lockOrBurnIn = { receiver: pad(attacker.address, { size: 32 }), remoteChainSelector: ctx.net.chains.base.selector, originalSender: attacker.address, amount: CCIP_PROBE_AMOUNT, localToken: keth };
    ccip = await expectRevert(home, deployer, { to: pool, abi: poolAbi, functionName: "lockOrBurn", args: [lockOrBurnIn] }, "KirchhoffTokenPool.lockOrBurn for the attacker (OnRamp stand-in)", broadcast, 500_000n);
    emit({ step: "refuse-ccip", status: "refused", chain: "home", title: "CCIP lockOrBurn reverted inside KirchhoffTokenPool", revertReason: ccip.reason, txHash: ccip.hash, explorerUrl: ccip.url });
  } else {
    const message = ccipMessage(keth, attacker.address, CCIP_PROBE_AMOUNT);
    const fee = await nativeFee(ctx, router, message);
    // The attempt must be mined to leave explorer evidence, so the attacker needs the native fee plus gas for the
    // approve, the reverted ccipSend and the later Guard and borrow attempts (50% headroom on the live gas price).
    const gasPrice = await home.client.getGasPrice();
    const needed = fee + ((gasPrice * 3n) / 2n) * (600_000n + 3n * 150_000n);
    const topped = await fundIfBelow(home, attacker.address, needed, needed + needed / 5n, "attacker for the CCIP attempt");
    if (topped !== null) emit({ step: "fund", status: "ok", chain: "home", title: "attacker funded for the CCIP attempt", txHash: topped.hash, explorerUrl: topped.url });
    await approveToken(ctx, "home", attacker, router, CCIP_PROBE_AMOUNT);
    ccip = await expectRevert(home, attacker, { to: router, abi: routerAbi, functionName: "ccipSend", args: [ctx.net.chains.base.selector, message], value: fee }, "attacker Router.ccipSend kETH -> Base", true, 600_000n);
    emit({ step: "refuse-ccip", status: "refused", chain: "home", title: "attacker ccipSend reverted onchain (Router pulls tokens first: KirchhoffGuard)", revertReason: ccip.reason, txHash: ccip.hash, explorerUrl: ccip.url, detail: { nativeFee: fee.toString() } });

    // The pool's own refusal: an untainted holder during the incident (lanes frozen for everyone).
    const held = await read<bigint>(home, { to: keth, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] });
    if (held < CCIP_PROBE_AMOUNT) await send(home, deployer, { to: keth, abi: kethAbi, functionName: "mint", args: [deployer.address, CCIP_PROBE_AMOUNT - held] }, "mint 1 kETH to the treasury for the lane probe");
    await approveToken(ctx, "home", deployer, router, CCIP_PROBE_AMOUNT);
    const probe = ccipMessage(keth, deployer.address, CCIP_PROBE_AMOUNT);
    ccipPool = await expectRevert(home, deployer, { to: router, abi: routerAbi, functionName: "ccipSend", args: [ctx.net.chains.base.selector, probe], value: await nativeFee(ctx, router, probe) }, "treasury Router.ccipSend kETH -> Base during the incident", true, 600_000n);
    emit({ step: "refuse-ccip-pool", status: "refused", chain: "home", title: "ccipSend reverted inside KirchhoffTokenPool (lanes frozen)", revertReason: ccipPool.reason, txHash: ccipPool.hash, explorerUrl: ccipPool.url });
  }

  emit({ step: "refuse-guard", status: "started", chain: "home", title: "attacker tries kETH transfer on home" });
  const guard = await expectRevert(home, attacker, { to: keth, abi: erc20Abi, functionName: "transfer", args: [deployer.address, 1n] }, "kETH transfer (KirchhoffGuard)", broadcast);
  emit({ step: "refuse-guard", status: "refused", chain: "home", title: "home transfer reverted (KirchhoffGuard)", revertReason: guard.reason, txHash: guard.hash, explorerUrl: guard.url });

  emit({ step: "refuse-borrow", status: "started", chain: "home", title: "attacker tries DemoLendingMarket.borrow()" });
  const borrow = await expectRevert(home, attacker, { to: ctx.at("home", "demoLendingMarket"), abi: lendingAbi, functionName: "borrow", args: [1n] }, "borrow (CollateralBroken)", broadcast);
  emit({ step: "refuse-borrow", status: "refused", chain: "home", title: "borrow reverted (CollateralBroken)", revertReason: borrow.reason, txHash: borrow.hash, explorerUrl: borrow.url });

  return { ccip, ccipPool, guard, borrow };
}

/** The block of a mined refusal, for the hook payload. */
export async function refusalBlock(ctx: Context, refusal: Refusal): Promise<{ hash: Hex; blockNumber: bigint } | undefined> {
  if (refusal.hash === null) return undefined;
  const receipt = await ctx.chains.home.client.getTransactionReceipt({ hash: refusal.hash });
  return { hash: refusal.hash, blockNumber: receipt.blockNumber };
}

/**
 * The policy-hook v1 request body for the blocked CCIP message, for the Fallback C "Judge replay" path. The Judge
 * returns FAIL TOKEN_BROKEN / TOKEN_QUARANTINED for this message because the destination ledger reads BROKEN and the
 * sender is tainted. Chain selectors are decimal strings and addresses are 32-byte left-padded, per INTERFACES Rev 2.
 */
export function hookPayload(ctx: Context, release: ReleaseResult, refusedTx?: { hash: Hex; blockNumber: bigint }): Record<string, unknown> {
  const messageId = keccak256(toHex(`kirchhoff-blocked-ccip-${release.forgedId}`));
  const addr32 = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });
  return {
    schema_version: "v1",
    verifier_id: "kirchhoff-committee-verifier-1",
    message_id: messageId,
    // The refused ccipSend is the "message" under review when there is one; otherwise the forged release tx.
    source_tx_hash: refusedTx?.hash ?? release.tx.hash,
    source_block_number: Number(refusedTx?.blockNumber ?? release.tx.receipt.blockNumber),
    finalized_block_number: Number(refusedTx?.blockNumber ?? release.tx.receipt.blockNumber),
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
