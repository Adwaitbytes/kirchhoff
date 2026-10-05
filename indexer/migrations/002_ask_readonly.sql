-- Ask KIRCHHOFF reads the mirror through these views only, as a role that can do nothing else.
-- Secrets-bearing and internal tables (api_keys, ai_cache, notifications, lab_runs) are never exposed.

create schema if not exists ask;

create or replace view ask.tokens as
  select symbol, token_id, name, decimals, model, home_chain, chains, status, reason, delta, epoch_id, updated_at, stale,
         active_incident_id, spec_hash
  from public.tokens;
create or replace view ask.chains as
  select chain, selector, chain_id, role, confidence, ledger, quarantine, feed, guard, registry, token, escrow,
         weak_bridge, ccip_pool
  from public.chains;
create or replace view ask.chain_state as select * from public.chain_state;
create or replace view ask.debits as select * from public.debits;
create or replace view ask.credits as select * from public.credits;
create or replace view ask.matches as select * from public.matches;
create or replace view ask.epochs as select * from public.epochs;
create or replace view ask.status_changes as select * from public.status_changes;
create or replace view ask.breaches as select * from public.breaches;
create or replace view ask.incidents as
  select id, token_symbol, reason, evidence_hash, status, offending_chain, offending_tx, recipient, amount, message_id,
         delta_after, opened_at, broken_at, resolved_at, recovery_ends_at
  from public.incidents;
create or replace view ask.incident_actions as select * from public.incident_actions;
create or replace view ask.taints as select * from public.taints;
create or replace view ask.verdicts as
  select message_id, token_symbol, evaluated_at, src_chain, dst_chain, amount, sender, receiver, decision, reason, note,
         source_tx, incident_id
  from public.verdicts;
create or replace view ask.specs as
  select spec_hash, token_symbol, state, source, propose_tx, proposed_at, activates_at, activate_tx, activated_at
  from public.specs;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'kirchhoff_ask_ro') then
    create role kirchhoff_ask_ro nologin;
  end if;
end
$$;

revoke all on schema public from kirchhoff_ask_ro;
grant usage on schema ask to kirchhoff_ask_ro;
grant select on all tables in schema ask to kirchhoff_ask_ro;
-- The API's own login role switches into the read-only role per query (SET LOCAL ROLE).
do $$
begin
  execute format('grant kirchhoff_ask_ro to %I', current_user);
end
$$;
