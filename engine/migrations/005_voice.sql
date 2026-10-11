-- DNA on X: the post queue, the reply opt-out list, and the daily tone brief as a log kind.
alter table log drop constraint log_kind_check;
alter table log add constraint log_kind_check check (kind in (
  'tx', 'anchor', 'mode', 'draft', 'alert', 'llm', 'x_post',
  'observe', 'thread', 'step', 'experiment', 'sim', 'security', 'memory', 'epoch', 'core', 'journal',
  'idea', 'report', 'autonomy', 'research', 'intake', 'plate',
  'tone'
));

-- One row per event (a chain log, a closed experiment, a mention). `event` is the RAW event: the disclosure-safe fact
-- sheet is built from it at send time (src/voice.ts factSheet) and recorded in the x_post log record. Mention text is
-- never copied here: a reply row holds only the reader's category.
create table x_outbox (
  id bigserial primary key,
  type text not null check (type in ('post', 'reply')),
  event_key text not null unique,
  event jsonb not null,
  reply_to text,                          -- the mention id a reply answers
  link text,                              -- appended by code after the writer's text (tx link)
  status text not null default 'queued' check (status in ('queued', 'dry_run', 'attempt', 'posted', 'attempted', 'skipped', 'failed')),
  errors int not null default 0,          -- writer failures so far (3 → failed)
  tweet_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index x_outbox_one_reply on x_outbox (reply_to) where type = 'reply'; -- one reply per mention id
create index x_outbox_queued on x_outbox (id) where status = 'queued';

-- Authors who said "stop" / "unsubscribe": never replied to again.
create table x_optout (
  author_id text primary key,
  at timestamptz not null default now()
);
revoke all on x_optout from dna_web;

-- the refresh token is stored sealed (src/sealed.ts): a plaintext row is dropped, never used (the deploy seeds a
-- fresh X_REFRESH_TOKEN)
delete from secret where key = 'x_refresh_token' and value not like 'v1:%';
