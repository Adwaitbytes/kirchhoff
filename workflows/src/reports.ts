import {
  encodeReport,
  ReportType,
  type BreachPayload,
  type EpochPayload,
  type Hex,
  type QuarantinePayload,
  type RecoveryPayload,
  type Report,
} from "@kirchhoff/engine";
import { encodeAbiParameters, keccak256, stringToHex } from "viem";
import type { ChainIo, WriteOutcome } from "./io.ts";

/** Where one chain's ConservationLedger lives; every report is bound to exactly this pair (PRD threat 8). */
export type LedgerTarget = { chain: string; selector: bigint; ledger: Hex };

export type ReportBody =
  | { reportType: typeof ReportType.EPOCH; payload: EpochPayload }
  | { reportType: typeof ReportType.BREACH; payload: BreachPayload }
  | { reportType: typeof ReportType.QUARANTINE_APPLIED; payload: QuarantinePayload }
  | { reportType: typeof ReportType.RECOVERY_CHECK; payload: RecoveryPayload };

/**
 * Gas for one `onReport` through the forwarder. A BREACH also freezes lanes and taints in the
 * QuarantineController; the forwarder itself needs ~130k (docs/research/cre-contracts.md section 6a).
 * Well under the 10M CRE transaction gas limit.
 */
export const REPORT_GAS_LIMIT: Readonly<Record<ReportBody["reportType"], bigint>> = {
  [ReportType.EPOCH]: 1_500_000n,
  [ReportType.BREACH]: 1_500_000n,
  [ReportType.QUARANTINE_APPLIED]: 1_500_000n,
  [ReportType.RECOVERY_CHECK]: 1_000_000n,
};

/** The INTERFACES.md envelope for one ledger: `abi.encode(reportType, chainSelector, ledger, tokenId, payload)`. */
export function envelopeFor(target: LedgerTarget, tokenId: Hex, body: ReportBody): Hex {
  const header = { chainSelector: target.selector, ledger: target.ledger, tokenId };
  // The discriminated union is rebuilt per variant so the engine's Report type checks each payload shape.
  let report: Report;
  switch (body.reportType) {
    case ReportType.EPOCH:
      report = { ...header, reportType: body.reportType, payload: body.payload };
      break;
    case ReportType.BREACH:
      report = { ...header, reportType: body.reportType, payload: body.payload };
      break;
    case ReportType.QUARANTINE_APPLIED:
      report = { ...header, reportType: body.reportType, payload: body.payload };
      break;
    case ReportType.RECOVERY_CHECK:
      report = { ...header, reportType: body.reportType, payload: body.payload };
      break;
  }
  return encodeReport(report);
}

export type WriteResult = { chain: string; outcome: WriteOutcome };

export const REPORT_TYPE_NAME: Readonly<Record<ReportBody["reportType"], string>> = {
  [ReportType.EPOCH]: "EPOCH",
  [ReportType.BREACH]: "BREACH",
  [ReportType.QUARANTINE_APPLIED]: "QUARANTINE_APPLIED",
  [ReportType.RECOVERY_CHECK]: "RECOVERY_CHECK",
};

export class ReportWriteError extends Error {
  override readonly name = "ReportWriteError";
}

/**
 * Writes one report per target ledger in this run. Every target is attempted even if an earlier one fails, so a
 * single bad chain cannot stop containment on the others; any failure then fails the execution loudly.
 */
export function writeToLedgers(
  io: ChainIo,
  targets: readonly LedgerTarget[],
  tokenId: Hex,
  body: ReportBody,
): WriteResult[] {
  const name = REPORT_TYPE_NAME[body.reportType];
  const results: WriteResult[] = targets.map((target) => {
    const outcome = io.writeReport(target.chain, target.ledger, envelopeFor(target, tokenId, body), REPORT_GAS_LIMIT[body.reportType]);
    io.log(outcome.ok ? `${name} -> ${target.chain} ledger ${target.ledger}: tx ${outcome.txHash}` : `${name} -> ${target.chain} FAILED: ${outcome.error}`);
    return { chain: target.chain, outcome };
  });
  const failed = results.filter((r) => !r.outcome.ok);
  if (failed.length > 0) {
    throw new ReportWriteError(`${name} write failed on ${failed.map((f) => f.chain).join(", ")}`);
  }
  return results;
}

const JUNCTION_EVIDENCE = stringToHex("KIRCHHOFF_JUNCTION_V1", { size: 32 });
const LOOP_EVIDENCE = stringToHex("KIRCHHOFF_LOOP_V1", { size: 32 });
const TOPOLOGY_EVIDENCE = stringToHex("KIRCHHOFF_TOPOLOGY_V1", { size: 32 });

/**
 * Evidence for one offending credit. W1 and W2 compute it identically, so the same forged credit is one
 * incident (`incidentId = keccak256(tokenId, evidenceHash)`) however many times or from whichever workflow it is
 * reported; the ledger treats a repeat as a no-op.
 */
export function junctionEvidence(e: { dstChain: bigint; txHash: Hex; messageId: Hex; reason: number }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint16" }],
      [JUNCTION_EVIDENCE, e.dstChain, e.txHash, e.messageId, e.reason],
    ),
  );
}

/** Evidence for one Loop Rule evaluation: the pinned blocks plus every term of Δ. */
export function loopEvidence(e: {
  blocksHash: Hex;
  backing: bigint;
  claims: bigint;
  inFlightOut: bigint;
  inFlightIn: bigint;
  delta: bigint;
  reason: number;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "int256" },
        { type: "int256" },
        { type: "int256" },
        { type: "int256" },
        { type: "int256" },
        { type: "uint16" },
      ],
      [LOOP_EVIDENCE, e.blocksHash, e.backing, e.claims, e.inFlightOut, e.inFlightIn, e.delta, e.reason],
    ),
  );
}

/** Evidence for a topology finding: which unlisted minters exist on which chain at which block. */
export function topologyEvidence(e: { blocksHash: Hex; findings: readonly { chain: bigint; minter: Hex }[] }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint64[]" }, { type: "address[]" }],
      [TOPOLOGY_EVIDENCE, e.blocksHash, e.findings.map((f) => f.chain), e.findings.map((f) => f.minter)],
    ),
  );
}
