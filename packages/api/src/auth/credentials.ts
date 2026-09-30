import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import type { VerifiedRegistration } from "../webauthn.ts";
import { mailDomain } from "./common.ts";

export interface PasskeyView {
  id: string; label: string; alg: number; backupEligible: boolean; backupState: boolean; transports: string[];
  createdAt: string; lastUsedAt: string | null; suspended: boolean; revoked: boolean;
}

export const passkeyView = (r: Record<string, any>): PasskeyView => ({
  id: r.id, label: r.label, alg: r.alg, backupEligible: r.backup_eligible, backupState: r.backup_state, transports: r.transports ?? [],
  createdAt: new Date(r.created_at).toISOString(), lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
  suspended: !!r.suspended_at, revoked: !!r.revoked_at,
});

export const cleanLabel = (v: unknown): string => {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64) : "";
  return s || "Passkey";
};

/** Hardened mode keeps no weaker fallback: a backup-eligible (synced) credential is refused. */
export async function assertCredentialAllowed(c: PoolClient, userId: string, reg: VerifiedRegistration): Promise<void> {
  const u = (await c.query("select hardened_mode from users where id = $1", [userId])).rows[0];
  if (u?.hardened_mode && reg.backupEligible) throw new HttpError(422, "hardened_mode_requires_device_bound");
}

export async function insertPasskey(ctx: AppContext, c: PoolClient, userId: string, reg: VerifiedRegistration, o: { label?: string; recoveryId?: string | null } = {}): Promise<{ id: string; row: Record<string, any> }> {
  const dup = await c.query("select 1 from passkeys where credential_id = $1", [reg.credentialId]);
  if ((dup.rowCount ?? 0) > 0) throw new HttpError(409, "credential_exists");
  const r = await c.query(
    `insert into passkeys (user_id, credential_id, public_key, alg, sign_count, transports, backup_eligible, backup_state, label, created_by_recovery_id, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [userId, reg.credentialId, reg.publicKey, reg.alg, reg.signCount, reg.transports, reg.backupEligible, reg.backupState, cleanLabel(o.label), o.recoveryId ?? null, ctx.clock.now()],
  );
  return { id: r.rows[0].id, row: r.rows[0] };
}

/**
 * True when the account has a channel that is independent of the login mailbox: a verified, live second or registrant
 * address on a different mail domain. Purchases and stored secrets, and email-only recovery, depend on this.
 */
export async function requireIndependentChannel(_ctx: Pick<AppContext, "clock">, client: PoolClient, userId: string): Promise<boolean> {
  const rows = (await client.query("select address::text as address, kind, verified_at from notification_addresses where user_id = $1 and removed_at is null", [userId])).rows as { address: string; kind: string; verified_at: Date | null }[];
  const login = rows.find((r) => r.kind === "login");
  if (!login) return false;
  const d = mailDomain(login.address);
  return rows.some((r) => r.kind !== "login" && r.verified_at !== null && mailDomain(r.address) !== d);
}
