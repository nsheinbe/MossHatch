-- Step-up module (Phase 2). Adds what commit needs to re-derive and to check the issued allowCredentials,
-- and clock-aware challenge functions (the app clock, not the database clock, decides expiry so tests can move time).
alter table actions add column if not exists allow_credential_ids text[];
alter table actions add column if not exists target_id text;
alter table actions add column if not exists user_input jsonb;

-- A challenge is bound to one action, one user and one session hash.
create or replace function stepup_challenge_put(p_challenge text, p_user uuid, p_session bytea, p_action uuid, p_now timestamptz, p_ttl interval)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  insert into webauthn_challenges (purpose, challenge, user_id, session_id_hash, action_id, expires_at, created_at)
  values ('stepup', p_challenge, p_user, p_session, p_action, p_now + p_ttl, p_now) returning id into v_id;
  return v_id;
end $$;

-- Consume: its own committed statement, before verification. Zero rows means expired, already used, or not this session's.
create or replace function stepup_challenge_consume(p_action uuid, p_user uuid, p_session bytea, p_now timestamptz)
returns table (id uuid, challenge text)
language sql security definer set search_path = public, pg_temp as $$
  update webauthn_challenges w set consumed_at = p_now
  where w.purpose = 'stepup' and w.action_id = p_action and w.user_id = p_user and w.session_id_hash = p_session
    and w.consumed_at is null and w.expires_at > p_now
  returning w.id, w.challenge
$$;

revoke all on function stepup_challenge_put(text, uuid, bytea, uuid, timestamptz, interval), stepup_challenge_consume(uuid, uuid, bytea, timestamptz) from public;
grant execute on function stepup_challenge_put(text, uuid, bytea, uuid, timestamptz, interval), stepup_challenge_consume(uuid, uuid, bytea, timestamptz) to mh_runtime, mh_cron;
