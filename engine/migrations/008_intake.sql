-- The X idea filter: GATE (deterministic, from the author's X profile and the round) → SCREEN (the
-- quarantined reader: genuine / joke / shill / spam / impossible, plus a score) → PICK (at round close the top 16 by
-- score are submitted at the START of the next round, a full round for staking). Every decision is also an `intake`
-- log record with its public reason. `round` is the round the mention arrived in; `submit_round` the round it went in.
alter table intake drop constraint intake_status_check;
alter table intake add constraint intake_status_check check (status in (
  'submitted', 'skipped', 'duplicate', 'full',                -- migration 004
  'gated', 'screened', 'candidate', 'picked', 'not_picked'
));
alter table intake add column author_id text, add column score int, add column title text, add column body text,
  add column submit_round int;
create index intake_round_author on intake (round, author_id);
