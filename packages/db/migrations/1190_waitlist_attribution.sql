-- First-touch campaign labels only; no URLs, click IDs or browser identifiers.
alter table waitlist add column attribution jsonb not null default '{}'::jsonb;

create function waitlist_join(p_email citext, p_name text, p_answer text, p_consent bytea, p_source text, p_ip bytea, p_now timestamptz, p_attribution jsonb)
returns table (id uuid, state text) language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; clean jsonb := '{}'::jsonb; k text; v text;
begin
  foreach k in array array['utm_source','utm_medium','utm_campaign'] loop
    v := lower(p_attribution ->> k);
    if jsonb_typeof(p_attribution -> k) = 'string' and v ~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
      clean := clean || jsonb_build_object(k,v);
    end if;
  end loop;
  select * into r from waitlist_join(p_email,p_name,p_answer,p_consent,p_source,p_ip,p_now);
  if r.state = 'new' then update waitlist w set attribution = clean where w.id = r.id; end if;
  return query select r.id::uuid, r.state::text;
end $$;

revoke all on function waitlist_join(citext,text,text,bytea,text,bytea,timestamptz,jsonb) from public;

grant execute on function waitlist_join(citext,text,text,bytea,text,bytea,timestamptz,jsonb) to mh_runtime,mh_cron;
