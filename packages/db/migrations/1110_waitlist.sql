-- Waitlist for the public preview, and the invites that let people in slowly (packages/api/src/waitlist).
-- The request path runs before the full API boots, with only DATABASE_URL, so it reaches these tables through the SECURITY DEFINER
-- functions below and nothing else. No raw IP address is ever stored: `ip_hash` is a keyed hash of the /24 (or /48) network.
-- Tokens (confirm, unsubscribe, invite) are stored as SHA-256 hashes only; each has one purpose.

create table waitlist (
  id uuid primary key default uuidv7(),
  email citext not null unique check (length(email) between 3 and 254),
  -- Names the person hatched in the preview (a label or a label.tld), at most 5, each at most 80 characters.
  requested_names text[] not null default '{}' check (cardinality(requested_names) <= 5),
  -- "Would you pay a few dollars for a one-of-a-kind creature designed for your name?"
  answer text check (answer in ('yes', 'no', 'maybe')),
  -- SHA-256 of the exact consent sentence the person ticked, so the wording they agreed to is provable later.
  consent_hash bytea not null check (length(consent_hash) = 32),
  consented_at timestamptz not null,
  source text not null check (source in ('app', 'fallback', 'page', 'signup')),
  ip_hash bytea check (ip_hash is null or length(ip_hash) = 32),
  created_at timestamptz not null,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  invited_at timestamptz
);
create index waitlist_unconfirmed on waitlist (created_at) where confirmed_at is null;
create index waitlist_line on waitlist (confirmed_at) where confirmed_at is not null and unsubscribed_at is null;

create table waitlist_tokens (
  hash bytea primary key check (length(hash) = 32),
  waitlist_id uuid not null references waitlist (id) on delete cascade,
  purpose text not null check (purpose in ('confirm', 'unsubscribe')),
  created_at timestamptz not null,
  expires_at timestamptz,
  used_at timestamptz
);
create index waitlist_tokens_owner on waitlist_tokens (waitlist_id);

-- An invite is bound to one waitlist entry (and so to its email). The token is `<id>.<secret>`; only SHA-256(secret) is kept and it
-- is compared in constant time by the caller. It is used once, inside the same transaction that activates the account.
create table waitlist_invites (
  id uuid primary key default uuidv7(),
  waitlist_id uuid not null references waitlist (id) on delete cascade,
  token_hash bytea not null check (length(token_hash) = 32),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references users (id) on delete set null
);
create index waitlist_invites_owner on waitlist_invites (waitlist_id);

do $$
declare t text;
begin
  foreach t in array array['waitlist', 'waitlist_tokens', 'waitlist_invites'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);  -- no policy: definer functions only for the runtime role
  end loop;
end $$;
-- The owner-only scripts (stats, invites) run as the cron role, which bypasses RLS by attribute.
grant select, insert, update, delete on waitlist, waitlist_tokens, waitlist_invites to mh_cron;

-- Join or re-join. Returns the entry and its state before this call: 'new', 'pending' (not confirmed, or unsubscribed) or 'confirmed'.
-- A confirmed entry keeps its place in line; a hatched name is added once; the answer is replaced only when one is given.
create or replace function waitlist_join(p_email citext, p_name text, p_answer text, p_consent bytea, p_source text, p_ip bytea, p_now timestamptz)
returns table (id uuid, state text) language plpgsql security definer set search_path = public, pg_temp as $$
declare v waitlist%rowtype;
begin
  insert into waitlist (email, requested_names, answer, consent_hash, consented_at, source, ip_hash, created_at)
  values (p_email, case when p_name is null then '{}'::text[] else array[p_name] end, p_answer, p_consent, p_now, p_source, p_ip, p_now)
  on conflict (email) do nothing
  returning * into v;
  if found then id := v.id; state := 'new'; return next; return; end if;
  select * into v from waitlist w where w.email = p_email for update;
  update waitlist w set
    requested_names = case when p_name is null or p_name = any (w.requested_names) or cardinality(w.requested_names) >= 5 then w.requested_names else w.requested_names || p_name end,
    answer = coalesce(p_answer, w.answer),
    consent_hash = p_consent, consented_at = p_now, ip_hash = coalesce(p_ip, w.ip_hash)
  where w.id = v.id;
  id := v.id;
  state := case when v.confirmed_at is not null and v.unsubscribed_at is null then 'confirmed' else 'pending' end;
  return next;
end $$;

create or replace function waitlist_token_put(p_waitlist uuid, p_purpose text, p_hash bytea, p_now timestamptz, p_expires timestamptz)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into waitlist_tokens (hash, waitlist_id, purpose, created_at, expires_at) values (p_hash, p_waitlist, p_purpose, p_now, p_expires)
$$;

