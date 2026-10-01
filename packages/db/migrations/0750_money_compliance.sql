-- Money-compliance and ops gaps (range 0750-0799): KMS reconcile by event id, dispute-rate inputs (C-40), the tax-region
-- gate and per-region sales ledger (C-42, C-43), and the C-19 retention purge. Add-only; nothing earlier is edited.

-- ---------------------------------------------------------------------------------------------------------------------
-- audit.kms_reconcile (PLAN 4.6 row 2, ST-10). Real KMS Decrypt must be sent exactly the encryption context used at
-- GenerateDataKey, so no per-call nonce can ride along. The reconcile token is the per-row id that IS in the original
-- context (vault: `secret_id`), and each CloudTrail Decrypt event (by its eventID) is judged once and consumes at most
-- one audit row, so one legitimate read cannot cover a second, unaudited Decrypt of the same row.
-- ---------------------------------------------------------------------------------------------------------------------
create table kms_reconcile_events (
  event_id text primary key,
  at timestamptz not null,
  key_id text,
  principal text,
  token text,
  state text not null check (state in ('matched', 'unaudited')),
  audit_chain_id uuid,
  audit_seq bigint,
  judged_at timestamptz not null,
  unique (audit_chain_id, audit_seq),
  check ((state = 'matched') = (audit_seq is not null))
);
create index kms_reconcile_events_at on kms_reconcile_events (at);
grant select, insert, update, delete on kms_reconcile_events to mh_cron;

-- ---------------------------------------------------------------------------------------------------------------------
-- C-40: disputes and early fraud warnings as their own durable record (webhook payloads are purged after 30 days), so the
-- monthly VAMP-style ratio can be computed. A PaymentIntent with both a TC40 (EFW) and a TC15 (dispute) counts twice.
-- ---------------------------------------------------------------------------------------------------------------------
create table payment_risk_events (
  id uuid primary key default uuidv7(),
  stripe_event_id text not null unique,
  kind text not null check (kind in ('dispute', 'early_fraud_warning')),
  payment_intent_id text,
  order_id uuid references orders(id),
  card_brand text,
  livemode boolean not null,
  occurred_at timestamptz not null
);
create index payment_risk_events_at on payment_risk_events (occurred_at);
grant select, insert on payment_risk_events to mh_runtime;
grant select, insert, update, delete on payment_risk_events to mh_cron;
alter table payments add column if not exists card_brand text;

-- ---------------------------------------------------------------------------------------------------------------------
-- C-42: the server-side tax-region gate. A region is an ISO 3166-2 subdivision code ("US-CA"). Launch is US-only: the
-- 50 states and DC are enabled for sale; nothing else is (territories and every other country are refused with a
-- waitlist message). Enabling or disabling a region is an operator SQL statement. `registered_at` stays the Stripe Tax
-- registration fact (C-42: Stripe Tax returns zero tax where no registration exists).
-- ---------------------------------------------------------------------------------------------------------------------
alter table tax_regions add column if not exists country text not null default 'US';
alter table tax_regions add column if not exists enabled boolean not null default false;
alter table tax_regions add column if not exists updated_at timestamptz not null default now();
insert into tax_regions (state, country, enabled)
select 'US-' || s, 'US', true from unnest(array[
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO',
  'MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
]) as s
on conflict (state) do nothing;
alter table payments add column if not exists billing_country text;

-- ---------------------------------------------------------------------------------------------------------------------
-- C-43: the sales ledger. `sales_ledger_entries` is the append-only source (one row per captured payment and per refund,
-- keyed by its source so the job is idempotent); `sales_ledger` (state, month) is the rolling aggregate the nexus check reads.
-- Gross is the amount before sales tax; a refund is a negative entry with no transaction count.
-- ---------------------------------------------------------------------------------------------------------------------
alter table sales_ledger add column if not exists tax_minor bigint not null default 0;
alter table sales_ledger add column if not exists updated_at timestamptz not null default now();
create table sales_ledger_entries (
  id uuid primary key default uuidv7(),
  source_kind text not null check (source_kind in ('payment', 'refund')),
  source_id uuid not null,
  region text not null,
  period date not null,
  gross_minor bigint not null,
  tax_minor bigint not null,
  txn_delta integer not null check (txn_delta in (0, 1)),
  livemode boolean not null,
  at timestamptz not null,
  unique (source_kind, source_id)
);
create index sales_ledger_entries_region on sales_ledger_entries (region, period);
grant select, insert, update, delete on sales_ledger_entries to mh_cron;

-- ---------------------------------------------------------------------------------------------------------------------
-- C-19: `legal_hold` next to every `retain_until` (PLAN 4.4 names consents, notices and audit_log; renewal_mandates carries
-- retain_until too). The retention job deletes only rows past retain_until with no hold.
-- ---------------------------------------------------------------------------------------------------------------------
-- `transfer_log` is created later (0900, outside this range), so it cannot be altered here: the retention job reads its hold
-- through `to_jsonb(row)->>'legal_hold'`, which honours a `legal_hold` column once the transfers migration adds one.
alter table consents add column if not exists legal_hold boolean not null default false;
alter table renewal_mandates add column if not exists legal_hold boolean not null default false;
create index if not exists consents_retain on consents (retain_until) where not legal_hold;
create index if not exists notices_retain on notices (retain_until) where not legal_hold;
create index if not exists webhook_events_received on webhook_events (received_at);
