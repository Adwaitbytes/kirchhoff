import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { chainBySelector, reasonFromValue, statusFromValue, type ChainKey } from "@kirchhoff/sdk";
import type { DbClient } from "./db.ts";
import type { IndexedEvent } from "./decode.ts";
import { refreshMatches } from "./matches.ts";

/** Extra reads taken at the event's block, because the events alone do not carry these fields. */
export type Enrichment = {
  epochs: Map<string, { reason: number; evaluatedAt: bigint; blocksHash: Hex; evidenceHash: Hex }>;
  breaches: Map<string, { messageId: Hex; delta: bigint; epochId: bigint }>;
};

export type ApplyContext = {
  chain: ChainKey;
  isHome: boolean;
  symbol: string;
  tokenId: Hex;
  blockTimes: ReadonlyMap<bigint, Date>;
};

export type ApplyResult = {
  /** Incidents first seen in this batch, for the notifier (after commit). */
  newIncidents: string[];
  touchedMessages: string[];
};

export const eventKey = (txHash: string, logIndex: number): string => `${txHash.toLowerCase()}:${logIndex}`;

/** Same formula as ConservationLedger, W3 and the API (docs/INTERFACES.md). */
export function incidentIdOf(tokenId: Hex, evidenceHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [tokenId, evidenceHash]));
}

function chainKeyOf(selector: bigint): ChainKey | null {
  return chainBySelector(selector)?.key ?? null;
}

async function emit(client: DbClient, symbol: string, channel: string, ref: Record<string, unknown>): Promise<void> {
  await client.query("insert into stream_events (token_symbol, channel, ref) values ($1, $2, $3)", [symbol, channel, JSON.stringify(ref)]);
}

/**
 * Writes one decoded block range for one chain. Every insert is keyed by (chain, tx, logIndex)
 * with ON CONFLICT DO NOTHING, so replaying a range after a crash or a reorg rewind is safe.
 */
