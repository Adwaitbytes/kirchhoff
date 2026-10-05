-- Breach.blocksHash (pinned blocks of the epoch that found the breach), read with breachOf() at the
-- report block. Loop Rule breaches have no offending credit, so this is their anchor evidence.
alter table breaches add column if not exists blocks_hash text;
