-- RFC 8707 audience binding on every bearer route (D-019, threat rows 15 and 38). An OAuth grant is an agent binding with an
-- `audience` (0950): the resource its tokens were minted for. The router refuses such a token on any route whose resource is not
-- that audience, so the pre-authentication lookup returns the audience with the binding. A token with no audience (Bindings tab,
-- command line) is unchanged. The return type changes, so the function is dropped and created again with the same grants.
drop function if exists auth_binding_get(text, bytea);
create function auth_binding_get(p_prefix text, p_hash bytea)
returns table (id uuid, user_id uuid, kind text, scopes jsonb, spend_cap_minor bigint, expires_at timestamptz, revoked_at timestamptz, paused_at timestamptz, audience text)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, user_id, kind, scopes, spend_cap_minor, expires_at, revoked_at, paused_at, audience from bindings where token_prefix = p_prefix and token_hash = p_hash
$$;
revoke all on function auth_binding_get(text, bytea) from public;
grant execute on function auth_binding_get(text, bytea) to mh_runtime, mh_cron;
