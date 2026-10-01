create table document_versions (
  id uuid primary key default uuidv7(),
  kind text not null,
  version_hash text not null,
  effective_at timestamptz not null,
  retired_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index document_versions_kind_hash on document_versions (kind, version_hash);

create table contacts (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  -- name, street, city, region, postal code, country, phone, email: field-encrypted under the PII key (JSON envelope per field).
  fields_enc jsonb not null,
  email_verified_at timestamptz,
  verification_state text not null default 'pending' check (verification_state in ('pending','verified','failed')),
  verification_deadline_at timestamptz,
  bounced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table consents (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  kind text not null check (kind in ('terms','registration_agreement','tld_addendum','fee_page','auto_renew_mandate','express_request')),
  document_hash text not null,
  version text not null,
  accepted_at timestamptz not null default now(),
  ip_enc jsonb,
  ua_family text,
  assertion_action_id uuid,
  order_id uuid,
  domain_id uuid,
  actor_kind text not null default 'user' check (actor_kind in ('user')),  -- an agent token cannot accept an agreement
  retain_until timestamptz not null,
  created_at timestamptz not null default now()
);
create index consents_user on consents (user_id);

create table tax_regions (
  id uuid primary key default uuidv7(),
  state text not null unique,
  registered_at timestamptz,
  stripe_registration_ref text,
  threshold_state text not null default 'below',
  created_at timestamptz not null default now()
);

create table sales_ledger (
  id uuid primary key default uuidv7(),
  state text not null,
  period date not null,
  gross_minor bigint not null default 0,
  txn_count integer not null default 0,
  unique (state, period)
);

create table sanctions_screenings (
  id uuid primary key default uuidv7(),
  subject_kind text not null,
  subject_ref text not null,
  list_version text not null,
  result text not null check (result in ('clear','match','review')),
  checked_at timestamptz not null default now()
);

create table notices (
  id uuid primary key default uuidv7(),
  kind text not null,
  domain_id uuid,
  user_id uuid not null references users(id),
  sent_at timestamptz not null default now(),
  template_version text not null,
  email_log_id uuid,
  retain_until timestamptz not null,
  legal_hold boolean not null default false
);
create index notices_user on notices (user_id);

create table abuse_reports (
  id uuid primary key default uuidv7(),
  target_kind text not null check (target_kind in ('domain','card')),
  reporter_ref text,
  channel text not null,
  received_at timestamptz not null default now(),
  acked_at timestamptz,
  evidence jsonb,
  decision text,
  actor text,
  state text not null default 'received',
  resolution text,
  actioned_at timestamptz
);
