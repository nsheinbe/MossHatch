-- Tokens, CLI bindings, the device flow and wire-it recipes (Phase 4, PLAN 4.5 and 4.3b). Only adds or alters.
-- Every token and code is stored as a hash; no table here holds a token, a device code, a user code or a value.

-- Bindings --------------------------------------------------------------------------------------------------------------
-- A CLI binding is one device grant: its token_hash is the current 60-minute access token, and its refresh tokens are
-- a family in binding_refresh_tokens (reuse of a rotated one revokes the binding and the family).
alter table bindings add column device_request_id uuid;
alter table bindings add column family_expires_at timestamptz;
alter table bindings add constraint bindings_name_plain check (name ~ '^[A-Za-z0-9 ._:()-]{1,64}$');
create index bindings_user_live on bindings (user_id) where revoked_at is null;

create table binding_refresh_tokens (
  id uuid primary key default uuidv7(),
  binding_id uuid not null references bindings(id),
  user_id uuid not null references users(id),
  token_prefix text not null,
  token_hash bytea not null unique,
  created_at timestamptz not null,
  -- 30 days idle (from the last rotation) and 90 days absolute (from the grant), own targets.
  idle_expires_at timestamptz not null,
  expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz
);
create index binding_refresh_family on binding_refresh_tokens (binding_id);

-- Device authorization requests (RFC 8628). The device code is 256-bit and stored as SHA-256; the user code (8 letters
-- from a 20-letter alphabet) is stored as a keyed HMAC so a database copy cannot be searched offline for live codes.
create table device_requests (
  id uuid primary key default uuidv7(),
  device_code_hash bytea not null unique,
  user_code_hash bytea not null,
  -- What the device says about itself: shown under "reported by the device, not verified", never as a fact.
  client_name text check (client_name is null or client_name ~ '^[A-Za-z0-9 ._-]{1,40}$'),
  client_version text check (client_version is null or client_version ~ '^[A-Za-z0-9._+-]{1,24}$'),
  requested_scopes jsonb not null default '[]',
  -- What the server observed.
  ip_prefix text,
  ua_family text,
  state text not null default 'pending' check (state in ('pending','approved','denied','consumed','expired')),
  user_id uuid references users(id),
  approved_scopes jsonb,
  approved_by_action_id uuid unique,
  binding_id uuid,
  interval_seconds integer not null default 5 check (interval_seconds between 5 and 60),
  last_polled_at timestamptz,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  decided_at timestamptz,
  constraint device_requests_decided check (state in ('pending','expired') or user_id is not null)
);
create unique index device_requests_user_code_live on device_requests (user_code_hash) where state = 'pending';
create index device_requests_user on device_requests (user_id);

