-- Domain management and DNS (Phase 3). Adds tables only, plus one trigger; no existing table is altered.
-- Every table with a user_id gets forced row-level security and the same `tenant` policy as 0007.

-- Per-domain security bookkeeping. The transfer authorization code is never stored: only the moment it was issued.
create table domain_security (
  domain_id uuid primary key references domains(id),
  user_id uuid not null references users(id),
  code_issued_at timestamptz,             -- issue time only (ST-22, ST-120)
  code_rerandomize_at timestamptz,        -- issue time + 24 h; cleared when the code has been replaced by one nobody knows
  code_rerandomized_at timestamptz,
  transfer_lock_until timestamptz,        -- C-07: 60-day inter-registrar lock after a change of registrant
  transfer_lock_reason text,
  unlocked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger domain_security_touch before update on domain_security for each row execute function set_updated_at();

-- Outbound transfers seen by transfer.poll (GET_TRANSFERS_AWAY). One row per (domain, request time).
create table domain_transfers_away (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  domain_id uuid not null references domains(id),
  gaining_registrar text,
  upstream_status text not null,
  requested_at timestamptz not null,
  detected_at timestamptz not null default now(),
  explained boolean not null default false,           -- a committed domain.transfer_out action matches
  state text not null default 'open' check (state in ('open','stopped','ended','completed')),
  prev_domain_state text,                             -- domains.state before "needs attention", restored when the transfer ends
  alert_id uuid,
  notified_at timestamptz,
  stopped_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (domain_id, requested_at)
);
create index domain_transfers_away_open on domain_transfers_away (domain_id) where state in ('open','stopped');

-- Human follow-up items opened by the product: the Stop ticket, .io code requests, client-hold requests, dispute locks.
create table domain_tickets (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  domain_id uuid not null references domains(id),
  kind text not null check (kind in ('stop_transfer','code_request','client_hold_request','dispute_lock')),
  state text not null default 'open' check (state in ('open','closed')),
  detail jsonb not null default '{}',                  -- ids, counts and enumerated codes only
  sla_due_at timestamptz,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);
create unique index domain_tickets_one_open on domain_tickets (domain_id, kind) where state = 'open';

-- The zone as it was before each write (30 days) and after it, for one-click rollback.
create table dns_snapshots (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  domain_id uuid not null references domains(id),
  reason text not null check (reason in ('pre_write','pre_rollback')),
  zone_hash text not null,
  records jsonb not null,
  after_hash text,
  added_count integer not null default 0,
  removed_count integer not null default 0,
  sensitive_count integer not null default 0,
  actor_kind text not null default 'user',
  rolled_back_at timestamptz,
  taken_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index dns_snapshots_domain on dns_snapshots (domain_id, taken_at desc);
create index dns_snapshots_ttl on dns_snapshots (expires_at);

-- Change of Registrant (C-07). `fields_enc` holds one PII envelope per field; the plain values are never stored here.
create table contact_changes (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  domain_id uuid not null references domains(id),
  state text not null default 'draft' check (state in ('draft','awaiting_approval','applied','expired','failed')),
  fields_enc jsonb not null,
  fields_hash text not null,
  new_email_hash text not null,
  registrant_change boolean not null,
  email_matches_login boolean not null default false,
  action_id uuid,
  submitted_at timestamptz,
  applied_at timestamptz,
  approval_deadline_at timestamptz,
  created_at timestamptz not null default now()
);
create index contact_changes_domain on contact_changes (domain_id, created_at desc);
create index contact_changes_open on contact_changes (approval_deadline_at) where state = 'awaiting_approval';

-- Registrant email verification (C-16): 15 days from registration, change of registrant or a bounce.
create table registrant_verifications (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  domain_id uuid not null references domains(id),
  reason text not null check (reason in ('registration','change_of_registrant','bounce')),
  state text not null default 'pending' check (state in ('pending','verified','suspended')),
  started_at timestamptz not null,
  deadline_at timestamptz not null,
  reminder_sent_at timestamptz,
  code_hash bytea,
  code_expires_at timestamptz,
  code_attempts integer not null default 0,
  verified_at timestamptz,
  suspended_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index registrant_verifications_one_open on registrant_verifications (domain_id) where state in ('pending','suspended');
create index registrant_verifications_due on registrant_verifications (deadline_at) where state = 'pending';

do $$
declare t text;
begin
  foreach t in array array['domain_security','domain_transfers_away','domain_tickets','dns_snapshots','contact_changes','registrant_verifications'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant on %I using (user_id = app_user_id()) with check (user_id = app_user_id())', t);
  end loop;
end $$;

grant select, insert, update on domain_security, domain_transfers_away, domain_tickets, dns_snapshots, contact_changes, registrant_verifications to mh_runtime;
grant all on domain_security, domain_transfers_away, domain_tickets, dns_snapshots, contact_changes, registrant_verifications to mh_cron;

-- Freeze (ST-148): whatever path sets users.frozen_at, the domains are locked afterwards by a job. The trigger only queues
-- work; it changes no domain and touches no session. SECURITY DEFINER so the runtime role may enqueue without wider grants.
create or replace function domain_freeze_enqueue() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into jobs (kind, priority, run_at, dedupe_key, payload, user_id)
  values ('domain.freeze_apply', 1, now(), 'domain.freeze_apply:' || new.id::text || ':' || extract(epoch from new.frozen_at)::text, jsonb_build_object('user_id', new.id), new.id)
  on conflict do nothing;
  return new;
end $$;
revoke all on function domain_freeze_enqueue() from public;
create trigger users_freeze_domains after update of frozen_at on users for each row
  when (old.frozen_at is null and new.frozen_at is not null) execute function domain_freeze_enqueue();
