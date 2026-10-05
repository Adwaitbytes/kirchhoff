import { keccak256, pad, parseEventLogs, toHex, zeroAddress, type Address, type Hex } from "viem";
import { erc20Abi, routerAbi } from "./abi.ts";
import { approveToken } from "./bridge.ts";
import { account, read, send, type Sent } from "./chain.ts";
import { tokenOf, type Context } from "./context.ts";
import { runWorkflow, type WorkflowRun } from "./engine-run.ts";
import { log, type stepEmitter } from "./events.ts";
import { ccipMessageUrl, txUrl, type ChainRole } from "./networks.ts";

type Emit = ReturnType<typeof stepEmitter>;

/** OffRamp 2.0.0 `ExecutionStateChanged(uint64 indexed, uint64 indexed, bytes32 indexed messageId, uint8 state, bytes)`. */
const EXECUTION_STATE_CHANGED = keccak256(toHex("ExecutionStateChanged(uint64,uint64,bytes32,uint8,bytes)"));
const STATE_NAME: Readonly<Record<number, string>> = { 0: "UNTOUCHED", 1: "IN_PROGRESS", 2: "SUCCESS", 3: "FAILURE" };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type CcipLeg = {
  from: ChainRole;
  to: ChainRole;
  amount: bigint;
  messageId: Hex;
  source: Sent;
  ccipExplorer: string;
  execution: { state: string; txHash: Hex; url: string | null } | null;
  freshnessRuns: WorkflowRun[];
};

/**
 * One real CCIP token transfer through the KirchhoffTokenPools (Router.ccipSend, native fee) with the PASS path:
 * the source pool needs a fresh CONSERVED/DRIFT status when it locks or burns, and the destination pool needs one
 * again when the CCIP executor calls releaseOrMint (spec staleness_seconds = 120). Simulation has no live W2 cron, so
 * this runs W2 right before the send and, once the source is close to final, every ~100 s until the destination
 * OffRamp reports the execution (at most `maxFreshness` runs, which bounds the spend).
 */
export async function ccipTransfer(ctx: Context, emit: Emit, from: ChainRole, to: ChainRole, amount: bigint, maxFreshness = 6): Promise<CcipLeg> {
  const source = ctx.chains[from];
  const dest = ctx.chains[to];
  const router = source.config.ccip?.router;
  const offRamp = dest.config.ccip?.offRamp;
  if (router === undefined || offRamp === undefined) throw new Error("CCIP transfers need the testnet Router and OffRamp (no CCIP on Anvil)");
  const deployer = account("DEPLOYER");
  const token = tokenOf(ctx, from);
  const held = await read<bigint>(source, { to: token, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] });
  if (held < amount) throw new Error(`deployer holds ${held} kETH on ${from}, needs ${amount}`);

  const message = { receiver: pad(deployer.address, { size: 32 }), data: "0x" as Hex, tokenAmounts: [{ token, amount }], feeToken: zeroAddress as Address, extraArgs: "0x" as Hex };
  const fee = await read<bigint>(source, { to: router, abi: routerAbi, functionName: "getFee", args: [ctx.net.chains[to].selector, message] });
  await approveToken(ctx, from, deployer, router, amount);

  // Fresh status on the source pool's ledger right before the lock/burn.
  const freshnessRuns: WorkflowRun[] = [await runWorkflow(ctx, "w2-loop", 0)];
  emit({ step: "ccip-send", status: "started", chain: from, title: `CCIP ${from} -> ${to}: ${amount} kETH (native fee ${fee} wei)` });
  const sent = await send(source, deployer, { to: router, abi: routerAbi, functionName: "ccipSend", args: [ctx.net.chains[to].selector, message], value: fee }, `ccipSend ${from} -> ${to}`);
  const event = parseEventLogs({ abi: routerAbi, logs: sent.receipt.logs, eventName: "CCIPMessageSent" })[0];
  if (event === undefined) throw new Error("ccipSend emitted no CCIPMessageSent");
  const messageId = event.args.messageId;
  const explorer = ccipMessageUrl(messageId);
  emit({ step: "ccip-send", status: "ok", chain: from, title: `CCIP message sent ${messageId}`, txHash: sent.hash, explorerUrl: sent.url, detail: { messageId, ccipExplorer: explorer } });

  // Wait for the destination execution; keep the destination ledger fresh once the source is nearly final.
  const sendTime = (await source.client.getBlock({ blockNumber: sent.receipt.blockNumber })).timestamp;
  const fromBlock = await dest.client.getBlockNumber();
  let execution: CcipLeg["execution"] = null;
  let lastFresh = 0;
  for (let polls = 0; polls < 180; polls++) {
    const logs = await dest.client.getLogs({ address: offRamp, fromBlock, toBlock: "latest" });
    const hit = logs.find((l) => l.topics[0]?.toLowerCase() === EXECUTION_STATE_CHANGED && l.topics[3]?.toLowerCase() === messageId.toLowerCase());
    if (hit?.transactionHash != null) {
      const state = Number(BigInt(`0x${hit.data.slice(2, 66)}`));
      execution = { state: STATE_NAME[state] ?? String(state), txHash: hit.transactionHash, url: txUrl(dest.config, hit.transactionHash) };
      break;
    }
    const sourceFinal = (await source.client.getBlock({ blockTag: "finalized" })).timestamp;
    const nearlyFinal = sourceFinal + 180n >= sendTime;
    if (nearlyFinal && Date.now() - lastFresh > 100_000 && freshnessRuns.length <= maxFreshness) {
      freshnessRuns.push(await runWorkflow(ctx, "w2-loop", 0));
      lastFresh = Date.now();
    } else {
      log(`CCIP ${messageId.slice(0, 10)}: waiting for execution on ${dest.config.label} (source finalized ${sendTime - sourceFinal}s behind the send)`);
    }
    await sleep(20_000);
  }
  emit({
    step: "ccip-execute",
    status: execution?.state === "SUCCESS" ? "ok" : "failed",
    chain: to,
    title: execution === null ? "no execution observed yet" : `executed on ${to}: ${execution.state}`,
    txHash: execution?.txHash ?? null,
    explorerUrl: execution?.url ?? explorer,
    detail: { messageId, ccipExplorer: explorer, freshnessEpochs: freshnessRuns.length },
  });
  return { from, to, amount, messageId, source: sent, ccipExplorer: explorer, execution, freshnessRuns };
}
