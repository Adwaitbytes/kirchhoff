/**
 * The contract surface the Judge reads. Signatures mirror contracts/src/interfaces/*.sol;
 * test/abi.test.ts checks them against the Foundry artifacts in contracts/out so drift fails CI.
 */
import { keccak256, parseAbi, toBytes, type Hex } from "viem";

export const LEDGER_ABI = parseAbi([
  "function statusOf(bytes32 tokenId) view returns (uint8 status, int256 delta, uint64 updatedAt, bool stale)",
  "struct Epoch { uint64 epochId; int256 delta; uint64 evaluatedAt; bytes32 blocksHash; bytes32 evidenceHash; uint8 status; uint16 reason; }",
  "function latestEpoch(bytes32 tokenId) view returns (Epoch)",
  "function activeIncident(bytes32 tokenId) view returns (bytes32)",
  "struct Breach { bytes32 tokenId; uint64 epochId; int256 delta; bytes32 blocksHash; bytes32 evidenceHash; uint16 reason; uint64 offendingChain; bytes32 offendingTx; address recipient; uint256 amount; bytes32 messageId; uint64 recordedAt; }",
  "function breachOf(bytes32 incidentId) view returns (Breach)",
]);

export const QUARANTINE_ABI = parseAbi([
  "function isFrozen(bytes32 tokenId) view returns (bool)",
  "function isTainted(bytes32 tokenId, address account) view returns (bool)",
]);

/** Canonical Multicall3 (same address on every EVM chain; verified on all three testnets, both providers). */
export const MULTICALL3: Hex = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const REGISTRY_ABI = parseAbi(["function activeSpecHash(bytes32 tokenId) view returns (bytes32)"]);

/** CCIP 2.0.0 TokenPool event (docs/research/ccip.md section 4). */
export const LOCKED_OR_BURNED_ABI = parseAbi([
  "event LockedOrBurned(uint64 indexed remoteChainSelector, address token, address sender, uint256 amount)",
]);

/** Canonical OnRamp 2.0.0 event signature; only its topics are read, so the data layout never matters. */
export const CCIP_MESSAGE_SENT_SIGNATURE =
  "CCIPMessageSent(uint64,address,bytes32,address,uint256,bytes,(address,uint32,uint32,uint256,bytes)[],bytes[])";

export const TOPIC_CCIP_MESSAGE_SENT: Hex = keccak256(toBytes(CCIP_MESSAGE_SENT_SIGNATURE));
export const TOPIC_LOCKED_OR_BURNED: Hex = keccak256(toBytes("LockedOrBurned(uint64,address,address,uint256)"));
