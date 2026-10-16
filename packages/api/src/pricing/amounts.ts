import { feePerYearMinor } from "./fee.ts";
import { registrationPerYearMinor, type RegistrationCostPolicy } from "./registration.ts";

/** Shared integer-only pricing arithmetic. An absent registration policy preserves the existing tariff. */
export function computeAmounts(p: { wholesalePerYearMinor: bigint; standardWholesalePerYearMinor: bigint; renewPerYearMinor?: bigint; years: number; taxCeilingBps: number; registrationPolicy?: RegistrationCostPolicy }) {
  const y = BigInt(p.years);
  const wholesaleMinor = p.wholesalePerYearMinor * y;
  const renew = p.renewPerYearMinor ?? 0n;
  const levelPerYear = renew > p.wholesalePerYearMinor ? renew - p.wholesalePerYearMinor : 0n;
  const renewalLevelMinor = levelPerYear * y;
  let fee = feePerYearMinor(renew > p.standardWholesalePerYearMinor ? renew : p.standardWholesalePerYearMinor);
  if (p.registrationPolicy) {
    // Keep the real wholesale amount pinned; only the explicitly disclosed service fee changes.
    const cost = p.wholesalePerYearMinor + levelPerYear;
    const retail = registrationPerYearMinor({ wholesalePerYearMinor: cost, existingPerYearMinor: cost + fee, years: p.years, taxCeilingBps: p.taxCeilingBps }, p.registrationPolicy);
    fee = retail - cost;
  }
  const feeMinor = fee * y;
  const subtotalMinor = wholesaleMinor + renewalLevelMinor + feeMinor;
  const taxCeilingMinor = (subtotalMinor * BigInt(p.taxCeilingBps) + 9999n) / 10000n;
  return { wholesaleMinor, renewalLevelMinor, feePerYearMinor: fee, feeMinor, subtotalMinor, taxCeilingMinor, totalMinor: subtotalMinor + taxCeilingMinor };
}
