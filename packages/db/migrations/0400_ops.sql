-- Ops module: brand-domain expectations and expiry watch, and the job-lease fence.

-- Stored expectation for the daily external check (ST-111): the NS, MX and apex A of each brand domain.
-- Changing a row is an operator action (a documented SQL statement); the app only reads it.
create table external_expectations (
  id uuid primary key default uuidv7(),
  domain text not null,
  rrtype text not null check (rrtype in ('NS','MX','A')),
  expected text[] not null,               -- lower-case, no trailing dot; MX entries are the exchange host only
  updated_by text not null default 'operator',
  updated_at timestamptz not null default now(),
  unique (domain, rrtype)
);

-- Domains we must never lose (D-033). alerted_days records which of 90/60/30 already fired for the current expiry.
create table owned_domains_watch (
  domain text primary key,
  registrar text,
  registered_at timestamptz,
  expires_at timestamptz,
  alerted_days integer[] not null default '{}',
  updated_at timestamptz not null default now()
);
create trigger owned_domains_watch_touch before update on owned_domains_watch for each row execute function set_updated_at();

grant select, insert, update, delete on external_expectations, owned_domains_watch to mh_cron;

-- A worker that outlived its lease must not commit. The handler's own writes run in a transaction that first takes a
-- share lock on its job row through this function (definer, so the runtime role needs no UPDATE right on jobs). While
-- the lock is held the reclaimer cannot flip the row, and once the lease is gone or the attempt changed it returns false.
create or replace function job_lease_lock(p_id uuid, p_attempt uuid, p_now timestamptz)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from jobs where id = p_id and attempt_id = p_attempt and state = 'running' and locked_until > p_now for share;
  return found;
end $$;
revoke all on function job_lease_lock(uuid, uuid, timestamptz) from public;
grant execute on function job_lease_lock(uuid, uuid, timestamptz) to mh_runtime, mh_cron;

-- Recurring jobs are enqueued once per bucket: this index makes "already enqueued for this bucket" a cheap lookup.
create index jobs_kind_dedupe on jobs (kind, dedupe_key) where dedupe_key is not null;
