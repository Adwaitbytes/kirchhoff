/**
 * demo/e2e.ts (TESTNET SIMULATION): the end-to-end Kelp Replay harness (PRD section 17 e2e row).
 *
 *   pnpm --filter @kirchhoff/demo e2e --network local|testnet [--reports cre|direct] [--no-reset]
 *
 * 1. Deployment check (testnet: strict-minimum gas for the attacker).
 * 2. W2 baseline epoch (CONSERVED on all three ledgers).
 * 3. Forged WeakBridge credit: 116,500 kETH released to the attacker with no debit.
 * 4. W1 on the forged Released log (BREACH DEBIT_NOT_FOUND to 3 chains in one run), W3 on BreachRecorded
 *    (QUARANTINE_APPLIED); asserts BREACH, active incident, frozen lanes and attacker taint on every ledger.
 * 5. Refusals, each a mined reverted tx: CCIP (testnet: real Router.ccipSend; Anvil: lockOrBurn via an OnRamp
 *    stand-in), home kETH transfer (KirchhoffGuard), borrow (CollateralBroken). Judge-replay hook payload.
 * 6. W2 epoch after the attack: asserts LOOP_DEFICIT with delta exactly -116,500 kETH.
 * 7. Reset (issuer Safe resolve, untaint, rebalance, recovery timelock, W2 RECOVERY_CHECK) back to CONSERVED;
 *    asserts < 3 min on Anvil, records the time on testnets (bounded by chain finality there).
 *
 * Reports go through `cre workflow simulate --broadcast` by default; `--reports direct` writes the same engine-encoded
 * reports through each chain's MockKeystoneForwarder (fallback only). Exits non-zero on any failure.
 */
import { Status } from "@kirchhoff/engine";
import { keccak256, toHex } from "viem";
import { ledgerAbi, quarantineAbi } from "./src/abi.ts";
import { fundIfBelow, hasCode, read } from "./src/chain.ts";
import { account } from "./src/chain.ts";
import { main, parseArgs, reportMode } from "./src/cli.ts";
import { loadContext, type Context } from "./src/context.ts";
import { log, stepEmitter } from "./src/events.ts";
import { attemptRefusals, baselineEpoch, deficitEpoch, driveContainment, forgeRelease, hookPayload, refusalBlock, type Emit } from "./src/attack.ts";
import { ledgerStatus, resetAll } from "./src/reset.ts";
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

async function assertAll(ctx: Context, expected: number, what: string): Promise<void> {
  for (const role of ROLES) {
    const [status] = await read<[number, bigint, bigint, boolean]>(ctx.chains[role], { to: ctx.at(role, "conservationLedger"), abi: ledgerAbi, functionName: "statusOf", args: [ctx.tokenId] });
    assert(status === expected, `${what}: ${role} status ${status}, expected ${expected}`);
  }
}

async function anyContained(ctx: Context): Promise<boolean> {
  for (const role of ROLES) {
    const s = await ledgerStatus(ctx, role);
    if (s.status === Status.BROKEN || s.status === Status.QUARANTINED || s.status === Status.RECOVERING || s.frozen) return true;
  }
  return false;
}

const BREACH_RECORDED = keccak256(toHex("BreachRecorded(bytes32,uint16,bytes32,uint64,bytes32,address,uint256)"));

/**
 * Detection latency on the home ledger, block time to block time: forged release -> first BreachRecorded (W1, the
 * Junction Rule) and -> last BreachRecorded (W2's LOOP_DEFICIT, the Loop Rule).
 */
