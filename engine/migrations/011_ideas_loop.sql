-- Ideas into the loop: `binding` records (an X account's payout wallet, keyed by the X user id), `reward` records (the
-- brain's signed decision behind GamePot.queueReward), the `binding` intake status, and the idea queue: accepted ideas
-- of FINAL IdeaMarket rounds, fee ideas on their way to an experiment and a reward, build ideas waiting for the
-- Sequencer (ordered by the brain's rubric score). Rows are enclave-signed state (sig = seq:signature, src/log.ts).
alter table log drop constraint log_kind_check;
alter table log add constraint log_kind_check check (kind in (
  'tx', 'anchor', 'mode', 'draft', 'alert', 'llm', 'x_post',
  'observe', 'thread', 'step', 'experiment', 'sim', 'security', 'memory', 'epoch', 'core', 'journal',
  'idea', 'report', 'autonomy', 'research', 'intake', 'plate',
  'tone', 'cycle', 'state', 'game', 'announce',
  'brain', 'approve', 'veto', 'model-change',
  'binding', 'reward'
));

alter table intake drop constraint intake_status_check;
alter table intake add constraint intake_status_check check (status in (
  'submitted', 'skipped', 'duplicate', 'full',
  'gated', 'screened', 'candidate', 'picked', 'not_picked',
  'binding'
));

create table idea_queue (
  id text primary key,                    -- im:<IdeaMarket idea id>
  kind text not null check (kind in ('fee', 'build')),
  status text not null,
  score int not null default 0,           -- build: the brain's rubric total
  data jsonb not null,
  sig text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idea_queue_next on idea_queue (kind, status, score desc, created_at);
