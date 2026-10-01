import crypto from "node:crypto";
import { withNoUser, type PoolClient } from "@mosshatch/db";
import type { AppContext, Mode } from "../ports.ts";
import type { HandlerReq } from "../http/types.ts";
import { HttpError } from "../http/router.ts";

/**
 * Invite-only sign-up (the gradual rollout). When on, `POST /auth/signup/start` and `/auth/signup/verify` need `invite`: a token
 * `<invite id>.<secret>` from an invite email, bound to the same address, unused and unexpired. The secret's SHA-256 is compared in
 * constant time. The invite is used (a conditional update) inside the transaction that activates the account, so a failed
 * activation leaves it unused and two racing sign-ups cannot both use it.
 *
 * MH_INVITE_ONLY=1 turns it on, =0 off; unset, it is on in staging and production (the live site) and off in local and preview.
 */
export function inviteOnlyFromEnv(env: Record<string, string | undefined>, mode: Mode): boolean {
  if (env.MH_INVITE_ONLY === "1") return true;
  if (env.MH_INVITE_ONLY === "0") return false;
  return mode === "production" || mode === "staging";
}

export const INVITE_TTL_MS = 14 * 86_400_000;
const TOKEN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export function parseInvite(v: unknown): { id: string; secret: string } | null {
  const m = typeof v === "string" ? TOKEN.exec(v) : null;
  return m ? { id: m[1]!, secret: m[2]! } : null;
}

const inviteOnly = (ctx: AppContext) => (ctx.services as { inviteOnly?: boolean }).inviteOnly === true;
const inviteFrom = (body: unknown) => parseInvite(body && typeof body === "object" ? (body as { invite?: unknown }).invite : undefined);

/** Whether the invite works for this address now. Always hashes and compares, so a wrong id costs the same as a wrong secret. */
export async function inviteValid(c: PoolClient, token: { id: string; secret: string }, email: string, now: Date): Promise<boolean> {
  const row = (await c.query("select token_hash, email, expires_at, used_at from waitlist_invite_get($1)", [token.id])).rows[0] as { token_hash: Buffer; email: string; expires_at: Date; used_at: Date | null } | undefined;
  const given = crypto.createHash("sha256").update(token.secret).digest();
  const stored = row ? Buffer.from(row.token_hash) : crypto.randomBytes(32);
  const same = stored.length === given.length && crypto.timingSafeEqual(stored, given);
  return !!row && same && row.email.toLowerCase() === email.trim().toLowerCase() && !row.used_at && new Date(row.expires_at).getTime() > now.getTime();
}

/** Sign-up start: with invite-only on, no valid invite for this address means 403 invite_required (the web shows the waitlist). */
export async function requireInvite(req: HandlerReq, email: string): Promise<void> {
  if (!inviteOnly(req.ctx)) return;
  const tok = inviteFrom(req.body);
  const ok = !!tok && (await withNoUser(req.ctx.runtime, (c) => inviteValid(c, tok, email, req.ctx.clock.now())));
  if (!ok) throw new HttpError(403, "invite_required");
}

/** Sign-up verify, inside the activation transaction: check again and use the invite, or throw (which rolls the activation back). */
export async function useInvite(req: HandlerReq, c: PoolClient, email: string, userId: string): Promise<void> {
  if (!inviteOnly(req.ctx)) return;
  const tok = inviteFrom(req.body);
  const now = req.ctx.clock.now();
  if (!tok || !(await inviteValid(c, tok, email, now))) throw new HttpError(403, "invite_required");
  const used = (await c.query("select waitlist_invite_use($1,$2,$3) as ok", [tok.id, userId, now])).rows[0].ok === true;
  if (!used) throw new HttpError(403, "invite_required");
}

/**
 * The invite-only live shop (docs/GO-LIVE.md). With the gate on, the production site sells only to accounts activated with an invite:
 * routes marked `liveGate` (search, quote, orders, pay links, renewals, transfers-in, agent checkout) answer 403 `invite_required` to
 * anyone else, and the web keeps showing them the demo (banner, practice hatch, public RDAP lookup, waitlist).
 *
 * MH_LIVE_GATE=1 turns it on, =0 off; unset, it is on in production (whatever MH_INVITE_ONLY says: opening sign-up alone never
 * opens the shop) and off elsewhere.
 */
export function liveGateFromEnv(env: Record<string, string | undefined>, mode: Mode): boolean {
  if (env.MH_LIVE_GATE === "1") return true;
  if (env.MH_LIVE_GATE === "0") return false;
  return mode === "production";
}

/** Whether this account may use the live shop now: always when the gate is off; with it on, only when it used an invite (migration 1120). */
export async function liveAccessFor(ctx: AppContext, userId: string | undefined): Promise<boolean> {
  if ((ctx.services as { liveGate?: boolean }).liveGate !== true) return true;
  if (!userId) return false;
  try { return (await withNoUser(ctx.runtime, (c) => c.query("select user_live_access($1) as ok", [userId]))).rows[0]?.ok === true; }
  catch { return false; } // fails closed
}

/** The router's check for `liveGate` routes (installed by buildRouter). Session and binding principals of invited accounts pass. */
export async function requireLiveAccess(req: HandlerReq): Promise<void> {
  const p = req.principal;
  const userId = p.kind === "session" || p.kind === "binding" ? p.userId : undefined;
  if (!(await liveAccessFor(req.ctx, userId))) throw new HttpError(403, "invite_required");
}
