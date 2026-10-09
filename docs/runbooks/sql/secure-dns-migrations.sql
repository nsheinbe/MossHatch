-- REVIEW ARTIFACT ONLY. Execute as ONE transaction after explicit owner approval.
-- Source 3280902987932ecc89f2ddf416fcc531053bf501; original-file SHA256 pins:
-- 0998_nameserver_proposals.sql: 1856d191e54cfd8cfcf3483be607dd2c80706c73c510e3d910c115faea573a92
-- 1130_dns_reconciliation.sql: 2ec9c61122ff2e32819c26e4690b3c979800631814e8a721aa88a8f0db799b80
set local lock_timeout = '1s';
set local statement_timeout = '30s';
set local search_path = pg_catalog, public, pg_temp;
do $release$
declare v_names text[]; v_catalogue jsonb; v_phase integer; v_acl_before jsonb; v_acl_after jsonb;
begin
  if not pg_try_advisory_xact_lock(727001) then raise exception 'release_migration_lock_busy'; end if;
  select array_agg(name order by name) into v_names from schema_migrations;
  if v_names = array['0001_base.sql','0002_accounts.sql','0003_compliance.sql','0004_domains_money.sql','0005_ops.sql','0006_audit.sql','0007_rls_grants.sql','0100_auth.sql','0110_register_options_hash.sql','0200_stepup.sql','0300_registrar_pricing.sql','0350_orders_machine.sql','0400_ops.sql','0550_domains_core.sql','0650_domain_mgmt.sql','0660_dns_snapshot_outcome.sql','0670_mandate_keep_after_charge.sql','0700_phase3_finish.sql','0750_money_compliance.sql','0800_vault.sql','0805_vault_review.sql','0850_bindings_cli.sql','0900_transfers.sql','0946_transfer_log_legal_hold.sql','0950_agents.sql','0965_binding_audience_lookup.sql','1000_cards.sql','1005_card_takedown_hold.sql','1010_card_species.sql','1050_account_closure.sql','1100_csp_reports.sql','1110_waitlist.sql','1120_openprovider_live.sql','1180_funded_admission.sql','1190_waitlist_attribution.sql','1200_conversion_measurement.sql','1210_name_lock_all_holding_states.sql','1220_openprovider_member_prices.sql']::text[] then v_phase := 0;
  elsif v_names = array['0001_base.sql','0002_accounts.sql','0003_compliance.sql','0004_domains_money.sql','0005_ops.sql','0006_audit.sql','0007_rls_grants.sql','0100_auth.sql','0110_register_options_hash.sql','0200_stepup.sql','0300_registrar_pricing.sql','0350_orders_machine.sql','0400_ops.sql','0550_domains_core.sql','0650_domain_mgmt.sql','0660_dns_snapshot_outcome.sql','0670_mandate_keep_after_charge.sql','0700_phase3_finish.sql','0750_money_compliance.sql','0800_vault.sql','0805_vault_review.sql','0850_bindings_cli.sql','0900_transfers.sql','0946_transfer_log_legal_hold.sql','0950_agents.sql','0965_binding_audience_lookup.sql','0998_nameserver_proposals.sql','1000_cards.sql','1005_card_takedown_hold.sql','1010_card_species.sql','1050_account_closure.sql','1100_csp_reports.sql','1110_waitlist.sql','1120_openprovider_live.sql','1180_funded_admission.sql','1190_waitlist_attribution.sql','1200_conversion_measurement.sql','1210_name_lock_all_holding_states.sql','1220_openprovider_member_prices.sql']::text[] then v_phase := 1;
  elsif v_names = array['0001_base.sql','0002_accounts.sql','0003_compliance.sql','0004_domains_money.sql','0005_ops.sql','0006_audit.sql','0007_rls_grants.sql','0100_auth.sql','0110_register_options_hash.sql','0200_stepup.sql','0300_registrar_pricing.sql','0350_orders_machine.sql','0400_ops.sql','0550_domains_core.sql','0650_domain_mgmt.sql','0660_dns_snapshot_outcome.sql','0670_mandate_keep_after_charge.sql','0700_phase3_finish.sql','0750_money_compliance.sql','0800_vault.sql','0805_vault_review.sql','0850_bindings_cli.sql','0900_transfers.sql','0946_transfer_log_legal_hold.sql','0950_agents.sql','0965_binding_audience_lookup.sql','0998_nameserver_proposals.sql','1000_cards.sql','1005_card_takedown_hold.sql','1010_card_species.sql','1050_account_closure.sql','1100_csp_reports.sql','1110_waitlist.sql','1120_openprovider_live.sql','1130_dns_reconciliation.sql','1180_funded_admission.sql','1190_waitlist_attribution.sql','1200_conversion_measurement.sql','1210_name_lock_all_holding_states.sql','1220_openprovider_member_prices.sql']::text[] then v_phase := 2;
  else raise exception 'release_migration_ledger_drift'; end if;
  select catalogue into v_catalogue from (select jsonb_build_object(
  'tables', (select jsonb_agg(to_jsonb(t) order by t.relname) from (select c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('agent_requests','dns_snapshots') and c.relkind='r') t),
  'columns', (select jsonb_agg(to_jsonb(t) order by t.table_name,t.ordinal_position) from (select table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name in ('agent_requests','dns_snapshots')) t),
  'constraints', (select jsonb_agg(to_jsonb(t) order by t.table_name,t.name) from (select c.conrelid::regclass::text as table_name,c.conname as name,c.contype::text as type,c.convalidated,pg_get_constraintdef(c.oid) as definition from pg_constraint c where c.conrelid in ('public.agent_requests'::regclass,'public.dns_snapshots'::regclass)) t),
  'indexes', (select jsonb_agg(to_jsonb(t) order by t.table_name,t.name) from (select i.indrelid::regclass::text as table_name,i.indexrelid::regclass::text as name,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) as definition from pg_index i where i.indrelid in ('public.agent_requests'::regclass,'public.dns_snapshots'::regclass)) t),
  'policies', (select jsonb_agg(to_jsonb(t) order by t.tablename,t.policyname) from (select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename in ('agent_requests','dns_snapshots')) t)
) as catalogue) as checked;
  if encode(digest(v_catalogue::text,'sha256'),'hex') is distinct from (case v_phase when 0 then 'dd1bc9403915be1233fdf071bec790591ce496e7be9eb20a2ec4c9a6ddf28899' when 1 then '272707ec602f12f7c911f8914678bf752a74d829b44c81e944122346cefbfd3b' when 2 then '32e26d1a33394a6331a78e571b999bee64a08b1d852b208e6dc36fe109ed090f' end) then raise exception 'release_migration_catalogue_drift'; end if;
  select * into v_acl_before from (select jsonb_agg(jsonb_build_object('table',relname,'acl',relacl::text[]) order by relname) from pg_class where oid in ('agent_requests'::regclass,'dns_snapshots'::regclass)) as before_acl;
  if v_phase = 0 then
    execute '-- Proposals share the existing revocation, expiry, tenant and request lifecycle.
