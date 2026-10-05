import type { Queryable } from "@kirchhoff/indexer";
import {
  CHAINS,
  isChainKey,
  type Address,
  type BlastRadiusEntry,
  type Bytes32,
  type ChainKey,
  type ContainmentAction,
  type ContainmentKind,
  type EvidenceItem,
  type HeldMessage,
  type Hex,
  type Incident,
  type IncidentResponse,
  type ReasonCode,
  type Severity,
  type TxRef,
} from "@kirchhoff/sdk";
import { notFound } from "./errors.ts";
import { ReadModel, type TokenRow } from "./readmodel.ts";

/** Everything the Incident Room shows except the AI narrative: deterministic, built from the mirror. */
export type IncidentBundle = Omit<IncidentResponse, "narrative" | "source" | "ledger" | "block" | "servedAt">;

type IncidentRow = {
  id: string;
  token_symbol: string;
  token_id: string;
  reason: ReasonCode;
  evidence_hash: string;
  status: Incident["status"];
  offending_chain: string | null;
  offending_tx: string;
  recipient: string;
  amount: string;
  message_id: string | null;
  delta_after: string | null;
  opened_at: Date;
  broken_at: Date;
  resolved_at: Date | null;
  recovery_ends_at: Date | null;
};

const JUNCTION_OR_LOOP: readonly ReasonCode[] = ["DEBIT_NOT_FOUND", "AMOUNT_MISMATCH", "RECIPIENT_MISMATCH", "DOUBLE_CREDIT", "LOOP_DEFICIT", "RESERVE_SHORTFALL"];
const short = (h: string): string => `${h.slice(0, 6)}...${h.slice(-4)}`;
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function formatUnits(amount: string, decimals: number): string {
  const neg = amount.startsWith("-");
  const digits = (neg ? amount.slice(1) : amount).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "").slice(0, 4);
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export class IncidentBuilder {
  private readonly db: Queryable;
  private readonly rm: ReadModel;
  constructor(db: Queryable, rm: ReadModel) {
    this.db = db;
    this.rm = rm;
  }

  async row(id: string): Promise<IncidentRow> {
    const r = await this.db.query<IncidentRow>("select * from incidents where id = $1", [id.toLowerCase()]);
    const row = r.rows[0];
    if (!row) throw notFound(`incident ${id}`);
    return row;
  }

  async incident(id: string): Promise<{ incident: Incident; token: TokenRow; row: IncidentRow }> {
    const row = await this.row(id);
    const token = await this.rm.tokenRow(row.token_symbol);
    const credit = (
      await this.db.query<{ chain: string; tx_hash: string; block: string; block_time: Date; bridge: string; message_id: string; claimed_src_chain: string | null }>(
        "select chain, tx_hash, block, block_time, bridge, message_id, claimed_src_chain from credits where tx_hash = $1 order by log_index limit 1",
        [row.offending_tx],
      )
    ).rows[0];
    const before = (
      await this.db.query<{ delta: string }>(
        "select delta::text from epochs where token_symbol = $1 and chain = $2 and evaluated_at <= $3 order by epoch_id desc limit 1",
        [row.token_symbol, token.home_chain, row.broken_at],
      )
    ).rows[0];
    const lastBreach = (
      await this.db.query<{ delta: string | null }>(
        "select delta::text from breaches where incident_id = $1 or (token_symbol = $2 and block_time >= $3) order by block_time desc limit 1",
        [row.id, row.token_symbol, row.broken_at],
      )
    ).rows[0];
    const offChain: ChainKey = row.offending_chain && isChainKey(row.offending_chain) ? row.offending_chain : (token.home_chain as ChainKey);
    const offendingAt = credit?.block_time ?? row.broken_at;
    const severity: Severity = JUNCTION_OR_LOOP.includes(row.reason) ? (row.status === "resolved" ? "SEV2" : "SEV1") : "SEV3";
    const incident: Incident = {
      id: row.id as Bytes32,
      token: row.token_symbol,
      tokenId: row.token_id as Bytes32,
      severity,
      status: row.status,
      reason: row.reason,
      deltaBefore: before?.delta ?? "0",
      deltaAfter: row.delta_after ?? lastBreach?.delta ?? token.delta,
      offending: {
        chain: offChain,
        tx: { chain: offChain, hash: row.offending_tx as Hex, block: credit?.block ?? "0", timestamp: offendingAt.toISOString() },
        bridge: credit?.bridge ?? "unknown",
        recipient: row.recipient as Address,
        amount: row.amount,
        messageId: (row.message_id ?? credit?.message_id ?? `0x${"0".repeat(64)}`) as Bytes32,
        claimedSrcChain: credit?.claimed_src_chain && isChainKey(credit.claimed_src_chain) ? credit.claimed_src_chain : offChain,
      },
      offendingBlockAt: offendingAt.toISOString(),
      brokenAt: row.broken_at.toISOString(),
      timeToBrokenSeconds: Math.max(0, Math.round((row.broken_at.getTime() - offendingAt.getTime()) / 1000)),
      evidenceHash: row.evidence_hash as Bytes32,
      openedAt: row.opened_at.toISOString(),
      resolvedAt: iso(row.resolved_at),
      recoveryEndsAt: iso(row.recovery_ends_at),
    };
    return { incident, token, row };
  }

  /** The deterministic evidence bundle (PRD section 11 Narrator input). Ids are stable: ev-1, ev-2, ... in a fixed order. */
  async bundle(id: string): Promise<IncidentBundle> {
    const { incident, token, row } = await this.incident(id);
    const evidence: EvidenceItem[] = [];
    const add = (item: Omit<EvidenceItem, "id">): void => {
      evidence.push({ id: `ev-${evidence.length + 1}`, ...item });
    };
    const units = (a: string): string => `${formatUnits(a, token.decimals)} ${token.symbol}`;
    const off = incident.offending;
    add({
      kind: "offending_credit",
      chain: off.chain,
      at: incident.offendingBlockAt,
      label: `${off.bridge === "weakbridge" ? "WeakBridge" : off.bridge} credited ${units(off.amount)} to ${short(off.recipient)} on ${CHAINS[off.chain].label} for message ${short(off.messageId)}`,
      tx: off.tx,
      blocks: null,
      messageId: null,
    });
    const src = off.claimedSrcChain;
    const srcState = (await this.db.query<{ block: string }>("select block from chain_state where chain = $1", [src])).rows[0];
    const bridgeCfg = token.config.bridges.find((b) => b.id === off.bridge);
    const window = BigInt(bridgeCfg?.searchWindowBlocks ?? "100");
    const to = srcState ? BigInt(srcState.block) : 0n;
    const matches = (await this.db.query<{ n: number }>("select count(*)::int as n from debits where message_id = $1", [off.messageId])).rows[0]?.n ?? 0;
    add({
      kind: "debit_search",
      chain: src,
      at: incident.brokenAt,
      label: `Searched ${CHAINS[src].label} for the matching debit of message ${short(off.messageId)}: ${matches} found`,
      tx: null,
      blocks: { from: (to > window ? to - window : 0n).toString(), to: to.toString(), matches },
      messageId: null,
    });
    const breaches = await this.db.query<{ chain: ChainKey; tx_hash: Hex; block: string; block_time: Date; reason: ReasonCode; delta: string | null }>(
      "select chain, tx_hash, block, block_time, reason, delta::text from breaches where incident_id = $1 order by block_time, chain",
      [row.id],
    );
    for (const b of breaches.rows) {
      add({
        kind: "breach_report",
        chain: b.chain,
        at: b.block_time.toISOString(),
        label: `BREACH ${b.reason} written to the ConservationLedger on ${CHAINS[b.chain].label}`,
        tx: { chain: b.chain, hash: b.tx_hash, block: b.block, timestamp: b.block_time.toISOString() },
        blocks: null,
        messageId: null,
      });
    }
    const actionsRows = await this.db.query<{ chain: ChainKey; tx_hash: Hex; block: string; block_time: Date; kind: string; account: string | null }>(
      `select chain, tx_hash, block, block_time, kind, account from incident_actions
       where (incident_id = $1 or (token_symbol = $2 and kind = 'quarantine_applied' and block_time >= $3)) and kind <> 'breach_report'
       order by block_time, chain, log_index`,
      [row.id, row.token_symbol, row.broken_at],
    );
    for (const a of actionsRows.rows) {
      const label =
        a.kind === "lanes_frozen"
          ? `CCIP lanes for ${token.symbol} frozen on ${CHAINS[a.chain].label}`
          : a.kind === "tainted"
            ? `${short(a.account ?? "")} tainted on ${CHAINS[a.chain].label}`
            : a.kind === "quarantine_applied"
              ? `Status QUARANTINED on ${CHAINS[a.chain].label}`
              : `${a.kind.replace(/_/g, " ")} on ${CHAINS[a.chain].label}`;
      add({ kind: "quarantine_tx", chain: a.chain, at: a.block_time.toISOString(), label, tx: { chain: a.chain, hash: a.tx_hash, block: a.block, timestamp: a.block_time.toISOString() }, blocks: null, messageId: null });
    }
    const refused = await this.rm.verdicts(row.token_symbol, 50, null, { incidentId: row.id });
    for (const v of refused.items.filter((x) => x.decision === "FAIL")) {
      add({
        kind: "refused_message",
        chain: v.dstChain,
        at: v.evaluatedAt,
        label: `Judge FAIL ${v.reason} for ${units(v.amount)} from ${CHAINS[v.srcChain].label} to ${CHAINS[v.dstChain].label}`,
        tx: v.sourceTx,
        blocks: null,
        messageId: v.messageId,
      });
    }
    const lab = (await this.db.query<{ run: { steps?: { key: string; txs?: TxRef[]; note?: string | null }[] } }>("select run from lab_runs where run->>'incidentId' = $1 order by started_at desc limit 1", [row.id])).rows[0];
    const guardStep = lab?.run.steps?.find((s) => s.key === "guard_and_lending");
    for (const tx of guardStep?.txs ?? []) {
      add({ kind: "guard_revert", chain: tx.chain, at: tx.timestamp, label: guardStep?.note ?? `Guarded transfer reverted on ${CHAINS[tx.chain].label}`, tx, blocks: null, messageId: null });
    }
    const confirm = await this.db.query<{ chain: ChainKey; tx_hash: Hex; block: string; block_time: Date; delta: string | null }>(
      "select chain, tx_hash, block, block_time, delta::text from breaches where token_symbol = $1 and reason = 'LOOP_DEFICIT' and incident_id <> $2 and block_time >= $3 and chain = $4 order by block_time limit 1",
      [row.token_symbol, row.id, row.broken_at, token.home_chain],
    );
    for (const e of confirm.rows) {
      add({
        kind: "epoch_report",
        chain: e.chain,
        at: e.block_time.toISOString(),
        label: `Loop Rule confirmed the deficit: delta ${units(e.delta ?? "0")}`,
        tx: { chain: e.chain, hash: e.tx_hash, block: e.block, timestamp: e.block_time.toISOString() },
        blocks: null,
        messageId: null,
      });
    }

    const actions: ContainmentAction[] = [];
    const txsOf = (kinds: string[]): TxRef[] =>
      actionsRows.rows.filter((a) => kinds.includes(a.kind)).map((a) => ({ chain: a.chain, hash: a.tx_hash, block: a.block, timestamp: a.block_time.toISOString() }));
    const firstAt = (txs: TxRef[]): string | null => (txs.length > 0 ? txs.map((t) => t.timestamp).sort()[0] ?? null : null);
    const pages = await this.db.query<{ sent_at: Date | null }>("select sent_at from notifications where incident_id = $1 and status = 'sent' order by sent_at", [row.id]);
    for (const kind of token.config.onBroken) {
      let txs: TxRef[] = [];
      let appliedAt: string | null;
      if (kind === "freeze_ccip_lanes") txs = txsOf(["lanes_frozen"]);
      else if (kind === "taint_recipient") txs = txsOf(["tainted"]);
      else if (kind === "flip_feed") txs = breaches.rows.map((b) => ({ chain: b.chain, hash: b.tx_hash, block: b.block, timestamp: b.block_time.toISOString() }));
      if (kind === "page_issuer") appliedAt = pages.rows[0]?.sent_at?.toISOString() ?? null;
      else appliedAt = firstAt(txs);
      actions.push({ kind: kind as ContainmentKind, applied: kind === "page_issuer" ? pages.rows.length > 0 : txs.length > 0, txs, appliedAt });
    }

    const status = await this.rm.status(row.token_symbol);
    const blastRadius: BlastRadiusEntry[] = [];
    const taints = await this.db.query<{ chain: string; account: Address }>("select chain, account from taints where incident_id = $1 and active", [row.id]);
    const forged = await this.db.query<{ chain: string; amount: string }>(
      "select c.chain, sum(c.amount)::text as amount from credits c where c.tx_hash in (select offending_tx from breaches where incident_id = $1) group by c.chain",
      [row.id],
    );
    for (const c of status.chains) {
      blastRadius.push({
        chain: c.chain,
        exposure: forged.rows.find((f) => f.chain === c.chain)?.amount ?? "0",
        taintedAddresses: [...new Set(taints.rows.filter((t) => t.chain === c.chain).map((t) => t.account))],
        frozenLanes: status.lanes.filter((l) => l.frozen && (l.srcChain === c.chain || l.dstChain === c.chain)).map((l) => l.id),
      });
    }
    const heldMessages: HeldMessage[] = refused.items
      .filter((v) => v.decision === "FAIL" && v.executionTx === null)
      .map((v) => ({ messageId: v.messageId, srcChain: v.srcChain, dstChain: v.dstChain, amount: v.amount, sender: v.sender, heldAt: v.evaluatedAt, reason: v.reason }));
    const home = await this.rm.homeChain(token);
    return {
      incident,
      evidence,
      actions,
      blastRadius,
      heldMessages,
      refused: refused.items.filter((v) => v.decision === "FAIL"),
      resolution: {
        chain: home.chain,
        issuerSafe: (home.issuer_safe ?? "0x0000000000000000000000000000000000000000"),
        quarantineController: home.quarantine,
        canResolve: token.status === "QUARANTINED",
      },
      tokenStatus: token.status,
    };
  }
}
