-- Public announcements: every event that matters is an `announce` log record the moment the
-- engine sees it (the site's feed reads them), and an X post by priority within the daily cap. What does not fit is
-- rolled into one daily digest post: status 'digest' (waiting for it), then 'digested' (in a posted digest).
alter table log drop constraint log_kind_check;
alter table log add constraint log_kind_check check (kind in (
  'tx', 'anchor', 'mode', 'draft', 'alert', 'llm', 'x_post',
  'observe', 'thread', 'step', 'experiment', 'sim', 'security', 'memory', 'epoch', 'core', 'journal',
  'idea', 'report', 'autonomy', 'research', 'intake', 'plate',
  'tone', 'cycle', 'state', 'game', 'announce'
));
alter table x_outbox drop constraint x_outbox_status_check;
alter table x_outbox add constraint x_outbox_status_check check (status in (
  'queued', 'dry_run', 'attempt', 'posted', 'attempted', 'skipped', 'failed', 'digest', 'digested'
));
-- one announcement per event key, also against two engine processes racing the select-then-append in announce()
create unique index log_announce_ref on log (ref) where kind = 'announce';
