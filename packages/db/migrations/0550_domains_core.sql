-- Domains core (Phase 3): adapter-truth sync fields, renewal schedule, auto-renew consent, refund rules, reconciliation, release, balance.
-- Adds and alters only; 0001-0400 stay untouched.

-- ---- domains: what the adapter told us last (cache with synced_at; `state` already mirrors the adapter status) ------------------
alter table domains
  add column if not exists transfer_away boolean not null default false,           -- adapter reports a pending outbound transfer
  add column if not exists owner_email_hash text,                                  -- SHA-256 of the lower-cased registrant email; never the address
  add column if not exists let_expire boolean not null default false,
  add column if not exists privacy_service boolean not null default false,        -- the paid privacy service is on (the product does not sell it)
  add column if not exists sync_error_since timestamptz,                           -- first failed sync in the current run of failures (the 15-minute rule)
  add column if not exists dispute_locked_at timestamptz,                          -- C-23: set only on registrar instruction (operator function)
  add column if not exists release_hold_until timestamptz;                         -- export works until here; destruction follows
create index if not exists domains_expiry on domains (expires_at) where released_at is null;
create index if not exists domains_released on domains (released_at) where released_at is not null;

-- ---- renewal schedule: one row per (domain, the expiry it extends) -------------------------------------------------------------
create table renewal_terms (
  id uuid primary key default uuidv7(),
  domain_id uuid not null references domains(id),
  user_id uuid not null references users(id),
  term_end timestamptz not null,                   -- E: the expiry this renewal extends
  target_expiry_year integer not null,             -- year of E, passed to the registrar as the current expiry year (its double-renew guard)
  charge_at timestamptz not null,                  -- C = E - 10 days
  state text not null default 'scheduled' check (state in ('scheduled','held','charging','payment_failed','renewing','renewed','refunded','lapsed','skipped')),
  held_reason text,                                -- account_review, above_cap, price_notice_pending, funds_gate, no_saved_card, paused
  order_id uuid references orders(id),
  baseline_price_minor bigint not null,            -- what the person was first told (subtotal for the term)
  current_price_minor bigint not null,
  current_wholesale_minor bigint not null default 0, -- reserved against the registrar balance (the sell gate)
  notified_price_minor bigint not null,            -- the highest price a notice has told them about
  price_notice_at timestamptz,                     -- when the latest price-change notice went out
  price_checked_at timestamptz,
  try integer not null default 0,                  -- off-session charge tries: the Stripe idempotency key includes it
  next_try_at timestamptz,
  livemode boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (domain_id, term_end)
);
create index renewal_terms_due on renewal_terms (charge_at) where state in ('scheduled','held','charging','payment_failed');
create index renewal_terms_user on renewal_terms (user_id);
create trigger renewal_terms_touch before update on renewal_terms for each row execute function set_updated_at();
alter table renewal_terms enable row level security;
alter table renewal_terms force row level security;
create policy tenant on renewal_terms using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert, update on renewal_terms to mh_runtime;

-- The first failed upstream renewal: the 15-minute then hourly cadence is counted from here (ST-110).
alter table orders add column if not exists upstream_first_failed_at timestamptz;

-- ---- auto-renew mandate: one live mandate per domain; consent recorded apart from the terms (C-31, C-38) ------------------------
create unique index if not exists renewal_mandates_one_live on renewal_mandates (domain_id) where revoked_at is null;
alter table renewal_mandates
  add column if not exists stripe_customer_ref text,
  add column if not exists revoked_by text;         -- user, email_link, agent, system, release

-- ---- notices ledger: one row per (domain, kind, term) --------------------------------------------------------------------------
alter table notices
  add column if not exists term_key text,
  add column if not exists stage text;
create unique index if not exists notices_once_per_term on notices (domain_id, kind, term_key) where term_key is not null;

