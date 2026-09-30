create table users (
  id uuid primary key default uuidv7(),
  email citext not null,
  email_verified_at timestamptz,
  webauthn_user_handle bytea not null default gen_random_bytes(32),
  billing_country text,
  terms_version text,
  terms_accepted_at timestamptz,
  status text not null default 'pending' check (status in ('pending','active','closing','closed','purged')),
  frozen_at timestamptz,
  risk_state text not null default 'normal' check (risk_state in ('normal','review')),
  hardened_mode boolean not null default false,
  device_login_enabled boolean not null default true,
  closed_at timestamptz,
  expires_at timestamptz,               -- pending rows only: 24 h
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One live account per address; a pending row never blocks a later verified sign-up (it is replaced).
create unique index users_email_live on users (email) where status in ('active','closing');
create unique index users_email_pending on users (email) where status = 'pending';
create unique index users_handle on users (webauthn_user_handle);
create trigger users_touch before update on users for each row execute function set_updated_at();

create table notification_addresses (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  address citext not null,
  kind text not null check (kind in ('login','second','registrant')),
  verified_at timestamptz,
  removed_at timestamptz,
  added_by_action_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index notification_addresses_live on notification_addresses (user_id, address) where removed_at is null;

create table passkeys (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  credential_id text not null unique,
  public_key bytea not null,
  alg integer not null check (alg in (-7, -257)),
  sign_count bigint not null default 0,
  transports text[] not null default '{}',
  backup_eligible boolean not null,
  backup_state boolean not null,
  label text not null default 'Passkey',
  last_used_at timestamptz,
  revoked_at timestamptz,
  suspended_at timestamptz,
  suspended_by_recovery_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index passkeys_user on passkeys (user_id);

create table sessions (
  id_hash bytea primary key,
  user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,       -- absolute, 8 h
  idle_expires_at timestamptz not null,  -- 15 min from last use
  revoked_at timestamptz,
  auth_credential_id text,
  ip_prefix text,
  ua_family text
);
create index sessions_user on sessions (user_id) where revoked_at is null;

create table webauthn_challenges (
  id uuid primary key default uuidv7(),
  purpose text not null check (purpose in ('register','login','stepup')),
  challenge text not null,
  user_id uuid references users(id),
  session_id_hash bytea,
  pre_auth_hash bytea,                   -- login: hash of the __Host-mh_pre cookie value
  action_id uuid,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index webauthn_challenges_lookup on webauthn_challenges (challenge);

-- Emailed one-time codes: sign-up verification and recovery. Stored hashed; five wrong tries kill a code.
create table email_codes (
  id uuid primary key default uuidv7(),
  purpose text not null check (purpose in ('signup','recovery')),
  email citext not null,
  user_id uuid references users(id),
  code_hash bytea not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index email_codes_email on email_codes (email, purpose);

create table recovery_codes (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  code_hash bytea not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index recovery_codes_user on recovery_codes (user_id);

create table recovery_requests (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  path text not null check (path in ('codes_email','email_only')),
  status text not null default 'pending' check (status in ('pending','cooling_off','holding','completed','cancelled')),
  cooling_off_until timestamptz,
  hold_until timestamptz,
  cancelled_by text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index recovery_one_open on recovery_requests (user_id) where status in ('pending','cooling_off','holding');

-- Holds that outlive the request (24 h / 72 h after completion, or 24 h on secret.reveal after adding a passkey).
create table action_holds (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  scope text not null check (scope in ('all_held','secret.reveal')),
  until timestamptz not null,
  recovery_id uuid references recovery_requests(id),
  created_at timestamptz not null default now()
);
create index action_holds_user on action_holds (user_id, until);

create table email_action_tokens (
  id uuid primary key default uuidv7(),
  token_hash bytea not null unique,
  purpose text not null check (purpose in ('freeze','recovery_cancel','auto_renew_off')),
  event_id uuid not null,
  user_id uuid not null references users(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table actions (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  session_id_hash bytea not null,
  type text not null check (type in ('secret.reveal','domain.nameservers.change','domain.unlock','domain.transfer_out','domain.contact.change','agent.purchase.approve','agent.token.create','agent.token.widen','dns.sensitive.approve','device.approve','passkey.add','card.publish','mandate.sign')),
  params jsonb not null,
  params_hash bytea not null,
  resource_id text,
  state text not null default 'prepared' check (state in ('prepared','committed','dispatching','executed','failed','outcome_unknown','expired','cancelled')),
  expires_at timestamptz not null,
  committed_at timestamptz,
  credential_id text,
  uv boolean, be boolean, bs boolean,
  client_data_json bytea, authenticator_data bytea, signature bytea,
  terms_hash bytea,
  expected_post_state jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- ST-56: evidence is complete on every committed action.
  constraint actions_evidence check (state = 'prepared' or state in ('expired','cancelled') or (credential_id is not null and uv is not null and be is not null and bs is not null and client_data_json is not null and authenticator_data is not null and signature is not null))
);
create index actions_user on actions (user_id, created_at desc);

-- Minimal now; Phase 4 and 5 add creation flows. Tokens are stored as SHA-256 hashes only.
create table bindings (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  kind text not null check (kind in ('agent','cli')),
  name text not null,
  token_prefix text not null,
  token_hash bytea not null unique,
  scopes jsonb not null default '[]',
  spend_cap_minor bigint not null default 0 check (spend_cap_minor >= 0),
  reserved_minor bigint not null default 0 check (reserved_minor >= 0),
  spent_minor bigint not null default 0 check (spent_minor >= 0),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  paused_at timestamptz,
  last_used_at timestamptz,
  created_by_action_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bindings_prefix on bindings (token_prefix);
