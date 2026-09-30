import { withNoUser, withUser, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import type { HandlerReq, HandlerResult, Route } from "../http/types.ts";
import { HttpError, json } from "../http/router.ts";
import { clearCookie, cookieHeader, createSession, parseCookies, PRE_AUTH_COOKIE, revokeSession, SESSION_COOKIE } from "../http/session.ts";
import { hit, type Limit } from "../ratelimit.ts";
import { verifyAssertion } from "../webauthn.ts";
import { b64u, safeEqual, sha256 } from "../util/bytes.ts";
import { LOGIN_CHALLENGE_TTL_S, SUSPENSION_MS, auditUser, newPre, preHashFrom, rateLimited } from "./common.ts";
import { asAssertion, challengeFrom, consumeChallenge, issueLoginOptions } from "./ceremony.ts";
import { cancelOpenOnSignIn, undoRecovery } from "./recovery.ts";
import { notifyUser } from "./mail.ts";

/** Only issuing a challenge is limited here. Nothing in this file touches a cancel, revoke or freeze path. */
export const LOGIN_OPTIONS_SOURCE: Limit = { bucket: "login.options.src", max: 300, windowSeconds: 3600 };

async function loginOptions(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const lim = await withNoUser(ctx.runtime, (c) => hit(ctx, c, req.ipPrefix, LOGIN_OPTIONS_SOURCE));
  if (!lim.allowed) throw rateLimited(lim.retryAfterSeconds);
  const pre = newPre();
  const options = await issueLoginOptions(ctx, pre.hash);
  return json({ options }, 200, { cookies: [cookieHeader(PRE_AUTH_COOKIE, pre.value, LOGIN_CHALLENGE_TTL_S)] });
}

async function raiseAlert(c: PoolClient, severity: "warn" | "page", kind: string, userId: string, detail: Record<string, unknown>) {
  await c.query("insert into alerts (severity, kind, subject, detail) values ($1,$2,$3,$4)", [severity, kind, userId, detail]);
}

/** Record a failure on the user's chain (committed) and answer 401 with one code for every cause. */
async function fail(ctx: AppContext, userId: string | null, reason: string, extra?: { alert?: { severity: "warn" | "page"; kind: string }; passkeyId?: string }): Promise<never> {
  if (userId) {
    await withUser(ctx.runtime, userId, async (c) => {
      if (extra?.alert) await raiseAlert(c, extra.alert.severity, extra.alert.kind, userId, { passkey: extra.passkeyId ?? null });
      await auditUser(ctx, c, userId, "auth.login.failed", { resourceKind: extra?.passkeyId ? "passkey" : undefined, resourceId: extra?.passkeyId, detail: { reason } });
    }).catch(() => undefined);
  }
  throw new HttpError(401, "login_failed");
}

async function revokePresentedSession(ctx: AppContext, request: Request): Promise<void> {
  const v = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  if (!v) return;
  const raw = Buffer.from(v, "base64url");
  if (raw.length !== 32) return;
  const hash = sha256(raw);
  const row = (await withNoUser(ctx.runtime, (c) => c.query("select user_id from auth_session_get($1)", [hash]))).rows[0];
  if (row) await revokeSession(ctx, row.user_id, hash);
}

async function loginVerify(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const preHash = preHashFrom(req.request);
  if (!preHash) throw new HttpError(401, "pre_auth_required");
  const response = asAssertion((req.body as { response?: unknown } | null)?.response);
  const challenge = challengeFrom(response);
  // Consumed before anything is verified, so a failed try burns the challenge too.
  const ch = await consumeChallenge(ctx, challenge, "login", { preHash });
  if (!ch) throw new HttpError(401, "login_failed");

  const cred = (await withNoUser(ctx.runtime, (c) => c.query("select * from auth_passkey_lookup($1)", [response.id]))).rows[0];
  if (!cred) return fail(ctx, null, "unknown_credential");
  const userId = cred.user_id as string;
  const passkeyId = cred.id as string;
  if (cred.user_status !== "active") return fail(ctx, userId, "inactive_user", { passkeyId });
  if (cred.revoked_at) return fail(ctx, userId, "revoked", { passkeyId });

  const now = ctx.clock.now();
  const extra = (await withUser(ctx.runtime, userId, (c) => c.query("select suspended_at, suspended_by_recovery_id from passkeys where id = $1", [passkeyId]))).rows[0];
  let restoreRecoveryId: string | null = null;
  if (cred.suspended_at) {
    // Only a credential a recovery suspended, inside its 30 days, can come back; that sign-in is the undo.
    const within = extra?.suspended_by_recovery_id && new Date(cred.suspended_at).getTime() + SUSPENSION_MS > now.getTime();
    if (!within) return fail(ctx, userId, "suspended", { passkeyId });
    restoreRecoveryId = extra.suspended_by_recovery_id as string;
  }

  const handle = response.response.userHandle;
  if (!handle || !safeEqual(Buffer.from(handle, "base64url"), Buffer.from(cred.webauthn_user_handle))) return fail(ctx, userId, "user_handle", { passkeyId });
  if (cred.hardened_mode && cred.backup_eligible) return fail(ctx, userId, "hardened_mode", { passkeyId });

  let verified;
  try {
    // signCount 0: the library's own counter rule would apply to every credential; ours applies only when backup_eligible = 0.
    verified = await verifyAssertion(ctx, response, challenge, { credentialId: response.id, publicKey: Buffer.from(cred.public_key), signCount: 0, transports: cred.transports, backupEligible: cred.backup_eligible });
  } catch { return fail(ctx, userId, "assertion", { passkeyId }); }
  if (!verified.userVerified) return fail(ctx, userId, "user_verification", { passkeyId });

  if (verified.backupEligible !== cred.backup_eligible) {
    return fail(ctx, userId, "backup_eligible_flip", { alert: { severity: "page", kind: "auth.backup_eligible_flip" }, passkeyId });
  }
  const stored = Number(cred.sign_count);
  if (!cred.backup_eligible && (verified.newCounter > 0 || stored > 0) && verified.newCounter <= stored) {
    return fail(ctx, userId, "sign_count", { alert: { severity: "page", kind: "auth.sign_count_regression" }, passkeyId });
  }

  // Everything below commits together.
  const newDevice = await withUser(ctx.runtime, userId, async (c) => {
    const seen = await c.query("select 1 from sessions where user_id = $1 and ip_prefix is not distinct from $2 and ua_family is not distinct from $3 limit 1", [userId, req.ipPrefix, req.uaFamily]);
    await c.query("update passkeys set sign_count = $2, backup_state = $3, last_used_at = $4 where id = $1", [passkeyId, verified.newCounter, verified.backupState, now]);
    if (cred.backup_state && !verified.backupState) {
      await raiseAlert(c, "warn", "auth.backup_state_cleared", userId, { passkey: passkeyId });
      await auditUser(ctx, c, userId, "auth.passkey.backup_state_cleared", { resourceKind: "passkey", resourceId: passkeyId });
    }
    if (restoreRecoveryId) await undoRecovery(ctx, c, userId, restoreRecoveryId);
    // Every legitimate sign-in cancels a request still open, the undo sign-in included (ST-46).
    await cancelOpenOnSignIn(ctx, c, userId);
    // Unfreezing happens only here, after a valid assertion. Paused tokens stay paused; each resumes through agent.token.widen.
    const un = await c.query("update users set frozen_at = null where id = $1 and frozen_at is not null returning id", [userId]);
    if (un.rowCount === 1) await auditUser(ctx, c, userId, "auth.unfreeze", { resourceKind: "user", resourceId: userId });
    await auditUser(ctx, c, userId, "auth.login", { resourceKind: "passkey", resourceId: passkeyId, detail: { be: verified.backupEligible, bs: verified.backupState, restored: !!restoreRecoveryId } });
    return (seen.rowCount ?? 0) === 0;
  });

  await revokePresentedSession(ctx, req.request);
  const s = await createSession(ctx, userId, { credentialId: response.id, ipPrefix: req.ipPrefix, uaFamily: req.uaFamily });
  if (newDevice) {
    await withUser(ctx.runtime, userId, (c) => notifyUser(ctx, c, userId, {
      kind: "login.new_device", dedupeKey: `login-new:${b64u(s.idHash).slice(0, 16)}`, subject: "New sign-in to your Mosshatch account",
      text: "Your account was signed in to from a device or network we have not seen before. If this was not you, review your passkeys and sessions.",
    }));
  }
  const u = (await withUser(ctx.runtime, userId, (c) => c.query("select id, email::text as email, frozen_at from users where id = $1", [userId]))).rows[0];
  return json({ user: { id: u.id, email: u.email }, restored: !!restoreRecoveryId }, 200, { cookies: [s.cookie, clearCookie(PRE_AUTH_COOKIE)] });
}

export const loginRoutes: Route[] = [
  { method: "POST", path: "/api/v1/auth/login/options", principals: ["anonymous"], handler: loginOptions, tag: "auth" },
  { method: "POST", path: "/api/v1/auth/login/verify", principals: ["anonymous"], handler: loginVerify, tag: "auth" },
];
