import { CHAINS, CHAIN_KEYS, REASON_BY_VALUE, chainBySelector, isChainKey, type ChainKey, type ReasonCode } from "@kirchhoff/sdk";
import { withTransaction, type Db } from "./db.ts";
import { refreshMatches } from "./matches.ts";

/**
 * One Judge outcome as a CCV cell reports it to POST /internal/verdicts. Verdicts are offchain
 * (the verifier only signs or not), so this sink is the read model's only source for them.
 */
export type JudgeVerdictReport = {
  cellId: string;
  messageId: string;
  decision: "PASS" | "FAIL" | "PENDING";
  reason: ReasonCode;
  note: string;
  latencyMs: number;
  evaluatedAt: string;
  srcChain: ChainKey;
  dstChain: ChainKey;
  amount: string;
  sender: string;
  receiver: string;
  token: string | null;
  sourceTxHash: string | null;
};

export class VerdictValidationError extends Error {
  override readonly name = "VerdictValidationError";
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
/** Hook payload addresses are 32-byte left-padded (docs/INTERFACES.md revision 2). */
const HEX_ADDR32 = /^0x0{24}[0-9a-fA-F]{40}$/;
const UINT = /^\d{1,78}$/;
const CELL = /^[A-Za-z0-9._-]{1,64}$/;

function chainOf(v: unknown, field: string): ChainKey {
  if (isChainKey(v)) return v;
  if (typeof v === "string" && /^\d{1,20}$/.test(v)) {
    const c = chainBySelector(BigInt(v));
    if (c) return c.key;
  }
  throw new VerdictValidationError(`${field} must be one of ${CHAIN_KEYS.join(", ")} or its CCIP selector`);
}

function address(v: unknown, field: string): string {
  if (typeof v !== "string") throw new VerdictValidationError(`${field} must be a hex address`);
  if (HEX_ADDR.test(v)) return v.toLowerCase();
  if (HEX_ADDR32.test(v)) return `0x${v.slice(-40)}`.toLowerCase();
  throw new VerdictValidationError(`${field} must be a 20-byte or left-padded 32-byte address`);
}

/** Validates an untrusted report body. Throws VerdictValidationError naming the first bad field. */
export function parseVerdictReport(input: unknown): JudgeVerdictReport {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new VerdictValidationError("body must be an object");
  const o = input as Record<string, unknown>;
  if (typeof o.cellId !== "string" || !CELL.test(o.cellId)) throw new VerdictValidationError("cellId must match [A-Za-z0-9._-]{1,64}");
  if (typeof o.messageId !== "string" || !HEX32.test(o.messageId)) throw new VerdictValidationError("messageId must be bytes32 hex");
  if (o.decision !== "PASS" && o.decision !== "FAIL" && o.decision !== "PENDING") throw new VerdictValidationError("decision must be PASS, FAIL or PENDING");
  if (typeof o.reason !== "string" || !(REASON_BY_VALUE as readonly string[]).includes(o.reason)) throw new VerdictValidationError("reason must be a reason code");
  const note = typeof o.note === "string" ? o.note.slice(0, 200) : "";
  if (typeof o.latencyMs !== "number" || !Number.isInteger(o.latencyMs) || o.latencyMs < 0 || o.latencyMs > 600_000) {
    throw new VerdictValidationError("latencyMs must be an integer 0..600000");
  }
  const evaluatedAt = typeof o.evaluatedAt === "string" ? o.evaluatedAt : new Date().toISOString();
  if (Number.isNaN(Date.parse(evaluatedAt))) throw new VerdictValidationError("evaluatedAt must be ISO-8601");
  if (typeof o.amount !== "string" || !UINT.test(o.amount)) throw new VerdictValidationError("amount must be a base-unit decimal string");
  const token = o.token === undefined || o.token === null ? null : typeof o.token === "string" && /^[A-Za-z0-9]{1,16}$/.test(o.token) ? o.token : undefined;
  if (token === undefined) throw new VerdictValidationError("token must be a symbol");
  const sourceTxHash = o.sourceTxHash === undefined || o.sourceTxHash === null ? null : typeof o.sourceTxHash === "string" && HEX32.test(o.sourceTxHash) ? o.sourceTxHash.toLowerCase() : undefined;
  if (sourceTxHash === undefined) throw new VerdictValidationError("sourceTxHash must be bytes32 hex");
  return {
    cellId: o.cellId,
    messageId: o.messageId.toLowerCase(),
    decision: o.decision,
    reason: o.reason as ReasonCode,
    note,
    latencyMs: o.latencyMs,
    evaluatedAt: new Date(evaluatedAt).toISOString(),
    srcChain: chainOf(o.srcChain, "srcChain"),
    dstChain: chainOf(o.dstChain, "dstChain"),
    amount: o.amount,
    sender: address(o.sender, "sender"),
    receiver: address(o.receiver, "receiver"),
    token,
    sourceTxHash,
  };
}

const STATUS_REASONS: readonly ReasonCode[] = ["TOKEN_BROKEN", "TOKEN_QUARANTINED", "TOKEN_RECOVERING"];

/**
 * Stores the raw cell report, then rebuilds the committee row for the message: each cell's latest
 * definitive decision counts once; PENDING (HTTP 503 to the verifier) is kept raw but never shown
 * as a verdict. The displayed decision is FAIL when any cell failed, because one refusal already
 * withholds that cell's signature.
 */
export async function ingestVerdict(db: Db, report: JudgeVerdictReport, defaultToken: string): Promise<{ stored: boolean }> {
  const symbol = report.token ?? defaultToken;
  return withTransaction(db, async (client) => {
    const ins = await client.query(
      `insert into judge_verdicts (cell_id, message_id, token_symbol, decision, reason, note, latency_ms, src_chain, dst_chain, amount, sender, receiver, source_tx, evaluated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict (cell_id, message_id, decision) do update set reason = excluded.reason, note = excluded.note, latency_ms = excluded.latency_ms,
         evaluated_at = excluded.evaluated_at, received_at = now()`,
      [
        report.cellId,
        report.messageId,
        symbol,
        report.decision,
        report.reason,
        report.note,
        report.latencyMs,
        report.srcChain,
        report.dstChain,
        report.amount,
        report.sender,
        report.receiver,
        report.sourceTxHash,
        report.evaluatedAt,
      ],
    );
    if (report.decision === "PENDING") return { stored: (ins.rowCount ?? 0) > 0 };
    const cells = await client.query<{ cell_id: string; decision: "PASS" | "FAIL"; reason: string; note: string; latency_ms: number; evaluated_at: Date }>(
      `select distinct on (cell_id) cell_id, decision, reason, note, latency_ms, evaluated_at from judge_verdicts
       where message_id = $1 and decision <> 'PENDING' order by cell_id, evaluated_at desc`,
      [report.messageId],
    );
    const fail = cells.rows.find((c) => c.decision === "FAIL");
    const lead = fail ?? cells.rows[0];
    if (!lead) return { stored: true };
    const incident = STATUS_REASONS.includes(lead.reason as ReasonCode)
      ? ((await client.query<{ id: string | null }>("select active_incident_id as id from tokens where symbol = $1", [symbol])).rows[0]?.id ?? null)
      : null;
    const debit = await client.query<{ tx_hash: string; block: string; block_time: Date }>(
      "select tx_hash, block, block_time from debits where message_id = $1 order by block limit 1",
      [report.messageId],
    );
    const src = debit.rows[0];
    await client.query(
      `insert into verdicts (message_id, token_symbol, evaluated_at, src_chain, dst_chain, amount, sender, receiver, decision, reason, note, cells,
                             source_tx, source_block, source_time, incident_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       on conflict (message_id) do update set evaluated_at = excluded.evaluated_at, decision = excluded.decision, reason = excluded.reason,
         note = excluded.note, cells = excluded.cells, source_tx = coalesce(excluded.source_tx, verdicts.source_tx),
         source_block = coalesce(excluded.source_block, verdicts.source_block), source_time = coalesce(excluded.source_time, verdicts.source_time),
         incident_id = coalesce(excluded.incident_id, verdicts.incident_id)`,
      [
        report.messageId,
        symbol,
        lead.evaluated_at,
        report.srcChain,
        report.dstChain,
        report.amount,
        report.sender,
        report.receiver,
        fail ? "FAIL" : "PASS",
        lead.reason,
        lead.note,
        JSON.stringify(cells.rows.map((c) => ({ cellId: c.cell_id, decision: c.decision, latencyMs: c.latency_ms }))),
        src?.tx_hash ?? report.sourceTxHash,
        src?.block ?? null,
        src?.block_time ?? null,
        incident,
      ],
    );
    await refreshMatches(client, [report.messageId]);
    await client.query("insert into stream_events (token_symbol, channel, ref) values ($1, 'verdict', $2)", [symbol, JSON.stringify({ messageId: report.messageId })]);
    return { stored: true };
  });
}

export const CHAIN_LABEL = (c: ChainKey): string => CHAINS[c].label;
