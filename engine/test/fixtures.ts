import { keccak256, stringToBytes } from "viem";
import { tokenId } from "../src/encoding.ts";
import { WEAKBRIDGE_EVENTS } from "../src/adapters/weakbridge.ts";
import type { Credit, Debit, Hex, TokenSpec } from "../src/types.ts";

export const HOME = 16015286601757825753n;
export const ARB = 3478487238524512106n;
export const BASE = 10344971235874465080n;

export const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
export const hash = (label: string): Hex => keccak256(stringToBytes(label));

export const CANONICAL = addr(0x1001);
export const ESCROW = addr(0x1002);
export const REMOTE_ARB = addr(0x2001);
export const REMOTE_BASE = addr(0x3001);
export const POOL_HOME = addr(0x1003);
export const POOL_ARB = addr(0x2002);
export const POOL_BASE = addr(0x3002);
export const WB_ARB = addr(0x2003);
export const ONRAMP_HOME = addr(0x1004);
export const OFFRAMP_HOME = addr(0x1005);
export const LOCKBOX = addr(0x1006);
export const ONRAMP_ARB = addr(0x2004);
export const OFFRAMP_ARB = addr(0x2005);
export const ONRAMP_BASE = addr(0x3004);
export const OFFRAMP_BASE = addr(0x3005);
export const WB_BASE = addr(0x3003);
export const ALICE = addr(0xa11ce);
export const BOB = addr(0xb0b);
export const MALLORY = addr(0xbad);

const E18 = 10n ** 18n;
export const units = (n: bigint): bigint => n * E18;

export type SpecOptions = {
  model?: TokenSpec["model"];
  arbDecimals?: number;
  baseDecimals?: number;
  homeDecimals?: number;
  flowLimit?: bigint | null;
  tolerance?: bigint;
  breachConfirmations?: number;
  porFeed?: Hex | null;
  reserveDecimals?: number;
};

/** The kETH demo spec in typed form, with concrete addresses. */
export function makeSpec(o: SpecOptions = {}): TokenSpec {
  const homeDecimals = o.homeDecimals ?? 18;
  return {
    specVersion: 1,
    token: "kETH",
    tokenId: tokenId("kETH"),
    model: o.model ?? "lock_release_home",
    unit: "tokens",
    home: {
      chain: { name: "ethereum-testnet-sepolia", selector: HOME, alias: "home" },
      canonical: CANONICAL,
      escrow: (o.model ?? "lock_release_home") === "lock_release_home" ? ESCROW : null,
      decimals: homeDecimals,
    },
    remotes: [
      {
        chain: { name: "ethereum-testnet-sepolia-arbitrum-1", selector: ARB, alias: "arb" },
        token: REMOTE_ARB,
        minters: ["ccip_pool_arb", "weakbridge_arb"],
        decimals: o.arbDecimals ?? 18,
      },
      {
        chain: { name: "ethereum-testnet-sepolia-base-1", selector: BASE, alias: "base" },
        token: REMOTE_BASE,
        minters: ["ccip_pool_base"],
        decimals: o.baseDecimals ?? 18,
      },
    ],
    bridges: [
      {
        id: "ccip",
        kind: "ccip_v2",
        pools: { home: POOL_HOME, arb: POOL_ARB, base: POOL_BASE },
        onramps: { home: ONRAMP_HOME, arb: ONRAMP_ARB, base: ONRAMP_BASE },
        offramps: { home: OFFRAMP_HOME, arb: OFFRAMP_ARB, base: OFFRAMP_BASE },
        lockbox: (o.model ?? "lock_release_home") === "lock_release_home" ? LOCKBOX : null,
        searchWindowBlocks: 100n,
        maxDeliverySeconds: 1200,
      },
      {
        id: "weakbridge",
        kind: "custom",
        contracts: { home: ESCROW, arb: WB_ARB, base: WB_BASE },
        events: WEAKBRIDGE_EVENTS,
        searchWindowBlocks: 100n,
        maxDeliverySeconds: 1200,
      },
    ],
    reserves: { porFeed: o.porFeed ?? null, decimals: o.reserveDecimals ?? homeDecimals },
    confidence: { default: "finalized", overrides: { "ethereum-testnet-sepolia-base-1": "safe" } },
    rules: {
      junction: { matchWindowSeconds: 1200n },
      loop: { toleranceWei: o.tolerance ?? 0n, breachConfirmations: o.breachConfirmations ?? 1 },
      soft: { flowLimitPerHour: o.flowLimit === undefined ? units(50000n) : o.flowLimit },
      stalenessSeconds: 120n,
      onStale: "fail_closed",
    },
    response: {
      onBroken: ["freeze_ccip_lanes", "taint_recipient", "flip_feed", "page_issuer"],
      replayRequires: "issuer_multisig",
      recoveryTimelockSeconds: 3600n,
    },
  };
}

export function debit(over: Partial<Debit> & { messageId: Hex }): Debit {
  return {
    srcChain: HOME,
    dstChain: ARB,
    amount: units(10n),
    recipient: ALICE,
    txHash: hash(`debit-tx:${over.messageId}`),
    block: 100n,
    ...over,
  };
}

/** The credit that exactly matches a debit. */
export function creditFor(d: Debit, over: Partial<Credit> = {}): Credit {
  const base: Credit = {
    messageId: d.messageId,
    claimedSrcChain: d.srcChain,
    dstChain: d.dstChain,
    amount: d.amount,
    txHash: hash(`credit-tx:${d.messageId}`),
    block: 200n,
  };
  return { ...base, ...(d.recipient === undefined ? {} : { recipient: d.recipient }), ...over };
}
