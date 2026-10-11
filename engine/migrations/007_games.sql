-- The game layer (contracts/SPEC.md §12–§14): the agent's ballot / mystery records. A ballot record lists
-- each option's name and vector with its on-chain descriptor (keccak256 of the canonical {name, vector}); a mystery
-- record holds only the commitment (the preimage is sealed in `secret` until the reveal).
alter table log drop constraint log_kind_check;
alter table log add constraint log_kind_check check (kind in (
  'tx', 'anchor', 'mode', 'draft', 'alert', 'llm', 'x_post',
  'observe', 'thread', 'step', 'experiment', 'sim', 'security', 'memory', 'epoch', 'core', 'journal',
  'idea', 'report', 'autonomy', 'research', 'intake', 'plate',
  'tone', 'cycle', 'state', 'game'
));
