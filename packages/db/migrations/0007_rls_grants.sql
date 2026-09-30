-- Row-level security: every tenant table compares user_id with app_user_id(); unset means no rows (fail closed).
do $$
declare t text;
begin
  foreach t in array array['notification_addresses','passkeys','sessions','actions','recovery_codes','recovery_requests','action_holds','email_action_tokens','bindings','contacts','consents','notices','domains','stripe_customers','orders','payments','refunds','renewal_mandates','account_exports','email_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant on %I using (user_id = app_user_id()) with check (user_id = app_user_id())', t);
  end loop;
end $$;

alter table users enable row level security; alter table users force row level security;
create policy tenant on users using (id = app_user_id()) with check (id = app_user_id());

-- Children of orders are tenant-scoped through the parent.
do $$
declare t text;
begin
  foreach t in array array['order_operations','order_events','registrar_profiles'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant on %I using (exists (select 1 from orders o where o.id = %I.order_id and o.user_id = app_user_id())) with check (exists (select 1 from orders o where o.id = %I.order_id and o.user_id = app_user_id()))', t, t, t);
  end loop;
end $$;

-- Challenges: a row is visible to its user; pre-auth rows (user_id null) are reachable only through the definer functions below.
alter table webauthn_challenges enable row level security; alter table webauthn_challenges force row level security;
create policy tenant on webauthn_challenges using (user_id = app_user_id()) with check (user_id = app_user_id());
alter table email_codes enable row level security; alter table email_codes force row level security;  -- no policy: definer functions only

-- The audit chain for a user is readable by that user; the system chain (all-zero id) by nobody but the cron role.
alter table audit_log enable row level security; alter table audit_log force row level security;
create policy tenant_read on audit_log for select using (chain_id = app_user_id());
create policy tenant_append on audit_log for insert with check (chain_id = app_user_id() or chain_id = '00000000-0000-0000-0000-000000000000');
alter table audit_heads enable row level security; alter table audit_heads force row level security;
create policy tenant_heads on audit_heads using (chain_id = app_user_id() or chain_id = '00000000-0000-0000-0000-000000000000') with check (chain_id = app_user_id() or chain_id = '00000000-0000-0000-0000-000000000000');

-- Cron (system) role bypasses RLS by attribute. Runtime gets exactly what the request path needs.
grant usage on schema public to mh_runtime, mh_cron, mh_contacts, mh_vault;
grant select, insert, update on users, notification_addresses, passkeys, actions, recovery_requests, action_holds, bindings, contacts, consents, notices, domains, stripe_customers, orders, payments, refunds, renewal_mandates, order_operations, registrar_profiles, account_exports, email_log to mh_runtime;
grant select, insert, update, delete on sessions, webauthn_challenges, recovery_codes, email_action_tokens to mh_runtime;
grant select, insert on order_events, audit_log to mh_runtime;
grant select, insert, update on audit_heads to mh_runtime;
grant select, insert, update, delete on rate_counters to mh_runtime;
grant select on flags, wholesale_prices, tld_policy, maintenance_windows, document_versions, tax_regions to mh_runtime;
grant select, insert on alerts, webhook_events to mh_runtime;
grant select, insert on jobs to mh_runtime;
grant all on all tables in schema public to mh_cron;
revoke truncate, delete on audit_log from mh_runtime, mh_cron;
revoke update on audit_log from mh_runtime, mh_cron;

-- Pre-authentication lookups. SECURITY DEFINER with a pinned search_path; each returns only what its caller needs.
create or replace function auth_session_get(p_hash bytea)
returns table (user_id uuid, created_at timestamptz, last_seen_at timestamptz, expires_at timestamptz, idle_expires_at timestamptz, revoked_at timestamptz, auth_credential_id text, user_status text, frozen_at timestamptz, email citext)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.idle_expires_at, s.revoked_at, s.auth_credential_id, u.status, u.frozen_at, u.email
  from sessions s join users u on u.id = s.user_id where s.id_hash = p_hash
$$;

create or replace function auth_user_by_email(p_email citext)
returns table (id uuid, status text, email_verified_at timestamptz, webauthn_user_handle bytea, hardened_mode boolean, frozen_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, status, email_verified_at, webauthn_user_handle, hardened_mode, frozen_at from users where email = p_email and status in ('active','closing')
$$;

-- Sign-up start replaces any earlier pending row for the address (closes account pre-hijacking); a live account is untouched.
create or replace function auth_signup_pending(p_email citext)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if exists (select 1 from users where email = p_email and status in ('active','closing')) then return null; end if;
  delete from email_codes where email = p_email and purpose = 'signup';
  delete from users where email = p_email and status = 'pending';
  insert into users (email, status, expires_at) values (p_email, 'pending', now() + interval '24 hours') returning id into v_id;
  return v_id;
end $$;

create or replace function auth_email_code_put(p_purpose text, p_email citext, p_user uuid, p_hash bytea, p_ttl interval)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  insert into email_codes (purpose, email, user_id, code_hash, expires_at) values (p_purpose, p_email, p_user, p_hash, now() + p_ttl) returning id into v_id;
  return v_id;
end $$;

-- Verify: constant-time comparison happens in the caller; here the row is returned only if live, and every miss burns an attempt.
create or replace function auth_email_code_take(p_purpose text, p_email citext)
returns table (id uuid, user_id uuid, code_hash bytea, attempts integer)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  update email_codes c set attempts = c.attempts + 1
  where c.id = (select e.id from email_codes e where e.email = p_email and e.purpose = p_purpose and e.consumed_at is null and e.expires_at > now() and e.attempts < 5 order by e.created_at desc limit 1)
  returning c.id, c.user_id, c.code_hash, c.attempts;
end $$;

create or replace function auth_email_code_consume(p_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  update email_codes set consumed_at = now() where id = p_id and consumed_at is null;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Challenge consume: its own committed statement, before verification; a failed attempt also burns it.
create or replace function auth_challenge_consume(p_challenge text, p_purpose text, p_session bytea, p_pre bytea)
returns table (id uuid, user_id uuid, action_id uuid)
language sql security definer set search_path = public, pg_temp as $$
  update webauthn_challenges w set consumed_at = now()
  where w.challenge = p_challenge and w.purpose = p_purpose and w.consumed_at is null and w.expires_at > now()
    and (p_session is null or w.session_id_hash = p_session)
    and (p_pre is null or w.pre_auth_hash = p_pre)
  returning w.id, w.user_id, w.action_id
$$;

create or replace function auth_challenge_put(p_purpose text, p_challenge text, p_user uuid, p_session bytea, p_pre bytea, p_action uuid, p_ttl interval)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  insert into webauthn_challenges (purpose, challenge, user_id, session_id_hash, pre_auth_hash, action_id, expires_at)
  values (p_purpose, p_challenge, p_user, p_session, p_pre, p_action, now() + p_ttl) returning id into v_id;
  return v_id;
end $$;

-- Discoverable login: the credential id identifies the account. Only live credentials are returned.
create or replace function auth_passkey_lookup(p_credential_id text)
returns table (id uuid, user_id uuid, public_key bytea, alg integer, sign_count bigint, transports text[], backup_eligible boolean, backup_state boolean, suspended_at timestamptz, revoked_at timestamptz, webauthn_user_handle bytea, user_status text, hardened_mode boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.user_id, p.public_key, p.alg, p.sign_count, p.transports, p.backup_eligible, p.backup_state, p.suspended_at, p.revoked_at, u.webauthn_user_handle, u.status, u.hardened_mode
  from passkeys p join users u on u.id = p.user_id where p.credential_id = p_credential_id
$$;

create or replace function auth_email_action_get(p_hash bytea)
returns table (id uuid, purpose text, event_id uuid, user_id uuid, expires_at timestamptz, used_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, purpose, event_id, user_id, expires_at, used_at from email_action_tokens where token_hash = p_hash
$$;

create or replace function auth_binding_get(p_prefix text, p_hash bytea)
returns table (id uuid, user_id uuid, kind text, scopes jsonb, spend_cap_minor bigint, expires_at timestamptz, revoked_at timestamptz, paused_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, user_id, kind, scopes, spend_cap_minor, expires_at, revoked_at, paused_at from bindings where token_prefix = p_prefix and token_hash = p_hash
$$;

revoke all on function auth_session_get(bytea), auth_user_by_email(citext), auth_signup_pending(citext), auth_email_code_put(text, citext, uuid, bytea, interval), auth_email_code_take(text, citext), auth_email_code_consume(uuid), auth_challenge_consume(text, text, bytea, bytea), auth_challenge_put(text, text, uuid, bytea, bytea, uuid, interval), auth_passkey_lookup(text), auth_email_action_get(bytea), auth_binding_get(text, bytea) from public;
grant execute on function auth_session_get(bytea), auth_user_by_email(citext), auth_signup_pending(citext), auth_email_code_put(text, citext, uuid, bytea, interval), auth_email_code_take(text, citext), auth_email_code_consume(uuid), auth_challenge_consume(text, text, bytea, bytea), auth_challenge_put(text, text, uuid, bytea, bytea, uuid, interval), auth_passkey_lookup(text), auth_email_action_get(bytea), auth_binding_get(text, bytea) to mh_runtime, mh_cron;
