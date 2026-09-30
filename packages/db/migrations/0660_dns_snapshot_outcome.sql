-- DNS write safety, review fix (plan 4.3b): a zone write now commits its pre-write snapshot BEFORE the registrar is called, so the
-- snapshot survives a write whose outcome is unknown. The row says what became of the write, and which zone the write asked for, so a
-- write that may have landed can still be rolled back exactly. Adds columns only; existing rows are writes that completed.
alter table dns_snapshots
  add column write_state text not null default 'applied' check (write_state in ('pending','applied','unknown','refused')),
  add column intended_hash text;
