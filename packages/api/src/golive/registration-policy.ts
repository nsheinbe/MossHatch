/** Commercial capacity is an explicit operator choice; dogfood remains the default. */
export const commercialRegistrationPolicy = (env: Record<string, string | undefined>): boolean =>
  env.MH_REGISTRATION_POLICY === "commercial";

/** A commercial override: no value or "unlimited" removes the count ceiling, 0 stops it, invalid values fail closed. */
export function commercialCountLimit(value: string | undefined): number | null {
  if (value === undefined || value.trim().toLowerCase() === "unlimited") return null;
  const text = value.trim();
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** The isolated registrar uses the same policy as web, independently configured on its own project. */
export function registrarSpendLimitFromEnv(env: Record<string, string | undefined>, live: boolean): number | null {
  if (commercialRegistrationPolicy(env)) return commercialCountLimit(env.MH_REGISTRAR_DAILY_SPEND_OPS);
  const raw = env.MH_REGISTRAR_DAILY_SPEND_OPS;
  return raw !== undefined && /^\d{1,6}$/.test(raw) ? Number(raw) : live ? 5 : null;
}
