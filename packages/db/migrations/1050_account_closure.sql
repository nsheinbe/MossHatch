-- Account closure, export and erasure (PLAN 4.3b "Account closure, export and erasure", docs/design/account-closure-export-erasure.md,
-- D-027, D-030, C-19, C-28, C-48, C-70). Only adds or alters.

-- Two step-up ids join the thirteen: closing the account and asking for a copy of its data both need a passkey.
alter table actions drop constraint if exists actions_type_check;
alter table actions add constraint actions_type_check check (type in (
  'secret.reveal','domain.nameservers.change','domain.unlock','domain.transfer_out','domain.contact.change','agent.purchase.approve',
  'agent.token.create','agent.token.widen','dns.sensitive.approve','device.approve','passkey.add','card.publish','mandate.sign',
  'account.close','account.export'));

-- One row per closure request. `users.status` carries active/closing/closed/purged; this row carries the steps in between:
--   cooling_off  (users.status closing) a passkey sign-in before cooling_off_until cancels it
--   winding_down (closing)              the cooling-off is over: remaining names are deleted, open money must settle
--   closed       (closed)               third parties told; personal data is erased next unless a legal hold applies
--   purged       (purged)               identifying rows erased (ops eraseUser plus the closure residue)
--   sealed       (purged)               every released name's vault ciphertext is destroyed; `chain.closed` is the chain's last row
--   cancelled                           a sign-in inside the cooling-off
create table account_closures (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  state text not null default 'cooling_off' check (state in ('cooling_off','winding_down','closed','purged','sealed','cancelled')),
  action_id uuid not null,                       -- the committed account.close action
  requested_at timestamptz not null,
  cooling_off_until timestamptz not null,
  delete_domains boolean not null default false, -- the person agreed that names still here when the cooling-off ends are deleted
  domain_count integer not null default 0,
  winding_down_at timestamptz,
  closed_at timestamptz,
  purged_at timestamptz,
  sealed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by text check (cancelled_by is null or cancelled_by in ('sign_in','support')),
  blocked_by text[] not null default '{}',       -- codes only: open_order, open_dispute, open_refund, live_domain, transfer_out, legal_hold
  legal_hold boolean not null default false,     -- set by an operator (documented SQL); keeps identifying rows until lifted
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index account_closures_open on account_closures (user_id) where state in ('cooling_off','winding_down','closed');
create index account_closures_due on account_closures (state, cooling_off_until) where state in ('cooling_off','winding_down','closed','purged');
create trigger account_closures_touch before update on account_closures for each row execute function set_updated_at();

-- Exports: the table exists since 0005; the flow adds its state and what the download needs.
alter table account_exports
  add column if not exists state text not null default 'requested' check (state in ('requested','building','ready','expired','failed','cancelled')),
  add column if not exists action_id uuid,
  add column if not exists size_bytes integer,
  add column if not exists sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  add column if not exists failure_code text check (failure_code is null or failure_code ~ '^[a-z_]{1,40}$'),
  add column if not exists download_count integer not null default 0,
  add column if not exists last_downloaded_at timestamptz,
  add column if not exists file_deleted_at timestamptz;
create index if not exists account_exports_user on account_exports (user_id, requested_at desc);
create index if not exists account_exports_expiry on account_exports (expires_at) where state = 'ready';

-- The export file, encrypted under the PII key (one envelope, AAD bound to the export id). The default ExportStore; a blob
-- store can replace it behind the same port. Deleted when the export expires, when the account closes and at erasure.
create table account_export_files (
  export_id uuid primary key references account_exports(id),
  user_id uuid not null references users(id),
  envelope jsonb not null,
  created_at timestamptz not null default now()
);

-- One-time download tickets: 256 bits, stored as SHA-256, bound to the session that asked, 5 minutes, used once.
create table account_export_tickets (
  id uuid primary key default uuidv7(),
  export_id uuid not null references account_exports(id),
  user_id uuid not null references users(id),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  session_id_hash bytea not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index account_export_tickets_export on account_export_tickets (export_id);

-- A Stripe customer is deleted when the account closes (and again after a restore that brought the row back).
alter table stripe_customers add column if not exists deleted_at timestamptz;

do $$
declare t text;
begin
  foreach t in array array['account_closures','account_export_files','account_export_tickets'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant on %I using (user_id = app_user_id()) with check (user_id = app_user_id())', t);
  end loop;
end $$;

-- Runtime: what the request path and the tenant-scoped export job need (RLS bounds every row to the person).
grant select, insert, update on account_closures, account_export_tickets to mh_runtime;
grant select, insert, update on account_export_files to mh_runtime;
grant all on account_closures, account_export_files, account_export_tickets to mh_cron;
