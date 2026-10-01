create table domains (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  fqdn_ascii text not null,
  tld text not null,
  registrar text not null,
  registrar_ref text,
  state text not null default 'pending',
  registered_at timestamptz,
  registry_created_at timestamptz,
  expires_at timestamptz,
  locked boolean not null default true,
  privacy_status text not null default 'redacted_default' check (privacy_status in ('redacted_default','not_available','exposed')),
  auto_renew boolean not null default false,
  nameservers text[] not null default '{}',
  registry_statuses text[] not null default '{}',
  ds_present boolean not null default false,
  dns_hosted_here boolean not null default false,
  dispute_lock_state text,
  livemode boolean not null,
  released_at timestamptz,
  release_reason text,
  synced_at timestamptz,
  sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index domains_live_fqdn on domains (fqdn_ascii) where released_at is null;
create index domains_user on domains (user_id);

create table registrar_profiles (
  id uuid primary key default uuidv7(),
  order_id uuid not null,
  domain_id uuid,
  username text not null,
  password_enc jsonb not null,
  created_at timestamptz not null default now()
);

create table stripe_customers (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  stripe_customer_id text not null unique,
  livemode boolean not null,
  created_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  kind text not null check (kind in ('register','renew','transfer_in','restore')),
  fqdn_ascii text not null,
  domain_id uuid references domains(id),
  years integer not null check (years between 1 and 10),
  state text not null default 'draft' check (state in (
    'draft','checkout_open','checkout_expired','payment_failed','review_hold','authorized','registering','registered',
    'capturing','captured','capture_failed','registrar_unavailable','outcome_unknown','registration_failed','canceling','voided',
    'refund_pending','refunded','partially_refunded','refund_failed','dispute_open','dispute_won','dispute_lost',
    'paid_before_registration','renewing_upstream','renewed')),
  idempotency_key text not null,
  request_hash bytea not null,
  quote jsonb not null,
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  tax_ceiling_minor bigint not null default 0 check (tax_ceiling_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  currency text not null default 'usd' check (currency = 'usd'),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  attempt integer not null default 1,
  capture_before timestamptz,
  target_expiry_year integer,
  agent_request_id uuid unique,
  reg_username text,                       -- the upstream profile generated for this order before the call
  checkout_ip_enc jsonb,
  livemode boolean not null,
  failure_code text,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index orders_user on orders (user_id, created_at desc);
create index orders_open on orders (state) where state in ('checkout_open','authorized','registering','outcome_unknown','registered','capturing','capture_failed','canceling','registrar_unavailable','paid_before_registration');
-- Two customers who pay for the same name: the second is voided at `authorized`.
create unique index orders_one_live_register on orders (fqdn_ascii) where kind = 'register' and state in ('authorized','registering','outcome_unknown','registered','capturing','captured');
create unique index orders_one_open_renewal on orders (domain_id, kind, target_expiry_year) where kind in ('renew','restore') and state not in ('checkout_expired','payment_failed','voided','refunded','registration_failed','renewed','captured');
create trigger orders_touch before update on orders for each row execute function set_updated_at();

create table order_operations (
  id uuid primary key default uuidv7(),
  order_id uuid not null references orders(id),
  kind text not null,
  seq integer not null default 1,
  request_hash bytea not null,
  state text not null default 'intent' check (state in ('intent','sent','resolved')),
  sent_at timestamptz,
  registrar_order_id text,
  response_code text,
  attempt_id uuid,
  detail jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, kind, seq)
);
create trigger order_operations_touch before update on order_operations for each row execute function set_updated_at();

create table order_events (
  id uuid primary key default uuidv7(),
  order_id uuid not null references orders(id),
  from_state text,
  to_state text not null,
  cause text not null check (cause in ('webhook','job','user','agent','system')),
  stripe_event_id text,
  detail jsonb,
  at timestamptz not null default now()
);
create index order_events_order on order_events (order_id, at);

create table payments (
  id uuid primary key default uuidv7(),
  order_id uuid not null references orders(id),
  user_id uuid not null references users(id),
  stripe_payment_intent_id text not null unique,
  amount_minor bigint not null,
  tax_minor bigint not null default 0,
  currency text not null,
  status text not null,
  captured_at timestamptz,
  refunded_minor bigint not null default 0,
  dispute_state text,
  billing_state text,
  livemode boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table refunds (
  id uuid primary key default uuidv7(),
  order_id uuid not null references orders(id),
  payment_id uuid not null references payments(id),
  user_id uuid not null references users(id),
  stripe_refund_id text unique,
  amount_minor bigint not null,
  reason text,
  created_at timestamptz not null default now()
);

create table renewal_mandates (
  id uuid primary key default uuidv7(),
  domain_id uuid not null references domains(id),
  user_id uuid not null references users(id),
  stripe_payment_method_ref text,
  price_ceiling_minor bigint not null,
  charge_days_before_expiry integer not null default 10,
  text_hash text not null,
  term_years integer not null default 1,
  signed_action_id uuid,
  consent_id uuid,
  accepted_at timestamptz not null default now(),
  retain_until timestamptz not null,
  revoked_at timestamptz,
  next_charge_at timestamptz
);

create table wholesale_prices (
  id uuid primary key default uuidv7(),
  registrar text not null,
  tld text not null,
  kind text not null check (kind in ('register','renew','transfer','restore')),
  amount_minor bigint not null,
  currency text not null default 'usd',
  effective_from date not null,
  source text not null,
  unique (registrar, tld, kind, effective_from)
);

create table tld_policy (
  registrar text not null,
  tld text not null,
  registry_window_days integer,
  longest_seen_days integer,
  expiry_grace_days integer,
  redemption_days integer,
  auction_from_day integer,
  restore_via_api boolean not null default false,
  min_term_years integer not null default 1,
  source text,
  primary key (registrar, tld)
);

create table maintenance_windows (
  id uuid primary key default uuidv7(),
  registrar text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  source text not null
);
