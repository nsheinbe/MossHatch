import { parseRegistrarRouting } from "@mosshatch/registrar/openprovider";
import type { RegistrarScopeReason } from "../registrar-rpc/scope.ts";

/**
 * Openprovider credential guard (mirrors the OpenSRS rules in registrar-rpc/scope.ts, ST-117 and ST-150):
 *  - `OPENPROVIDER_*` variables exist only in the `registrar` scope (MH_SCOPE=registrar), and never in a preview deployment;
 *  - `OPENPROVIDER_ENV` says which Openprovider the credentials belong to: `sandbox` (the default) or `production`. Production credentials
 *    (`OPENPROVIDER_ENV=production`, or any `OPENPROVIDER_LIVE_*` / `OPENPROVIDER_PROD_*` / `OPENPROVIDER_PRODUCTION_*` name) are refused outside a
 *    production process, and sandbox credentials are refused in a production process;
 *  - in the registrar scope the credentials must agree with MH_REGISTRAR_MODE (live with production, sandbox or mock with sandbox);
 *  - MH_REGISTRAR_PROVIDER / MH_REGISTRAR_PROVIDER_BY_TLD must parse (openprovider | opensrs | mock, and no mock beside a real provider).
 * Pure: returns reason codes only, never a value.
 */
export type OpenproviderGuardReason =
  | "openprovider_env_invalid" | "openprovider_production_credentials_outside_production" | "openprovider_sandbox_credentials_in_production"
  | "openprovider_env_registrar_mode_mismatch" | "registrar_provider_invalid";

const ANY = /^OPENPROVIDER_/i;
const PROD_NAMED = /^OPENPROVIDER_(LIVE|PROD|PRODUCTION)_/i;

export function openproviderGuardReasons(env: Record<string, string | undefined>, mode: "local" | "preview" | "staging" | "production", registrarMode: "mock" | "sandbox" | "live"): (OpenproviderGuardReason | RegistrarScopeReason)[] {
  const reasons = new Set<OpenproviderGuardReason | RegistrarScopeReason>();
  const present = Object.keys(env).filter((k) => ANY.test(k) && k.toUpperCase() !== "OPENPROVIDER_ENV" && (env[k] ?? "") !== "");
  const target = (env.OPENPROVIDER_ENV ?? "sandbox").toLowerCase();
  if (target !== "sandbox" && target !== "production") reasons.add("openprovider_env_invalid");
  if (present.length) {
    if (env.MH_SCOPE !== "registrar") reasons.add("registrar_key_outside_registrar_scope");
    if (mode === "preview") reasons.add("registrar_credentials_in_preview");
    const production = target === "production" || present.some((k) => PROD_NAMED.test(k));
    if (production && mode !== "production") reasons.add("openprovider_production_credentials_outside_production");
    if (!production && mode === "production") reasons.add("openprovider_sandbox_credentials_in_production");
    if (env.MH_SCOPE === "registrar" && production !== (registrarMode === "live")) reasons.add("openprovider_env_registrar_mode_mismatch");
  }
  try { parseRegistrarRouting({ ...env, MH_REGISTRAR_MODE: registrarMode }); } catch { reasons.add("registrar_provider_invalid"); }
  return [...reasons];
}
