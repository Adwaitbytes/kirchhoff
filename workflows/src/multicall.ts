import type { Hex } from "@kirchhoff/engine";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";

/** Canonical Multicall3 `aggregate3`, the one call W2/W3/W4 make per chain at a pinned block. */
export const MULTICALL3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

export type Call = { target: Hex; callData: Hex };
export type CallResult = { success: boolean; returnData: Hex };

/** CRE `ChainRead.PayloadSizeLimit` is 5 KB; keep the encoded aggregate3 calldata under it. */
export const CRE_READ_PAYLOAD_LIMIT_BYTES = 5 * 1024;

export function encodeAggregate3(calls: readonly Call[]): Hex {
  const data = encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    // allowFailure keeps one bad target (e.g. an unregistered token view) from hiding every other read;
    // callers check `success` per entry and fail closed.
    args: [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }))],
  });
  const bytes = (data.length - 2) / 2;
  if (bytes > CRE_READ_PAYLOAD_LIMIT_BYTES) {
    throw new RangeError(`aggregate3 calldata is ${bytes} bytes, above the CRE read payload limit of ${CRE_READ_PAYLOAD_LIMIT_BYTES}`);
  }
  return data;
}

export function decodeAggregate3(returnData: Hex, expected: number): CallResult[] {
  const results = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", data: returnData });
  if (results.length !== expected) {
    throw new Error(`aggregate3 returned ${results.length} results for ${expected} calls`);
  }
  return results.map((r) => ({ success: r.success, returnData: r.returnData }));
}

/**
 * The return data of a successful sub-call, or an error naming which read failed. A call to an address without
 * code "succeeds" with empty data, which is reported as such (usually: contract not deployed on this chain).
 */
export function successful(result: CallResult | undefined, label: string): Hex {
  if (result === undefined) throw new Error(`multicall result for ${label} is missing`);
  if (!result.success) throw new Error(`multicall read ${label} reverted`);
  if (result.returnData === "0x") throw new Error(`multicall read ${label} returned no data: no contract code at the target?`);
  return result.returnData;
}
