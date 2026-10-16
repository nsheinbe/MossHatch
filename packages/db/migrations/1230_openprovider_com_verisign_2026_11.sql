-- Verisign, which runs .com, raises the registry-level wholesale fee for each new and renewal .com registration from
-- USD 10.26 to USD 10.97 effective 2026-11-01 (announced 2026-04-23; Verisign Form 10-Q for the quarter ended 2026-06-30,
-- SEC EDGAR accession 0001014473-26-000028; see docs/research/tld-registry-facts.md). With the ICANN registrar transaction
-- fee of USD 0.20, the at-cost floor moves from USD 10.46 to USD 11.17. Openprovider's member .com price is expected to
-- follow to USD 11.17 (today it is exactly registry plus the ICANN fee: 10.26 + 0.20 = 10.46, the member rows in 1220).
-- Owner decision 2026-10-16: prepare dated rows at USD 11.17 and keep the flat USD 3.00 fee, so the .com retail price
-- becomes USD 14.17 a year from 2026-11-01. The published fees table keeps USD 13.46 until that date and announces the
-- new price in its Price changes section (apps/web/public/fees.html).
-- Like 1120 and 1220, these rows are UNVERIFIED against Openprovider's live API: the public price API still showed
-- membershipPrice 10.46 on 2026-10-16. The D-031 price guard compares every live registrar quote with the row in force
-- and refuses the order (`price_mismatch`) when they differ, so a wrong figure fails closed, never over- or under-charges.
-- Re-check the API before 2026-11-01 (`scripts/live-preflight.mjs` shows the comparison per extension) and supersede this
-- row with the published figure if it differs; a price change is a new row with a later effective_from, never an update.
-- Register, renew and transfer stay equal for .com, so the D-059 renewal floor adds nothing.
insert into wholesale_prices (registrar, tld, kind, amount_minor, effective_from, source) values
  ('openprovider', 'com', 'register', 1117, '2026-11-01', 'Openprovider member create USD 11.17 expected: Verisign registry USD 10.97 from 2026-11-01 plus ICANN fee USD 0.20 (owner decision 2026-10-16; UNVERIFIED against the live member price, guard fails closed on mismatch)'),
  ('openprovider', 'com', 'renew',    1117, '2026-11-01', 'Openprovider member renew USD 11.17 expected: Verisign registry USD 10.97 from 2026-11-01 plus ICANN fee USD 0.20 (owner decision 2026-10-16; UNVERIFIED, fails closed)'),
  ('openprovider', 'com', 'transfer', 1117, '2026-11-01', 'Openprovider member transfer USD 11.17 expected: Verisign registry USD 10.97 from 2026-11-01 plus ICANN fee USD 0.20 (owner decision 2026-10-16; UNVERIFIED, fails closed)')
on conflict (registrar, tld, kind, effective_from) do nothing;
