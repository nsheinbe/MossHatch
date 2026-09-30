-- Extensions, helpers and roles. The migrator (a superuser or the table owner) runs this file.
create extension if not exists citext;
create extension if not exists pgcrypto;

-- Time-ordered ids (UUIDv7); PostgreSQL 16 has no built-in generator.
create or replace function uuidv7() returns uuid language sql volatile as $$
  select encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid()) placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3) from 1 for 6),
      52, 1), 53, 1), 'hex')::uuid
$$;

-- Roles are NOLOGIN groups; deployments grant LOGIN roles membership. Console roles bypass RLS, so these are created in SQL.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'mh_runtime') then create role mh_runtime nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'mh_cron') then create role mh_cron nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'mh_contacts') then create role mh_contacts nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'mh_vault') then create role mh_vault nologin; end if;
end $$;

-- The tenant for this transaction. Unset or empty means "nobody": every RLS policy compares against this and fails closed.
create or replace function app_user_id() returns uuid language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
