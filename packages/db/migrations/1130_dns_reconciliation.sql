-- Local application migration only: never run against production without release approval.
-- Existing snapshots are also operation receipts. Persist the immutable intended zone and
-- read-only reconciliation observations. A timed-out request is never retried automatically.
alter table dns_snapshots
  -- No default/backfill: legacy snapshots omitted TTL/opaque records and are not safe rollback inventories.
  add column state_format text check (state_format = 'complete-v1'),
  add column intended_records jsonb,
  add column agent_request_id uuid references agent_requests(id),
  add column observed_hash text,
  add column observed_at timestamptz,
  add column reconciliation_state text not null default 'unresolved'
    check (reconciliation_state in ('unresolved','desired_observed','before_observed','partial_observed'));
create index dns_snapshots_unresolved on dns_snapshots(domain_id)
  where write_state in ('pending','unknown');
