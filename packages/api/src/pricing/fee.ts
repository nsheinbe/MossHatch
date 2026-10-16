/** D-003: flat fee per domain-year by the extension's standard wholesale per year (USD cents, bigint). */
export const FEE_LOW_MINOR = 300n;    // wholesale under 30.00 (4.00 until 2026-10-08, D-062)
export const FEE_LOWER_MID_MINOR = 500n; // 30.00 to under 50.00 (3.00 until 2026-10-16: fatter .studio cushion, owner decision)
export const FEE_MID_MINOR = 900n;    // 50.00 to under 100.00
export const FEE_HIGH_MINOR = 1000n;  // 100.00 and above
export function feePerYearMinor(standardWholesalePerYearMinor: bigint): bigint {
  if (standardWholesalePerYearMinor < 3000n) return FEE_LOW_MINOR;
  if (standardWholesalePerYearMinor < 5000n) return FEE_LOWER_MID_MINOR;
  if (standardWholesalePerYearMinor < 10000n) return FEE_MID_MINOR;
  return FEE_HIGH_MINOR;
}
