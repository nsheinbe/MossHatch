import crypto from "node:crypto";
import { z } from "zod";
import { withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import type { HandlerReq, HandlerResult, Route } from "../http/types.ts";
import { HttpError, json } from "../http/router.ts";
import { clearCookie, createSession, PRE_AUTH_COOKIE, revokeAllSessions, revokeSession, SESSION_COOKIE } from "../http/session.ts";
import { verifyRegistration } from "../webauthn.ts";
import { SECRET_REVEAL_HOLD_MS, SUSPENSION_MS, UUID_RE, auditUser, parseBody } from "./common.ts";
import { asRegistration, challengeFrom, challengeOptionsHash, consumeChallenge } from "./ceremony.ts";
import { markExecuted, requireAction } from "../stepup/gate.ts";
import { safeEqual } from "../util/bytes.ts";
import { assertCredentialAllowed, insertPasskey, passkeyView, requireIndependentChannel } from "./credentials.ts";
import { issueRecoveryCodes, unusedRecoveryCodes } from "./codes.ts";
import { assertNoRecoveryActivity, assertNotHeld } from "./holds.ts";
import { notifyUser } from "./mail.ts";
import { recoveryBanner } from "./recovery.ts";

const CLEAR_SITE_DATA = '"cookies", "storage"';

function sessionOf(req: HandlerReq): { userId: string; sessionIdHash: Buffer } {
  const { userId, sessionIdHash } = req.principal;
  if (req.principal.kind !== "session" || !userId || !sessionIdHash) throw new HttpError(401, "unauthorized");
  return { userId, sessionIdHash };
}

/** Logout deletes the session (revokes the row) and tells the browser to drop cookies and storage. */
async function logout(req: HandlerReq): Promise<HandlerResult> {
  const { userId, sessionIdHash } = sessionOf(req);
  await revokeSession(req.ctx, userId, sessionIdHash);
  await withUser(req.ctx.runtime, userId, (c) => auditUser(req.ctx, c, userId, "auth.logout"));
  return json({ ok: true }, 200, { headers: { "Clear-Site-Data": CLEAR_SITE_DATA }, cookies: [clearCookie(SESSION_COOKIE), clearCookie(PRE_AUTH_COOKIE)] });
}

/** Revoke every session of the account, this one included. Not a step-up and not rate limited. */
async function revokeAll(req: HandlerReq): Promise<HandlerResult> {
  const { userId } = sessionOf(req);
  const n = await revokeAllSessions(req.ctx, userId);
  await withUser(req.ctx.runtime, userId, async (c) => {
    await auditUser(req.ctx, c, userId, "auth.sessions.revoked_all", { detail: { count: n } });
    await notifyUser(req.ctx, c, userId, { kind: "sessions.revoked", dedupeKey: `revoke-all:${crypto.randomUUID()}`, subject: "All sessions were signed out", text: "Every session on your Mosshatch account was signed out." });
  });
  return json({ ok: true, revoked: n }, 200, { headers: { "Clear-Site-Data": CLEAR_SITE_DATA }, cookies: [clearCookie(SESSION_COOKIE)] });
}

async function me(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const { userId } = sessionOf(req);
  const out = await withUser(ctx.runtime, userId, async (c) => {
    const u = (await c.query("select id, email::text as email, status, hardened_mode, frozen_at, device_login_enabled, created_at from users where id = $1", [userId])).rows[0];
    if (!u) throw new HttpError(401, "unauthorized");
    const creds = (await c.query("select * from passkeys where user_id = $1 and revoked_at is null order by created_at", [userId])).rows;
    const addrs = (await c.query("select id, address::text as address, kind, verified_at from notification_addresses where user_id = $1 and removed_at is null order by created_at", [userId])).rows;
    const now = ctx.clock.now();
    const holds = (await c.query("select scope, max(until) as until from action_holds where user_id = $1 and until > $2 group by scope", [userId, now])).rows as { scope: string; until: Date }[];
    const hold = (s: string) => { const h = holds.find((x) => x.scope === s); return h ? new Date(h.until).toISOString() : null; };
    const banner = await recoveryBanner(ctx, c, userId);
    const codes = await unusedRecoveryCodes(c, userId);
    const independent = await requireIndependentChannel(ctx, c, userId);
    const live = creds.filter((p) => !p.suspended_at);
    const warnings: string[] = [];
    if (live.length < 2) warnings.push("single_credential");
    if (live.length > 0 && live.every((p) => p.backup_eligible)) warnings.push("synced_credentials_only");
    if (!independent) warnings.push("no_independent_channel");
    if (codes === 0) warnings.push("no_recovery_codes");
    return {
      user: { id: u.id, email: u.email, status: u.status, hardenedMode: u.hardened_mode, frozen: !!u.frozen_at, deviceLoginEnabled: u.device_login_enabled },
      credentials: creds.map(passkeyView),
      addresses: addrs.map((a) => ({ id: a.id, address: a.address, kind: a.kind, verified: !!a.verified_at })),
      hold: { active: hold("all_held") !== null || hold("secret.reveal") !== null, allHeldUntil: hold("all_held"), secretRevealUntil: hold("secret.reveal") },
      recovery: banner,
      recoveryCodesRemaining: codes,
      independentChannel: independent,
      warnings,
    };
  });
  return json(out);
}

/* ---- passkeys ---- */

async function listPasskeys(req: HandlerReq): Promise<HandlerResult> {
  const { userId } = sessionOf(req);
  const rows = await withUser(req.ctx.runtime, userId, (c) => c.query("select * from passkeys where user_id = $1 and revoked_at is null order by created_at", [userId]));
  return json({ passkeys: rows.rows.map(passkeyView) });
}

/** Give the caller a fresh session id and end the others: a credential change always rotates sessions. */
async function rotateSessions(ctx: AppContext, req: HandlerReq, userId: string, credentialId: string | null | undefined): Promise<string> {
  const s = await createSession(ctx, userId, { credentialId: credentialId ?? undefined, ipPrefix: req.ipPrefix, uaFamily: req.uaFamily });
  await revokeAllSessions(ctx, userId, s.idHash);
  return s.cookie;
}

const deleteBody = z.object({ confirmLast: z.boolean().optional() }).optional();

async function deletePasskey(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const { userId } = sessionOf(req);
  const id = req.params.id ?? "";
  if (!UUID_RE.test(id)) throw new HttpError(404, "not_found");
  const b = parseBody(deleteBody, req.body ?? undefined);
  const removedCredentialId = await withUser(ctx.runtime, userId, async (c) => {
    const p = (await c.query("select * from passkeys where id = $1 and user_id = $2 and revoked_at is null", [id, userId])).rows[0];
    if (!p) throw new HttpError(404, "not_found");
    // A hold freezes credential changes, and a suspended credential is the undo path: nobody removes it from a session.
    await assertNoRecoveryActivity(ctx, c, userId);
    if (p.suspended_at && p.suspended_by_recovery_id && new Date(p.suspended_at).getTime() + SUSPENSION_MS > ctx.clock.now().getTime()) throw new HttpError(409, "credential_suspended");
    if (!p.suspended_at) {
      const others = Number((await c.query("select count(*) as n from passkeys where user_id = $1 and revoked_at is null and suspended_at is null and id <> $2", [userId, id])).rows[0].n);
      if (others === 0) {
        if ((await unusedRecoveryCodes(c, userId)) === 0) throw new HttpError(409, "last_credential_no_recovery_codes");
        if (b?.confirmLast !== true) throw new HttpError(409, "confirm_required");
      }
    }
    const r = await c.query("update passkeys set revoked_at = $3 where id = $1 and user_id = $2 and revoked_at is null returning credential_id", [id, userId, ctx.clock.now()]);
    if (r.rowCount !== 1) throw new HttpError(404, "not_found");
    await auditUser(ctx, c, userId, "auth.passkey.revoked", { resourceKind: "passkey", resourceId: id });
    await notifyUser(ctx, c, userId, { kind: "passkey.removed", dedupeKey: `passkey-removed:${id}`, subject: "A passkey was removed from your Mosshatch account", text: "A passkey was removed. If this was not you, cancel with a recovery and review your account at once." });
    return r.rows[0].credential_id as string;
  });
  const keep = req.principal.authCredentialId === removedCredentialId ? null : req.principal.authCredentialId;
  const cookie = await rotateSessions(ctx, req, userId, keep);
  return json({ ok: true }, 200, { cookies: [cookie] });
}

/**
 * Runs after the step-up gate for `passkey.add`. The gate hands over the signed, server-derived params (the label and
 * the hash of the registration options the person approved); the registration response comes from the request body.
 * The ceremony must have been issued with exactly the approved options, and the action is spent in the same
 * transaction that stores the credential and starts the 24-hour `secret.reveal` hold.
 */
async function addPasskey(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const { userId, sessionIdHash } = sessionOf(req);
  const action = requireAction(req, "passkey.add");
  const params = (action.params ?? {}) as { label?: unknown; options_hash?: unknown };
  const response = asRegistration((req.body as { registration?: unknown } | null)?.registration);
  const challenge = challengeFrom(response);
  const ch = await consumeChallenge(ctx, challenge, "register", { sessionHash: sessionIdHash });
  if (!ch || ch.user_id !== userId) throw new HttpError(400, "invalid_challenge");
  let reg;
  try { reg = await verifyRegistration(ctx, response, challenge); } catch { throw new HttpError(400, "registration_failed"); }
  const row = await withUser(ctx.runtime, userId, async (c) => {
    await assertNotHeld(ctx, c, userId, "passkey.add");
    const issued = await challengeOptionsHash(c, ch.id, userId);
    const signed = typeof params.options_hash === "string" && /^[0-9a-f]{64}$/.test(params.options_hash) ? Buffer.from(params.options_hash, "hex") : null;
    if (!issued || !signed || !safeEqual(issued, signed)) throw new HttpError(409, "params_changed");
    await assertCredentialAllowed(c, userId, reg);
    // Single use: a second add with this action (a race, or a retry after success) gets 409 and its insert rolls back.
    await markExecuted(c, action);
    const { id, row } = await insertPasskey(ctx, c, userId, reg, { label: typeof params.label === "string" ? params.label : undefined });
    const now = ctx.clock.now();
    await c.query("insert into action_holds (user_id, scope, until, created_at) values ($1,'secret.reveal',$2,$3)", [userId, new Date(now.getTime() + SECRET_REVEAL_HOLD_MS), now]);
    await auditUser(ctx, c, userId, "auth.passkey.added", { resourceKind: "passkey", resourceId: id, detail: { via: "step_up", action: action.id, be: reg.backupEligible, bs: reg.backupState, alg: reg.alg } });
    await notifyUser(ctx, c, userId, { kind: "passkey.added", dedupeKey: `passkey-added:${id}`, subject: "A passkey was added to your Mosshatch account", text: "A passkey was added. Secret reveals are on hold for 24 hours. If this was not you, sign out everywhere and review your passkeys." });
    return row;
  });
  const cookie = await rotateSessions(ctx, req, userId, req.principal.authCredentialId);
  return json({ credential: passkeyView(row) }, 201, { cookies: [cookie] });
}

/* ---- recovery codes ---- */

async function regenerateCodes(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const { userId } = sessionOf(req);
  const codes = await withUser(ctx.runtime, userId, async (c) => {
    await assertNoRecoveryActivity(ctx, c, userId);
    const had = await unusedRecoveryCodes(c, userId);
    const list = await issueRecoveryCodes(ctx, c, userId);
    await auditUser(ctx, c, userId, "auth.recovery_codes.issued", { detail: { replaced: had } });
    await notifyUser(ctx, c, userId, { kind: "codes.regenerated", dedupeKey: `codes:${crypto.randomUUID()}`, subject: "Your recovery codes were replaced", text: "Ten new recovery codes were issued and the old ones stopped working. If this was not you, review your account at once." });
    return list;
  });
  return json({ recoveryCodes: codes }, 201);
}

export const accountRoutes: Route[] = [
  { method: "POST", path: "/api/v1/auth/logout", principals: ["session"], handler: logout, tag: "auth" },
  { method: "POST", path: "/api/v1/auth/sessions/revoke-all", principals: ["session"], handler: revokeAll, tag: "auth" },
  { method: "GET", path: "/api/v1/me", principals: ["session"], handler: me, tag: "auth" },
  { method: "GET", path: "/api/v1/passkeys", principals: ["session"], handler: listPasskeys, tag: "auth" },
  { method: "DELETE", path: "/api/v1/passkeys/:id", principals: ["session"], handler: deletePasskey, tag: "auth" },
  { method: "POST", path: "/api/v1/passkeys", principals: ["session"], stepUp: "passkey.add", handler: addPasskey, tag: "auth" },
  { method: "POST", path: "/api/v1/recovery-codes", principals: ["session"], handler: regenerateCodes, tag: "auth" },
];