-- Whether a confirm or unsubscribe token would work now (the GET page shows a button; only the POST acts).
create or replace function waitlist_token_live(p_hash bytea, p_purpose text, p_now timestamptz)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from waitlist_tokens t where t.hash = p_hash and t.purpose = p_purpose and t.used_at is null and (t.expires_at is null or t.expires_at > p_now))
$$;

-- Confirm: the token is used once (conditional update); the entry is confirmed (a re-join after unsubscribing goes to the back of the line).
-- Returns the entry, its email (for the welcome message) and its place in line; no row when the token is unknown, used or expired.
create or replace function waitlist_confirm(p_hash bytea, p_now timestamptz)
returns table (id uuid, email text, place integer) language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  update waitlist_tokens t set used_at = p_now where t.hash = p_hash and t.purpose = 'confirm' and t.used_at is null and (t.expires_at is null or t.expires_at > p_now)
  returning t.waitlist_id into v_id;
  if v_id is null then return; end if;
  update waitlist w set confirmed_at = case when w.confirmed_at is null or w.unsubscribed_at is not null then p_now else w.confirmed_at end, unsubscribed_at = null
  where w.id = v_id;
  -- Every other confirm link of this entry dies with this one.
  update waitlist_tokens t set used_at = p_now where t.waitlist_id = v_id and t.purpose = 'confirm' and t.used_at is null;
  return query select w.id, w.email::text, waitlist_place(w.id) from waitlist w where w.id = v_id;
end $$;

-- Place in line: confirmed, still subscribed entries ordered by confirmation time (ties by id). No referral boost.
create or replace function waitlist_place(p_id uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from waitlist o, waitlist me
  where me.id = p_id and me.confirmed_at is not null and me.unsubscribed_at is null
    and o.confirmed_at is not null and o.unsubscribed_at is null and (o.confirmed_at, o.id) <= (me.confirmed_at, me.id)
$$;

-- Unsubscribe: the link keeps working (it can be clicked again) but only ever unsubscribes. Pending invites die with it.
create or replace function waitlist_unsubscribe(p_hash bytea, p_now timestamptz)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  select t.waitlist_id into v_id from waitlist_tokens t where t.hash = p_hash and t.purpose = 'unsubscribe' and (t.expires_at is null or t.expires_at > p_now);
  if v_id is null then return false; end if;
  update waitlist w set unsubscribed_at = coalesce(w.unsubscribed_at, p_now) where w.id = v_id;
  update waitlist_tokens t set used_at = p_now where t.waitlist_id = v_id and t.purpose = 'confirm' and t.used_at is null;
  update waitlist_invites i set expires_at = least(i.expires_at, p_now) where i.waitlist_id = v_id and i.used_at is null;
  return true;
end $$;

-- Unconfirmed entries are kept 30 days, used or expired tokens 30 days after their use or expiry.
create or replace function waitlist_sweep(p_now timestamptz)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from waitlist w where w.confirmed_at is null and w.created_at < p_now - interval '30 days';
  get diagnostics n = row_count;
  delete from waitlist_tokens t where coalesce(t.used_at, t.expires_at) < p_now - interval '30 days';
  return n;
end $$;

-- Invite lookup for the sign-up guard: the hash, the bound email and the state, by invite id. The caller compares in constant time.
create or replace function waitlist_invite_get(p_id uuid)
returns table (token_hash bytea, email text, expires_at timestamptz, used_at timestamptz) language sql stable security definer set search_path = public, pg_temp as $$
  select i.token_hash, w.email::text, i.expires_at, i.used_at from waitlist_invites i join waitlist w on w.id = i.waitlist_id where i.id = p_id
$$;

-- Use an invite once: a conditional update, so of two racing sign-ups only one gets the row.
create or replace function waitlist_invite_use(p_id uuid, p_user uuid, p_now timestamptz)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  update waitlist_invites i set used_at = p_now, used_by = p_user where i.id = p_id and i.used_at is null and i.expires_at > p_now;
  get diagnostics n = row_count;
  return n = 1;
end $$;

revoke all on function waitlist_join(citext, text, text, bytea, text, bytea, timestamptz), waitlist_token_put(uuid, text, bytea, timestamptz, timestamptz),
  waitlist_token_live(bytea, text, timestamptz), waitlist_confirm(bytea, timestamptz), waitlist_place(uuid), waitlist_unsubscribe(bytea, timestamptz),
  waitlist_sweep(timestamptz), waitlist_invite_get(uuid), waitlist_invite_use(uuid, uuid, timestamptz) from public;
grant execute on function waitlist_join(citext, text, text, bytea, text, bytea, timestamptz), waitlist_token_put(uuid, text, bytea, timestamptz, timestamptz),
  waitlist_token_live(bytea, text, timestamptz), waitlist_confirm(bytea, timestamptz), waitlist_place(uuid), waitlist_unsubscribe(bytea, timestamptz),
  waitlist_sweep(timestamptz), waitlist_invite_get(uuid), waitlist_invite_use(uuid, uuid, timestamptz) to mh_runtime, mh_cron;
