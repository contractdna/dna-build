-- The Sequencer (src/sequencer.ts): its signed records and its builds.
--  build       a signed build order (the workflow verifies it against the enclave's log signer)
--  gates       the enclave's own gate run on a pull request's exact head (M3: CI is advice)
--  ship        a delayed ship decision (one public hour, Safe veto; M1)
--  ship-cancel the enclave stops its own ship (a page check failing during the public hour)
--  retire      a delayed retire decision for a live game (M1)
--  release     a delayed `release` fast-forward (M2): a ship's inherits the ship's hour, any other merge on main gets its own
--  page-kill   a game page pulled at once (the kill switch)
--  fund        a game fund queued through Roles → Delay (its Delay nonce and tx)
-- seq_build rows are enclave-signed state (sig = seq:signature, src/log.ts). At most one build is active, whatever the
-- process does: a second active row is refused by the database.
alter table log drop constraint log_kind_check;
alter table log add constraint log_kind_check check (kind in (
  'tx', 'anchor', 'mode', 'draft', 'alert', 'llm', 'x_post',
  'observe', 'thread', 'step', 'experiment', 'sim', 'security', 'memory', 'epoch', 'core', 'journal',
  'idea', 'report', 'autonomy', 'research', 'intake', 'plate',
  'tone', 'cycle', 'state', 'game', 'announce',
  'brain', 'approve', 'veto', 'model-change',
  'binding', 'reward',
  'build', 'gates', 'ship', 'ship-cancel', 'retire', 'release', 'page-kill', 'fund'
));

create table seq_build (
  id text primary key,                    -- b<yyyymmdd>-<idea>
  status text not null check (status in ('decided', 'dispatched', 'gated', 'verdict', 'shipping', 'shipped', 'killed', 'skipped')),
  round int not null check (round between 1 and 4),
  data jsonb not null,
  sig text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- one build at a time
create unique index seq_build_one_active on seq_build ((true)) where status in ('decided', 'dispatched', 'gated', 'verdict', 'shipping');
create index seq_build_updated on seq_build (updated_at desc);
