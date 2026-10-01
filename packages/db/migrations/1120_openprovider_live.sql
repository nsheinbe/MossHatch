-- Go-live with Openprovider (docs/GO-LIVE.md): the extension policy and the wholesale price table for registrar 'openprovider',
-- and the live-access check behind the invite-only shop.
--
-- Prices are Openprovider's published NON-MEMBER reseller prices in USD per year (no membership is bought yet), read 2026-10-01 from
-- the public feed behind openprovider.com's price pages:
--   https://tld-price-api.op-prod.net/api/sheets/domains/filter?page=1&size=5000&currency=USD&years=1&operation={create,renew,transfer}
-- Cross-checks: the sandbox GET /domains/prices on 2026-09-30 answered the same .com (11.98 / 16.98 / 11.98), .ai (109) and .studio (46)
-- figures; the sandbox said .io create 70.00 where the feed now says 74.98 (unexplained; the live quote decides, see below).
-- UNVERIFIED against the live API: no call to https://api.openprovider.eu has been made. Whether the live `price.reseller.price`
-- equals these numbers, whether the .studio non-member promotion (21.99 to 2026-12-31) is applied to API orders, and whether a
-- 2026-11-01 .com change arrives, are all unknown. The order path's price guard (D-031) compares every live quote with this table
-- and refuses the order (`price_mismatch`) when they differ, so a wrong row fails closed: nobody is charged a price we did not see.
-- A price change is a new row with a later effective_from, never an update.
--
-- Renewal floor: Mosshatch charges the same price every year. Where renew > create (.com 16.98 > 11.98, .ai 134 > 109), the quote
-- (pricing/quote.ts computeAmounts) charges max(create, renew) + the D-003 fee from the first year, so a renewal is never sold below cost.

-- Extension policy: the OpenSRS rows' registry facts (they are the registry's, not the reseller's) under registrar 'openprovider'.
create temporary table _op_policy on commit drop as select * from tld_policy where registrar = 'opensrs';
update _op_policy set registrar = 'openprovider',
  -- Observed in the Openprovider sandbox 2026-09-30: POST /domains/{id}/restore restored a deleted .io at no charge; the API offers it for all six.
  restore_via_api = true,
  source = 'Registry facts copied from the opensrs rows (migrations 0300, 0900); restore through the Openprovider API (sandbox-observed for .io only), 2026-10-01';
insert into tld_policy select * from _op_policy on conflict (registrar, tld) do nothing;

-- Refund windows (C-29) as the registry's add grace period, the same as the OpenSRS rows. UNVERIFIED at Openprovider: whether a delete
-- inside the add grace period credits the reseller balance (the rehearsal's "refund inside the grace window" checks it, LAUNCH-CHECKLIST stage 3).
insert into refund_policy (registrar, tld, refundable, window_days, note)
select 'openprovider', tld, refundable, window_days, note || '; Openprovider credit on an add-grace delete UNVERIFIED' from refund_policy where registrar = 'opensrs'
on conflict do nothing;

insert into wholesale_prices (registrar, tld, kind, amount_minor, effective_from, source) values
  ('openprovider', 'com',    'register',  1198, '2026-10-01', 'Openprovider non-member create USD 11.98 (public feed 2026-10-01; sandbox GET /domains/prices 2026-09-30 agrees)'),
  ('openprovider', 'com',    'renew',     1698, '2026-10-01', 'Openprovider non-member renew USD 16.98 (public feed 2026-10-01; sandbox agrees)'),
  ('openprovider', 'com',    'transfer',  1198, '2026-10-01', 'Openprovider non-member transfer USD 11.98 (public feed 2026-10-01; sandbox agrees)'),
  ('openprovider', 'dev',    'register',  2398, '2026-10-01', 'Openprovider non-member create USD 23.98 (public feed 2026-10-01; not seen in the sandbox)'),
  ('openprovider', 'dev',    'renew',     2398, '2026-10-01', 'Openprovider non-member renew USD 23.98 (public feed 2026-10-01)'),
  ('openprovider', 'dev',    'transfer',  2398, '2026-10-01', 'Openprovider non-member transfer USD 23.98 (public feed 2026-10-01)'),
  ('openprovider', 'app',    'register',  2698, '2026-10-01', 'Openprovider non-member create USD 26.98 (public feed 2026-10-01; not seen in the sandbox)'),
  ('openprovider', 'app',    'renew',     2698, '2026-10-01', 'Openprovider non-member renew USD 26.98 (public feed 2026-10-01)'),
  ('openprovider', 'app',    'transfer',  2698, '2026-10-01', 'Openprovider non-member transfer USD 26.98 (public feed 2026-10-01)'),
  ('openprovider', 'io',     'register',  7498, '2026-10-01', 'Openprovider non-member create USD 74.98 (public feed 2026-10-01; the sandbox said 70.00 on 2026-09-30)'),
  ('openprovider', 'io',     'renew',     8998, '2026-10-01', 'Openprovider non-member renew USD 89.98 (public feed 2026-10-01)'),
  ('openprovider', 'io',     'transfer',  7498, '2026-10-01', 'Openprovider non-member transfer USD 74.98 (public feed 2026-10-01)'),
  ('openprovider', 'studio', 'register',  4600, '2026-10-01', 'Openprovider non-member create USD 46.00 (public feed 2026-10-01, promotion 21.99 to 2026-12-31 not used; sandbox 46)'),
  ('openprovider', 'studio', 'renew',     4600, '2026-10-01', 'Openprovider non-member renew USD 46.00 (public feed 2026-10-01)'),
  ('openprovider', 'studio', 'transfer',  4600, '2026-10-01', 'Openprovider non-member transfer USD 46.00 (public feed 2026-10-01)'),
  ('openprovider', 'ai',     'register', 10900, '2026-10-01', 'Openprovider non-member create USD 109.00 per year, 2-year minimum (public feed 2026-10-01; sandbox 2 y 218.00)'),
  ('openprovider', 'ai',     'renew',    13400, '2026-10-01', 'Openprovider non-member renew USD 134.00 per year (public feed 2026-10-01)'),
  ('openprovider', 'ai',     'transfer', 10900, '2026-10-01', 'Openprovider non-member transfer USD 109.00 (public feed 2026-10-01)')
on conflict (registrar, tld, kind, effective_from) do nothing;

-- Live access for the invite-only shop (waitlist/gate.ts `requireLiveAccess`): an account may buy while the gate is on only when it
-- was activated with an invite. The invites table has forced row-level security and no policy, so the runtime role asks through this.
create or replace function user_live_access(p_user uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from waitlist_invites i where i.used_by = p_user and i.used_at is not null)
$$;
revoke all on function user_live_access(uuid) from public;
grant execute on function user_live_access(uuid) to mh_runtime, mh_cron;

-- The dogfood spend fuse: live registrations allowed in total (lifetime) while the gate is on. The daily cap is
-- `limits.daily_registrations`; both are lowered further by MH_LIVE_DAILY_REGISTRATIONS / MH_LIVE_TOTAL_REGISTRATIONS (compliance/velocity.ts).
insert into flags (name, value) values ('limits.total_live_registrations', '10') on conflict (name) do nothing;
