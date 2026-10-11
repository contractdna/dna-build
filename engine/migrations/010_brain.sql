-- The brain and the model registry: `brain` decision records, Safe-owner `approve` / `veto` signatures on delayed
-- actions, and `model-change` records (a model swap that takes effect after its public hour).
alter table log drop constraint log_kind_check;
alter table log add constraint log_kind_check check (kind in (
  'tx', 'anchor', 'mode', 'draft', 'alert', 'llm', 'x_post',
  'observe', 'thread', 'step', 'experiment', 'sim', 'security', 'memory', 'epoch', 'core', 'journal',
  'idea', 'report', 'autonomy', 'research', 'intake', 'plate',
  'tone', 'cycle', 'state', 'game', 'announce',
  'brain', 'approve', 'veto', 'model-change'
));
