"use client";

import { useMutation } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address, Bytes32, ChainKey, TokenStatus } from "@/lib/api/types";
import { conservationLedgerAbi } from "@/lib/abi";
import { CHAINS } from "@/lib/chains";
import { DATA_SOURCE } from "@/lib/api/client";

const STATUS_BY_VALUE: readonly TokenStatus[] = ["UNKNOWN", "CONSERVED", "DRIFT", "BROKEN", "QUARANTINED", "RECOVERING"];

export interface LedgerRead {
  status: TokenStatus;
  delta: bigint;
  updatedAt: number;
  stale: boolean;
  blockNumber: bigint;
  /** "rpc" for a live read, "fixture" when the app runs on fixture data (no real ledger exists). */
  via: "rpc" | "fixture";
}

/**
 * Reads ConservationLedger.statusOf(tokenId) directly from the chain, bypassing the API.
 * `expected` is the mirrored value, used verbatim in fixtures mode where no contract exists.
 */
export function useVerifyLedger(chain: ChainKey) {
  const client = usePublicClient({ chainId: CHAINS[chain].id });
  return useMutation({
    mutationFn: async ({ ledger, tokenId, expected }: { ledger: Address; tokenId: Bytes32; expected: Omit<LedgerRead, "via" | "blockNumber"> }): Promise<LedgerRead> => {
      if (DATA_SOURCE === "fixtures") {
        await new Promise((r) => setTimeout(r, 400));
        return { ...expected, blockNumber: 0n, via: "fixture" };
      }
      if (!client) throw new Error(`No RPC configured for ${CHAINS[chain].name}`);
      const blockNumber = await client.getBlockNumber();
      const [status, delta, updatedAt, stale] = await client.readContract({
        address: ledger,
        abi: conservationLedgerAbi,
        functionName: "statusOf",
        args: [tokenId],
        blockNumber,
      });
      const name = STATUS_BY_VALUE[status];
      if (!name) throw new Error(`Ledger returned unknown status ${status}`);
      return { status: name, delta, updatedAt: Number(updatedAt), stale, blockNumber, via: "rpc" };
    },
  });
}
