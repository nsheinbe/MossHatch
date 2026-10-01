import type { Config, Mode } from "../ports.ts";
import { registrarScopeReasons, type RegistrarScopeReason } from "../registrar-rpc/scope.ts";
import type { Money } from "@mosshatch/registrar/port";
import { openproviderGuardReasons, type OpenproviderGuardReason } from "./openprovider-guard.ts";

/**
 * Mode guard (PLAN.md 4.3b "Environments and what each may touch", rule 1; ST-150).
 * Allowed: a test Stripe key with a mock or sandbox registrar, or a live key with the live registrar in production.
 * Anything else throws. Error messages carry reason codes only, never a key, host or alias.
 */
export type ModeErrorReason =
  | OpenproviderGuardReason
  | "live_key_with_non_live_registrar" | "test_key_with_live_registrar" | "live_outside_production" | "no_stripe_key_in_production" | "no_stripe_key_with_live_registrar"
  | "vercel_env_mismatch" | "db_host_environment_mismatch" | "kms_alias_environment_mismatch" | "sample_amount_at_live_checkout"
  | "stripe_key_unrecognized" | "config_missing" | RegistrarScopeReason;
export class ModeError extends Error {
  constructor(public reasons: ModeErrorReason[]) { super(`mode guard: ${reasons.join(",")}`); this.name = "ModeError"; }
}

export interface ModeInputs {
  stripeKeyKind: "test" | "live" | "none";
  registrarMode: "mock" | "sandbox" | "live";
  mode: Mode;
  /** `VERCEL_ENV` when set. Custom environments such as staging report `preview`. */
  vercelEnv?: "development" | "preview" | "production";
  /** Hints, compared by environment token only when present: a production process must not point at a non-production host or alias, and the reverse. */
  dbHost?: string;
  kmsAlias?: string;
}

const NONPROD = new Set(["localhost", "127", "local", "dev", "development", "staging", "stage", "preview", "test", "sandbox", "nonprod", "mock"]);
const PROD = new Set(["prod", "production", "live"]);
function tokens(s: string): Set<string> { return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)); }
function envMismatch(hint: string, mode: Mode): boolean {
  const t = tokens(hint);
  const hasProd = [...t].some((x) => PROD.has(x));
  const hasNon = [...t].some((x) => NONPROD.has(x));
  return mode === "production" ? hasNon : hasProd;
}

export function assertModeConsistency(i: ModeInputs): void {
  const reasons: ModeErrorReason[] = [];
  const nonLiveRegistrar = i.registrarMode === "mock" || i.registrarMode === "sandbox";
  if (i.stripeKeyKind === "live") {
    if (i.registrarMode !== "live") reasons.push("live_key_with_non_live_registrar");
    if (i.mode !== "production") reasons.push("live_outside_production");
  } else if (i.stripeKeyKind === "test") {
    if (!nonLiveRegistrar) reasons.push("test_key_with_live_registrar");
  } else { // no Stripe key: allowed only for a non-production process with a non-live registrar (nothing can move money)
    if (i.mode === "production") reasons.push("no_stripe_key_in_production");
    if (!nonLiveRegistrar) reasons.push("no_stripe_key_with_live_registrar");
  }
  if (i.registrarMode === "live" && i.mode !== "production" && !reasons.includes("live_outside_production")) reasons.push("live_outside_production");
  if (i.vercelEnv !== undefined) {
    const prodEnv = i.vercelEnv === "production";
    if (prodEnv !== (i.mode === "production")) reasons.push("vercel_env_mismatch");
    if (i.vercelEnv === "development" && i.mode !== "local") reasons.push("vercel_env_mismatch");
    if (i.vercelEnv === "preview" && i.mode !== "preview" && i.mode !== "staging") reasons.push("vercel_env_mismatch");
  }
  if (i.dbHost !== undefined && envMismatch(i.dbHost, i.mode)) reasons.push("db_host_environment_mismatch");
  if (i.kmsAlias !== undefined && envMismatch(i.kmsAlias, i.mode)) reasons.push("kms_alias_environment_mismatch");
  if (reasons.length) throw new ModeError([...new Set(reasons)]);
}

