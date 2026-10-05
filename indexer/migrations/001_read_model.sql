-- KIRCHHOFF UI read model (PRD section 10). Mirrors onchain state; never in the veto path.
-- Amounts are numeric(78,0) (uint256 range) and block numbers numeric(20,0) (uint64), so nothing passes through a float.

create table if not exists chains (
  chain                 text primary key,
  selector              numeric(20, 0) not null,
  chain_id              integer not null,
  mode                  text not null check (mode in ('local', 'testnet')),
  role                  text not null check (role in ('home', 'remote')),
  confidence            text not null check (confidence in ('latest', 'safe', 'finalized')),
  ledger                text not null,
  quarantine            text not null,
  feed                  text not null,
  guard                 text,
  registry              text,
  token                 text not null,
  escrow                text,
  weak_bridge           text,
  ccip_pool             text,
  ccip_lockbox          text,
  on_ramp               text,
  off_ramp              text,
  token_admin_registry  text,
  lending_market        text,
  issuer_safe           text,
  deployed_at_block     numeric(20, 0),
  updated_at            timestamptz not null default now()
);

create table if not exists tokens (
  symbol              text primary key,
  token_id            text not null unique,
  name                text not null,
  decimals            integer not null,
  model               text not null check (model in ('lock_release_home', 'burn_mint_multi')),
  home_chain          text not null,
  chains              text[] not null,
  simulation          boolean not null default true,
  spec_yaml           text not null,
  config              jsonb not null,
  status              text not null default 'UNKNOWN',
  reason              text not null default 'OK',
  delta               numeric(78, 0) not null default 0,
  epoch_id            numeric(20, 0) not null default 0,
  updated_at          timestamptz,
  stale               boolean not null default true,
  active_incident_id  text,
  spec_hash           text not null default '0x0000000000000000000000000000000000000000000000000000000000000000'
);

-- Reorg-safe cursor: the last indexed block and its hash, plus recent hashes to find the fork point.
create table if not exists cursors (
  chain       text primary key references chains (chain) on delete cascade,
  block       numeric(20, 0) not null,
  block_hash  text not null,
  block_time  timestamptz not null,
  updated_at  timestamptz not null default now()
);

create table if not exists block_hashes (
  chain   text not null,
  number  numeric(20, 0) not null,
  hash    text not null,
  primary key (chain, number)
);

-- Latest reads per chain at the cursor block (supply, escrow, ledger status, freeze flag, read health).
create table if not exists chain_state (
  chain               text primary key references chains (chain) on delete cascade,
  token_symbol        text not null,
  block               numeric(20, 0) not null,
  block_time          timestamptz not null,
  supply              numeric(78, 0) not null,
  escrow              numeric(78, 0),
  ccip_lockbox        numeric(78, 0),
  ledger_status       text not null,
  ledger_reason       text not null default 'OK',
  ledger_delta        numeric(78, 0) not null,
  ledger_updated_at   timestamptz,
  ledger_stale        boolean not null,
  frozen              boolean not null,
  read_ok             boolean not null default true,
  read_error          text,
  read_error_since    timestamptz,
  updated_at          timestamptz not null default now()
);

create table if not exists debits (
  chain         text not null,
  tx_hash       text not null,
  log_index     integer not null,
  block         numeric(20, 0) not null,
  block_time    timestamptz not null,
  token_symbol  text not null,
  bridge        text not null,
  message_id    text not null,
  src_chain     text not null,
  dst_chain     text,
  dst_selector  numeric(20, 0) not null,
  amount        numeric(78, 0) not null,
  sender        text,
  recipient     text,
  primary key (chain, tx_hash, log_index)
);
create index if not exists debits_message on debits (message_id);
create index if not exists debits_block on debits (chain, block);

create table if not exists credits (
  chain                  text not null,
  tx_hash                text not null,
  log_index              integer not null,
  block                  numeric(20, 0) not null,
  block_time             timestamptz not null,
  token_symbol           text not null,
  bridge                 text not null,
  message_id             text not null,
  dst_chain              text not null,
  claimed_src_chain      text,
  claimed_src_selector   numeric(20, 0) not null,
  amount                 numeric(78, 0) not null,
  recipient              text,
  primary key (chain, tx_hash, log_index)
);
create index if not exists credits_message on credits (message_id);
create index if not exists credits_block on credits (chain, block);

