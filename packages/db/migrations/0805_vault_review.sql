-- Vault review fixes (Phase 4). Only adds or alters; 0800 is unchanged.

-- 1. A pointer MAC is single-use. Before this, the MAC was a deterministic function of the pointer, so a database writer
--    who saved a secret's (current_version, current_version_id, pointer_mac) triple could write it back after a rotation
--    and the old value was served again. Every pointer MAC now carries a fresh random nonce (vault/secrets.ts), and this
--    trigger refuses any pointer MAC the database has held before, for any row and any role (the owner included). A
--    restore to a kept version (ST-35) gets a fresh MAC and passes; a replayed triple does not.
create table secret_pointer_macs (
  mac bytea primary key,
  secret_id uuid not null,
  at timestamptz not null default now()
);
-- Append-only and invisible to the app roles; only the definer trigger below writes it.
create or replace function secret_pointer_macs_immutable() returns trigger language plpgsql as $$
begin raise exception 'secret_pointer_macs is append-only (%)', tg_op using errcode = '42501'; end $$;
create trigger secret_pointer_macs_no_update before update on secret_pointer_macs for each row execute function secret_pointer_macs_immutable();
create trigger secret_pointer_macs_no_delete before delete on secret_pointer_macs for each row execute function secret_pointer_macs_immutable();
create trigger secret_pointer_macs_no_truncate before truncate on secret_pointer_macs for each statement execute function secret_pointer_macs_immutable();
alter table secret_pointer_macs enable always trigger secret_pointer_macs_no_update;
alter table secret_pointer_macs enable always trigger secret_pointer_macs_no_delete;
alter table secret_pointer_macs enable always trigger secret_pointer_macs_no_truncate;
revoke all on secret_pointer_macs from public, mh_runtime, mh_cron, mh_vault, mh_contacts;

insert into secret_pointer_macs (mac, secret_id) select pointer_mac, id from secrets where pointer_mac is not null on conflict do nothing;

create or replace function secrets_pointer_single_use() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.pointer_mac is not null and (tg_op = 'INSERT' or new.pointer_mac is distinct from old.pointer_mac) then
    insert into public.secret_pointer_macs (mac, secret_id) values (new.pointer_mac, new.id) on conflict (mac) do nothing;
    if not found then
      raise exception 'pointer MAC was used before' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function secrets_pointer_single_use() from public;
create trigger secrets_pointer_single_use before insert or update on secrets for each row execute function secrets_pointer_single_use();
alter table secrets enable always trigger secrets_pointer_single_use;

-- 2. ST-12 covers every audit action that audit.kms_reconcile and the compromise drill accept as proof of an audited
--    Decrypt (ops/kms-reconcile.ts RECONCILE_AUDIT_ACTIONS), including `connection.credential.used`: only the vault role
--    inserts them, so runtime or cron code cannot pre-forge a row that hides a Decrypt of a stored provider credential.
create or replace function audit_vault_rows_only() returns trigger language plpgsql as $$
begin
  if new.action ~ '^(secret\.(reveal|read)(\.|$)|connection\.credential\.used$)' and not pg_has_role(current_user, 'mh_vault', 'MEMBER') then
    raise exception 'vault audit rows need the vault role' using errcode = '42501';
  end if;
  return new;
end $$;
