-- The allowed log kinds become rows of `log_kinds` (a foreign key from log.kind) instead of a CHECK list that every
-- migration had to rewrite whole: a later migration adds its kinds with
--   insert into log_kinds (kind) values ('...') on conflict do nothing;
-- which does not depend on the order migrations land in. Existing rows are untouched (the key only validates them).
-- simplification: a plain add (one index-backed check per row: hundreds of records a day, well under a second). A
-- `not valid` + `validate constraint` split would only help in separate transactions, and each migration file runs in
-- one; split it if the log ever grows past millions of rows.
-- New kind 'self': the brain's self-file (src/self.ts), at least one signed record a day (ref = the UTC day) with the
-- file's text and sha256, and the persona and context hashes it ran beside.
create table log_kinds (kind text primary key);
insert into log_kinds (kind) values
  ('tx'), ('anchor'), ('mode'), ('draft'), ('alert'), ('llm'), ('x_post'),
  ('observe'), ('thread'), ('step'), ('experiment'), ('sim'), ('security'), ('memory'), ('epoch'), ('core'), ('journal'),
  ('idea'), ('report'), ('autonomy'), ('research'), ('intake'), ('plate'),
  ('tone'), ('cycle'), ('state'), ('game'), ('announce'),
  ('brain'), ('approve'), ('veto'), ('model-change'),
  ('binding'), ('reward'),
  ('build'), ('gates'), ('ship'), ('ship-cancel'), ('retire'), ('release'), ('page-kill'), ('fund'),
  ('self');
alter table log drop constraint log_kind_check;
alter table log add constraint log_kind_fk foreign key (kind) references log_kinds (kind);