-- One row per message id and bridge: the debit, the credit and the lane state (Circuit Map wires).
create table if not exists matches (
  message_id    text not null,
  bridge        text not null,
  token_symbol  text not null,
  src_chain     text,
  dst_chain     text,
  amount        numeric(78, 0) not null,
  sender        text,
  recipient     text,
  debit_chain   text,
  debit_tx      text,
  debit_block   numeric(20, 0),
  debit_time    timestamptz,
  credit_chain  text,
  credit_tx     text,
  credit_block  numeric(20, 0),
  credit_time   timestamptz,
  state         text not null check (state in ('in_flight', 'settled', 'refused', 'forged')),
  consumed      boolean not null default false,
  updated_at    timestamptz not null default now(),
  primary key (message_id, bridge)
);
create index if not exists matches_lane on matches (token_symbol, bridge, src_chain, dst_chain, updated_at desc);

-- EpochRecorded on each chain's ledger, enriched with latestEpoch() read at the same block.
create table if not exists epochs (
  chain          text not null,
  tx_hash        text not null,
  log_index      integer not null,
  block          numeric(20, 0) not null,
  block_time     timestamptz not null,
  token_symbol   text not null,
  epoch_id       numeric(20, 0) not null,
  delta          numeric(78, 0) not null,
  status         text not null,
  reason         text not null,
  evaluated_at   timestamptz not null,
  blocks_hash    text not null,
  evidence_hash  text not null,
  primary key (chain, tx_hash, log_index)
);
create index if not exists epochs_token on epochs (token_symbol, epoch_id desc);

create table if not exists status_changes (
  chain         text not null,
  tx_hash       text not null,
  log_index     integer not null,
  block         numeric(20, 0) not null,
  block_time    timestamptz not null,
  token_symbol  text not null,
  from_status   text not null,
  to_status     text not null,
  reason        text not null,
  primary key (chain, tx_hash, log_index)
);

create table if not exists breaches (
  chain            text not null,
  tx_hash          text not null,
  log_index        integer not null,
  block            numeric(20, 0) not null,
  block_time       timestamptz not null,
  token_symbol     text not null,
  incident_id      text not null,
  reason           text not null,
  evidence_hash    text not null,
  offending_chain  text,
  offending_selector numeric(20, 0) not null,
  offending_tx     text not null,
  recipient        text not null,
  amount           numeric(78, 0) not null,
  message_id       text,
  delta            numeric(78, 0),
  epoch_id         numeric(20, 0),
  primary key (chain, tx_hash, log_index)
);
create index if not exists breaches_incident on breaches (incident_id);

create table if not exists incidents (
  id                  text primary key,
  token_symbol        text not null,
  token_id            text not null,
  reason              text not null,
  evidence_hash       text not null,
  status              text not null default 'open' check (status in ('open', 'recovering', 'resolved')),
  offending_chain     text,
  offending_tx        text not null,
  recipient           text not null,
  amount              numeric(78, 0) not null,
  message_id          text,
  delta_after         numeric(78, 0),
  opened_at           timestamptz not null,
  broken_at           timestamptz not null,
  resolved_at         timestamptz,
  recovery_ends_at    timestamptz,
  narrative           jsonb,
  narrative_key       text,
  updated_at          timestamptz not null default now()
);
create index if not exists incidents_token on incidents (token_symbol, opened_at desc);

-- Containment and resolution events, one row per chain (LanesFrozen, Tainted, QUARANTINE status, IncidentResolved, ...).
create table if not exists incident_actions (
  chain         text not null,
  tx_hash       text not null,
  log_index     integer not null,
  block         numeric(20, 0) not null,
  block_time    timestamptz not null,
  token_symbol  text not null,
  incident_id   text,
  kind          text not null,
  account       text,
  primary key (chain, tx_hash, log_index)
);
create index if not exists incident_actions_incident on incident_actions (incident_id);

