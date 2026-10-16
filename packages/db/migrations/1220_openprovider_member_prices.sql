-- Openprovider membership (Basic S) was activated on 2026-10-07 (owner; expires 2027-10-08, auto-renew on; D-062). From that day the
-- account pays member prices. These are Openprovider's published MEMBER reseller prices in USD per year, field `membershipPrice` for a
-- one-year term, read 2026-10-08 from the public price API behind openprovider.com's price pages:
--   https://www.openprovider.com/api/domains/full?tld={com,dev,app,io,studio,ai}&currency=USD
-- The 2026-10-01 non-member rows (1120) are kept for history; these supersede them from the activation date. A price change is a new
-- row with a later effective_from, never an update.
-- Promotions are not used: the .studio member create promotion (17.99, 2026-07-01 to 2026-12-31) is left out, as 1120 left out the
-- non-member one.
-- UNVERIFIED against the live API, like 1120: the D-031 price guard compares every live registrar quote with these rows and refuses the
-- order (`price_mismatch`) when they differ, so a member price the account is not actually charged fails closed. `scripts/live-preflight.mjs`
-- shows the comparison per extension. If the membership lapses, the account returns to non-member prices and the guard refuses orders and
-- renewals until new dated rows are added (D-059, D-062).
-- At member prices register, renew and transfer are equal for all six extensions, so the D-059 renewal floor adds nothing.
-- Verisign's .com increase on 2026-11-01 needs its own dated row once Openprovider publishes the new member price.
insert into wholesale_prices (registrar, tld, kind, amount_minor, effective_from, source) values
  ('openprovider', 'com',    'register',  1046, '2026-10-07', 'Openprovider member create USD 10.46 (public price API 2026-10-08; membership active 2026-10-07)'),
  ('openprovider', 'com',    'renew',     1046, '2026-10-07', 'Openprovider member renew USD 10.46 (public price API 2026-10-08)'),
  ('openprovider', 'com',    'transfer',  1046, '2026-10-07', 'Openprovider member transfer USD 10.46 (public price API 2026-10-08)'),
  ('openprovider', 'dev',    'register',  1220, '2026-10-07', 'Openprovider member create USD 12.20 (public price API 2026-10-08; membership active 2026-10-07)'),
  ('openprovider', 'dev',    'renew',     1220, '2026-10-07', 'Openprovider member renew USD 12.20 (public price API 2026-10-08)'),
  ('openprovider', 'dev',    'transfer',  1220, '2026-10-07', 'Openprovider member transfer USD 12.20 (public price API 2026-10-08)'),
  ('openprovider', 'app',    'register',  1420, '2026-10-07', 'Openprovider member create USD 14.20 (public price API 2026-10-08; membership active 2026-10-07)'),
  ('openprovider', 'app',    'renew',     1420, '2026-10-07', 'Openprovider member renew USD 14.20 (public price API 2026-10-08)'),
  ('openprovider', 'app',    'transfer',  1420, '2026-10-07', 'Openprovider member transfer USD 14.20 (public price API 2026-10-08)'),
  ('openprovider', 'studio', 'register',  3120, '2026-10-07', 'Openprovider member create USD 31.20 (public price API 2026-10-08, member promotion 17.99 to 2026-12-31 not used; membership active 2026-10-07)'),
  ('openprovider', 'studio', 'renew',     3120, '2026-10-07', 'Openprovider member renew USD 31.20 (public price API 2026-10-08)'),
  ('openprovider', 'studio', 'transfer',  3120, '2026-10-07', 'Openprovider member transfer USD 31.20 (public price API 2026-10-08)'),
  ('openprovider', 'io',     'register',  5000, '2026-10-07', 'Openprovider member create USD 50.00 (public price API 2026-10-08; membership active 2026-10-07)'),
  ('openprovider', 'io',     'renew',     5000, '2026-10-07', 'Openprovider member renew USD 50.00 (public price API 2026-10-08)'),
  ('openprovider', 'io',     'transfer',  5000, '2026-10-07', 'Openprovider member transfer USD 50.00 (public price API 2026-10-08)'),
  ('openprovider', 'ai',     'register',  8000, '2026-10-07', 'Openprovider member create USD 80.00 per year, 2-year minimum (public price API 2026-10-08; membership active 2026-10-07)'),
  ('openprovider', 'ai',     'renew',     8000, '2026-10-07', 'Openprovider member renew USD 80.00 per year (public price API 2026-10-08)'),
  ('openprovider', 'ai',     'transfer',  8000, '2026-10-07', 'Openprovider member transfer USD 80.00 (public price API 2026-10-08)')
on conflict (registrar, tld, kind, effective_from) do nothing;
