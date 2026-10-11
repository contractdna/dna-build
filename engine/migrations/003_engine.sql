-- The engine service (src/engine.ts). The indexer never writes these tables.

-- Hash-chained, append-only engine log. Appended ONLY through log_append(): one advisory lock (distinct from the
-- indexer's 'MORP') serializes appends, so seq, at and prev_hash are strictly ordered.
--   hash = sha256(prev_hash || sha256(utf8 body)), prev_hash of seq 1 = 32 zero bytes.
-- The engine writes canonical JSON (sorted keys); the DB hashes the exact bytes it stores. Daily heads are anchored
-- on-chain (registry.anchor) and served at /api/log/<day>; engine/scripts/verify-log.ts recomputes the chain.
create table log (
  seq bigint primary key,
  at timestamptz not null,
  kind text not null check (kind in ('tx', 'anchor', 'mode', 'draft', 'alert', 'llm', 'x_post')),
  ref text,
  body text not null,
  doc jsonb generated always as (body::jsonb) stored, -- also rejects bodies that are not JSON
  body_hash bytea not null,
  prev_hash bytea not null,
  hash bytea not null unique
);
create index log_at on log (at);
create index log_kind on log (kind, at);

create function log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'log is append-only';
end $$;
create trigger log_no_update before update or delete on log for each row execute function log_immutable();
create trigger log_no_truncate before truncate on log for each statement execute function log_immutable();

create function log_append(p_kind text, p_ref text, p_body text) returns log language plpgsql as $$
declare
  prev log;
  r log;
  bh bytea := sha256(convert_to(p_body, 'UTF8'));
  ph bytea;
begin
  perform pg_advisory_xact_lock(1297042503); -- 'MOLG' (indexer: 'MORP')
  select * into prev from log order by seq desc limit 1;
  ph := coalesce(prev.hash, decode(repeat('00', 32), 'hex'));
  insert into log (seq, at, kind, ref, body, body_hash, prev_hash, hash)
  values (coalesce(prev.seq, 0) + 1, greatest(clock_timestamp(), prev.at), p_kind, p_ref, p_body, bh, ph, sha256(ph || bh))
  returning * into r;
  -- small payload (8000-byte NOTIFY cap): readers fetch the record by seq. 'elog' because the indexer owns t:'log'.
  perform pg_notify('feed', json_build_object('t', 'elog', 'seq', r.seq, 'kind', r.kind, 'ref', r.ref, 'at', r.at)::text);
  return r;
end $$;
-- functions are EXECUTE-able by PUBLIC by default: the read-only web role must not append
revoke execute on function log_append(text, text, text) from public;
revoke execute on function log_immutable() from public;

-- Job queue. Workers claim with `for update skip locked`; per-kind lanes cap concurrency in the engine process.
create table job (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null default '{}',
  run_at timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  locked_until timestamptz,
  dedupe_key text unique, -- scheduler: '<kind>:<period start>'; never reused, so a period runs once
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index job_due on job (run_at) where status in ('queued', 'running');

-- Mode = most restrictive of env ENGINE_MODE and `override`. Telegram can only set dry_run/halted; the override is
-- cleared only when the operator changes ENGINE_MODE (env_mode remembers the last one seen).
create table engine_flags (
  id int primary key default 1 check (id = 1),
  override text check (override in ('dry_run', 'halted')),
  env_mode text not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

create table llm_call (
  id bigserial primary key,
  at timestamptz not null default now(),
  agent text not null,
  budget text not null,
  mode text not null, -- live | record | replay
  requested_model text not null,
  returned_model text,
  prompt_hash text not null,
  schema_hash text not null,
  input_hash text not null,
  output_hash text,
  input_tokens int,
  output_tokens int,
  cost_usd numeric(12, 6) not null default 0,
  ok boolean not null,
  error text
);
create index llm_call_at on llm_call (at);

-- Telegram approval primitive: the payload is exactly what gets published/sent on approval.
create table draft (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'done', 'failed')),
  created_at timestamptz not null default now(),
  tg_message_id bigint,
  decided_by bigint,
  decided_at timestamptz,
  result jsonb
);

-- X mentions: UNTRUSTED text, only ever read through the quarantined reader.
create table x_mention (
  id text primary key,
  author_id text,
  author_username text,
  text text not null,
  created_at timestamptz,
  fetched_at timestamptz not null default now(),
  raw jsonb not null
);

-- Rotating credentials (X OAuth2 refresh tokens are single-use). Never readable by the web role.
create table secret (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
revoke all on secret from dna_web;
