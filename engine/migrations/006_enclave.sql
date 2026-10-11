-- Enclave build: the enclave's own log chain inside the DB log, and signatures on every state
-- row the enclave re-reads. The DB is storage and transport only: an unsigned or foreign row is ignored and alerted.
--
-- Enclave chain: ehash = sha256(eprev || sha256(utf8 body)), eprev = the ehash of the previous record the ENCLAVE signed
-- (32 zero bytes for the first), passed in by the engine from its own head (never picked from the DB, so a row the DB
-- made up can't become a link); esig = the enclave log key's EIP-191 signature over
-- sha256("dna/log/v1" || ehash || sha256(canonical [kind, ref])) (src/log.ts logDigest).
-- The engine recomputes ehash itself before it signs. A row that does not link or verify is skipped by every reader
-- (verify, the boot check, trusted loads), never fatal. Records appended without p_enclave have no ehash.
alter table log add column eprev bytea, add column ehash bytea unique, add column esig text;
create index log_ehash_seq on log (seq) where ehash is not null;

drop function log_append(text, text, text);
create function log_append(p_kind text, p_ref text, p_body text, p_enclave boolean default false, p_eprev bytea default null) returns log language plpgsql as $$
declare
  prev log;
  r log;
  bh bytea := sha256(convert_to(p_body, 'UTF8'));
  ph bytea;
  ep bytea;
begin
  perform pg_advisory_xact_lock(1297042503); -- 'MOLG' (indexer: 'MORP')
  select * into prev from log order by seq desc limit 1;
  ph := coalesce(prev.hash, decode(repeat('00', 32), 'hex'));
  if p_enclave then
    ep := coalesce(p_eprev, decode(repeat('00', 32), 'hex'));
  end if;
  insert into log (seq, at, kind, ref, body, body_hash, prev_hash, hash, eprev, ehash)
  values (coalesce(prev.seq, 0) + 1, greatest(clock_timestamp(), prev.at), p_kind, p_ref, p_body, bh, ph, sha256(ph || bh),
    ep, case when p_enclave then sha256(ep || bh) end)
  returning * into r;
  perform pg_notify('feed', json_build_object('t', 'elog', 'seq', r.seq, 'kind', r.kind, 'ref', r.ref, 'at', r.at)::text);
  return r;
end $$;
revoke execute on function log_append(text, text, text, boolean, bytea) from public;

-- append-only, except the one write that completes an enclave record: esig null → set, nothing else changes
create or replace function log_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.esig is null and new.esig is not null and old.ehash is not null
    and (new.seq, new.at, new.kind, new.ref, new.body, new.body_hash, new.prev_hash, new.hash, new.eprev, new.ehash)
      is not distinct from (old.seq, old.at, old.kind, old.ref, old.body, old.body_hash, old.prev_hash, old.hash, old.eprev, old.ehash) then
    return new;
  end if;
  raise exception 'log is append-only';
end $$;

-- 'cycle': one record per agent-loop cycle with the chain snapshot it judged ({fromBlock, toBlock, toBlockHash,
-- eventsSha256}, the RPC host set, tcb_info in the enclave)
alter table log drop constraint log_kind_check;
alter table log add constraint log_kind_check check (kind in (
  'tx', 'anchor', 'mode', 'draft', 'alert', 'llm', 'x_post',
  'observe', 'thread', 'step', 'experiment', 'sim', 'security', 'memory', 'epoch', 'core', 'journal',
  'idea', 'report', 'autonomy', 'research', 'intake', 'plate',
  'tone', 'cycle', 'state'
));

-- state rows the enclave re-reads: sig = '<seq>:<log key EIP-191 signature over sha256("dna/state/v1" || canonical
-- {table, key, value, seq})>', seq = the 'state' log record written with it (an older signed row replayed is refused).
-- Flags, mute and drafts carry no sig: the enclave reads them from its own log records (src/mode.ts, x.ts, telegram.ts).
alter table thread add column sig text;
alter table state add column sig text;
alter table x_outbox add column sig text;
alter table x_mention add column sig text;
