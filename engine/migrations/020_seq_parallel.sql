-- Several builds at once (src/config.ts SEQ_PACE.maxInflight, which the Sequencer checks before it starts one): the
-- database no longer refuses a second active build, but still refuses two active builds of the same idea.
drop index if exists seq_build_one_active;
create unique index if not exists seq_build_one_active_idea on seq_build ((data->>'idea'))
  where status in ('decided','dispatched','gated','verdict','shipping') and data->>'idea' <> '';
