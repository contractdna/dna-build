-- X conversations (src/tiers.ts): a reply drafted for an important account waits as 'held' until a signer taps Send
-- (or Skip) in Telegram. Threads are read from x_mention (conversation_id in raw) and x_outbox: no new table.
alter table x_outbox drop constraint x_outbox_status_check;
alter table x_outbox add constraint x_outbox_status_check check (status in (
  'queued', 'held', 'dry_run', 'attempt', 'posted', 'attempted', 'skipped', 'failed', 'digest', 'digested'
));
create index x_mention_conversation on x_mention ((raw->>'conversation_id'), author_id);
