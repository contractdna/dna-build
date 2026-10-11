-- Copy pools (src/clones.ts): its signed records.
--  clone    one DNA pool without DNA's hook (ref = v4 pool id or the v2/v3 pool address)
--  leakage  DNA volume through the hook pool vs the copies over one block window (ref = its last block)
insert into log_kinds (kind) values ('clone'), ('leakage') on conflict do nothing;
