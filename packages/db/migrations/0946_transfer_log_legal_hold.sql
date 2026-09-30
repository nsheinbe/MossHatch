-- C-19: `legal_hold` next to `retain_until` on the transfer log too (0900 created it without one). The retention purge
-- (`retention.expire`) already reads the hold of every table it purges, so a transfer-log row under hold now survives its
-- 15-month clock until the hold is lifted. Only adds.
alter table transfer_log add column if not exists legal_hold boolean not null default false;
create index if not exists transfer_log_retain on transfer_log (retain_until) where not legal_hold;
