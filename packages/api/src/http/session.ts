import type { AppContext } from "../ports.ts";
import { withNoUser, withUser } from "@mosshatch/db";
import { b64u, randomBytes, sha256 } from "../util/bytes.ts";

export const SESSION_COOKIE = "__Host-mh_session";
export const PRE_AUTH_COOKIE = "__Host-mh_pre";
export const IDLE_MS = 15 * 60_000;
export const ABSOLUTE_MS = 8 * 3600_000;

export function cookieHeader(name: string, value: string, maxAgeSeconds?: number): string {
  // __Host- prefix requires Secure, Path=/ and no Domain. SameSite=Lax, not Strict: Strict drops the cookie on the return from Stripe.
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax${maxAgeSeconds === undefined ? "" : `; Max-Age=${maxAgeSeconds}`}`;
}
export const clearCookie = (name: string) => `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export interface NewSession { cookie: string; idHash: Buffer; expiresAt: Date }

/** Issue a session. The id is 256 random bits; only its SHA-256 is stored. Always a new id (login, credential change, recovery). */
export async function createSession(ctx: AppContext, userId: string, opts: { credentialId?: string; ipPrefix?: string; uaFamily?: string }): Promise<NewSession> {
  const raw = randomBytes(32);
  const idHash = sha256(raw);
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + ABSOLUTE_MS);
  await withUser(ctx.runtime, userId, (c) => c.query(
    "insert into sessions (id_hash, user_id, created_at, last_seen_at, expires_at, idle_expires_at, auth_credential_id, ip_prefix, ua_family) values ($1,$2,$3,$3,$4,$5,$6,$7,$8)",
    [idHash, userId, now, expiresAt, new Date(now.getTime() + IDLE_MS), opts.credentialId ?? null, opts.ipPrefix ?? null, opts.uaFamily ?? null],
  ));
  return { cookie: cookieHeader(SESSION_COOKIE, b64u(raw)), idHash, expiresAt };
}

export type SessionCheck =
  | { ok: true; userId: string; idHash: Buffer; credentialId: string | null; email: string; frozen: boolean }
  | { ok: false; reason: "missing" | "unknown" | "revoked" | "idle" | "absolute" | "inactive_user" };

/** Resolve and touch a session. Idle and absolute expiry are enforced here, on the server, on every request. */
export async function resolveSession(ctx: AppContext, cookieValue: string | undefined): Promise<SessionCheck> {
  if (!cookieValue) return { ok: false, reason: "missing" };
  let raw: Buffer;
  try { raw = Buffer.from(cookieValue, "base64url"); } catch { return { ok: false, reason: "unknown" }; }
  if (raw.length !== 32) return { ok: false, reason: "unknown" };
  const idHash = sha256(raw);
  const row = (await withNoUser(ctx.runtime, (c) => c.query("select * from auth_session_get($1)", [idHash]))).rows[0];
  if (!row) return { ok: false, reason: "unknown" };
  const now = ctx.clock.now();
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (row.user_status !== "active") return { ok: false, reason: "inactive_user" };
  if (now >= new Date(row.expires_at)) return { ok: false, reason: "absolute" };
  if (now >= new Date(row.idle_expires_at)) return { ok: false, reason: "idle" };
  await withUser(ctx.runtime, row.user_id, (c) => c.query("update sessions set last_seen_at = $2, idle_expires_at = least($3::timestamptz, $4::timestamptz) where id_hash = $1", [idHash, now, new Date(now.getTime() + IDLE_MS), row.expires_at]));
  return { ok: true, userId: row.user_id, idHash, credentialId: row.auth_credential_id, email: row.email, frozen: !!row.frozen_at };
}

/** Revoke every session of a user (revoke-all, credential change, recovery). Effective on the next request. */
export async function revokeAllSessions(ctx: AppContext, userId: string, exceptIdHash?: Buffer): Promise<number> {
  const r = await withUser(ctx.runtime, userId, (c) => c.query(
    "update sessions set revoked_at = $2 where user_id = $1 and revoked_at is null and ($3::bytea is null or id_hash <> $3)", [userId, ctx.clock.now(), exceptIdHash ?? null]));
  return r.rowCount ?? 0;
}

export async function revokeSession(ctx: AppContext, userId: string, idHash: Buffer): Promise<void> {
  await withUser(ctx.runtime, userId, (c) => c.query("update sessions set revoked_at = $2 where id_hash = $1 and revoked_at is null", [idHash, ctx.clock.now()]));
}
