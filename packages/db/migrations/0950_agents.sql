-- Phase 5: the agent surface (PLAN 4.5 "Agent purchases and the approval card", MCP, Tokens; D-019; threat rows 15 to 20).
-- Agent requests and spend-cap reservations, the OAuth authorization server for MCP, the secret-scanning receiver's
-- bookkeeping, and the triggers that keep reservations honest whichever module moves an order or revokes a binding.
-- Only adds or alters. No table here holds a token, an authorization code, a Checkout URL or a secret value.

-- The owner-set threshold above which the approval card asks the person to type the domain (default USD 50, own target).
alter table users add column agent_confirm_threshold_minor bigint not null default 5000 check (agent_confirm_threshold_minor >= 0);

-- OAuth clients (MCP connectors). Not tenant data: a client is shared by every person who connects it.
-- `client_name` is what the client says about itself: shown only as "reported by the client, not verified", never in a summary.
create table oauth_clients (
  id uuid primary key default uuidv7(),
  client_id text not null unique check (length(client_id) between 16 and 500 and client_id !~ '\s'),
  registration text not null check (registration in ('dcr','cimd')),
  client_name text check (client_name is null or client_name ~ '^[^\x01-\x1f\x7f]{1,80}$'),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  metadata_hash bytea,
  fetched_at timestamptz,
  ip_prefix text,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

-- An OAuth grant is an agent binding: the client it was issued to and the resource (audience) it was minted for.
alter table bindings add column oauth_client_id uuid references oauth_clients(id);
alter table bindings add column audience text check (audience is null or (audience ~ '^https?://\S+$' and length(audience) <= 300));
create index bindings_oauth_client on bindings (oauth_client_id) where oauth_client_id is not null;

-- Agent requests: what an agent proposed and what the person decided. `params` is a closed typed schema built by the server
-- (no free-text field); the binding name on the card is the owner's own. `quoted_minor` is the reservation held against
-- the binding's cap: the frozen quote with the tax ceiling, for the longer of the years asked and the extension's minimum.
create table agent_requests (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  binding_id uuid not null references bindings(id),
  kind text not null check (kind in ('register','renew','dns_change','scope')),
  state text not null default 'pending' check (state in ('pending','approved','declined','expired','void','failed','completed')),
  request_hash bytea not null check (octet_length(request_hash) = 32),
  params jsonb not null check (jsonb_typeof(params) = 'object'),
  domain_id uuid references domains(id),
  fqdn_ascii text check (fqdn_ascii is null or fqdn_ascii ~ '^[a-z0-9.-]{3,253}$'),
  years integer check (years is null or years between 1 and 10),
  quoted_minor bigint not null default 0 check (quoted_minor >= 0),
  reservation text not null default 'none' check (reservation in ('none','held','consumed','released')),
  price_hash bytea check (price_hash is null or octet_length(price_hash) = 32),
  ip_prefix text,
  new_network boolean not null default false,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  decided_at timestamptz,
  decided_by_action_id uuid unique,
  decision_reason text check (decision_reason is null or decision_reason ~ '^[a-z_]{1,40}$'),
  order_id uuid unique,
  constraint agent_requests_reservation_amount check (reservation = 'none' or quoted_minor > 0),
  constraint agent_requests_decided check (state in ('pending','expired') or decided_at is not null or decision_reason is not null)
);
-- Idempotent proposals: the same request from the same binding while one is pending is the same row (ST-75).
create unique index agent_requests_pending_once on agent_requests (binding_id, request_hash) where state = 'pending';
create index agent_requests_user on agent_requests (user_id, created_at desc);
create index agent_requests_binding on agent_requests (binding_id, created_at desc);
create index agent_requests_expiry on agent_requests (expires_at) where state = 'pending';

-- OAuth authorization requests (RFC 6749 4.1 with PKCE S256 only). The client's `state` is returned verbatim and is not ours.
-- The code is 256 bits, stored as SHA-256, lives 60 seconds and is exchanged once.
create table oauth_authorizations (
  id uuid primary key default uuidv7(),
  client_ref uuid not null references oauth_clients(id),
  redirect_uri text not null check (length(redirect_uri) between 8 and 500),
  state_param text check (state_param is null or (length(state_param) between 1 and 500 and state_param ~ '^[\x21-\x7e]+$')),
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  requested_scope text check (requested_scope is null or length(requested_scope) <= 2000),
  resource text check (resource is null or length(resource) <= 300),
  user_id uuid references users(id),
  status text not null default 'pending' check (status in ('pending','approved','denied','exchanged','expired')),
  binding_id uuid references bindings(id),
  approved_by_action_id uuid unique,
  code_hash bytea unique check (code_hash is null or octet_length(code_hash) = 32),
  code_expires_at timestamptz,
  ip_prefix text,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  decided_at timestamptz
);
create index oauth_authorizations_user on oauth_authorizations (user_id) where user_id is not null;

-- Rotating refresh tokens of OAuth grants, bound to their client. Reuse of a rotated one revokes the binding and the family.
-- Kept apart from the CLI's binding_refresh_tokens so the CLI token endpoint can never refresh an OAuth client's grant.
create table oauth_refresh_tokens (
  id uuid primary key default uuidv7(),
  binding_id uuid not null references bindings(id),
  user_id uuid not null references users(id),
  client_ref uuid not null references oauth_clients(id),
  token_prefix text not null,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null,
  idle_expires_at timestamptz not null,
  expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz
);
create index oauth_refresh_family on oauth_refresh_tokens (binding_id);

-- Row-level security ------------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['agent_requests','oauth_authorizations','oauth_refresh_tokens'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant on %I using (user_id = app_user_id()) with check (user_id = app_user_id())', t);
  end loop;
end $$;

grant select, insert, update on agent_requests, oauth_authorizations, oauth_refresh_tokens to mh_runtime;
grant select, insert, update on oauth_clients to mh_runtime;
grant all on agent_requests, oauth_clients, oauth_authorizations, oauth_refresh_tokens to mh_cron;

-- Reservations are kept by the database (ST-74, ST-75) ------------------------------------------------------------------
-- Leaving `pending` for declined, expired, void or failed releases a held reservation in the same statement, whichever
-- module moved it (revoke-all in the bindings module declines pending requests directly).
create or replace function agent_request_release() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.state is distinct from old.state and new.state in ('declined','expired','void','failed') and old.reservation = 'held' then
    update bindings set reserved_minor = greatest(reserved_minor - old.quoted_minor, 0) where id = old.binding_id;
    new.reservation := 'released';
  end if;
  if new.state is distinct from old.state and new.state <> 'pending' and new.decided_at is null then new.decided_at := now(); end if;
  return new;
end $$;
create trigger agent_requests_release before update of state on agent_requests for each row execute function agent_request_release();

-- The order an approval created: capture consumes the reservation (moved from reserved to spent); a void, an expired
-- Checkout, a failed payment or a failed registration releases it (plan 4.5: released on decline, expiry, void and failure).
create or replace function agent_order_settle() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare r agent_requests; v_paid bigint;
begin
  if new.agent_request_id is null or new.state is not distinct from old.state then return new; end if;
  select * into r from agent_requests where id = new.agent_request_id for update;
  if not found then return new; end if;
  if new.state = 'captured' and r.reservation = 'held' then
    -- What was actually taken: the succeeded payment, else the authorized amount being captured, never more than was reserved.
    select least(coalesce(sum(amount_minor), new.amount_capturable_minor, r.quoted_minor), r.quoted_minor) into v_paid from payments where order_id = new.id and status = 'succeeded';
    update bindings set reserved_minor = greatest(reserved_minor - r.quoted_minor, 0), spent_minor = spent_minor + coalesce(v_paid, r.quoted_minor) where id = r.binding_id;
    update agent_requests set reservation = 'consumed', state = 'completed' where id = r.id and state = 'approved';
  elsif new.state in ('voided','checkout_expired','payment_failed','registration_failed') and r.state = 'approved' then
    update agent_requests set state = 'failed', decision_reason = 'order_' || new.state where id = r.id and state = 'approved';
  end if;
  return new;
end $$;
create trigger orders_agent_settle after update of state on orders for each row execute function agent_order_settle();

-- A revoked binding's OAuth refresh family dies with it, whichever path revoked it (the bindings module, revoke-all, the
-- scanning receiver). Its pending requests are left to the caller: revoke-all declines them in the same transaction, and a
-- single revoke leaves them to the approval check (a revoked binding is never approved for) and the sweeper, which voids them.
create or replace function agent_binding_revoked() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update oauth_refresh_tokens set revoked_at = new.revoked_at where binding_id = new.id and revoked_at is null;
  end if;
  return new;
end $$;
create trigger bindings_agent_revoked after update of revoked_at on bindings for each row execute function agent_binding_revoked();

-- ST-35: an agent's write to prod keeps the prior version (versions are append-only) and tells the owner at once. The job is
-- queued here so every write path (MCP, REST push) is covered; the MCP tool also sends immediately under the same key.
create or replace function agent_prod_write_queue() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_env text;
begin
  if new.created_by_kind <> 'agent' then return new; end if;
  select env into v_env from secrets where id = new.secret_id;
  if v_env is distinct from 'prod' then return new; end if;
  insert into jobs (kind, priority, payload, user_id, dedupe_key)
  values ('agents.prod_write_notice', 1, jsonb_build_object('resource', new.secret_id, 'version', new.version, 'by', new.created_by_id), new.user_id,
          'agents.prod_write:' || new.secret_id || ':' || new.version)
  on conflict do nothing;
  return new;
end $$;
create trigger secret_versions_agent_prod after insert on secret_versions for each row execute function agent_prod_write_queue();

-- Pre-authentication paths (definer functions, pinned search_path) ------------------------------------------------------

create or replace function oauth_authorization_create(p_client uuid, p_redirect text, p_state text, p_challenge text, p_scope text, p_resource text, p_ip text, p_now timestamptz, p_ttl interval)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  update oauth_authorizations set status = 'expired' where status = 'pending' and expires_at <= p_now;
  insert into oauth_authorizations (client_ref, redirect_uri, state_param, code_challenge, requested_scope, resource, ip_prefix, created_at, expires_at)
  values (p_client, p_redirect, p_state, p_challenge, p_scope, p_resource, p_ip, p_now, p_now + p_ttl) returning id into v_id;
  return v_id;
end $$;

-- The first signed-in person to open a pending request claims it; nobody else can see or approve it afterwards.
create or replace function oauth_authorization_claim(p_id uuid, p_user uuid, p_now timestamptz)
returns table (id uuid, client_ref uuid, redirect_uri text, requested_scope text, resource text, ip_prefix text, created_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update oauth_authorizations a set user_id = p_user where a.id = p_id and a.user_id is null and a.status = 'pending' and a.expires_at > p_now;
  return query select a.id, a.client_ref, a.redirect_uri, a.requested_scope, a.resource, a.ip_prefix, a.created_at, a.expires_at
    from oauth_authorizations a where a.id = p_id and a.user_id = p_user and a.status = 'pending' and a.expires_at > p_now;
end $$;

create or replace function oauth_code_get(p_hash bytea)
returns table (id uuid, user_id uuid, client_ref uuid, redirect_uri text, code_challenge text, resource text, status text, code_expires_at timestamptz, binding_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, user_id, client_ref, redirect_uri, code_challenge, resource, status, code_expires_at, binding_id from oauth_authorizations where code_hash = p_hash
$$;

create or replace function oauth_refresh_get(p_hash bytea)
returns table (id uuid, binding_id uuid, user_id uuid, client_ref uuid, rotated_at timestamptz, revoked_at timestamptz, idle_expires_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, binding_id, user_id, client_ref, rotated_at, revoked_at, idle_expires_at, expires_at from oauth_refresh_tokens where token_hash = p_hash
$$;

-- The secret-scanning receiver resolves a reported token to its owner without a tenant context (hash lookup only).
create or replace function scanning_token_owner(p_hash bytea)
returns table (binding_id uuid, user_id uuid, revoked_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.id, b.user_id, b.revoked_at from bindings b where b.token_hash = p_hash
  union all select r.binding_id, r.user_id, b.revoked_at from binding_refresh_tokens r join bindings b on b.id = r.binding_id where r.token_hash = p_hash
  union all select o.binding_id, o.user_id, b.revoked_at from oauth_refresh_tokens o join bindings b on b.id = o.binding_id where o.token_hash = p_hash
$$;

revoke all on function oauth_authorization_create(uuid, text, text, text, text, text, text, timestamptz, interval), oauth_authorization_claim(uuid, uuid, timestamptz),
  oauth_code_get(bytea), oauth_refresh_get(bytea), scanning_token_owner(bytea) from public;
grant execute on function oauth_authorization_create(uuid, text, text, text, text, text, text, timestamptz, interval), oauth_authorization_claim(uuid, uuid, timestamptz),
  oauth_code_get(bytea), oauth_refresh_get(bytea), scanning_token_owner(bytea) to mh_runtime, mh_cron;
revoke all on function agent_request_release(), agent_order_settle(), agent_binding_revoked(), agent_prod_write_queue() from public;
