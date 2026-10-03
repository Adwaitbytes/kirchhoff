import { decodeAbiParameters, encodeAbiParameters, keccak256, stringToBytes } from "viem";
import { EngineInputError, ReportType, Status, toReason, type ChainSel, type Hex, type PinnedBlock, type Reason } from "./types.ts";

const ENVELOPE = [
  { type: "uint8", name: "reportType" },
  { type: "uint64", name: "chainSelector" },
  { type: "address", name: "ledger" },
  { type: "bytes32", name: "tokenId" },
  { type: "bytes", name: "payload" },
] as const;

const EPOCH_PAYLOAD = [
  { type: "uint64", name: "epochId" },
  { type: "int256", name: "delta" },
  { type: "bytes32", name: "blocksHash" },
  { type: "bytes32", name: "evidenceHash" },
  { type: "uint8", name: "status" },
  { type: "uint16", name: "reason" },
  { type: "bytes32[]", name: "settledMessageIds" },
] as const;

const BREACH_PAYLOAD = [
  { type: "uint64", name: "epochId" },
  { type: "int256", name: "delta" },
  { type: "bytes32", name: "blocksHash" },
  { type: "bytes32", name: "evidenceHash" },
  { type: "uint16", name: "reason" },
  { type: "uint64", name: "offendingChain" },
  { type: "bytes32", name: "offendingTx" },
  { type: "address", name: "recipient" },
  { type: "uint256", name: "amount" },
  { type: "bytes32", name: "messageId" },
] as const;

const QUARANTINE_PAYLOAD = [
  { type: "bytes32", name: "incidentId" },
  { type: "address[]", name: "tainted" },
] as const;

const RECOVERY_PAYLOAD = [
  { type: "uint64", name: "epochId" },
  { type: "int256", name: "delta" },
  { type: "bytes32", name: "blocksHash" },
] as const;

export type EpochPayload = {
  epochId: bigint;
  delta: bigint;
  blocksHash: Hex;
  evidenceHash: Hex;
  /** EPOCH reports carry CONSERVED or DRIFT only. */
  status: typeof Status.CONSERVED | typeof Status.DRIFT;
  reason: Reason;
  settledMessageIds: readonly Hex[];
};

export type BreachPayload = {
  epochId: bigint;
  delta: bigint;
  blocksHash: Hex;
  evidenceHash: Hex;
  reason: Reason;
  offendingChain: ChainSel;
  offendingTx: Hex;
  recipient: Hex;
  amount: bigint;
  messageId: Hex;
};

export type QuarantinePayload = { incidentId: Hex; tainted: readonly Hex[] };

export type RecoveryPayload = { epochId: bigint; delta: bigint; blocksHash: Hex };

type EnvelopeHeader = { chainSelector: ChainSel; ledger: Hex; tokenId: Hex };

export type Report = EnvelopeHeader &
  (
    | { reportType: typeof ReportType.EPOCH; payload: EpochPayload }
    | { reportType: typeof ReportType.BREACH; payload: BreachPayload }
    | { reportType: typeof ReportType.QUARANTINE_APPLIED; payload: QuarantinePayload }
    | { reportType: typeof ReportType.RECOVERY_CHECK; payload: RecoveryPayload }
  );

export function encodeEpochPayload(p: EpochPayload): Hex {
  return encodeAbiParameters(EPOCH_PAYLOAD, [
    p.epochId,
    p.delta,
    p.blocksHash,
    p.evidenceHash,
    p.status,
    p.reason,
    [...p.settledMessageIds],
  ]);
}

export function encodeBreachPayload(p: BreachPayload): Hex {
  return encodeAbiParameters(BREACH_PAYLOAD, [
    p.epochId,
    p.delta,
    p.blocksHash,
    p.evidenceHash,
    p.reason,
    p.offendingChain,
    p.offendingTx,
    p.recipient,
    p.amount,
    p.messageId,
  ]);
}

export function encodeQuarantinePayload(p: QuarantinePayload): Hex {
  return encodeAbiParameters(QUARANTINE_PAYLOAD, [p.incidentId, [...p.tainted]]);
}

