-- Read-only role for the web service. Created without login: the operator enables it once with a secret
--   alter role dna_web with login password '<secret>';
-- and gives web DATABASE_URL=postgres://dna_web:<secret>@host/db. LISTEN needs no extra privilege.
do $$ begin
  if not exists (select from pg_roles where rolname = 'dna_web') then
    create role dna_web nologin;
  end if;
end $$;
grant usage on schema public to dna_web;
grant select on all tables in schema public to dna_web;
alter default privileges in schema public grant select on tables to dna_web;