/** Boot-time check on an assembled Config (used by the Stripe client constructor and the adapter factory; `POST /orders` answers 503 when this throws). */
export function assertConfigMode(c: Pick<Config, "stripeKeyKind" | "registrarMode" | "mode" | "livemode">, extra: { vercelEnv?: ModeInputs["vercelEnv"]; dbHost?: string; kmsAlias?: string } = {}): void {
  assertModeConsistency({ stripeKeyKind: c.stripeKeyKind, registrarMode: c.registrarMode, mode: c.mode, ...extra });
  if (c.livemode !== (c.stripeKeyKind === "live")) throw new ModeError(["live_key_with_non_live_registrar"]);
}

/** Checkout refuses a sample amount when the deployment is in live mode. Returns the amount for chaining. */
export function refuseSampleAtLiveCheckout<T extends Pick<Money, "source">>(money: T, livemode: boolean): T {
  if (livemode && money.source === "sample") throw new ModeError(["sample_amount_at_live_checkout"]);
  return money;
}

function stripeKind(key: string | undefined): ModeInputs["stripeKeyKind"] {
  if (!key) return "none";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  throw new ModeError(["stripe_key_unrecognized"]);
}
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).hostname; } catch { return undefined; }
}

/**
 * Build Config from environment variables and run the mode guard. Values are never logged or put in errors.
 * Variables: MH_MODE (local|preview|staging|production; default derived from VERCEL_ENV, else local), VERCEL_ENV, MH_ORIGIN, MH_RP_ID,
 * MH_ALLOWED_ORIGINS (comma list), CRON_SECRET (32+ characters), STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 * MH_REGISTRAR_MODE (mock|sandbox|live; default mock), DATABASE_URL (host hint only), MH_KMS_ALIAS (hint only),
 * MH_SCOPE (`registrar` only in the registrar project), REGISTRAR_RPC_URL (host compared with the environment); OPENSRS_* / REGISTRAR_LIVE_* credentials are refused outside the registrar scope.
 */
/** The deployment mode alone (MH_MODE, else derived from VERCEL_ENV, else local), before the rest of the config is checked. */
export function modeFromEnv(env: Record<string, string | undefined>): Mode {
  const vercelEnv = env.VERCEL_ENV;
  const modeRaw = env.MH_MODE ?? (vercelEnv === "production" ? "production" : vercelEnv === "preview" ? "preview" : "local");
  if (!["local", "preview", "staging", "production"].includes(modeRaw)) throw new ModeError(["config_missing"]);
  return modeRaw as Mode;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const vercelEnv = env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development" ? env.VERCEL_ENV : undefined;
  const mode = modeFromEnv(env);
  const regRaw = env.MH_REGISTRAR_MODE ?? "mock";
  if (!["mock", "sandbox", "live"].includes(regRaw)) throw new ModeError(["config_missing"]);
  const registrarMode = regRaw as Config["registrarMode"];
  const stripeKeyKind = stripeKind(env.STRIPE_SECRET_KEY);
  const origin = env.MH_ORIGIN ?? (mode === "local" ? "http://localhost:3000" : undefined);
  const cronSecret = env.CRON_SECRET;
  if (!origin || !cronSecret || cronSecret.length < 32) throw new ModeError(["config_missing"]);
  assertModeConsistency({ stripeKeyKind, registrarMode, mode, vercelEnv, dbHost: hostOf(env.DATABASE_URL), kmsAlias: env.MH_KMS_ALIAS });
  // ST-117: reseller credentials exist only in the `registrar` scope (MH_SCOPE=registrar), live ones only in production, none in preview.
  const scopeReasons = registrarScopeReasons(env, mode);
  if (scopeReasons.length) throw new ModeError(scopeReasons);
  // Openprovider: OPENPROVIDER_* only in the registrar scope; sandbox credentials refused in production, production ones outside it; MH_REGISTRAR_PROVIDER must parse.
  const openproviderReasons = openproviderGuardReasons(env, mode, registrarMode);
  if (openproviderReasons.length) throw new ModeError(openproviderReasons);
  let rpId = env.MH_RP_ID;
  if (!rpId) { try { rpId = new URL(origin).hostname; } catch { throw new ModeError(["config_missing"]); } }
  const allowedOrigins = env.MH_ALLOWED_ORIGINS ? env.MH_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) : [origin];
  return { mode, origin, rpId, allowedOrigins, cronSecret, livemode: stripeKeyKind === "live", stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET, stripeKeyKind, registrarMode };
}