async function detectionLatency(ctx: Context, releaseBlock: bigint): Promise<{ junctionSeconds: number; loopSeconds: number; junctionTx: string; loopTx: string }> {
  const home = ctx.chains.home.client;
  const logs = (await home.getLogs({ address: ctx.at("home", "conservationLedger"), fromBlock: releaseBlock, toBlock: "latest" })).filter((l) => l.topics[0]?.toLowerCase() === BREACH_RECORDED);
  const first = logs[0];
  const last = logs.at(-1);
  if (first === undefined || last === undefined) throw new AssertionError("no BreachRecorded after the attack");
  const at = async (n: bigint): Promise<bigint> => (await home.getBlock({ blockNumber: n })).timestamp;
  const t0 = await at(releaseBlock);
  return { junctionSeconds: Number((await at(first.blockNumber)) - t0), loopSeconds: Number((await at(last.blockNumber)) - t0), junctionTx: first.transactionHash, loopTx: last.transactionHash };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), { options: ["reports"], flags: ["no-reset"] });
  const mode = reportMode(args);
  const ctx = await loadContext(args.network);
  const emit = stepEmitter(ctx.net.name);
  const attacker = account("ATTACKER").address;
  const started = Date.now();
  emit({ step: "e2e", status: "started", title: "Kelp Replay end-to-end", detail: { network: ctx.net.name, reports: mode } });

  await checkDeployment(ctx, emit);
  if (ctx.net.name === "testnet") {
    // Strict minimum for the attacker's home txs at the 1.3 gwei cap. Peak need is the real ccipSend: a 600k gas limit
    // reserved (0.00078 ETH) plus the native CCIP fee as msg.value (~0.0002 ETH, refunded when it reverts). The other
    // txs (forged credit ~150k, approve ~46k, two reverts, return transfer ~40k) fit in what remains.
    const funded = await fundIfBelow(ctx.chains.home, attacker, 1_100_000_000_000_000n, 1_200_000_000_000_000n, "attacker on home");
    if (funded !== null) emit({ step: "fund", status: "ok", chain: "home", title: "attacker funded to 0.0012 ETH", txHash: funded.hash, explorerUrl: funded.url });
  }
  const timings: Record<string, number> = {};
  let mark = Date.now();
  const lap = (name: string): void => {
    timings[name] = Math.round((Date.now() - mark) / 100) / 10;
    mark = Date.now();
  };

  // W2 baseline epoch, then the attack and the Conservation Engine (W1 on the forged Released, W3 on BreachRecorded).
  // A previous interrupted run can leave an incident open; recover it first so every run starts from a clean circuit.
  if (await anyContained(ctx)) {
    log("ledgers start contained from an earlier run; resetting before the baseline");
    await resetAll(ctx, emit, mode);
  }
  await baselineEpoch(ctx, emit, mode);
  await assertAll(ctx, Status.CONSERVED, "baseline CONSERVED");
  lap("baselineSeconds");
  const release = await forgeRelease(ctx, emit);
  await driveContainment(ctx, emit, mode, release);
  lap("attackAndContainmentSeconds");

  // Assertions: BREACH + incident on all three ledgers.
  await assertContained(ctx, release.incidentId, attacker, emit);

  // Attacker's three onward moves must all be refused.
  const refusals = await attemptRefusals(ctx, emit, true);
  assert(refusals.ccip.hash !== null, "CCIP refusal was not mined onchain");
  assert(/SenderTainted|AccountTainted|LaneFrozen|TokenNotConserved/.test(refusals.ccip.reason), `CCIP refusal reason unexpected: ${refusals.ccip.reason}`);
  if (refusals.ccipPool !== null) assert(/TokenNotConserved|LaneFrozen/.test(refusals.ccipPool.reason), `pool refusal reason unexpected: ${refusals.ccipPool.reason}`);
  assert(/SenderTainted/i.test(refusals.guard.reason), `Guard refusal reason unexpected: ${refusals.guard.reason}`);
  assert(/CollateralBroken/i.test(refusals.borrow.reason), `borrow refusal reason unexpected: ${refusals.borrow.reason}`);
  emit({ step: "assert-refusals", status: "ok", title: "every onward move refused", detail: { ccip: refusals.ccip.reason, guard: refusals.guard.reason, borrow: refusals.borrow.reason } });

  // W2's next epoch confirms the Loop Rule deficit; the incident stays the active one.
  const loop = await deficitEpoch(ctx, emit, mode, release);
  const delta = /delta=(-?\d+)/.exec(loop)?.[1];
  assert(delta !== undefined && BigInt(delta) === -release.amount, `W2 Loop Rule delta ${delta ?? "missing"}, expected ${-release.amount}`);
  emit({ step: "assert-delta", status: "ok", title: `Loop Rule delta = -${release.amount / 10n ** 18n} kETH`, detail: { delta: delta ?? null } });
  const latency = await detectionLatency(ctx, release.tx.receipt.blockNumber);
  emit({ step: "latency", status: "ok", chain: "home", title: `attack -> BROKEN onchain: Junction ${latency.junctionSeconds}s, Loop ${latency.loopSeconds}s`, detail: latency });
  await assertContained(ctx, release.incidentId, attacker, emit);
  lap("refusalsAndDeficitSeconds");

  const payload = hookPayload(ctx, release, await refusalBlock(ctx, refusals.ccipPool ?? refusals.ccip));
  emit({ step: "judge-replay-payload", status: "ok", title: "policy-hook payload produced", detail: { messageId: String(payload.message_id) } });

  // Reset.
  if (!args.flags.has("no-reset")) {
    const elapsedMs = await resetAll(ctx, emit, mode);
    // The 3-minute target holds on Anvil. On testnets the CRE RECOVERY_CHECK must wait for every chain's finality
    // (Sepolia ~15 min, L2s follow L1), so the time is recorded, not asserted.
    if (ctx.net.name === "local") assert(elapsedMs < 180_000, `reset took ${elapsedMs}ms, over the 3-minute target`);
    lap("resetSeconds");
  }

  emit({ step: "e2e", status: "ok", title: "Kelp Replay end-to-end PASSED", detail: { ...timings, totalSeconds: Math.round((Date.now() - started) / 100) / 10 } });
  log("e2e PASSED");
}

main(run);
