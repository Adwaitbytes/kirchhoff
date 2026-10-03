import { parseAbi } from "viem";

/**
 * The contract views the workflows read, copied from contracts/src/interfaces (IConservationLedger,
 * Epoch in KirchhoffTypes) and the standard ERC-20 / AccessControl shapes. `Status` is a Solidity enum, so it
 * is a uint8 on the wire.
 */
export const LEDGER_ABI = parseAbi([
  "struct Epoch { uint64 epochId; int256 delta; uint64 evaluatedAt; bytes32 blocksHash; bytes32 evidenceHash; uint8 status; uint16 reason; }",
  "function statusOf(bytes32 tokenId) view returns (uint8 status, int256 delta, uint64 updatedAt, bool stale)",
  "function latestEpoch(bytes32 tokenId) view returns (Epoch)",
  "function isConsumed(bytes32 messageId) view returns (bool)",
  "function recoveryEndsAt(bytes32 tokenId) view returns (uint64)",
  "function activeIncident(bytes32 tokenId) view returns (bytes32)",
]);

export const ERC20_ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

export const ACCESS_CONTROL_ABI = parseAbi(["function hasRole(bytes32 role, address account) view returns (bool)"]);
