-- Live idea mode (src/config.ts IDEA_MODE): an X idea past the screen is judged at once and ends queued (for the dev
-- team or the fee experiments) or rejected, instead of waiting for a round's pick.
alter table intake drop constraint intake_status_check;
alter table intake add constraint intake_status_check check (status in (
  'submitted', 'skipped', 'duplicate', 'full',
  'gated', 'screened', 'candidate', 'picked', 'not_picked',
  'binding', 'queued', 'rejected'
));
