import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { ChainSel, Credit, Debit, Hex } from "../types.ts";

/**
 * WeakBridge / HomeEscrowAdapter id registries (INTERFACES.md revision 3). W1
 * reads `debitOf` with one callContract at the source chain's pinned confidence
 * block instead of scanning logs, because CRE caps filterLogs at 100 blocks.
 */
export const BRIDGE_REGISTRY_ABI = parseAbi([
  "function debitOf(bytes32 id) view returns (uint256 amount, address recipient, uint64 dstChain, uint64 blockNumber)",
  "function creditOf(bytes32 id) view returns (uint256 amount, address recipient, uint64 srcChain, uint64 blockNumber)",
]);

/** A registry read carries no transaction; evidence links to the log found in the 100-block window instead. */
export const NO_TX: Hex = `0x${"0".repeat(64)}`;

export function encodeDebitOf(messageId: Hex): Hex {
  return encodeFunctionData({ abi: BRIDGE_REGISTRY_ABI, functionName: "debitOf", args: [messageId] });
}

export function encodeCreditOf(messageId: Hex): Hex {
  return encodeFunctionData({ abi: BRIDGE_REGISTRY_ABI, functionName: "creditOf", args: [messageId] });
}

/**
 * The Debit a `debitOf(id)` return value describes, or null when the bridge has
 * no debit for the id (amount 0). Same shape as a log-decoded debit, so
 * junction() treats both sources identically.
 */
export function debitFromRegistry(messageId: Hex, srcChain: ChainSel, returnData: Hex, txHash: Hex = NO_TX): Debit | null {
  const [amount, recipient, dstChain, blockNumber] = decodeFunctionResult({
    abi: BRIDGE_REGISTRY_ABI,
    functionName: "debitOf",
    data: returnData,
  });
  if (amount === 0n) return null;
  return { messageId: messageId.toLowerCase() as Hex, srcChain, dstChain, amount, recipient: recipient.toLowerCase() as Hex, txHash, block: blockNumber };
}

/** The Credit a `creditOf(id)` return value describes, or null when none (amount 0). */
export function creditFromRegistry(messageId: Hex, dstChain: ChainSel, returnData: Hex, txHash: Hex = NO_TX): Credit | null {
  const [amount, recipient, srcChain, blockNumber] = decodeFunctionResult({
    abi: BRIDGE_REGISTRY_ABI,
    functionName: "creditOf",
    data: returnData,
  });
  if (amount === 0n) return null;
  return {
    messageId: messageId.toLowerCase() as Hex,
    claimedSrcChain: srcChain,
    dstChain,
    amount,
    recipient: recipient.toLowerCase() as Hex,
    txHash,
    block: blockNumber,
  };
}
