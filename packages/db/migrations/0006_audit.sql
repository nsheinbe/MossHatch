create table audit_heads (
  chain_id uuid primary key,
  seq bigint not null,
  head_mac bytea not null
);

create table audit_log (
  chain_id uuid not null,
  seq bigint not null,
  at timestamptz not null default now(),
  actor_kind text not null check (actor_kind in ('user','agent','cli','system','support')),
  actor_id text,
  action text not null,
  resource_kind text,
  resource_id text,
  pii jsonb,
  detail jsonb not null default '{}',
  retention_class text not null default 'standard',
  legal_hold boolean not null default false,
  prev_mac bytea not null,
  mac bytea not null,
  primary key (chain_id, seq)
);
create index audit_log_at on audit_log (at);

-- Append-only, enforced below the application: triggers fire even for replicas and superusers' session_replication_role.
create or replace function audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_log is append-only (%)', tg_op using errcode = '42501'; end $$;
create trigger audit_no_update before update on audit_log for each row execute function audit_immutable();
create trigger audit_no_delete before delete on audit_log for each row execute function audit_immutable();
create trigger audit_no_truncate before truncate on audit_log for each statement execute function audit_immutable();
alter table audit_log enable always trigger audit_no_update;
alter table audit_log enable always trigger audit_no_delete;
alter table audit_log enable always trigger audit_no_truncate;

create table audit_anchors (
  id uuid primary key default uuidv7(),
  anchored_at timestamptz not null default now(),
  heads jsonb not null,           -- [{chain_id, seq, head_mac}]
  anchor_mac bytea not null,
  external_ref text
);
