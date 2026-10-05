import type { PublicClient } from "viem";
import { createChainClient, redactRpcError } from "@kirchhoff/indexer";
import {
  CHAINS,
  ledgerAbi,
  quarantineAbi,
  statusFromValue,
  tokenIdOf,
  type Address,
  type ChainKey,
  type CheckTransferRequest,
  type CheckTransferResponse,
  type NetworkMode,
  type ReasonCode,
  type TokenStatus,
} from "@kirchhoff/sdk";
import { ApiFailure } from "./errors.ts";
import type { ChainRow, TokenRow } from "./readmodel.ts";

/**
 * POST /check-transfer reads CURRENT onchain status over RPC (not the mirror), the same facts the
 * Judge reads for a real CCIP message: the token's ConservationLedger status on the source and
 * destination chains, the lane freeze flag, and whether the sender is tainted. A dry run only:
 * the real verdict always comes from the Judge in each CCV cell.
 */

export type ChainClients = { get(chain: ChainKey, chainId: number): PublicClient };

export function chainClients(rpc: Record<ChainKey, string[]>, mode: NetworkMode): ChainClients {
  const cache = new Map<ChainKey, PublicClient>();
  return {
    get(chain) {
      let c = cache.get(chain);
      if (!c) {
        c = createChainClient(chain, mode, rpc[chain], 3_000);
        cache.set(chain, c);
      }
      return c;
    },
  };
}

type Read = { chain: ChainKey; status: TokenStatus; stale: boolean; frozen: boolean; tainted: boolean; block: bigint; timestamp: Date; ledger: Address };

async function readChain(clients: ChainClients, row: ChainRow, tokenId: `0x${string}`, sender: Address, checkTaint: boolean): Promise<Read> {
  const client = clients.get(row.chain, row.chain_id);
  try {
    const block = await client.getBlock({ blockTag: "latest" });
    const at = { blockNumber: block.number } as const;
    const [statusTuple, frozen, tainted] = await Promise.all([
      client.readContract({ address: row.ledger, abi: ledgerAbi, functionName: "statusOf", args: [tokenId], ...at }),
      client.readContract({ address: row.quarantine, abi: quarantineAbi, functionName: "isFrozen", args: [tokenId], ...at }),
      checkTaint ? client.readContract({ address: row.quarantine, abi: quarantineAbi, functionName: "isTainted", args: [tokenId, sender], ...at }) : Promise.resolve(false),
    ]);
    const [status, , , stale] = statusTuple;
    return { chain: row.chain, status: statusFromValue(status), stale, frozen, tainted, block: block.number, timestamp: new Date(Number(block.timestamp) * 1000), ledger: row.ledger };
  } catch (e) {
    throw new ApiFailure(502, "UPSTREAM_RPC", `Could not read ${CHAINS[row.chain].label}: ${redactRpcError(e)}`, row.chain);
  }
}

const SEVERITY: Readonly<Record<TokenStatus, number>> = { CONSERVED: 0, DRIFT: 1, UNKNOWN: 2, RECOVERING: 3, QUARANTINED: 4, BROKEN: 5 };

export function decide(
  src: Pick<Read, "status" | "stale" | "frozen" | "tainted">,
  dst: Pick<Read, "status" | "stale" | "frozen">,
  onStale: TokenRow["config"]["onStale"],
  symbol: string,
  dstLabel: string,
): { wouldPass: boolean; reason: ReasonCode; advice: string; status: TokenStatus } {
  const status = SEVERITY[src.status] > SEVERITY[dst.status] ? src.status : dst.status;
  const stop = (reason: ReasonCode, advice: string) => ({ wouldPass: false, reason, advice, status });
  if (status === "BROKEN") return stop("TOKEN_BROKEN", `Do not move ${symbol}: its supply no longer adds up across chains. Every CCIP transfer is refused until the issuer recovers.`);
  if (status === "QUARANTINED") return stop("TOKEN_QUARANTINED", `Do not move ${symbol}: it is quarantined after a breach. Held messages can be replayed after recovery.`);
  if (status === "RECOVERING") return stop("TOKEN_RECOVERING", `Wait: ${symbol} is in its recovery timelock. Transfers resume once a fresh epoch confirms conservation.`);
  if (src.frozen || dst.frozen) return stop("TOKEN_QUARANTINED", `Do not move ${symbol}: its CCIP lanes are frozen.`);
  if (src.tainted) return stop("TOKEN_QUARANTINED", `Do not move ${symbol} from this sender: the address is tainted by an incident.`);
  if (status === "UNKNOWN" || src.stale || dst.stale) {
    if (onStale === "fail_closed") return stop("STATUS_STALE", `Wait: ${symbol} has no fresh conservation epoch, and its spec fails closed. Retry in a minute.`);
    return { wouldPass: true, reason: "STATUS_STALE", advice: `${symbol} status is stale; its spec fails open, so the transfer would pass. Proceed with caution.`, status };
  }
  if (status === "DRIFT") return { wouldPass: true, reason: "FLOW_LIMIT", advice: `${symbol} is conserved but flagged (soft rule). The transfer to ${dstLabel} would pass.`, status };
  return { wouldPass: true, reason: "OK", advice: `${symbol} adds up across every chain. The transfer to ${dstLabel} would pass if its debit matches.`, status };
}

export async function checkTransfer(
  req: CheckTransferRequest,
  token: TokenRow | null,
  chains: ChainRow[],
  clients: ChainClients,
): Promise<Omit<CheckTransferResponse, "servedAt" | "source"> & { servedAt?: string }> {
  const dstRow = chains.find((c) => c.chain === req.dstChain);
  const srcRow = chains.find((c) => c.chain === req.srcChain);
  if (token === null || !dstRow || !srcRow || !token.chains.includes(req.srcChain) || !token.chains.includes(req.dstChain)) {
    const ledgerRow = dstRow ?? srcRow ?? chains[0];
    if (!ledgerRow) throw new ApiFailure(404, "NOT_FOUND", "no KIRCHHOFF deployment is indexed yet");
    return {
      ledger: { chain: ledgerRow.chain, address: ledgerRow.ledger },
      block: { chain: ledgerRow.chain, number: "0", timestamp: new Date(0).toISOString() },
      wouldPass: false,
      reason: "UNKNOWN_TOKEN",
      advice: `${req.token} is not protected by KIRCHHOFF on ${CHAINS[req.srcChain].label} to ${CHAINS[req.dstChain].label}. KIRCHHOFF cannot vouch for this transfer.`,
      status: "UNKNOWN",
    };
  }
  const tokenId = tokenIdOf(token.symbol);
  const [src, dst] = await Promise.all([readChain(clients, srcRow, tokenId, req.sender, true), readChain(clients, dstRow, tokenId, req.sender, false)]);
  const d = decide(src, dst, token.config.onStale, token.symbol, CHAINS[req.dstChain].label);
  return {
    // Documented exception to MirrorMeta's home-ledger default: the Judge reads the destination ledger.
    ledger: { chain: dst.chain, address: dst.ledger },
    block: { chain: dst.chain, number: dst.block.toString(), timestamp: dst.timestamp.toISOString() },
    ...d,
  };
}
