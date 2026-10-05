-- A page claimed by a process that then crashed is reclaimable after a grace period.
alter table notifications add column if not exists claimed_at timestamptz not null default now();

-- The merged deployments document (deployments/<network>.json) the spec hash is resolved against,
-- so serverless API instances can verify registry spec hashes without the repo checkout.
create table if not exists deployment_docs (
  name        text primary key,
  doc         jsonb not null,
  updated_at  timestamptz not null default now()
);

create index if not exists specs_token_source on specs (token_symbol, source, created_at desc);
