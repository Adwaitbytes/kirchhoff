import {
  blocksHash as engineBlocksHash,
  encodeReport,
  incidentId as engineIncidentId,
  ReportType,
  Status,
  type BreachPayload,
  type EpochPayload,
  type QuarantinePayload,
  type RecoveryPayload,
  type Report,
} from "@kirchhoff/engine";
import { encodeAbiParameters, encodePacked, keccak256, parseEventLogs, stringToHex, toHex, type Address, type Hex } from "viem";
import { mockForwarderAbi } from "./abi.ts";
import { account, read, send, TxError, type Sent } from "./chain.ts";
import { ledgerAbi } from "./abi.ts";
import type { Context } from "./context.ts";
import { log } from "./events.ts";
import { ROLES, type ChainRole } from "./networks.ts";

const JUNCTION_EVIDENCE = stringToHex("KIRCHHOFF_JUNCTION_V1", { size: 32 });
const LOOP_EVIDENCE = stringToHex("KIRCHHOFF_LOOP_V1", { size: 32 });

/**
 * W1's junction evidence hash, byte-for-byte the engine/workflows formula (workflows/src/reports.ts), so the direct
 * path produces the same incident id a live W1 run would.
 */
export function junctionEvidence(e: { dstChain: bigint; txHash: Hex; messageId: Hex; reason: number }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint16" }],
      [JUNCTION_EVIDENCE, e.dstChain, e.txHash, e.messageId, e.reason],
    ),
  );
}

/** W2's loop evidence hash (same formula as workflows/src/reports.ts). */
export function loopEvidence(e: { blocksHash: Hex; backing: bigint; claims: bigint; inFlightOut: bigint; inFlightIn: bigint; delta: bigint; reason: number }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "int256" }, { type: "int256" }, { type: "int256" }, { type: "int256" }, { type: "int256" }, { type: "uint16" }],
      [LOOP_EVIDENCE, e.blocksHash, e.backing, e.claims, e.inFlightOut, e.inFlightIn, e.delta, e.reason],
    ),
  );
}

/** Simulation metadata the Deploy script pins on local / simulation ledgers (contracts/README, INTERFACES Rev 2.7). */
export const SIM_WORKFLOW_ID: Hex = `0x${"11".repeat(32)}`;
export const SIM_WORKFLOW_OWNER: Address = `0x${"aa".repeat(20)}`;

export type ReportBody =
  | { reportType: typeof ReportType.EPOCH; payload: EpochPayload }
  | { reportType: typeof ReportType.BREACH; payload: BreachPayload }
  | { reportType: typeof ReportType.QUARANTINE_APPLIED; payload: QuarantinePayload }
  | { reportType: typeof ReportType.RECOVERY_CHECK; payload: RecoveryPayload };

function envelope(ctx: Context, role: ChainRole, body: ReportBody): Hex {
  const header = { chainSelector: ctx.net.chains[role].selector, ledger: ctx.at(role, "conservationLedger"), tokenId: ctx.tokenId };
  const report = { ...header, reportType: body.reportType, payload: body.payload } as Report;
  return encodeReport(report);
}

/**
 * Builds the DON raw report exactly as `cre workflow simulate --broadcast` does, so the direct path uses the same
 * engine encoding as the live CRE path. Layout: version(1) | execId(32) | timestamp(4) | donId(4) | donCfg(4) |
 * workflowCid(32) | workflowName(10) | workflowOwner(20) | reportId(2) | reportBody.
 */
function rawReport(reportBody: Hex, reportId: number): Hex {
  const execId = keccak256(stringToHex(`kirchhoff-direct-${Date.now()}-${Math.floor(Math.random() * 1e9)}`));
  return encodePacked(
    ["uint8", "bytes32", "uint32", "uint32", "uint32", "bytes32", "bytes10", "address", "bytes2", "bytes"],
    [1, execId, Math.floor(Date.now() / 1000), 1, 1, SIM_WORKFLOW_ID, `0x${"00".repeat(10)}`, SIM_WORKFLOW_OWNER, toHex(reportId, { size: 2 }), reportBody],
  );
}

/**
 * Delivers one report to one chain's ledger through its MockKeystoneForwarder, the clearly named `--reports=direct`
 * fallback the PRD allows while the CRE workflows are being built (the default path is `cre workflow simulate`).
 * Uses the engine's report encoding, so the bytes are identical to what the DON would sign.
 */
