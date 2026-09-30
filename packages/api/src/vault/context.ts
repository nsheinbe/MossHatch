import type { Pool } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { KmsError, type VaultKmsAdmin, type VaultKmsPort } from "./kms/types.ts";
import { VaultIntegrityError } from "./envelope.ts";
import { raiseAlert } from "../ops/alerts.ts";

/**
 * What the vault needs beyond the base context: its own database role (`mh_vault`, the only role that can read
 * ciphertext or insert reveal and read audit rows) and the vault KMS. Installed by boot; tests install fakes.
 * Missing either one fails closed with 503 `vault_unavailable`.
 */
export interface VaultServices {
  pool: Pool;
  kms: VaultKmsPort;
  /** Incident identity for the drill and the auto-deny; absent in request paths. */
  admin?: VaultKmsAdmin;
  /** KMS deadline per call (PLAN 4.3b: 3 seconds, no retry loop). */
  timeoutMs?: number;
}

export function installVault(ctx: Pick<AppContext, "services">, s: VaultServices): void {
  (ctx.services as Record<string, unknown>).vault = s;
}

export function vaultOf(ctx: Pick<AppContext, "services">): VaultServices {
  const v = (ctx.services as { vault?: VaultServices }).vault;
  if (!v || !v.pool || !v.kms) throw new HttpError(503, "vault_unavailable");
  return v;
}

export const vaultTimeout = (v: VaultServices) => v.timeoutMs ?? 3000;

/** Headers for every response that can carry a value, and for every vault route (ST-15). */
export const NO_STORE: Record<string, string> = { "Cache-Control": "no-store, private", Pragma: "no-cache" };

/**
 * Map a failure below the vault to its public answer. KMS errors are 503 `vault_unavailable`; an authentication failure
 * of a stored row is 500 `vault_integrity` and pages. Nothing from the error (message, context, ids) is logged or
 * returned: the error code is the whole story (PLAN 4.6 row 4).
 */
export async function vaultFailure(ctx: Pick<AppContext, "services" | "cron">, e: unknown, subject: string): Promise<HttpError> {
  if (e instanceof HttpError) return e;
  if (e instanceof VaultIntegrityError) {
    await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "vault.integrity", subject }).catch(() => undefined);
    return new HttpError(500, "vault_integrity", undefined, NO_STORE);
  }
  if (e instanceof KmsError) return new HttpError(503, "vault_unavailable", undefined, NO_STORE);
  return new HttpError(503, "vault_unavailable", undefined, NO_STORE);
}
