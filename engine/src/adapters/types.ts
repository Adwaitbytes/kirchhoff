import type { ChainSel, Credit, Debit, Hex, TokenSpec } from "../types.ts";

/** The subset of an EVM log the adapters need; matches viem's Log and CRE's filterLogs output once mapped. */
export type Log = {
  address: Hex;
  topics: readonly Hex[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: bigint;
};

/** PRD section 10 adapter contract. */
export interface BridgeAdapter {
  /** "ccip_v2", "layerzero_oft", "weakbridge", or the spec bridge id for custom bridges. */
  id: string;
  debitTopics(spec: TokenSpec, chain: ChainSel): Hex[];
  creditTopics(spec: TokenSpec, chain: ChainSel): Hex[];
  decodeDebit(log: Log, chain: ChainSel): Debit | null;
  decodeCredit(log: Log, chain: ChainSel): Credit | null;
  /**
   * Debits in one transaction's logs, in log order. Bridges whose message id
   * lives in a different log than the value movement (CCIP 2.0) can only be
   * decoded this way; for single-event bridges it maps decodeDebit.
   */
  decodeTxDebits(logs: readonly Log[], chain: ChainSel): Debit[];
  decodeTxCredits(logs: readonly Log[], chain: ChainSel): Credit[];
  /** Which indexed topic carries the message id, for filterLogs. */
  messageIdTopicIndex: 1 | 2 | 3;
  /** Used to size the match window. */
  maxDeliverySeconds: number;
}
