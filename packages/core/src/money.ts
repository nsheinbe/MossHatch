/** Money is integer minor units (cents) with an ISO currency. Never floats. */
export interface Money { readonly cents: number; readonly currency: "USD" }

export const usd = (cents: number): Money => {
  if (!Number.isSafeInteger(cents)) throw new Error("money must be whole cents");
  return { cents, currency: "USD" };
};
export const add = (a: Money, b: Money): Money => usd(a.cents + b.cents);

export function formatUsd(m: Money): string {
  const dollars = Math.trunc(m.cents / 100);
  const c = Math.abs(m.cents % 100);
  return `$${dollars}.${String(c).padStart(2, "0")}`;
}

/** D-003: flat fee per domain-year by wholesale band (USD cents). */
export function feePerYear(wholesale: Money): Money {
  const w = wholesale.cents;
  return usd(w < 5000 ? 400 : w < 10000 ? 900 : 1000);
}
