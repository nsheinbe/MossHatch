-- Vault (Phase 4): secrets, their envelope-encrypted versions, connections and stored provider credentials.
-- Only adds or alters. Ciphertext lives in exactly two tables, secret_versions and connection_credentials, and only the
-- vault role (mh_vault) and the system role can read them; the runtime role sees names and versions, never ciphertext.

create table secrets (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  domain_id uuid not null references domains(id),
  env text not null check (env in ('dev','preview','prod')),
  name text not null check (name ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  -- Null until the first version commits (a write whose KMS call failed leaves no visible secret).
  current_version integer check (current_version is null or current_version >= 1),
  current_version_id uuid,
  -- KMS HMAC (the pointer key) over secret_id, domain_id, name, env, current_version and current_version_id; checked on every read.
  pointer_mac bytea,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint secrets_pointer_complete check ((current_version is null) = (current_version_id is null) and (current_version is null) = (pointer_mac is null))
);
create unique index secrets_live_name on secrets (domain_id, env, name) where deleted_at is null;
create index secrets_user on secrets (user_id);
create trigger secrets_touch before update on secrets for each row execute function set_updated_at();

create table secret_versions (
  id uuid primary key default uuidv7(),
  secret_id uuid not null references secrets(id),
  user_id uuid not null references users(id),
  version integer not null check (version >= 1),
  format_version smallint not null default 1 check (format_version = 1),
  alg text not null default 'A256GCM' check (alg = 'A256GCM'),
  ciphertext bytea check (ciphertext is null or octet_length(ciphertext) between 1 and 16384),
  nonce bytea not null check (octet_length(nonce) = 12),
  tag bytea not null check (octet_length(tag) = 16),
  wrapped_dek bytea,
  kek_ref text not null,
  kek_class text not null check (kek_class in ('vault-prod','vault-nonprod')),
  created_by_kind text not null check (created_by_kind in ('user','agent','cli','system')),
  created_by_id text,
  destroyed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (secret_id, version),
  -- Deletion nulls the ciphertext and the wrapped key at once; a live row always has both.
  constraint secret_versions_destroyed check (
    (destroyed_at is null and ciphertext is not null and wrapped_dek is not null) or (destroyed_at is not null and ciphertext is null and wrapped_dek is null))
);
create index secret_versions_kek on secret_versions (kek_ref) where destroyed_at is null;
create index secret_versions_user on secret_versions (user_id);

create table connections (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  domain_id uuid not null references domains(id),
  service text not null check (service in ('vercel','neon','resend')),
  external_ref text check (external_ref is null or external_ref ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  status text not null default 'active' check (status in ('active','ended','error')),
  recipe_application_id uuid,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index connections_live on connections (domain_id, service) where ended_at is null;
create index connections_user on connections (user_id);
create trigger connections_touch before update on connections for each row execute function set_updated_at();

create table connection_credentials (
  id uuid primary key default uuidv7(),
  connection_id uuid not null references connections(id),
  user_id uuid not null references users(id),
  kind text not null check (kind in ('pasted_token','oauth_refresh')),
  scope_summary text check (scope_summary is null or scope_summary ~ '^[a-z0-9_:.-]{1,64}$'),
  format_version smallint not null default 1 check (format_version = 1),
  alg text not null default 'A256GCM' check (alg = 'A256GCM'),
  ciphertext bytea check (ciphertext is null or octet_length(ciphertext) between 1 and 16384),
  nonce bytea not null check (octet_length(nonce) = 12),
  tag bytea not null check (octet_length(tag) = 16),
  wrapped_dek bytea,
  kek_ref text not null,
  kek_class text not null check (kek_class in ('vault-prod','vault-nonprod')),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint connection_credentials_destroyed check (
    (revoked_at is null and ciphertext is not null and wrapped_dek is not null) or (revoked_at is not null and ciphertext is null and wrapped_dek is null))
);
create unique index connection_credentials_live on connection_credentials (connection_id) where revoked_at is null;
create index connection_credentials_kek on connection_credentials (kek_ref) where revoked_at is null;

-- Revoking a credential destroys it in the same statement, whoever revokes it (disconnect, domain release, account closure).
create or replace function vault_destroy_on_revoke() returns trigger language plpgsql as $$
begin
  if new.revoked_at is not null then new.ciphertext = null; new.wrapped_dek = null; end if;
  return new;
end $$;
create trigger connection_credentials_destroy before update on connection_credentials for each row execute function vault_destroy_on_revoke();

-- Row-level security: every vault table is tenant-scoped by user_id and fails closed when app.user_id is unset.
do $$
declare t text;
begin
  foreach t in array array['secrets','secret_versions','connections','connection_credentials'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant on %I using (user_id = app_user_id()) with check (user_id = app_user_id())', t);
  end loop;
end $$;

-- ST-12: reveal and read audit rows are inserted only by the vault role, so app code in the runtime role cannot forge the
-- rows that audit.kms_reconcile matches against CloudTrail. Superusers (migrations, fixtures) pass pg_has_role.
create or replace function audit_vault_rows_only() returns trigger language plpgsql as $$
begin
  if new.action ~ '^secret\.(reveal|read)(\.|$)' and not pg_has_role(current_user, 'mh_vault', 'MEMBER') then
    raise exception 'vault audit rows need the vault role' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger audit_vault_rows before insert on audit_log for each row execute function audit_vault_rows_only();
alter table audit_log enable always trigger audit_vault_rows;

-- Grants. Runtime: metadata only (names, versions, connection status). Vault: ciphertext plus what a reveal or read
-- transaction touches (the action's single use, the audit chain, the notification and the limits). Cron: system jobs.
grant select on secrets, connections to mh_runtime;
grant select, insert, update on secrets, secret_versions, connections, connection_credentials to mh_vault;
grant select on domains, users, notification_addresses, action_holds, flags to mh_vault;
grant select, update on actions to mh_vault;
grant select, insert on audit_log to mh_vault;
grant select, insert, update on audit_heads to mh_vault;
grant select, insert, update, delete on rate_counters to mh_vault;
grant select, insert, update on email_log, security_notice_queue to mh_vault;
grant select, insert on alerts, jobs to mh_vault;
grant all on secrets, secret_versions, connections, connection_credentials to mh_cron;
