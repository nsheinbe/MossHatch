-- Auth module (Phase 2). Only adds or alters; 0001-0007 are untouched.
-- The app clock (not the database clock) decides expiry in every function below, so tests can move time.

-- Address verification codes use the same emailed-code table.
alter table email_codes drop constraint if exists email_codes_purpose_check;
alter table email_codes add constraint email_codes_purpose_check check (purpose in ('signup','recovery','address'));

-- A credential registered by a recovery is revoked again when the old credentials are restored (ST-48).
alter table passkeys add column if not exists created_by_recovery_id uuid;
-- A registration ceremony that completes a recovery carries the request id.
alter table webauthn_challenges add column if not exists recovery_id uuid;

-- Class B notices coalesced under flood. Kinds only: no addresses, no text.
create table if not exists security_notice_queue (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  kind text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists security_notice_queue_open on security_notice_queue (user_id) where sent_at is null;
alter table security_notice_queue enable row level security;
alter table security_notice_queue force row level security;
create policy tenant on security_notice_queue using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert, update on security_notice_queue to mh_runtime;
grant all on security_notice_queue to mh_cron;

-- Sign-up start: a live account that has a credential is untouched. Any earlier pending row (and its codes) for the address is
-- replaced. A verified account that never registered a credential (a browser closed mid-ceremony) is offered the same code flow:
-- proving the mailbox is the only thing that gets a registration ticket, and it never has anything to protect yet.
create or replace function auth2_signup_pending(p_email citext, p_now timestamptz)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_live uuid;
begin
  select id into v_live from users where email = p_email and status in ('active','closing');
  if v_live is not null then
    if exists (select 1 from users where id = v_live and status = 'active') and not exists (select 1 from passkeys where user_id = v_live) and not exists (select 1 from recovery_codes where user_id = v_live) then
      delete from email_codes where email = p_email and purpose = 'signup';
      return v_live;
    end if;
    return null;
  end if;
  delete from email_codes where email = p_email and purpose = 'signup';
  -- A pending row holds no credential; what it does hold (its own codes' mail log, ceremony state) goes with it.
  delete from webauthn_challenges where user_id in (select id from users where email = p_email and status = 'pending');
  delete from email_log where user_id in (select id from users where email = p_email and status = 'pending');
  delete from users where email = p_email and status = 'pending';
  insert into users (email, status, expires_at) values (p_email, 'pending', p_now + interval '24 hours') returning id into v_id;
  return v_id;
end $$;

create or replace function auth2_pending_by_email(p_email citext, p_now timestamptz)
returns table (id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select u.id from users u where u.email = p_email and (
    (u.status = 'pending' and (u.expires_at is null or u.expires_at > p_now))
    or (u.status = 'active' and not exists (select 1 from passkeys p where p.user_id = u.id) and not exists (select 1 from recovery_codes r where r.user_id = u.id)))
$$;

create or replace function auth2_code_put(p_purpose text, p_email citext, p_user uuid, p_hash bytea, p_expires timestamptz, p_now timestamptz)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  insert into email_codes (purpose, email, user_id, code_hash, expires_at, created_at) values (p_purpose, p_email, p_user, p_hash, p_expires, p_now) returning id into v_id;
  return v_id;
end $$;

-- Every take burns an attempt (five per code, right or wrong); the caller compares the hash in constant time.
create or replace function auth2_code_take(p_purpose text, p_email citext, p_user uuid, p_now timestamptz)
returns table (id uuid, user_id uuid, code_hash bytea, attempts integer)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  update email_codes c set attempts = c.attempts + 1
  where c.id = (select e.id from email_codes e where e.email = p_email and e.purpose = p_purpose and e.consumed_at is null and e.expires_at > p_now and e.attempts < 5
                  and (p_user is null or e.user_id = p_user) order by e.created_at desc limit 1)
  returning c.id, c.user_id, c.code_hash, c.attempts;
end $$;

-- Is there a live code (unconsumed, unexpired, under five tries)? Used so a flood of starts cannot rotate the owner's code.
create or replace function auth2_code_live(p_purpose text, p_email citext, p_user uuid, p_now timestamptz)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from email_codes e where e.email = p_email and e.purpose = p_purpose and e.consumed_at is null and e.expires_at > p_now and e.attempts < 5 and (p_user is null or e.user_id = p_user))
$$;

create or replace function auth2_code_consume(p_id uuid, p_now timestamptz)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  update email_codes set consumed_at = p_now where id = p_id and consumed_at is null and expires_at > p_now;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Ceremony state. A row is bound exactly to what it was issued for: session hash or pre-auth cookie hash, never "either".
create or replace function auth2_challenge_put(p_purpose text, p_challenge text, p_user uuid, p_session bytea, p_pre bytea, p_recovery uuid, p_now timestamptz, p_ttl interval)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  insert into webauthn_challenges (purpose, challenge, user_id, session_id_hash, pre_auth_hash, recovery_id, expires_at, created_at)
  values (p_purpose, p_challenge, p_user, p_session, p_pre, p_recovery, p_now + p_ttl, p_now) returning id into v_id;
  return v_id;
end $$;

create or replace function auth2_challenge_consume(p_challenge text, p_purpose text, p_session bytea, p_pre bytea, p_now timestamptz)
returns table (id uuid, user_id uuid, recovery_id uuid)
language sql security definer set search_path = public, pg_temp as $$
  update webauthn_challenges w set consumed_at = p_now
  where w.challenge = p_challenge and w.purpose = p_purpose and w.consumed_at is null and w.expires_at > p_now
    and w.session_id_hash is not distinct from p_session and w.pre_auth_hash is not distinct from p_pre
  returning w.id, w.user_id, w.recovery_id
$$;

-- A registration ticket: whoever holds the pre-auth cookie issued after a verified sign-up or a redeemed recovery, for 30 minutes.
create or replace function auth2_ticket_lookup(p_pre bytea, p_now timestamptz)
returns table (user_id uuid, recovery_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select w.user_id, w.recovery_id from webauthn_challenges w
  where w.purpose = 'register' and w.pre_auth_hash = p_pre and w.user_id is not null and w.session_id_hash is null and w.created_at > p_now - interval '30 minutes'
  order by w.created_at desc limit 1
$$;

create or replace function auth2_ticket_kill(p_pre bytea)
returns void language sql security definer set search_path = public, pg_temp as $$
  delete from webauthn_challenges where pre_auth_hash = p_pre
$$;

-- Housekeeping for the cron role (the ops sweeper calls sweepAuth).
create or replace function auth2_sweep(p_now timestamptz)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer := 0; k integer;
begin
  delete from webauthn_challenges where expires_at < p_now - interval '1 day'; get diagnostics k = row_count; n := n + k;
  delete from email_codes where expires_at < p_now - interval '1 day'; get diagnostics k = row_count; n := n + k;
  delete from email_codes where user_id in (select id from users where status = 'pending' and expires_at < p_now);
  delete from webauthn_challenges where user_id in (select id from users where status = 'pending' and expires_at < p_now);
  delete from email_log where user_id in (select id from users where status = 'pending' and expires_at < p_now);
  delete from users u where u.status = 'pending' and u.expires_at < p_now
    and not exists (select 1 from notification_addresses a where a.user_id = u.id) and not exists (select 1 from passkeys p where p.user_id = u.id)
    and not exists (select 1 from sessions s where s.user_id = u.id);
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;

revoke all on function auth2_signup_pending(citext, timestamptz), auth2_pending_by_email(citext, timestamptz), auth2_code_put(text, citext, uuid, bytea, timestamptz, timestamptz),
  auth2_code_take(text, citext, uuid, timestamptz), auth2_code_live(text, citext, uuid, timestamptz), auth2_code_consume(uuid, timestamptz),
  auth2_challenge_put(text, text, uuid, bytea, bytea, uuid, timestamptz, interval), auth2_challenge_consume(text, text, bytea, bytea, timestamptz),
  auth2_ticket_lookup(bytea, timestamptz), auth2_ticket_kill(bytea), auth2_sweep(timestamptz) from public;
grant execute on function auth2_signup_pending(citext, timestamptz), auth2_pending_by_email(citext, timestamptz), auth2_code_put(text, citext, uuid, bytea, timestamptz, timestamptz),
  auth2_code_take(text, citext, uuid, timestamptz), auth2_code_live(text, citext, uuid, timestamptz), auth2_code_consume(uuid, timestamptz),
  auth2_challenge_put(text, text, uuid, bytea, bytea, uuid, timestamptz, interval), auth2_challenge_consume(text, text, bytea, bytea, timestamptz),
  auth2_ticket_lookup(bytea, timestamptz), auth2_ticket_kill(bytea) to mh_runtime, mh_cron;
grant execute on function auth2_sweep(timestamptz) to mh_cron;
