import assert from 'node:assert/strict';
import test from 'node:test';
import { computeAmounts } from '../packages/api/src/pricing/amounts.ts';
import { newComPricingActive, registrationCostPolicy, registrationPerYearMinor } from '../packages/api/src/pricing/registration.ts';

const policy = registrationCostPolicy({});
const base = { wholesalePerYearMinor: 1046n, standardWholesalePerYearMinor: 1046n, renewPerYearMinor: 1046n, years: 1, taxCeilingBps: 1000 };
const ceil = (n, d) => (n + d - 1n) / d;

test('new .com target is $14.99 and old registration/renewal arithmetic remains $13.46', () => {
  assert.equal(computeAmounts(base).subtotalMinor, 1346n);
  const quoted = computeAmounts({ ...base, registrationPolicy: policy });
  assert.equal(quoted.subtotalMinor, 1499n);
  assert.equal(quoted.wholesaleMinor, 1046n);
  assert.equal(quoted.feeMinor, 453n);
  assert.equal(quoted.totalMinor, 1649n);
  // Renewal arithmetic does not receive the registration policy. Stored checkout quotes are covered by the API lifecycle suites.
  assert.equal(computeAmounts(base).subtotalMinor, 1346n);
});

test('multi-year totals, tax ceiling and transparent fee reconcile exactly', () => {
  const q = computeAmounts({ ...base, years: 3, registrationPolicy: policy });
  assert.equal(q.subtotalMinor, 4497n);
  assert.equal(q.wholesaleMinor + q.renewalLevelMinor + q.feeMinor, q.subtotalMinor);
  assert.equal(q.feePerYearMinor * 3n, q.feeMinor);
  assert.equal(q.totalMinor, q.subtotalMinor + q.taxCeilingMinor);
});

test('higher supplier/renewal costs raise the first price rather than subsidizing it', () => {
  const q = computeAmounts({ ...base, wholesalePerYearMinor: 1198n, renewPerYearMinor: 1698n, registrationPolicy: policy });
  assert(q.subtotalMinor > 1499n);
  assert.equal(q.wholesaleMinor, 1198n);
  assert.equal(q.renewalLevelMinor, 500n);
  assert.equal(q.subtotalMinor, q.wholesaleMinor + q.renewalLevelMinor + q.feeMinor);
  const payment = ceil(q.totalMinor * BigInt(policy.paymentBps), 10000n) + policy.paymentFixedMinor;
  assert(q.subtotalMinor - 1698n - payment - policy.overheadPerYearMinor >= policy.contributionPerYearMinor);
});

test('cost floor covers payment fees on tax-inclusive charges across costs, terms and rates', () => {
  for (const cost of [0n, 1046n, 1200n, 1698n, 4999n, 50000n]) {
    for (const years of [1, 2, 3, 10]) for (const tax of [0, 1000, 10000]) for (const rate of [0, 290, 600, 1000]) {
      const p = { ...policy, paymentBps: rate };
      const y = BigInt(years);
      const price = registrationPerYearMinor({ wholesalePerYearMinor: cost, existingPerYearMinor: cost + 300n, years, taxCeilingBps: tax }, p);
      const subtotal = price * y, gross = subtotal + ceil(subtotal * BigInt(tax), 10000n);
      const payment = ceil(gross * BigInt(rate), 10000n) + p.paymentFixedMinor;
      assert(subtotal - cost * y - payment - p.overheadPerYearMinor * y >= p.contributionPerYearMinor * y);
      assert(price >= p.targetPerYearMinor);
      assert(price >= cost + 300n);
    }
  }
});

test('activation requires an explicit switch and 60 complete days after the recorded notice', () => {
  const notice = { MH_NEW_COM_PRICING_NOTICE_AT: '2026-10-13T17:30:00.123Z' };
  const env = { ...notice, MH_NEW_COM_PRICING_ENABLED: '1' };
  for (const enabled of [undefined, '0', 'false', 'true', '']) {
    assert.equal(newComPricingActive(new Date('2027-01-01'), { ...notice, MH_NEW_COM_PRICING_ENABLED: enabled }), false);
  }
  assert.equal(newComPricingActive(new Date('2027-01-01'), { MH_NEW_COM_PRICING_ENABLED: '1' }), false);
  assert.equal(newComPricingActive(new Date('2027-01-01'), {}), false);
  assert.equal(newComPricingActive(new Date('2026-12-11T23:59:59Z'), env), false);
  assert.equal(newComPricingActive(new Date('2026-12-12T00:00:00Z'), env), false);
  assert.equal(newComPricingActive(new Date('2026-12-12T17:30:00.122Z'), env), false);
  assert.equal(newComPricingActive(new Date('2026-12-12T17:30:00.123Z'), env), true);
  assert.equal(newComPricingActive(new Date('2026-12-13'), { MH_NEW_COM_PRICING_NOTICE_AT: '2026-10-13T17:30:00Z', MH_NEW_COM_PRICING_ENABLED: '1' }), true);
  assert.throws(() => newComPricingActive(new Date(), { MH_NEW_COM_PRICING_NOTICE_AT: '2026-10-12T23:59:59Z' }));
  assert.throws(() => newComPricingActive(new Date(), { MH_NEW_COM_PRICING_NOTICE_AT: '2026-02-31T00:00:00Z' }));
});

test('invalid cost configuration fails closed instead of silently dropping reserves', () => {
  for (const value of ['-1', 'NaN', '2.9', '', '1000000000']) {
    assert.throws(() => registrationCostPolicy({ MH_REGISTRATION_OVERHEAD_MINOR: value }));
  }
  assert.throws(() => registrationCostPolicy({ MH_REGISTRATION_PAYMENT_BPS: '5000' }));
  assert.throws(() => registrationPerYearMinor({ wholesalePerYearMinor: 1046n, existingPerYearMinor: 1346n, years: 0, taxCeilingBps: 1000 }, policy));
  assert.equal(registrationCostPolicy({ MH_REGISTRATION_OVERHEAD_MINOR: '350' }).overheadPerYearMinor, 350n);
});