-- ---- refund rules (C-29): data, not code ----------------------------------------------------------------------------------------
create table refund_policy (
  registrar text not null,
  tld text not null,
  refundable boolean not null,
  window_days integer,                    -- days from registry creation (registration) or from the charge (renewal)
  note text,
  primary key (registrar, tld)
);
insert into refund_policy (registrar, tld, refundable, window_days, note) values
  ('opensrs','com',true,5,'add grace period'), ('opensrs','dev',true,5,'add grace period'), ('opensrs','app',true,5,'add grace period'), ('opensrs','studio',true,5,'add grace period'),
  ('opensrs','io',false,null,'registry terms: no refund once registered'), ('opensrs','ai',false,null,'unverified upstream: non-refundable unless the upstream says otherwise')
  on conflict do nothing;
grant select on refund_policy to mh_runtime;

-- ---- reconciliation (ST-114, ST-60): what the detector found, per run -------------------------------------------------------------
create table reconciliation_runs (
  id uuid primary key default uuidv7(),
  kind text not null check (kind in ('inventory','sync','posture')),
  started_at timestamptz not null,
  finished_at timestamptz,
  domains_seen integer not null default 0,
  findings_opened integer not null default 0,
  error text
);
create table reconciliation_findings (
  id uuid primary key default uuidv7(),
  run_id uuid references reconciliation_runs(id),
  domain_id uuid references domains(id),
  fqdn_ascii text,                        -- operator table: needed for extra_domain rows that have no domain id
  kind text not null check (kind in ('unexplained_change','missing_domain','extra_domain','mismatch')),
  fields text[] not null default '{}',    -- field names only (lock, nameservers, ds, contact_email_hash, auto_renew, let_expire, privacy, transfer)
  detail jsonb not null default '{}',     -- counts and booleans; never values, addresses or names
  fingerprint text not null,
  state text not null default 'open' check (state in ('open','explained','dismissed')),
  found_at timestamptz not null,
  resolved_at timestamptz
);
create unique index reconciliation_findings_open on reconciliation_findings (fingerprint) where state = 'open';
create index reconciliation_findings_domain on reconciliation_findings (domain_id, found_at);

-- ---- release (ST-94 to ST-96, C-53): every cause sets released_at; destruction waits out the hold ---------------------------------
create table domain_releases (
  id uuid primary key default uuidv7(),
  domain_id uuid not null unique references domains(id),
  user_id uuid not null references users(id),
  cause text not null check (cause in ('lapsed','transferred_out','unpaid','refunded','account_closed','deleted')),
  released_at timestamptz not null,
  hold_until timestamptz not null,
  bindings_revoked integer not null default 0,
  mandates_revoked integer not null default 0,
  unpublished_at timestamptz,
  steps_done_at timestamptz,              -- immediate steps (revoke, cancel, unpublish) finished
  destroyed_at timestamptz,               -- secrets and connection credentials destroyed after the hold
  created_at timestamptz not null default now()
);
create index domain_releases_hold on domain_releases (hold_until) where destroyed_at is null;
alter table domain_releases enable row level security;
alter table domain_releases force row level security;
create policy tenant on domain_releases using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select on domain_releases to mh_runtime;

-- A released name can be registered again (ST-94): the register order that held the name stops counting once its domain is released.
-- The index keeps its name, which the order machine's "someone else just bought this name" branch matches on.
alter table orders add column if not exists superseded_at timestamptz;
drop index if exists orders_one_live_register;
create unique index orders_one_live_register on orders (fqdn_ascii)
  where kind = 'register' and superseded_at is null and state in ('authorized','registering','outcome_unknown','registered','capturing','captured');

-- ---- registrar balance and the sell gate (hourly job) --------------------------------------------------------------------------------
create table registrar_balance_snapshots (
  id uuid primary key default uuidv7(),
  at timestamptz not null,
  balance_minor bigint not null,
  held_minor bigint not null,
  available_minor bigint not null,
  reserved_renewals_minor bigint not null,
  reserved_registrations_minor bigint not null,
  floor_minor bigint not null,
  gate_open boolean not null
);

insert into flags (name, value) values ('sell_gate.min_funds_minor', '25000'), ('renewals_paused', 'false') on conflict do nothing;

grant select, insert, update, delete on renewal_terms, refund_policy, reconciliation_runs, reconciliation_findings, domain_releases, registrar_balance_snapshots to mh_cron;
