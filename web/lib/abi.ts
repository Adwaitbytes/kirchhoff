/** Minimal ABIs for read-only verification (docs/INTERFACES.md, PRD section 7). */

export const conservationLedgerAbi = [
  {
    type: "function",
    name: "statusOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "bytes32" }],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "delta", type: "int256" },
      { name: "updatedAt", type: "uint64" },
      { name: "stale", type: "bool" },
    ],
  },
] as const;

export const quarantineControllerAbi = [
  {
    type: "function",
    name: "resolve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "bytes32" },
      { name: "incidentId", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "isFrozen",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const conservationFeedAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;
