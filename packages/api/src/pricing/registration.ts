/** New .com registrations only. Renewals, transfers and stored orders retain their existing pricing. */
export const FEE_NOTICE_MS = 60 * 86_400_000;

/** Recording a notice never enables pricing: operators must separately enable it after cost/readiness review. */
export function newComPricingActive(now: Date, env: Record<string, string | undefined> = process.env): boolean {
  const announced = env.MH_NEW_COM_PRICING_NOTICE_AT;
  if (!announced) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(announced)) throw new Error("Invalid MH_NEW_COM_PRICING_NOTICE_AT");
  const date = new Date(announced);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== announced.replace(/(?<!\.\d{3})Z$/, ".000Z")
    || date.getTime() < Date.parse("2026-10-13T00:00:00Z")) throw new Error("Invalid MH_NEW_COM_PRICING_NOTICE_AT");
  return env.MH_NEW_COM_PRICING_ENABLED === "1" && now.getTime() >= date.getTime() + FEE_NOTICE_MS;
}
export interface RegistrationCostPolicy {
  targetPerYearMinor: bigint;
  paymentBps: number;
  paymentFixedMinor: bigint;
  overheadPerYearMinor: bigint;
  contributionPerYearMinor: bigint;
}

/** Planning reserves, not measured costs: operators must set these to their actual processor and support costs. */
export function registrationCostPolicy(env: Record<string, string | undefined> = process.env): RegistrationCostPolicy {
  const minor = (name: string, fallback: bigint) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (!/^\d{1,9}$/.test(raw)) throw new Error(`Invalid ${name}`);
    return BigInt(raw);
  };
  const paymentBps = Number(minor("MH_REGISTRATION_PAYMENT_BPS", 290n));
  if (paymentBps >= 5000) throw new Error("Invalid MH_REGISTRATION_PAYMENT_BPS");
  return {
    targetPerYearMinor: minor("MH_NEW_COM_TARGET_MINOR", 1499n),
    paymentBps,
    paymentFixedMinor: minor("MH_REGISTRATION_PAYMENT_FIXED_MINOR", 30n),
    overheadPerYearMinor: minor("MH_REGISTRATION_OVERHEAD_MINOR", 100n),
    contributionPerYearMinor: minor("MH_REGISTRATION_MIN_CONTRIBUTION_MINOR", 250n),
  };
}

const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;

/** Price at or above the target and existing tariff, with a reserve for fees on the maximum tax-inclusive charge. */
export function registrationPerYearMinor(input: {
  wholesalePerYearMinor: bigint;
  existingPerYearMinor: bigint;
  years: number;
  taxCeilingBps: number;
}, policy: RegistrationCostPolicy): bigint {
  if (!Number.isSafeInteger(input.years) || input.years < 1 || input.years > 10
    || !Number.isInteger(input.taxCeilingBps) || input.taxCeilingBps < 0 || input.taxCeilingBps > 10000
    || input.wholesalePerYearMinor < 0n || input.existingPerYearMinor < 0n
    || !Number.isInteger(policy.paymentBps) || policy.paymentBps < 0 || policy.paymentBps >= 5000
    || [policy.targetPerYearMinor, policy.paymentFixedMinor, policy.overheadPerYearMinor, policy.contributionPerYearMinor].some((v) => v < 0n)) {
    throw new Error("Invalid registration pricing input");
  }
  const y = BigInt(input.years), rate = BigInt(policy.paymentBps), tax = BigInt(input.taxCeilingBps);
  const required = (input.wholesalePerYearMinor + policy.overheadPerYearMinor + policy.contributionPerYearMinor) * y;
  // Integer-only ceiling; +1 reserves the fractional cent introduced by the tax ceiling rounding.
  const floor = ceil((required + policy.paymentFixedMinor + 1n) * 100_000_000n, y * (100_000_000n - rate * (10000n + tax)));
  let price = [input.existingPerYearMinor, policy.targetPerYearMinor, floor].reduce((a, b) => a > b ? a : b);
  const net = (perYear: bigint) => {
    const subtotal = perYear * y;
    const gross = subtotal + ceil(subtotal * tax, 10000n);
    return subtotal - ceil(gross * rate, 10000n) - policy.paymentFixedMinor;
  };
  while (net(price) < required) price++;
  return price;
}
