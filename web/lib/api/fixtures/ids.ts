import { encodeAbiParameters, keccak256, toBytes, getAddress } from "viem";
import type { Address, Bytes32, ChainKey, TxRef } from "@/lib/api/types";

/** Deterministic ids for fixture data. Same label, same value, on every run. */

export function fxHash(label: string): Bytes32 {
  return keccak256(toBytes(`kirchhoff-fixture:${label}`));
}

export function fxAddress(label: string): Address {
  return getAddress(`0x${fxHash(label).slice(26)}`);
}

export function tokenIdOf(symbol: string): Bytes32 {
  return keccak256(toBytes(symbol));
}

/** incidentId = keccak256(abi.encode(tokenId, evidenceHash)) (docs/INTERFACES.md). */
export function incidentIdOf(tokenId: Bytes32, evidenceHash: Bytes32): Bytes32 {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [tokenId, evidenceHash]));
}

interface ChainClock {
  baseBlock: bigint;
  blockMs: number;
}

const CLOCKS: Record<ChainKey, ChainClock> = {
  "ethereum-testnet-sepolia": { baseBlock: 9_412_800n, blockMs: 12_000 },
  "ethereum-testnet-sepolia-arbitrum-1": { baseBlock: 205_118_400n, blockMs: 250 },
  "ethereum-testnet-sepolia-base-1": { baseBlock: 31_204_600n, blockMs: 2_000 },
};

export class BlockClock {
  constructor(private readonly anchorMs: number) {}

  blockAt(chain: ChainKey, ms: number): bigint {
    const c = CLOCKS[chain];
    return c.baseBlock + BigInt(Math.floor((ms - this.anchorMs) / c.blockMs));
  }

  blockMs(chain: ChainKey): number {
    return CLOCKS[chain].blockMs;
  }

  tx(chain: ChainKey, label: string, ms: number): TxRef {
    return { chain, hash: fxHash(`tx:${label}`), block: this.blockAt(chain, ms).toString(), timestamp: new Date(ms).toISOString() };
  }
}