export function encodeRecoveryPayload(p: RecoveryPayload): Hex {
  return encodeAbiParameters(RECOVERY_PAYLOAD, [p.epochId, p.delta, p.blocksHash]);
}

function encodePayload(report: Report): Hex {
  switch (report.reportType) {
    case ReportType.EPOCH:
      return encodeEpochPayload(report.payload);
    case ReportType.BREACH:
      return encodeBreachPayload(report.payload);
    case ReportType.QUARANTINE_APPLIED:
      return encodeQuarantinePayload(report.payload);
    case ReportType.RECOVERY_CHECK:
      return encodeRecoveryPayload(report.payload);
  }
}

/** `abi.encode(uint8 reportType, uint64 chainSelector, address ledger, bytes32 tokenId, bytes payload)`. */
export function encodeReport(report: Report): Hex {
  return encodeAbiParameters(ENVELOPE, [
    report.reportType,
    report.chainSelector,
    report.ledger,
    report.tokenId,
    encodePayload(report),
  ]);
}

export function decodeReport(data: Hex): Report {
  const [reportType, chainSelector, ledger, tokenId, payload] = decodeAbiParameters(ENVELOPE, data);
  const header: EnvelopeHeader = { chainSelector, ledger, tokenId };
  switch (reportType) {
    case ReportType.EPOCH: {
      const [epochId, delta, blocksHash, evidenceHash, status, reason, settledMessageIds] = decodeAbiParameters(
        EPOCH_PAYLOAD,
        payload,
      );
      if (status !== Status.CONSERVED && status !== Status.DRIFT) {
        throw new EngineInputError(`EPOCH status must be CONSERVED or DRIFT, got ${status.toString()}`);
      }
      return {
        ...header,
        reportType,
        payload: { epochId, delta, blocksHash, evidenceHash, status, reason: toReason(reason), settledMessageIds },
      };
    }
    case ReportType.BREACH: {
      const [epochId, delta, blocksHash, evidenceHash, reason, offendingChain, offendingTx, recipient, amount, messageId] =
        decodeAbiParameters(BREACH_PAYLOAD, payload);
      return {
        ...header,
        reportType,
        payload: {
          epochId,
          delta,
          blocksHash,
          evidenceHash,
          reason: toReason(reason),
          offendingChain,
          offendingTx,
          recipient,
          amount,
          messageId,
        },
      };
    }
    case ReportType.QUARANTINE_APPLIED: {
      const [incidentId, tainted] = decodeAbiParameters(QUARANTINE_PAYLOAD, payload);
      return { ...header, reportType, payload: { incidentId, tainted } };
    }
    case ReportType.RECOVERY_CHECK: {
      const [epochId, delta, blocksHash] = decodeAbiParameters(RECOVERY_PAYLOAD, payload);
      return { ...header, reportType, payload: { epochId, delta, blocksHash } };
    }
    default:
      throw new EngineInputError(`unknown report type ${reportType.toString()}`);
  }
}

/** `tokenId = keccak256(bytes(symbol))`. */
export function tokenId(symbol: string): Hex {
  return keccak256(stringToBytes(symbol));
}

/** `incidentId = keccak256(abi.encode(tokenId, evidenceHash))`. */
export function incidentId(token: Hex, evidenceHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32", name: "tokenId" },
        { type: "bytes32", name: "evidenceHash" },
      ],
      [token, evidenceHash],
    ),
  );
}

/** `blocksHash = keccak256(abi.encode(uint64[] chainSelectors, uint64[] blockNumbers))`, selectors ascending. */
export function blocksHash(pinned: readonly PinnedBlock[]): Hex {
  const sorted = [...pinned].sort((a, b) => (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0));
  let previous: ChainSel | null = null;
  for (const p of sorted) {
    if (p.chain === previous) throw new EngineInputError("blocksHash needs one block per chain");
    previous = p.chain;
  }
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint64[]", name: "chainSelectors" },
        { type: "uint64[]", name: "blockNumbers" },
      ],
      [sorted.map((p) => p.chain), sorted.map((p) => p.block)],
    ),
  );
}
