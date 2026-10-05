import type { Queryable } from "./db.ts";

/**
 * Rebuilds the `matches` rows for the given message ids from debits, credits, breaches and
 * verdicts. Idempotent: running it twice yields the same rows. A credit with no debit is
 * `in_flight` until a BREACH names its transaction, then `forged`; a debit whose CCIP message the
 * committee refused is `refused`.
 */
export async function refreshMatches(db: Queryable, messageIds: readonly string[]): Promise<void> {
  if (messageIds.length === 0) return;
  const ids = [...new Set(messageIds.map((m) => m.toLowerCase()))];
  await db.query(
    `with d as (
       select distinct on (message_id, bridge) * from debits where message_id = any($1::text[]) order by message_id, bridge, block, log_index
     ), c as (
       select distinct on (message_id, bridge) * from credits where message_id = any($1::text[]) order by message_id, bridge, block, log_index
     ), joined as (
       select coalesce(d.message_id, c.message_id) as message_id,
              coalesce(d.bridge, c.bridge) as bridge,
              coalesce(d.token_symbol, c.token_symbol) as token_symbol,
              coalesce(d.src_chain, c.claimed_src_chain) as src_chain,
              coalesce(c.dst_chain, d.dst_chain) as dst_chain,
              coalesce(c.amount, d.amount) as amount,
              d.sender,
              coalesce(c.recipient, d.recipient) as recipient,
              d.chain as debit_chain, d.tx_hash as debit_tx, d.block as debit_block, d.block_time as debit_time,
              c.chain as credit_chain, c.tx_hash as credit_tx, c.block as credit_block, c.block_time as credit_time
       from d full outer join c on d.message_id = c.message_id and d.bridge = c.bridge
     )
     insert into matches (message_id, bridge, token_symbol, src_chain, dst_chain, amount, sender, recipient,
                          debit_chain, debit_tx, debit_block, debit_time, credit_chain, credit_tx, credit_block, credit_time,
                          state, consumed, updated_at)
     select j.message_id, j.bridge, j.token_symbol, j.src_chain, j.dst_chain, j.amount, j.sender, j.recipient,
            j.debit_chain, j.debit_tx, j.debit_block, j.debit_time, j.credit_chain, j.credit_tx, j.credit_block, j.credit_time,
            case
              when j.credit_tx is not null and exists (select 1 from breaches b where b.offending_tx = j.credit_tx) then 'forged'
              when j.debit_tx is not null and j.credit_tx is not null then 'settled'
              when j.credit_tx is null and exists (select 1 from verdicts v where v.message_id = j.message_id and v.decision = 'FAIL') then 'refused'
              else 'in_flight'
            end,
            false,
            now()
     from joined j
     on conflict (message_id, bridge) do update set
       token_symbol = excluded.token_symbol, src_chain = excluded.src_chain, dst_chain = excluded.dst_chain,
       amount = excluded.amount, sender = excluded.sender, recipient = excluded.recipient,
       debit_chain = excluded.debit_chain, debit_tx = excluded.debit_tx, debit_block = excluded.debit_block, debit_time = excluded.debit_time,
       credit_chain = excluded.credit_chain, credit_tx = excluded.credit_tx, credit_block = excluded.credit_block, credit_time = excluded.credit_time,
       state = excluded.state, updated_at = now()`,
    [ids],
  );
  // Rows whose debit and credit both vanished in a reorg.
  await db.query(
    `delete from matches m where m.message_id = any($1::text[])
       and not exists (select 1 from debits d where d.message_id = m.message_id and d.bridge = m.bridge)
       and not exists (select 1 from credits c where c.message_id = m.message_id and c.bridge = m.bridge)`,
    [ids],
  );
}