export async function applyEvents(client: DbClient, events: readonly IndexedEvent[], ctx: ApplyContext, enrich: Enrichment): Promise<ApplyResult> {
  const newIncidents: string[] = [];
  const touched: string[] = [];
  const { chain, symbol } = ctx;
  const time = (block: bigint): Date => {
    const t = ctx.blockTimes.get(block);
    if (t === undefined) throw new Error(`missing timestamp for ${chain} block ${block.toString()}`);
    return t;
  };

  for (const ev of events) {
    if ("tokenId" in ev && ev.tokenId.toLowerCase() !== ctx.tokenId.toLowerCase()) continue;
    const base = [chain, ev.txHash.toLowerCase(), ev.logIndex, ev.block.toString(), time(ev.block)];
    switch (ev.kind) {
      case "Debit": {
        const r = await client.query(
          `insert into debits (chain, tx_hash, log_index, block, block_time, token_symbol, bridge, message_id, src_chain, dst_chain, dst_selector, amount, sender, recipient)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$1,$9,$10,$11,$12,$13) on conflict do nothing`,
          [...base, symbol, ev.bridge, ev.messageId.toLowerCase(), chainKeyOf(ev.dstSelector), ev.dstSelector.toString(), ev.amount.toString(), ev.sender, ev.recipient],
        );
        touched.push(ev.messageId);
        if (r.rowCount) await emit(client, symbol, "transfer", { messageId: ev.messageId.toLowerCase(), bridge: ev.bridge });
        break;
      }
      case "Credit": {
        const r = await client.query(
          `insert into credits (chain, tx_hash, log_index, block, block_time, token_symbol, bridge, message_id, dst_chain, claimed_src_chain, claimed_src_selector, amount, recipient)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$1,$9,$10,$11,$12) on conflict do nothing`,
          [...base, symbol, ev.bridge, ev.messageId.toLowerCase(), chainKeyOf(ev.srcSelector), ev.srcSelector.toString(), ev.amount.toString(), ev.recipient],
        );
        touched.push(ev.messageId);
        if (r.rowCount) await emit(client, symbol, "transfer", { messageId: ev.messageId.toLowerCase(), bridge: ev.bridge });
        break;
      }
      case "EpochRecorded": {
        const extra = enrich.epochs.get(eventKey(ev.txHash, ev.logIndex));
        const r = await client.query(
          `insert into epochs (chain, tx_hash, log_index, block, block_time, token_symbol, epoch_id, delta, status, reason, evaluated_at, blocks_hash, evidence_hash)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict do nothing`,
          [
            ...base,
            symbol,
            ev.epochId.toString(),
            ev.delta.toString(),
            statusFromValue(ev.status),
            reasonFromValue(extra?.reason ?? 0),
            extra ? new Date(Number(extra.evaluatedAt) * 1000) : time(ev.block),
            extra?.blocksHash ?? "0x",
            extra?.evidenceHash ?? "0x",
          ],
        );
        if (r.rowCount && ctx.isHome) await emit(client, symbol, "epoch", { chain, txHash: ev.txHash.toLowerCase(), logIndex: ev.logIndex });
        break;
      }
      case "StatusChanged": {
        await client.query(
          `insert into status_changes (chain, tx_hash, log_index, block, block_time, token_symbol, from_status, to_status, reason)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`,
          [...base, symbol, statusFromValue(ev.from), statusFromValue(ev.to), reasonFromValue(ev.reason)],
        );
        if (ev.to === 4) {
          await client.query(
            `insert into incident_actions (chain, tx_hash, log_index, block, block_time, token_symbol, incident_id, kind)
             values ($1,$2,$3,$4,$5,$6,(select active_incident_id from tokens where symbol = $6),'quarantine_applied') on conflict do nothing`,
            [...base, symbol],
          );
        }
        if (ctx.isHome) await emit(client, symbol, "status", {});
        break;
      }
      case "BreachRecorded": {
        const incidentId = incidentIdOf(ctx.tokenId, ev.evidenceHash).toLowerCase();
        const extra = enrich.breaches.get(eventKey(ev.txHash, ev.logIndex));
        const offendingChain = chainKeyOf(ev.offendingChain);
        await client.query(
          `insert into breaches (chain, tx_hash, log_index, block, block_time, token_symbol, incident_id, reason, evidence_hash, offending_chain,
                                 offending_selector, offending_tx, recipient, amount, message_id, delta, epoch_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) on conflict do nothing`,
          [
            ...base,
            symbol,
            incidentId,
            reasonFromValue(ev.reason),
            ev.evidenceHash.toLowerCase(),
            offendingChain,
            ev.offendingChain.toString(),
            ev.offendingTx.toLowerCase(),
            ev.recipient,
            ev.amount.toString(),
            extra?.messageId.toLowerCase() ?? null,
            extra?.delta.toString() ?? null,
            extra?.epochId.toString() ?? null,
          ],
        );
        const inserted = await client.query<{ created: boolean }>(
          `insert into incidents (id, token_symbol, token_id, reason, evidence_hash, offending_chain, offending_tx, recipient, amount, message_id,
                                  delta_after, opened_at, broken_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
           on conflict (id) do update set
             broken_at = least(incidents.broken_at, excluded.broken_at),
             opened_at = least(incidents.opened_at, excluded.opened_at),
             message_id = coalesce(incidents.message_id, excluded.message_id),
             delta_after = coalesce(incidents.delta_after, excluded.delta_after),
             updated_at = now()
           returning (xmax = 0) as created`,
          [
            incidentId,
            symbol,
            ctx.tokenId.toLowerCase(),
            reasonFromValue(ev.reason),
            ev.evidenceHash.toLowerCase(),
            offendingChain,
            ev.offendingTx.toLowerCase(),
            ev.recipient,
            ev.amount.toString(),
            extra?.messageId.toLowerCase() ?? null,
            extra?.delta.toString() ?? null,
            time(ev.block),
          ],
        );
        if (inserted.rows[0]?.created === true) newIncidents.push(incidentId);
        if (extra) touched.push(extra.messageId);
        await client.query("update tokens set active_incident_id = coalesce(active_incident_id, $2) where symbol = $1", [symbol, incidentId]);
        await client.query(
          `insert into incident_actions (chain, tx_hash, log_index, block, block_time, token_symbol, incident_id, kind)
           values ($1,$2,$3,$4,$5,$6,$7,'breach_report') on conflict do nothing`,
          [...base, symbol, incidentId],
        );
        await emit(client, symbol, "incident", { incidentId });
        break;
      }
      case "IncidentOpened":
        await client.query("update incidents set opened_at = least(opened_at, $2), updated_at = now() where id = $1", [ev.incidentId.toLowerCase(), time(ev.block)]);
        break;
      case "RecoveryStarted":
      case "IncidentResolved": {
        const id = ev.incidentId.toLowerCase();
        await client.query(
          `update incidents set status = 'recovering', resolved_at = coalesce(resolved_at, $2), recovery_ends_at = $3, updated_at = now() where id = $1`,
          [id, time(ev.block), new Date(Number(ev.recoveryEndsAt) * 1000)],
        );
        await client.query(
          `insert into incident_actions (chain, tx_hash, log_index, block, block_time, token_symbol, incident_id, kind)
           values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
          [...base, symbol, id, ev.kind === "RecoveryStarted" ? "recovery_started" : "incident_resolved"],
        );
        await emit(client, symbol, "incident", { incidentId: id });
        break;
      }
      case "LanesFrozen":
        await client.query(
          `insert into incident_actions (chain, tx_hash, log_index, block, block_time, token_symbol, incident_id, kind)
           values ($1,$2,$3,$4,$5,$6,$7,'lanes_frozen') on conflict do nothing`,
          [...base, symbol, ev.incidentId.toLowerCase()],
        );
        await emit(client, symbol, "incident", { incidentId: ev.incidentId.toLowerCase() });
        break;
      case "LanesUnfrozen":
        await client.query(
          `insert into incident_actions (chain, tx_hash, log_index, block, block_time, token_symbol, incident_id, kind)
           values ($1,$2,$3,$4,$5,$6,null,'lanes_unfrozen') on conflict do nothing`,
          [...base, symbol],
        );
        await client.query(
          `update incidents set status = 'resolved', updated_at = now() where token_symbol = $1 and status = 'recovering' and recovery_ends_at <= $2`,
          [symbol, time(ev.block)],
        );
        await client.query("update tokens set active_incident_id = null where symbol = $1", [symbol]);
        break;
      case "Tainted":
        await client.query(
          `insert into incident_actions (chain, tx_hash, log_index, block, block_time, token_symbol, incident_id, kind, account)
           values ($1,$2,$3,$4,$5,$6,$7,'tainted',$8) on conflict do nothing`,
          [...base, symbol, ev.incidentId.toLowerCase(), ev.account],
        );
        await client.query(
          `insert into taints (token_symbol, chain, account, incident_id, tx_hash, block, block_time, active)
           values ($1,$2,$3,$4,$5,$6,$7,true)
           on conflict (token_symbol, chain, account) do update set active = true, incident_id = excluded.incident_id,
             tx_hash = excluded.tx_hash, block = excluded.block, block_time = excluded.block_time`,
          [symbol, chain, ev.account, ev.incidentId.toLowerCase(), ev.txHash.toLowerCase(), ev.block.toString(), time(ev.block)],
        );
        break;
      case "Untainted":
        await client.query("update taints set active = false where token_symbol = $1 and chain = $2 and account = $3", [symbol, chain, ev.account]);
        break;
      case "MessageConsumed":
        await client.query("update matches set consumed = true where message_id = $1", [ev.messageId.toLowerCase()]);
        break;
      case "SpecProposed":
        await client.query(
          `insert into specs (spec_hash, token_symbol, spec_uri, state, source, propose_chain, propose_tx, propose_block, proposed_at, activates_at)
           values ($1,$2,$3,'proposed','registry',$4,$5,$6,$7,$8)
           on conflict (spec_hash, token_symbol) do update set state = case when specs.state = 'active' then specs.state else 'proposed' end,
             spec_uri = excluded.spec_uri, propose_chain = excluded.propose_chain, propose_tx = excluded.propose_tx,
             propose_block = excluded.propose_block, proposed_at = excluded.proposed_at, activates_at = excluded.activates_at`,
          [ev.specHash.toLowerCase(), symbol, ev.specURI, chain, ev.txHash.toLowerCase(), ev.block.toString(), time(ev.block), new Date(Number(ev.eta) * 1000)],
        );
        break;
      case "SpecActivated":
        await client.query("update specs set state = 'superseded' where token_symbol = $1 and state = 'active' and spec_hash <> $2", [symbol, ev.specHash.toLowerCase()]);
        await client.query(
          `insert into specs (spec_hash, token_symbol, spec_uri, state, source, activate_tx, activate_block, activated_at)
           values ($1,$2,$3,'active','registry',$4,$5,$6)
           on conflict (spec_hash, token_symbol) do update set state = 'active', activate_tx = excluded.activate_tx,
             activate_block = excluded.activate_block, activated_at = excluded.activated_at`,
          [ev.specHash.toLowerCase(), symbol, ev.specURI, ev.txHash.toLowerCase(), ev.block.toString(), time(ev.block)],
        );
        await client.query("update tokens set spec_hash = $2 where symbol = $1", [symbol, ev.specHash.toLowerCase()]);
        break;
      case "SpecProposalCancelled":
        await client.query("update specs set state = 'cancelled' where spec_hash = $1 and token_symbol = $2 and state = 'proposed'", [ev.specHash.toLowerCase(), symbol]);
        break;
    }
  }
  await refreshMatches(client, touched);
  return { newIncidents, touchedMessages: touched };
}

/** Removes every row above `block` on `chain` (reorg rewind), then rebuilds dependent rows. */
export async function rewindChain(client: DbClient, chain: ChainKey, block: bigint): Promise<void> {
  const b = block.toString();
  const msgs = await client.query<{ message_id: string }>(
    `select message_id from debits where chain = $1 and block > $2 union select message_id from credits where chain = $1 and block > $2`,
    [chain, b],
  );
  for (const table of ["debits", "credits", "epochs", "status_changes", "breaches", "incident_actions"]) {
    await client.query(`delete from ${table} where chain = $1 and block > $2`, [chain, b]);
  }
  await client.query("delete from taints where chain = $1 and block > $2", [chain, b]);
  await client.query("delete from specs where source = 'registry' and propose_chain = $1 and propose_block > $2 and activate_tx is null", [chain, b]);
  await client.query("delete from incidents i where not exists (select 1 from breaches b where b.incident_id = i.id)");
  await client.query("delete from block_hashes where chain = $1 and number > $2", [chain, b]);
  await refreshMatches(client, msgs.rows.map((r) => r.message_id));
}
