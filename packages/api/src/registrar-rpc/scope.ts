/**
 * Where registrar credentials may exist (ST-117; plan 4.3b environments table, threat rows 29 and 30). The one reseller key lives in the `registrar`
 * project only, Production scope for live and never in Preview. `web` holds the RPC secret, which is not a registrar key.
 * Pure: returns reason codes; `loadConfig` turns them into a ModeError, so a process that has the wrong variables does not boot.
 */
export type RegistrarScopeReason =
  | "registrar_key_outside_registrar_scope" | "live_registrar_key_outside_production" | "registrar_credentials_in_preview" | "registrar_rpc_target_environment_mismatch";

/** Any of these names carries reseller credentials. Live names are separate so production keys can never be mistaken for Horizon ones. */
const LIVE_KEY = /^(OPENSRS|REGISTRAR)_(LIVE|PROD|PRODUCTION)_/i;
const ANY_KEY = /^OPENSRS_/i;

const PROD = new Set(["prod", "production", "live"]);
const NONPROD = new Set(["localhost", "127", "local", "dev", "development", "staging", "stage", "preview", "test", "sandbox", "nonprod", "mock"]);

export function registrarScopeReasons(env: Record<string, string | undefined>, mode: "local" | "preview" | "staging" | "production"): RegistrarScopeReason[] {
  const reasons = new Set<RegistrarScopeReason>();
  const scope = env.MH_SCOPE === "registrar" ? "registrar" : "other";
  const present = Object.keys(env).filter((k) => ANY_KEY.test(k) || LIVE_KEY.test(k)).filter((k) => (env[k] ?? "") !== "");
  const live = present.filter((k) => LIVE_KEY.test(k));
  if (scope !== "registrar" && present.length > 0) reasons.add("registrar_key_outside_registrar_scope");
  if (scope === "registrar" && live.length > 0 && mode !== "production") reasons.add("live_registrar_key_outside_production");
  // Preview deployments get no registrar credentials at all: the mock is used there.
  if (mode === "preview" && present.length > 0) reasons.add("registrar_credentials_in_preview");
  if (env.MH_REGISTRAR_MODE === "live" && scope === "registrar" && mode !== "production") reasons.add("live_registrar_key_outside_production");
  const url = env.REGISTRAR_RPC_URL;
  if (url) {
    let host = ""; try { host = new URL(url).hostname; } catch { /* handled below */ }
    const t = new Set(host.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const hasProd = [...t].some((x) => PROD.has(x)), hasNon = [...t].some((x) => NONPROD.has(x));
    if (!host || (mode === "production" ? hasNon : hasProd)) reasons.add("registrar_rpc_target_environment_mismatch");
  }
  return [...reasons];
}
