-- Phase 5 transfers (0900-0949): Rescue (transfer-in) and the Gate (transfer-out). Adds tables and columns only.

-- C-01 / C-06: the per-TLD transfer profile, built to today's Transfer Policy text (updated 2024-02-21, in force 2025-08-21). The TAC
-- recommendations (Board 2026-06-07) have no effective date and are not encoded as ICANN rules here.
alter table tld_policy add column if not exists transfer_add_years integer not null default 1;
alter table tld_policy add column if not exists transfer_lock_days integer not null default 60;
alter table tld_policy add column if not exists owner_confirm_days integer not null default 5;
alter table tld_policy add column if not exists policy_profile text not null default 'transfer-policy-2024-02-21';
-- Registry pending window 5 calendar days for .com .dev .app .studio; the longest seen through OpenSRS is about two weeks (C-06).
update tld_policy set registry_window_days = 5, longest_seen_days = 14 where registrar = 'opensrs' and tld in ('com', 'dev', 'app', 'studio');
-- .ai and .io: only registrar knowledge bases exist, so no registry window is stored ("The registry sets the timing and we cannot predict it").
update tld_policy set registry_window_days = null, longest_seen_days = 14 where registrar = 'opensrs' and tld in ('ai', 'io');
update tld_policy set transfer_add_years = 2 where registrar = 'opensrs' and tld = 'ai';

-- One inbound transfer. The authorization code is held (PII envelope) only until the registrar accepts the order, then wiped; it is
-- never in a job payload, an audit row, an order event or a log line (ST-22).
create table transfers_in (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  order_id uuid not null unique references orders(id),
  fqdn_ascii text not null,
  tld text not null,
  years integer not null check (years between 1 and 2),
  state text not null default 'awaiting_confirmation' check (state in (
    'awaiting_confirmation', 'awaiting_payment', 'submitting', 'submitted', 'pending_owner_approval', 'pending_registry',
    'completed', 'failed', 'nacked', 'cancelled', 'expired')),
  idempotency_key text not null,
  request_hash bytea not null,
  auth_code_enc jsonb,
  auth_code_wiped_at timestamptz,
  -- C-08 inbound: the registrant email confirms the transfer (an authenticated owner confirmation, stored as a hash and a time).
  confirm_code_hash bytea,
  confirm_expires_at timestamptz,
  confirm_attempts integer not null default 0,
  confirm_sends integer not null default 0,
  confirm_email_hash text,
  confirmed_at timestamptz,
  eligibility jsonb not null default '{}',             -- codes and dates only
  dnssec_checked boolean not null default false,
  registrar_order_id text,
  sent_at timestamptz,
  upstream_status text,
  owner_deadline_at timestamptz,
  registry_deadline_at timestamptz,
  early_capture_at timestamptz,
  completed_at timestamptz,
  ended_at timestamptz,
  failure text,
  nack_reason text,
  domain_id uuid references domains(id),
  next_check_at timestamptz,
  check_count integer not null default 0,
  late_watch_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create trigger transfers_in_touch before update on transfers_in for each row execute function set_updated_at();
-- One live transfer-in per name across every account, from payment onwards.
create unique index transfers_in_one_live on transfers_in (fqdn_ascii)
  where state in ('awaiting_payment', 'submitting', 'submitted', 'pending_owner_approval', 'pending_registry');
create index transfers_in_open on transfers_in (next_check_at) where state in ('awaiting_confirmation', 'awaiting_payment', 'submitting', 'submitted', 'pending_owner_approval', 'pending_registry');

-- C-09 / C-10: the transfer log (who, when, how), kept 15 months. Codes and ids only, never a code or a name.
create table transfer_log (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  domain_id uuid references domains(id),
  transfer_in_id uuid references transfers_in(id),
  direction text not null check (direction in ('in', 'out')),
  event text not null,
  actor_kind text not null check (actor_kind in ('user', 'system', 'operator')),
  detail jsonb not null default '{}',
  at timestamptz not null,
  retain_until timestamptz not null
);
create index transfer_log_user on transfer_log (user_id, at desc);
create index transfer_log_domain on transfer_log (domain_id, at desc);

-- The Gate: a requested outbound transfer gets its own notice, and a completed one is released once.
alter table domain_transfers_away add column if not exists gate_notified_at timestamptz;
alter table domain_transfers_away add column if not exists released_at timestamptz;

do $$
declare t text;
begin
  foreach t in array array['transfers_in', 'transfer_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant on %I using (user_id = app_user_id()) with check (user_id = app_user_id())', t);
  end loop;
end $$;

grant select, insert, update on transfers_in to mh_runtime;
grant select, insert on transfer_log to mh_runtime;
grant all on transfers_in, transfer_log to mh_cron;
