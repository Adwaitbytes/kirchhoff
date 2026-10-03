import { toEventSelector } from "viem";
import type { Hex } from "./types.ts";

/**
 * Event signatures the workflows subscribe to: ledger and registry events
 * from contracts/src/interfaces (cross-checked by test/compile.test.ts), plus
 * the standard ERC-20 Transfer and OpenZeppelin AccessControl RoleGranted.
 */
export const CONTRACT_EVENTS = {
  BreachRecorded:
    "BreachRecorded(bytes32 indexed tokenId, uint16 reason, bytes32 evidenceHash, uint64 offendingChain, bytes32 offendingTx, address recipient, uint256 amount)",
  EpochRecorded: "EpochRecorded(bytes32 indexed tokenId, uint64 indexed epochId, int256 delta, uint8 status)",
  StatusChanged: "StatusChanged(bytes32 indexed tokenId, uint8 from, uint8 to, uint16 reason)",
  SpecActivated: "SpecActivated(bytes32 indexed tokenId, bytes32 indexed specHash, string specURI, uint64 version)",
  Transfer: "Transfer(address indexed from, address indexed to, uint256 value)",
  RoleGranted: "RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
} as const;

export type ContractEvent = keyof typeof CONTRACT_EVENTS;

export function eventTopic(name: ContractEvent): Hex {
  return toEventSelector(CONTRACT_EVENTS[name]);
}

/** Canonical Multicall3, deployed at the same address on every chain the demo uses. */
export const MULTICALL3: Hex = "0xcA11bde05977b3631167028862bE2a173976CA11";
