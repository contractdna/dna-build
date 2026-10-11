-- An engine change the Sequencer built ends `handed`: its pull request is left open for an owner to review and merge
-- (the Sequencer never merges one). Not an active status: the next build may start.
alter table seq_build drop constraint seq_build_status_check;
alter table seq_build add constraint seq_build_status_check
  check (status in ('decided', 'dispatched', 'gated', 'verdict', 'shipping', 'shipped', 'handed', 'killed', 'skipped'));
