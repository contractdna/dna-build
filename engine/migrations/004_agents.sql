-- The agent loop. Engine records (thread steps, experiments, sims, memory, epochs, journal, ...) are log kinds
-- appended through log_append() like every other record; the web reads them through the read-only role.
alter table log drop constraint log_kind_check;
alter table log add constraint log_kind_check check (kind in (
  'tx', 'anchor', 'mode', 'draft', 'alert', 'llm', 'x_post',
  'observe', 'thread', 'step', 'experiment', 'sim', 'security', 'memory', 'epoch', 'core', 'journal',
  'idea', 'report', 'autonomy', 'research', 'intake', 'plate'
));
create index log_ref on log (kind, ref, seq desc);

-- Mutable orchestration state (one row per thread: a fee experiment or an idea round). Every transition also appends
-- a 'plate' / 'step' record in the same transaction, so the log is the history and this row is only the cursor.
create table thread (
  id text primary key,                    -- 'T-0001' (fee), 'R-0003' (idea round), 'G-0000' (genesis)
  kind text not null check (kind in ('fee', 'idea', 'genesis')),
  stage text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index thread_open on thread (kind) where stage <> 'closed';

-- X mention → IdeaMarket intake decisions (the mention text itself stays in x_mention, untrusted).
create table intake (
  mention_id text primary key references x_mention (id),
  round int,
  status text not null check (status in ('submitted', 'skipped', 'duplicate', 'full')),
  title_key text,                         -- normalized title hash, for per-round dedupe
  idea_id bigint,
  reason text,
  at timestamptz not null default now()
);
create unique index intake_dedupe on intake (round, title_key) where status = 'submitted';

-- XP: one view over finalized chain events, weights published on /xp. Points per address:
--   staking   1 XP per 1,000 DNA staked (IdeaMarket Staked, opening stakes included)
--   ideas     500 XP per idea accepted in a finalized round (author of IdeaSubmitted, bit set in RoundFinalized.accepted)
--   work      50 XP per BountyBoard WorkSubmitted
--   bounties  1,000 XP per BountyAwarded (winner)
create view xp as
with staked as (
  select lower(args->>'staker') as addr, sum((args->>'amount')::numeric) / 1e21 as pts from chain_log where event = 'Staked' group by 1
), accepted as (
  select lower(s.args->>'author') as addr, count(*) * 500 as pts
  from chain_log s join chain_log f on f.event = 'RoundFinalized' and f.args->>'round' = s.args->>'round'
  where s.event = 'IdeaSubmitted'
    and mod(floor((f.args->>'accepted')::numeric / power(2::numeric, (s.args->>'index')::int)), 2) = 1
  group by 1
), work as (
  select lower(args->>'by') as addr, count(*) * 50 as pts from chain_log where event = 'WorkSubmitted' group by 1
), awarded as (
  select lower(args->>'winner') as addr, count(*) * 1000 as pts from chain_log where event = 'BountyAwarded' group by 1
), all_pts as (
  select addr, pts, 'staking' as src from staked union all select addr, pts, 'ideas' from accepted
  union all select addr, pts, 'work' from work union all select addr, pts, 'bounties' from awarded
)
select addr,
  floor(sum(pts))::bigint as xp,
  floor(coalesce(sum(pts) filter (where src = 'staking'), 0))::bigint as staking,
  coalesce(sum(pts) filter (where src = 'ideas'), 0)::bigint as ideas,
  coalesce(sum(pts) filter (where src = 'work'), 0)::bigint as work,
  coalesce(sum(pts) filter (where src = 'bounties'), 0)::bigint as bounties
from all_pts group by addr;
grant select on xp to dna_web;
