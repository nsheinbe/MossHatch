import { z } from "zod";
import { withNoUser, withUser } from "@mosshatch/db";
import type { HandlerReq, HandlerResult, Route } from "../http/types.ts";
import { HttpError, json } from "../http/router.ts";
import { clearCookie, cookieHeader, createSession, PRE_AUTH_COOKIE, SESSION_COOKIE } from "../http/session.ts";
import { sendMail } from "../email.ts";
import { verifyRegistration } from "../webauthn.ts";
import { TICKET_TTL_S, auditUser, emailSchema, newPre, parseBody, preHashFrom, rateLimited } from "./common.ts";
import { checkEmailCode, issueRecoveryCodes, putEmailCode } from "./codes.ts";
import { asRegistration, challengeFrom, consumeChallenge, issueRegistrationOptions } from "./ceremony.ts";
import { assertCredentialAllowed, insertPasskey, passkeyView } from "./credentials.ts";
import { classAAllowed } from "./mail.ts";
import { completeRecovery } from "./recovery.ts";
import { requireInvite, useInvite } from "../waitlist/gate.ts";

export const SIGNUP_CODE_TTL_MS = 15 * 60_000;

/**
 * Sign-up start: the same 202 whether or not the address has an account. A live account gets no mail here (the
 * per-address counters still tick, so the counters cannot be used to tell). The pending row is replaced by every start.
 */
async function signupStart(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const { email } = parseBody(z.object({ email: emailSchema }), req.body);
  const gate = await classAAllowed(ctx, email, "signup");
  if (!gate.allowed) throw rateLimited(gate.retryAfterSeconds);
  await requireInvite(req, email);   // invite-only rollout (waitlist/gate.ts); a no-op unless MH_INVITE_ONLY is on
  const pendingId = (await withNoUser(ctx.runtime, (c) => c.query("select auth2_signup_pending($1,$2) as id", [email, ctx.clock.now()]))).rows[0].id as string | null;
  if (pendingId) {
    await withUser(ctx.runtime, pendingId, async (c) => {
      const { id, code } = await putEmailCode(ctx, c, "signup", email, pendingId, SIGNUP_CODE_TTL_MS);
      await sendMail(c, ctx.email, {
        dedupeKey: `signup-code:${id}`, kind: "signup.code", userId: pendingId, to: [email], klass: "A", subject: "Your Mosshatch sign-up code",
        text: `Your sign-up code is ${code}. It works for 15 minutes and dies after 5 wrong tries. If you did not ask for it, ignore this message.`,
      });
    });
  }
  return json({ ok: true }, 202);
}

/** Verify the emailed code, activate the pending row, and hand back registration options bound to a challenge and the pre-auth cookie. */
async function signupVerify(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const b = parseBody(z.object({ email: emailSchema, code: z.string().trim().min(4).max(16) }), req.body);
  const pending = (await withNoUser(ctx.runtime, (c) => c.query("select * from auth2_pending_by_email($1,$2)", [b.email, ctx.clock.now()]))).rows[0] as { id: string } | undefined;
  const pre = newPre();
  const out = await (async () => {
    if (!pending) return null;
    // The code check (which burns a try) commits on its own; activation is a separate transaction.
    const chk = await withNoUser(ctx.runtime, (c) => checkEmailCode(ctx, c, "signup", b.email, b.code, { userId: pending.id }));
    if (!chk.ok) return null;
    return withUser(ctx.runtime, pending.id, async (c) => {
      const now = ctx.clock.now();
      const u = await c.query("update users set status = 'active', email_verified_at = coalesce(email_verified_at, $2), expires_at = null where id = $1 and status in ('pending','active') returning id, webauthn_user_handle", [pending.id, now]);
      if (u.rowCount !== 1) return null;
      await useInvite(req, c, b.email, pending.id);   // uses the invite in this activation transaction (no-op when invite-only is off)
      await c.query("insert into notification_addresses (user_id, address, kind, verified_at, created_at) select $1::uuid,$2::citext,'login',$3::timestamptz,$3::timestamptz where not exists (select 1 from notification_addresses where user_id = $1::uuid and address = $2::citext and removed_at is null)", [pending.id, b.email, now]);
      await auditUser(ctx, c, pending.id, "auth.signup.verified", { resourceKind: "user", resourceId: pending.id });
      return issueRegistrationOptions(ctx, c, { id: pending.id, email: b.email, handle: Buffer.from(u.rows[0].webauthn_user_handle) }, { preHash: pre.hash });
    });
  })();
  if (!out) throw new HttpError(401, "invalid_code");
  return json({ options: out }, 200, { cookies: [cookieHeader(PRE_AUTH_COOKIE, pre.value, TICKET_TTL_S)] });
}

/**
 * New registration options. A signed-in user gets options for adding a passkey (the challenge is bound to the session
 * hash; the add itself is `POST /passkeys`). Otherwise the holder of a registration ticket (the pre-auth cookie set by
 * a verified sign-up or a redeemed recovery) gets fresh options. An unverified account has neither.
 */