create table if not exists taints (
  token_symbol  text not null,
  chain         text not null,
  account       text not null,
  incident_id   text,
  tx_hash       text not null,
  block         numeric(20, 0) not null,
  block_time    timestamptz not null,
  active        boolean not null default true,
  primary key (token_symbol, chain, account)
);

create table if not exists specs (
  spec_hash      text not null,
  token_symbol   text not null,
  yaml           text,
  spec_uri       text,
  state          text not null check (state in ('draft', 'proposed', 'active', 'superseded', 'cancelled')),
  source         text not null check (source in ('registry', 'issuer', 'copilot', 'topology_scout')),
  propose_chain  text,
  propose_tx     text,
  propose_block  numeric(20, 0),
  proposed_at    timestamptz,
  activates_at   timestamptz,
  activate_tx    text,
  activate_block numeric(20, 0),
  activated_at   timestamptz,
  notes          jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  primary key (spec_hash, token_symbol)
);

-- Raw Judge outcomes as each CCV cell reported them (POST /internal/verdicts). Verdicts are offchain.
create table if not exists judge_verdicts (
  id            bigserial primary key,
  cell_id       text not null,
  message_id    text not null,
  token_symbol  text,
  decision      text not null check (decision in ('PASS', 'FAIL', 'PENDING')),
  reason        text not null,
  note          text not null default '',
  latency_ms    integer not null,
  src_chain     text not null,
  dst_chain     text not null,
  amount        numeric(78, 0) not null,
  sender        text not null,
  receiver      text not null,
  source_tx     text,
  evaluated_at  timestamptz not null,
  received_at   timestamptz not null default now(),
  unique (cell_id, message_id, decision)
);
create index if not exists judge_verdicts_time on judge_verdicts (received_at desc);

-- Committee view per message (latest definitive decision per cell), built from judge_verdicts.
create table if not exists verdicts (
  message_id     text primary key,
  token_symbol   text not null,
  evaluated_at   timestamptz not null,
  src_chain      text not null,
  dst_chain      text not null,
  amount         numeric(78, 0) not null,
  sender         text not null,
  receiver       text not null,
  decision       text not null check (decision in ('PASS', 'FAIL')),
  reason         text not null,
  note           text not null,
  cells          jsonb not null,
  source_tx      text,
  source_block   numeric(20, 0),
  source_time    timestamptz,
  incident_id    text
);
create index if not exists verdicts_token on verdicts (token_symbol, evaluated_at desc);

create table if not exists ai_cache (
  key          text primary key,
  kind         text not null,
  model        text not null,
  response     jsonb not null,
  tokens_in    integer not null default 0,
  tokens_out   integer not null default 0,
  cost_usd     numeric(12, 6) not null default 0,
  created_at   timestamptz not null default now()
);

-- Outbox for live channels: WS and SSE both tail it by id, so no event is lost between restarts.
create table if not exists stream_events (
  id            bigserial primary key,
  token_symbol  text not null,
  channel       text not null check (channel in ('status', 'epoch', 'verdict', 'incident', 'transfer', 'lab')),
  ref           jsonb not null,
  created_at    timestamptz not null default now()
);
create index if not exists stream_events_token on stream_events (token_symbol, id);

create table if not exists lab_runs (
  id           text primary key,
  token        text not null,
  state        text not null check (state in ('running', 'succeeded', 'failed')),
  run          jsonb not null,
  started_at   timestamptz not null,
  finished_at  timestamptz
);

create table if not exists api_keys (
  id            text primary key,
  label         text not null,
  prefix        text not null,
  key_hash      text not null unique,
  scopes        text[] not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

-- Notifier idempotency: one page per incident per channel, ever.
create table if not exists notifications (
  incident_id  text not null,
  channel      text not null,
  status       text not null check (status in ('sending', 'sent', 'failed')),
  attempts     integer not null default 0,
  last_error   text,
  sent_at      timestamptz,
  primary key (incident_id, channel)
);
