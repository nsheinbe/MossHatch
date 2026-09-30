-- Phase 2 registrar, pricing and search module (migrations 0300-0349).
-- Wholesale seed: OpenSRS Essential tier, docs/PLAN.md 4.1 and 4.2 and docs/research/reg-opensrs.md, sources re-fetched 2026-09-29.
-- Amounts are USD minor units (cents) per YEAR. The rate card does not say whether the USD 0.20 ICANN fee is included
-- (only GET_PRICE does), and `.ai` 111.00 x 2 is an inference: no live GET_PRICE has been run. Nothing here is verified against the live API.
-- effective_from 2026-09-29 is the date the prices were read, not the date the registrar set them.
alter table tld_policy add column max_term_years integer not null default 10;

insert into tld_policy (registrar, tld, registry_window_days, longest_seen_days, expiry_grace_days, redemption_days, auction_from_day, restore_via_api, min_term_years, max_term_years, source) values
  ('opensrs','com',    null, null, 40, 30, 41, true,  1, 10, 'PLAN.md 4.1 / reg-opensrs.md (T1, K14), 2026-09-29'),
  ('opensrs','dev',    null, null, 40, 30, 41, true,  1, 10, 'PLAN.md 4.1 / reg-opensrs.md (T1, K14), 2026-09-29'),
  ('opensrs','app',    null, null, 40, 30, 41, false, 1, 10, 'PLAN.md 4.1 / reg-opensrs.md (T1, K14), 2026-09-29; restore through OpenSRS support'),
  ('opensrs','studio', null, null, 40, 30, 41, true,  1, 10, 'PLAN.md 4.1 / reg-opensrs.md (T1, K14), 2026-09-29'),
  ('opensrs','io',     null, null, 40, 30, 41, false, 1, 10, 'PLAN.md 4.1 / reg-opensrs.md (T1, K14), 2026-09-29; restore through OpenSRS support'),
  ('opensrs','ai',     null, null, 40, 30, 41, false, 2, 10, 'PLAN.md 4.1 / reg-opensrs.md (T1, K12, K14), 2026-09-29; 2-year minimum; restore through OpenSRS support');

-- register = renew = transfer per year on every tier (reg-opensrs.md "Other tiers"); restore is a per-transaction fee.
insert into wholesale_prices (registrar, tld, kind, amount_minor, effective_from, source)
select 'opensrs', v.tld, k.kind, v.amount, v.eff::date, v.src
from (values
  ('com',    1450, '2026-09-29', 'PLAN.md 4.2 Wholesale row; rate card reg-opensrs.md Essential 14.50, read 2026-09-29'),
  ('com',    1525, '2026-11-01', 'PLAN.md 4.2 Wholesale row; tld-price-changes 15.25 effective 2026-11-01, read 2026-09-29'),
  ('dev',    1700, '2026-09-29', 'PLAN.md 4.2 Wholesale row; rate card Essential 17.00 (promo 10.00 excluded), read 2026-09-29'),
  ('app',    2100, '2026-09-29', 'PLAN.md 4.2 Wholesale row; rate card Essential 21.00 (promo 14.00 excluded), read 2026-09-29'),
  ('studio', 4200, '2026-09-29', 'PLAN.md 4.2 Wholesale row; rate card Essential 42.00, read 2026-09-29'),
  ('studio', 5100, '2026-10-06', 'PLAN.md 4.2 Wholesale row; tld-price-changes 51.00 effective 2026-10-06, read 2026-09-29'),
  ('io',     6000, '2026-09-29', 'PLAN.md 4.2 Wholesale row; rate card Essential 60.00 (promo 34.00 excluded), read 2026-09-29'),
  ('ai',    11100, '2026-09-29', 'PLAN.md 4.2 Wholesale row; rate card Essential 111.00 per year, 2-year minimum (222.00 at first charge inferred, GET_PRICE not run), read 2026-09-29')
) as v(tld, amount, eff, src)
cross join (values ('register'), ('renew'), ('transfer')) as k(kind);

insert into wholesale_prices (registrar, tld, kind, amount_minor, effective_from, source) values
  ('opensrs','com',    'restore',  8000, '2026-09-29', 'PLAN.md 4.1 / reg-opensrs.md rate card Restore, read 2026-09-29'),
  ('opensrs','dev',    'restore', 15000, '2026-09-29', 'PLAN.md 4.1 / reg-opensrs.md rate card Restore, read 2026-09-29'),
  ('opensrs','app',    'restore', 15000, '2026-09-29', 'PLAN.md 4.1 / reg-opensrs.md rate card Restore, read 2026-09-29'),
  ('opensrs','studio', 'restore',  8000, '2026-09-29', 'PLAN.md 4.1 / reg-opensrs.md rate card Restore, read 2026-09-29'),
  ('opensrs','io',     'restore', 25000, '2026-09-29', 'PLAN.md 4.1 / reg-opensrs.md rate card Restore, read 2026-09-29'),
  ('opensrs','ai',     'restore', 20000, '2026-09-29', 'PLAN.md 4.1 / reg-opensrs.md rate card Restore, read 2026-09-29');

-- Tunables. The lookup budget is a PLACEHOLDER: the real ceiling is 50% of the fee threshold agreed in writing with OpenSRS (PLAN.md 4.3b), which does not exist yet.
insert into flags (name, value) values
  ('pricing.tax_ceiling_bps', '1000'),               -- upper bound on tax we may ask Checkout to add: 10% of subtotal (not a tax rate)
  ('limits.lookup_budget_daily', '20000'),           -- total registrar lookups per UTC day; 70% search, 30% checkout/renewals/agents
  ('limits.review_order_wholesale_minor', '5000')    -- risk_state='review' holds orders above USD 50 wholesale
on conflict (name) do nothing;

-- Shared registrar lookup budget (one row per pool per UTC day). No search text, no addresses.
create table lookup_budget (
  pool text not null check (pool in ('search','checkout')),
  day date not null,
  used integer not null default 0 check (used >= 0),
  primary key (pool, day)
);
grant select, insert, update on lookup_budget to mh_runtime;

-- Sanctions screening log: opaque references only; never names or addresses.
grant select, insert on sanctions_screenings to mh_runtime;
create index sanctions_screenings_ref on sanctions_screenings (subject_kind, subject_ref, checked_at desc);

-- Global registration velocity across all tenants, without exposing rows (runtime cannot see other users' orders through RLS).
create or replace function velocity_global_registrations(p_since timestamptz)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from orders
  where kind = 'register' and created_at >= p_since
    and state not in ('draft','checkout_open','checkout_expired','payment_failed')
$$;
revoke all on function velocity_global_registrations(timestamptz) from public;
grant execute on function velocity_global_registrations(timestamptz) to mh_runtime, mh_cron;
