import { encodeAbiParameters, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import {
  blocksHash,
  decodeReport,
  encodeEpochPayload,
  encodeReport,
  incidentId,
  tokenId,
  type Report,
} from "../src/encoding.ts";
import { EngineInputError, Reason, ReportType, Status } from "../src/types.ts";
import { ALICE, ARB, BASE, ESCROW, HOME, MALLORY, addr, hash } from "./fixtures.ts";

const KETH = tokenId("kETH");
const header = { chainSelector: HOME, ledger: ESCROW, tokenId: KETH };

// Vectors produced independently with Foundry's `cast` (keccak / abi-encode).
describe("identifiers match cast", () => {
  it("tokenId = keccak256(bytes(symbol))", () => {
    expect(KETH).toBe("0xe7cbc0ff4035309f71987d099a88ed33ef6bfd1a7d6c1050befb12561b95eb9c");
  });
  it("incidentId = keccak256(abi.encode(tokenId, evidenceHash))", () => {
    expect(incidentId(KETH, hash("evidence"))).toBe("0xa86d91afe1a38b851b179fc890d969a145950a745ec4d876ca89ebce71f13959");
  });
  it("blocksHash sorts selectors ascending whatever the input order", () => {
    const expected = "0x0a7262b64bdb13223819af27411f25beb2c4eb966569cdefdfe9360a63e68fcb";
    expect(blocksHash([{ chain: HOME, block: 100n }, { chain: ARB, block: 200n }, { chain: BASE, block: 300n }])).toBe(expected);
    expect(blocksHash([{ chain: BASE, block: 300n }, { chain: HOME, block: 100n }, { chain: ARB, block: 200n }])).toBe(expected);
  });
  it("blocksHash refuses two blocks for one chain", () => {
    expect(() => blocksHash([{ chain: HOME, block: 1n }, { chain: HOME, block: 2n }])).toThrow(EngineInputError);
  });
  it("EPOCH payload layout", () => {
    const payload = encodeEpochPayload({
      epochId: 7n,
      delta: -5n,
      blocksHash: hash("b"),
      evidenceHash: hash("e"),
      status: Status.DRIFT,
      reason: Reason.FLOW_LIMIT,
      settledMessageIds: [hash("m1")],
    });
    expect(keccak256(payload)).toBe("0x134489059cd50ef174caecdd7a5250970e032b175f1bf2145b30046b34960fd3");
  });
  it("QUARANTINE_APPLIED envelope layout", () => {
    const report: Report = {
      ...header,
      reportType: ReportType.QUARANTINE_APPLIED,
      payload: { incidentId: hash("incident"), tainted: [ALICE, MALLORY] },
    };
    expect(keccak256(encodeReport(report))).toBe("0x746b95f75c201d9e24618a349f66552775f1373d47f8f4a91becee75cb2121a2");
  });
});

/** viem returns checksummed addresses; compare hex case-insensitively. */
function lowerHex(value: unknown): unknown {
  if (typeof value === "string") return value.startsWith("0x") ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(lowerHex);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, lowerHex(v)]));
  }
  return value;
}

describe("report round trips", () => {
  const reports: Report[] = [
    {
      ...header,
      reportType: ReportType.EPOCH,
      payload: {
        epochId: 4182n,
        delta: 0n,
        blocksHash: hash("blocks"),
        evidenceHash: hash("evidence"),
        status: Status.CONSERVED,
        reason: Reason.OK,
        settledMessageIds: [hash("a"), hash("b")],
      },
    },
    {
      ...header,
      reportType: ReportType.BREACH,
      payload: {
        epochId: 4183n,
        delta: -116_500n * 10n ** 18n,
        blocksHash: hash("blocks"),
        evidenceHash: hash("evidence"),
        reason: Reason.DEBIT_NOT_FOUND,
        offendingChain: HOME,
        offendingTx: hash("tx"),
        recipient: MALLORY,
        amount: 116_500n * 10n ** 18n,
        messageId: hash("forged"),
      },
    },
    { ...header, reportType: ReportType.QUARANTINE_APPLIED, payload: { incidentId: hash("i"), tainted: [MALLORY] } },
    { ...header, reportType: ReportType.RECOVERY_CHECK, payload: { epochId: 9n, delta: 1n, blocksHash: hash("b") } },
  ];
  it.each(reports.map((r) => [r.reportType, r] as const))("type %i", (_type, report) => {
    expect(lowerHex(decodeReport(encodeReport(report)))).toEqual(lowerHex(report));
  });
});

describe("decodeReport rejects", () => {
  const envelope = (reportType: number, payload: `0x${string}`) =>
    encodeAbiParameters(
      [
        { type: "uint8" },
        { type: "uint64" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes" },
      ],
      [reportType, HOME, addr(1), KETH, payload],
    );
  it("an unknown report type", () => {
    expect(() => decodeReport(envelope(9, "0x"))).toThrow(EngineInputError);
  });
  it("an EPOCH carrying a status other than CONSERVED or DRIFT", () => {
    const payload = encodeAbiParameters(
      [
        { type: "uint64" },
        { type: "int256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint8" },
        { type: "uint16" },
        { type: "bytes32[]" },
      ],
      [1n, 0n, hash("b"), hash("e"), Status.BROKEN, Reason.OK, []],
    );
    expect(() => decodeReport(envelope(ReportType.EPOCH, payload))).toThrow(EngineInputError);
  });
  it("an unknown reason code", () => {
    const payload = encodeAbiParameters(
      [
        { type: "uint64" },
        { type: "int256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint8" },
        { type: "uint16" },
        { type: "bytes32[]" },
      ],
      [1n, 0n, hash("b"), hash("e"), Status.CONSERVED, 500, []],
    );
    expect(() => decodeReport(envelope(ReportType.EPOCH, payload))).toThrow(EngineInputError);
  });
});