export async function writeReportDirect(ctx: Context, role: ChainRole, body: ReportBody, reportIndex: number): Promise<Sent> {
  const chain = ctx.chains[role];
  const forwarder = ctx.at(role, "mockKeystoneForwarder");
  const ledger = ctx.at(role, "conservationLedger");
  const sent = await send(
    chain,
    account("DEPLOYER"),
    { to: forwarder, abi: mockForwarderAbi, functionName: "report", args: [ledger, rawReport(envelope(ctx, role, body), reportIndex), "0x", []] },
    `direct ${reportName(body.reportType)} -> ${role}`,
  );
  const processed = parseEventLogs({ abi: mockForwarderAbi, logs: sent.receipt.logs, eventName: "ReportProcessed" })[0];
  if (processed === undefined) throw new TxError(`forwarder emitted no ReportProcessed on ${role}`);
  if (!processed.args.result) throw new TxError(`ledger rejected ${reportName(body.reportType)} on ${role} (ReportProcessed result=false)`);
  return sent;
}

export function reportName(t: ReportBody["reportType"]): string {
  return t === ReportType.EPOCH ? "EPOCH" : t === ReportType.BREACH ? "BREACH" : t === ReportType.QUARANTINE_APPLIED ? "QUARANTINE_APPLIED" : "RECOVERY_CHECK";
}

/** Delta for the Kelp Replay: the forged credit minus no matching debit, in token base units. */
export const DEMO_BREACH_AMOUNT = 116_500n * 10n ** 18n;

export type BreachInputs = { offendingChain: ChainRole; offendingTx: Hex; messageId: Hex; recipient: Address; amount: bigint; reason: number };

/** W1's BREACH payload for a forged credit; evidenceHash is computed exactly as the engine does so the incident id matches. */
export function breachBody(ctx: Context, inputs: BreachInputs, epochId: bigint): ReportBody {
  const evidenceHash = junctionEvidence({ dstChain: ctx.net.chains[inputs.offendingChain].selector, txHash: inputs.offendingTx, messageId: inputs.messageId, reason: inputs.reason });
  const payload: BreachPayload = {
    epochId,
    delta: -inputs.amount,
    blocksHash: `0x${"00".repeat(32)}`,
    evidenceHash,
    reason: inputs.reason as BreachPayload["reason"],
    offendingChain: ctx.net.chains[inputs.offendingChain].selector,
    offendingTx: inputs.offendingTx,
    recipient: inputs.recipient,
    amount: inputs.amount,
    messageId: inputs.messageId,
  };
  return { reportType: ReportType.BREACH, payload };
}

export function incidentIdFor(ctx: Context, inputs: BreachInputs): Hex {
  const evidenceHash = junctionEvidence({ dstChain: ctx.net.chains[inputs.offendingChain].selector, txHash: inputs.offendingTx, messageId: inputs.messageId, reason: inputs.reason });
  return engineIncidentId(ctx.tokenId, evidenceHash);
}

export function quarantineBody(incidentId: Hex, tainted: readonly Address[]): ReportBody {
  return { reportType: ReportType.QUARANTINE_APPLIED, payload: { incidentId, tainted } };
}

export function recoveryBody(epochId: bigint): ReportBody {
  return { reportType: ReportType.RECOVERY_CHECK, payload: { epochId, delta: 0n, blocksHash: engineBlocksHash([{ chain: 1n, block: 0n }]) } };
}

export function epochBody(ctx: Context, epochId: bigint, delta: bigint, status: typeof Status.CONSERVED | typeof Status.DRIFT, reason: number): ReportBody {
  const payload: EpochPayload = {
    epochId,
    delta,
    blocksHash: `0x${"00".repeat(32)}`,
    evidenceHash: delta < 0n ? loopEvidence({ blocksHash: `0x${"00".repeat(32)}`, backing: 0n, claims: -delta, inFlightOut: 0n, inFlightIn: 0n, delta, reason }) : `0x${"00".repeat(32)}`,
    status,
    reason: reason as EpochPayload["reason"],
    settledMessageIds: [],
  };
  return { reportType: ReportType.EPOCH, payload };
}

/** Next strictly increasing epoch id for a ledger (past the per-token high-water mark via the latest epoch). */
export async function nextEpochId(ctx: Context, role: ChainRole): Promise<bigint> {
  const chain = ctx.chains[role];
  const epoch = await read<{ epochId: bigint }>(chain, { to: ctx.at(role, "conservationLedger"), abi: ledgerAbi, functionName: "latestEpoch", args: [ctx.tokenId] });
  const now = BigInt(Math.floor(Date.now() / 1000));
  return (epoch.epochId > now ? epoch.epochId : now) + 1n;
}

/** Writes the same body to all three ledgers (direct path); returns the per-chain receipts. */
export async function writeAllDirect(ctx: Context, make: (role: ChainRole, epochId: bigint) => ReportBody, reportIndex: number): Promise<Record<ChainRole, Sent>> {
  const out = {} as Record<ChainRole, Sent>;
  for (const role of ROLES) {
    const epochId = await nextEpochId(ctx, role);
    out[role] = await writeReportDirect(ctx, role, make(role, epochId), reportIndex);
    log(`  ${role}: ${out[role].hash}`);
  }
  return out;
}