-- Revoke links in grant notices: GET shows a confirm page, POST revokes. Single use, 7 days.
create table binding_revoke_links (
  id uuid primary key default uuidv7(),
  token_hash bytea not null unique,
  user_id uuid not null references users(id),
  binding_id uuid not null references bindings(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Wire-it recipes -------------------------------------------------------------------------------------------------------
-- The plan holds records and variable names, never values. Its SHA-256 over canonical JSON is what an approval binds
-- and what apply recomputes: applied set = previewed set.
create table recipe_applications (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  domain_id uuid not null references domains(id),
  recipe_id text not null check (recipe_id ~ '^[a-z][a-z0-9-]{1,40}$'),
  recipe_version integer not null check (recipe_version >= 1),
  input jsonb not null default '{}',
  plan jsonb not null,
  plan_hash bytea not null check (octet_length(plan_hash) = 32),
  needs_approval boolean not null,
  sensitive_count integer not null default 0,
  state text not null default 'planned' check (state in ('planned','approved','applying','applied','failed','expired','removed')),
  created_by_kind text not null check (created_by_kind in ('user','agent','cli')),
  created_by_id text,
  approved_by_action_id uuid unique,
  applied_records jsonb,
  failure_code text check (failure_code is null or failure_code ~ '^[a-z_]{1,48}$'),
  applied_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index recipe_applications_domain on recipe_applications (domain_id, created_at desc);
create trigger recipe_applications_touch before update on recipe_applications for each row execute function set_updated_at();
alter table connections add constraint connections_recipe_application_fk foreign key (recipe_application_id) references recipe_applications(id);

-- Non-secret facts a connection check read from the provider (project ids, recommended record values, domain ids).
alter table connections add column provider_facts jsonb not null default '{}';
alter table connections add column checked_at timestamptz;
alter table connections add constraint connections_facts_no_secret check (provider_facts::text !~* '"[a-z_]*(secret|password|token|key_value|connection_uri)[a-z_]*"\s*:');

-- Dangling-record findings (a wired host that answers with the provider's not-found page, ST-130).
create table recipe_findings (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  domain_id uuid not null references domains(id),
  connection_id uuid references connections(id),
  application_id uuid references recipe_applications(id),
  kind text not null check (kind in ('dangling_target')),
  host text not null check (host ~ '^[a-z0-9.@_-]{1,253}$'),
  state text not null default 'open' check (state in ('open','resolved')),
  found_at timestamptz not null,
  resolved_at timestamptz
);
create unique index recipe_findings_open on recipe_findings (domain_id, kind, host) where state = 'open';

insert into flags (name, value) values ('device_login_paused', 'false') on conflict do nothing;

-- Row-level security -----------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['binding_refresh_tokens','device_requests','binding_revoke_links','recipe_applications','recipe_findings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant on %I using (user_id = app_user_id()) with check (user_id = app_user_id())', t);
  end loop;
end $$;

grant select, insert, update on binding_refresh_tokens, device_requests, binding_revoke_links, recipe_applications, recipe_findings to mh_runtime;
grant select on bindings, recipe_applications to mh_vault;
grant all on binding_refresh_tokens, device_requests, binding_revoke_links, recipe_applications, recipe_findings to mh_cron;

-- Pre-authentication paths (definer functions, pinned search_path) ------------------------------------------------------

-- Bearer idle limit (30 days without use, own target) and last-used, checked on every bearer request.
create or replace function auth_binding_touch(p_id uuid, p_now timestamptz, p_idle interval)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_last timestamptz;
begin
  select coalesce(last_used_at, created_at) into v_last from bindings where id = p_id and revoked_at is null;
  if v_last is null or v_last <= p_now - p_idle then return false; end if;
  if v_last < p_now - interval '60 seconds' then update bindings set last_used_at = p_now where id = p_id; end if;
  return true;
end $$;

create or replace function auth_refresh_get(p_hash bytea)
returns table (id uuid, binding_id uuid, user_id uuid, rotated_at timestamptz, revoked_at timestamptz, idle_expires_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, binding_id, user_id, rotated_at, revoked_at, idle_expires_at, expires_at from binding_refresh_tokens where token_hash = p_hash
$$;

create or replace function device_request_create(p_device_hash bytea, p_user_code_hash bytea, p_client_name text, p_client_version text, p_scopes jsonb, p_ip text, p_ua text, p_now timestamptz, p_ttl interval)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  update device_requests set state = 'expired' where state = 'pending' and expires_at <= p_now;
  insert into device_requests (device_code_hash, user_code_hash, client_name, client_version, requested_scopes, ip_prefix, ua_family, created_at, expires_at)
  values (p_device_hash, p_user_code_hash, p_client_name, p_client_version, p_scopes, p_ip, p_ua, p_now, p_now + p_ttl)
  on conflict do nothing returning id into v_id;
  return v_id;
end $$;

-- What the approval page may show: observed facts, the device's own claims and the scopes it asked for. Never the codes.
create or replace function device_request_by_user_code(p_user_code_hash bytea, p_now timestamptz)
returns table (id uuid, client_name text, client_version text, requested_scopes jsonb, ip_prefix text, ua_family text, created_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, client_name, client_version, requested_scopes, ip_prefix, ua_family, created_at, expires_at from device_requests
   where user_code_hash = p_user_code_hash and state = 'pending' and expires_at > p_now
$$;

create or replace function device_request_get(p_id uuid, p_now timestamptz)
returns table (id uuid, user_code_hash bytea, requested_scopes jsonb, ip_prefix text, created_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, user_code_hash, requested_scopes, ip_prefix, created_at, expires_at from device_requests where id = p_id and state = 'pending' and expires_at > p_now
$$;

-- Compare-and-set from pending: the approving user, the exact scopes and the action that approved them.
create or replace function device_request_decide(p_id uuid, p_user_code_hash bytea, p_user uuid, p_state text, p_scopes jsonb, p_action uuid, p_now timestamptz)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  if p_state not in ('approved','denied') then return false; end if;
  update device_requests set state = p_state, user_id = p_user, approved_scopes = p_scopes, approved_by_action_id = p_action, decided_at = p_now
   where id = p_id and user_code_hash = p_user_code_hash and state = 'pending' and expires_at > p_now;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Polling by device code. Returns the row and records the poll time; the caller decides slow_down from the previous time.
create or replace function device_request_poll(p_device_hash bytea, p_now timestamptz)
returns table (id uuid, state text, user_id uuid, approved_scopes jsonb, approved_by_action_id uuid, interval_seconds integer, prev_polled_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare r device_requests;
begin
  select * into r from device_requests d where d.device_code_hash = p_device_hash for update;
  if not found then return; end if;
  update device_requests d set last_polled_at = p_now where d.id = r.id;
  return query select r.id, r.state, r.user_id, r.approved_scopes, r.approved_by_action_id, r.interval_seconds, r.last_polled_at, r.expires_at;
end $$;

create or replace function device_request_slow_down(p_id uuid)
returns integer language sql security definer set search_path = public, pg_temp as $$
  update device_requests set interval_seconds = least(interval_seconds + 5, 60) where id = p_id returning interval_seconds
$$;

create or replace function device_request_expire(p_id uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  update device_requests set state = 'expired' where id = p_id and state = 'pending'
$$;

create or replace function binding_revoke_link_get(p_hash bytea)
returns table (id uuid, user_id uuid, binding_id uuid, expires_at timestamptz, used_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, user_id, binding_id, expires_at, used_at from binding_revoke_links where token_hash = p_hash
$$;

revoke all on function auth_binding_touch(uuid, timestamptz, interval), auth_refresh_get(bytea),
  device_request_create(bytea, bytea, text, text, jsonb, text, text, timestamptz, interval), device_request_by_user_code(bytea, timestamptz),
  device_request_get(uuid, timestamptz), device_request_decide(uuid, bytea, uuid, text, jsonb, uuid, timestamptz), device_request_poll(bytea, timestamptz),
  device_request_slow_down(uuid), device_request_expire(uuid), binding_revoke_link_get(bytea) from public;
grant execute on function auth_binding_touch(uuid, timestamptz, interval), auth_refresh_get(bytea),
  device_request_create(bytea, bytea, text, text, jsonb, text, text, timestamptz, interval), device_request_by_user_code(bytea, timestamptz),
  device_request_get(uuid, timestamptz), device_request_decide(uuid, bytea, uuid, text, jsonb, uuid, timestamptz), device_request_poll(bytea, timestamptz),
  device_request_slow_down(uuid), device_request_expire(uuid), binding_revoke_link_get(bytea) to mh_runtime, mh_cron;
