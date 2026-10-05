import type { IncidentBundle } from "../src/types.ts";

const HOME = "ethereum-testnet-sepolia" as const;
const ARB = "ethereum-testnet-sepolia-arbitrum-1" as const;
const BASE = "ethereum-testnet-sepolia-base-1" as const;
const H = (c: string): `0x${string}` => `0x${c.repeat(64)}`;
const A = (c: string): `0x${string}` => `0x${c.repeat(40)}`;
const tx = (chain: typeof HOME | typeof ARB | typeof BASE, c: string, at: string) => ({ chain, hash: H(c), block: "100", timestamp: at });

/** A Kelp Replay incident bundle shaped exactly like the API builds it. */
export const KELP_BUNDLE: IncidentBundle = {
  incident: {
    id: H("1"),
    token: "kETH",
    tokenId: H("2"),
    severity: "SEV1",
    status: "open",
    reason: "DEBIT_NOT_FOUND",
    deltaBefore: "0",
    deltaAfter: "-116500000000000000000000",
    offending: { chain: HOME, tx: tx(HOME, "3", "2026-10-06T09:00:00.000Z"), bridge: "weakbridge", recipient: A("4"), amount: "116500000000000000000000", messageId: H("5"), claimedSrcChain: ARB },
    offendingBlockAt: "2026-10-06T09:00:00.000Z",
    brokenAt: "2026-10-06T09:00:14.000Z",
    timeToBrokenSeconds: 14,
    evidenceHash: H("6"),
    openedAt: "2026-10-06T09:00:14.000Z",
    resolvedAt: null,
    recoveryEndsAt: null,
  },
  evidence: [
    { id: "ev-1", kind: "offending_credit", chain: HOME, at: "2026-10-06T09:00:00.000Z", label: "WeakBridge credited 116,500 kETH to 0x4444...4444 on Ethereum Sepolia", tx: tx(HOME, "3", "2026-10-06T09:00:00.000Z"), blocks: null, messageId: null },
    { id: "ev-2", kind: "debit_search", chain: ARB, at: "2026-10-06T09:00:14.000Z", label: "Searched Arbitrum Sepolia for the matching debit: 0 found", tx: null, blocks: { from: "900", to: "1000", matches: 0 }, messageId: null },
    { id: "ev-3", kind: "breach_report", chain: HOME, at: "2026-10-06T09:00:14.000Z", label: "BREACH DEBIT_NOT_FOUND written on Ethereum Sepolia", tx: tx(HOME, "7", "2026-10-06T09:00:14.000Z"), blocks: null, messageId: null },
    { id: "ev-4", kind: "breach_report", chain: ARB, at: "2026-10-06T09:00:15.000Z", label: "BREACH DEBIT_NOT_FOUND written on Arbitrum Sepolia", tx: tx(ARB, "8", "2026-10-06T09:00:15.000Z"), blocks: null, messageId: null },
    { id: "ev-5", kind: "quarantine_tx", chain: HOME, at: "2026-10-06T09:00:20.000Z", label: "CCIP lanes for kETH frozen on Ethereum Sepolia", tx: tx(HOME, "9", "2026-10-06T09:00:20.000Z"), blocks: null, messageId: null },
    { id: "ev-6", kind: "refused_message", chain: BASE, at: "2026-10-06T09:01:00.000Z", label: "Judge FAIL TOKEN_BROKEN for 1,000 kETH to Base Sepolia", tx: tx(HOME, "a", "2026-10-06T09:00:50.000Z"), blocks: null, messageId: H("b") },
  ],
  actions: [
    { kind: "freeze_ccip_lanes", applied: true, txs: [tx(HOME, "9", "2026-10-06T09:00:20.000Z")], appliedAt: "2026-10-06T09:00:20.000Z" },
    { kind: "taint_recipient", applied: true, txs: [tx(HOME, "c", "2026-10-06T09:00:20.000Z")], appliedAt: "2026-10-06T09:00:20.000Z" },
    { kind: "flip_feed", applied: true, txs: [tx(HOME, "7", "2026-10-06T09:00:14.000Z")], appliedAt: "2026-10-06T09:00:14.000Z" },
    { kind: "page_issuer", applied: false, txs: [], appliedAt: null },
  ],
  blastRadius: [{ chain: HOME, exposure: "116500000000000000000000", taintedAddresses: [A("4")], frozenLanes: ["ccip:ethereum-testnet-sepolia->ethereum-testnet-sepolia-base-1"] }],
  heldMessages: [],
  refused: [],
  resolution: { chain: HOME, issuerSafe: A("d"), quarantineController: A("e"), canResolve: true },
  tokenStatus: "QUARANTINED",
};