async function registerOptions(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  if (req.principal.kind === "session" && req.principal.userId && req.principal.sessionIdHash) {
    const userId = req.principal.userId;
    const options = await withUser(ctx.runtime, userId, async (c) => {
      const u = (await c.query("select id, email::text as email, webauthn_user_handle, status from users where id = $1", [userId])).rows[0];
      if (!u || u.status !== "active") throw new HttpError(403, "not_verified");
      return issueRegistrationOptions(ctx, c, { id: u.id, email: u.email, handle: Buffer.from(u.webauthn_user_handle) }, { sessionHash: req.principal.sessionIdHash });
    });
    return json({ options });
  }
  const preHash = preHashFrom(req.request);
  if (!preHash) throw new HttpError(401, "unauthorized");
  const t = (await withNoUser(ctx.runtime, (c) => c.query("select * from auth2_ticket_lookup($1,$2)", [preHash, ctx.clock.now()]))).rows[0] as { user_id: string; recovery_id: string | null } | undefined;
  if (!t) throw new HttpError(401, "unauthorized");
  const options = await withUser(ctx.runtime, t.user_id, async (c) => {
    const u = (await c.query("select id, email::text as email, webauthn_user_handle, status, email_verified_at from users where id = $1", [t.user_id])).rows[0];
    if (!u || u.status !== "active" || !u.email_verified_at) throw new HttpError(403, "not_verified");
    return issueRegistrationOptions(ctx, c, { id: u.id, email: u.email, handle: Buffer.from(u.webauthn_user_handle) }, { preHash, recoveryId: t.recovery_id ?? undefined });
  });
  return json({ options });
}

/**
 * Complete the first credential of an account (after sign-up) or of a recovery. Needs the pre-auth cookie that the
 * challenge was bound to. The challenge is consumed first, in its own committed statement, so a failed try also burns it.
 */
async function registerVerify(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const preHash = preHashFrom(req.request);
  if (!preHash) throw new HttpError(401, "unauthorized");
  const body = req.body as { response?: unknown } | null;
  const response = asRegistration(body?.response);
  const challenge = challengeFrom(response);
  const ch = await consumeChallenge(ctx, challenge, "register", { preHash });
  if (!ch || !ch.user_id) throw new HttpError(401, "invalid_challenge");
  const userId = ch.user_id;
  let reg;
  try { reg = await verifyRegistration(ctx, response, challenge); } catch { throw new HttpError(400, "registration_failed"); }

  const result = await withUser(ctx.runtime, userId, async (c) => {
    const u = (await c.query("select id, email::text as email, status, email_verified_at from users where id = $1 for update", [userId])).rows[0];
    // An unverified (pending) account never reaches a credential, even if a challenge row somehow existed.
    if (!u || u.status !== "active" || !u.email_verified_at) throw new HttpError(403, "not_verified");
    await assertCredentialAllowed(c, userId, reg);
    let holdUntil: Date | null = null;
    if (ch.recovery_id) {
      holdUntil = (await completeRecovery(ctx, c, userId, ch.recovery_id)).holdUntil;
    } else {
      const live = Number((await c.query("select count(*) as n from passkeys where user_id = $1 and revoked_at is null", [userId])).rows[0].n);
      if (live > 0) throw new HttpError(409, "already_registered");
    }
    const { id, row } = await insertPasskey(ctx, c, userId, reg, { label: "Passkey", recoveryId: ch.recovery_id });
    const hadCodes = Number((await c.query("select count(*) as n from recovery_codes where user_id = $1", [userId])).rows[0].n) > 0;
    const recoveryCodes = hadCodes ? undefined : await issueRecoveryCodes(ctx, c, userId);
    await auditUser(ctx, c, userId, "auth.passkey.added", { resourceKind: "passkey", resourceId: id, detail: { via: ch.recovery_id ? "recovery" : "signup", be: reg.backupEligible, bs: reg.backupState, alg: reg.alg } });
    return { email: u.email as string, id, row, recoveryCodes, holdUntil };
  });

  await withNoUser(ctx.runtime, (c) => c.query("select auth2_ticket_kill($1)", [preHash]));
  const s = await createSession(ctx, userId, { credentialId: reg.credentialId, ipPrefix: req.ipPrefix, uaFamily: req.uaFamily });
  return json(
    { user: { id: userId, email: result.email }, credential: passkeyView(result.row), recoveryCodes: result.recoveryCodes, holdUntil: result.holdUntil?.toISOString() ?? null },
    201, { cookies: [s.cookie, clearCookie(PRE_AUTH_COOKIE)] },
  );
}

export const signupRoutes: Route[] = [
  { method: "POST", path: "/api/v1/auth/signup/start", principals: ["anonymous"], handler: signupStart, tag: "auth" },
  { method: "POST", path: "/api/v1/auth/signup/verify", principals: ["anonymous"], handler: signupVerify, tag: "auth" },
  { method: "POST", path: "/api/v1/auth/register/options", principals: ["anonymous", "session"], handler: registerOptions, tag: "auth" },
  { method: "POST", path: "/api/v1/auth/register/verify", principals: ["anonymous"], handler: registerVerify, tag: "auth" },
];
void SESSION_COOKIE;