-- Execution remains gated until destination authorization/inventory and DNSSEC transition verification exist.
alter table agent_requests drop constraint agent_requests_kind_check;
alter table agent_requests add constraint agent_requests_kind_check
  check (kind in (''register'',''renew'',''dns_change'',''scope'',''nameservers_change''));
';
    insert into schema_migrations(name) values ('0998_nameserver_proposals.sql');
  end if;
  if v_phase < 2 then
    execute '-- Local application migration only: never run against production without release approval.
-- Existing snapshots are also operation receipts. Persist the immutable intended zone and
-- read-only reconciliation observations. A timed-out request is never retried automatically.
alter table dns_snapshots
  -- No default/backfill: legacy snapshots omitted TTL/opaque records and are not safe rollback inventories.
  add column state_format text check (state_format = ''complete-v1''),
  add column intended_records jsonb,
  add column agent_request_id uuid references agent_requests(id),
  add column observed_hash text,
  add column observed_at timestamptz,
  add column reconciliation_state text not null default ''unresolved''
    check (reconciliation_state in (''unresolved'',''desired_observed'',''before_observed'',''partial_observed''));
create index dns_snapshots_unresolved on dns_snapshots(domain_id)
  where write_state in (''pending'',''unknown'');
';
    insert into schema_migrations(name) values ('1130_dns_reconciliation.sql');
  end if;
  select catalogue into v_catalogue from (select jsonb_build_object(
  'tables', (select jsonb_agg(to_jsonb(t) order by t.relname) from (select c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('agent_requests','dns_snapshots') and c.relkind='r') t),
  'columns', (select jsonb_agg(to_jsonb(t) order by t.table_name,t.ordinal_position) from (select table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name in ('agent_requests','dns_snapshots')) t),
  'constraints', (select jsonb_agg(to_jsonb(t) order by t.table_name,t.name) from (select c.conrelid::regclass::text as table_name,c.conname as name,c.contype::text as type,c.convalidated,pg_get_constraintdef(c.oid) as definition from pg_constraint c where c.conrelid in ('public.agent_requests'::regclass,'public.dns_snapshots'::regclass)) t),
  'indexes', (select jsonb_agg(to_jsonb(t) order by t.table_name,t.name) from (select i.indrelid::regclass::text as table_name,i.indexrelid::regclass::text as name,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) as definition from pg_index i where i.indrelid in ('public.agent_requests'::regclass,'public.dns_snapshots'::regclass)) t),
  'policies', (select jsonb_agg(to_jsonb(t) order by t.tablename,t.policyname) from (select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename in ('agent_requests','dns_snapshots')) t)
) as catalogue) as checked;
  if encode(digest(v_catalogue::text,'sha256'),'hex') is distinct from '32e26d1a33394a6331a78e571b999bee64a08b1d852b208e6dc36fe109ed090f' then raise exception 'release_migration_postcheck_failed'; end if;
  select * into v_acl_after from (select jsonb_agg(jsonb_build_object('table',relname,'acl',relacl::text[]) order by relname) from pg_class where oid in ('agent_requests'::regclass,'dns_snapshots'::regclass)) as after_acl;
  if v_acl_after is distinct from v_acl_before then raise exception 'release_migration_acl_changed'; end if;
end $release$;
select name, applied_at from schema_migrations where name in ('0998_nameserver_proposals.sql','1130_dns_reconciliation.sql') order by name;
