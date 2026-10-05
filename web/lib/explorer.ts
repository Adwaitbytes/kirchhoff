import type { Address, Bytes32, ChainKey, TxHash, TxRef } from "@/lib/api/types";
import { CHAINS } from "@/lib/chains";

/** Explorer link builders. Every number in the UI resolves to one of these (PRD section 12). */

export function txUrl(chain: ChainKey, hash: TxHash): string {
  return `${CHAINS[chain].explorer}/tx/${hash}`;
}

export function txRefUrl(tx: TxRef): string {
  return txUrl(tx.chain, tx.hash);
}

export function addressUrl(chain: ChainKey, address: Address): string {
  return `${CHAINS[chain].explorer}/address/${address}`;
}

/** Contract "Read" tab: the one-click onchain read behind a mirrored value. */
export function readContractUrl(chain: ChainKey, address: Address): string {
  return `${CHAINS[chain].explorer}/address/${address}#readContract`;
}

export function tokenUrl(chain: ChainKey, token: Address): string {
  return `${CHAINS[chain].explorer}/token/${token}`;
}

/** Token page filtered to one holder: the escrow balance behind the Backing figure. */
export function escrowBalanceUrl(chain: ChainKey, token: Address, holder: Address): string {
  return `${CHAINS[chain].explorer}/token/${token}?a=${holder}`;
}

export function blockUrl(chain: ChainKey, block: string): string {
  return `${CHAINS[chain].explorer}/block/${block}`;
}

export function ccipMessageUrl(messageId: Bytes32): string {
  return `https://ccip.chain.link/msg/${messageId}`;
}

export function safeQueueUrl(chain: ChainKey, safe: Address): string {
  return `https://app.safe.global/transactions/queue?safe=${CHAINS[chain].safePrefix}:${safe}`;
}

/** Safe Transaction Builder opened for the issuer Safe. Calldata is pasted from the prepared payload. */
export function safeTxBuilderUrl(chain: ChainKey, safe: Address): string {
  const appUrl = encodeURIComponent("https://apps-portal.safe.global/tx-builder");
  return `https://app.safe.global/apps/open?safe=${CHAINS[chain].safePrefix}:${safe}&appUrl=${appUrl}`;
}

export function shortHash(hash: string, head = 6, tail = 4): string {
  if (hash.length <= head + tail + 2) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}
