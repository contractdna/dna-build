-- Character memory (src/character.ts): what the X writer remembers. It feeds the writer only, never the brain or
-- anything that moves money. Its sources are signed log records: our own x_post records (the history view below) and
-- `character` records (the weekly voice audit's banned patterns). People are found by X id, jokes by label, both in the
-- same x_post records (`author`, `joke`); the mood is computed from the state and kept in each x_post record.
insert into log_kinds (kind) values ('character') on conflict do nothing;

-- Every text we posted (or dry-ran): the writer's history, with the enclave-chain fields so a reader can check each row.
create view x_post_history as
  select seq, at, kind, ref, body, eprev, ehash, esig, doc from log
  where kind = 'x_post' and doc->>'status' in ('attempt', 'dry_run') and doc ? 'text';

-- a reject's signer is kept as its allowlist place (src/telegram.ts signerTag), never a Telegram user id: the column
-- becomes text and the ids stored so far are dropped
alter table draft alter column decided_by type text using null;

-- people by X id (character memory) and a post by its tweet id (/api/log/tweet/<id>: the signed text behind a post)
create index log_x_post_author on log ((doc->>'author')) where kind = 'x_post';
create index log_x_post_tweet on log ((doc->>'tweetId')) where kind = 'x_post';
