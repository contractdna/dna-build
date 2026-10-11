-- Only finalized chain data is persisted, so there is no reorg rollback path. The indexer checks that
-- cursor.hash is still canonical every tick and exits non-zero if not (a reorg past finality needs a human).
create table cursor (
  id int primary key default 1 check (id = 1),
  block bigint not null,
  hash text not null,
  at timestamptz not null,                      -- timestamp of `block`
  checked_at timestamptz not null default now() -- last successful indexer pass (health: stale if > 5 min old)
);

create table chain_log (
  block bigint not null,
  log_index int not null,
  tx text not null,
  block_hash text not null,
  at timestamptz not null,
  address text not null,
  event text not null,
  args jsonb not null,
  primary key (block, log_index)
);
create index chain_log_event on chain_log (event, block desc, log_index desc);

-- Snapshots read at the finalized block (key 'chain'), the head tier's block ('head'), plus the deployment and
-- module manifests the indexer loaded at start ('deployment', 'manifests'), so the web never reads engine files.
create table state (
  key text primary key,
  block bigint not null,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- The hash-chained engine log is in migration 003.
