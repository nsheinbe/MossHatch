import crypto from "node:crypto";
import { z } from "zod";
import { withNoUser, withUser, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import type { HandlerReq, HandlerResult, Route } from "../http/types.ts";
import { HttpError, json } from "../http/router.ts";
import { cookieHeader, PRE_AUTH_COOKIE } from "../http/session.ts";
import { hit, type Limit } from "../ratelimit.ts";
import { sendMail } from "../email.ts";
import { COOLING_OFF_MS, DAY, HOLD_MS, TICKET_TTL_S, auditUser, emailSchema, newPre, parseBody, rateLimited } from "./common.ts";
import { checkEmailCode, consumeCode, hasLiveCode, putEmailCode, spendRecoveryCode } from "./codes.ts";
import { issueRegistrationOptions } from "./ceremony.ts";
import { requireIndependentChannel } from "./credentials.ts";
import { classAAllowed, notifyUser } from "./mail.ts";
import { cancelRequest, emailActionUrl, mintEmailActionToken, runEmailAction } from "./email-actions.ts";
import { sendAllHomeIn } from "../agents/sendhome.ts";

export const RECOVERY_START_SOURCE: Limit = { bucket: "recovery.start.src", max: 10, windowSeconds: 3600 };
export const RECOVERY_MAIL_ACCOUNT: Limit = { bucket: "recovery.mail.acct", max: 1, windowSeconds: 900 };
export const RECOVERY_CODE_ATTEMPTS: Limit = { bucket: "recovery.code.acct", max: 10, windowSeconds: 3600 };
export const RECOVERY_EMAIL_CODE_TTL_MS = 24 * 3600_000;

export type RecoveryPath = "codes_email" | "email_only";

interface RequestRow { id: string; path: RecoveryPath; status: string; cooling_off_until: Date | null; hold_until: Date | null; created_at: Date; completed_at: Date | null }

/** A request whose hold ended is completed; done lazily so nothing depends on a sweeper having run. */
export async function settleRecoveries(ctx: AppContext, c: PoolClient, userId: string): Promise<void> {
  await c.query("update recovery_requests set status = 'completed', updated_at = $2 where user_id = $1 and status = 'holding' and hold_until <= $2", [userId, ctx.clock.now()]);
}

async function currentRequest(c: PoolClient, userId: string): Promise<RequestRow | null> {
  return ((await c.query("select * from recovery_requests where user_id = $1 and status in ('pending','cooling_off','holding') order by created_at desc limit 1", [userId])).rows[0] as RequestRow | undefined) ?? null;
}

/** The banner shown at every sign-in while a request is open or its hold runs. */
export async function recoveryBanner(ctx: AppContext, c: PoolClient, userId: string) {
  await settleRecoveries(ctx, c, userId);
  const r = await currentRequest(c, userId);
  if (!r) return null;
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return { id: r.id, status: r.status, path: r.path, startedAt: iso(r.created_at), coolingOffUntil: iso(r.cooling_off_until), holdUntil: iso(r.hold_until) };
}

/* ---- start ---- */

const startBody = z.object({ email: emailSchema, path: z.enum(["codes_email", "email_only"]) });

async function startHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const b = parseBody(startBody, req.body);
  // Per source prefix. This blocks starts only; redeem and cancel never consult it.
  const src = await withNoUser(ctx.runtime, (c) => hit(ctx, c, req.ipPrefix, RECOVERY_START_SOURCE));
  if (!src.allowed) throw rateLimited(src.retryAfterSeconds);
  const u = (await withNoUser(ctx.runtime, (c) => c.query("select * from auth_user_by_email($1)", [b.email]))).rows[0];
  if (u && u.status === "active") await startFor(ctx, u.id, b.email, b.path);
  // Same status and body whether or not the address has an account.
  return json({ ok: true }, 202);
}

async function startFor(ctx: AppContext, userId: string, email: string, path: RecoveryPath): Promise<void> {
  await withUser(ctx.runtime, userId, async (c) => {
    await settleRecoveries(ctx, c, userId);
    const now = ctx.clock.now();
    let r = await currentRequest(c, userId);
    if (!r) {
      if (path === "email_only" && !(await requireIndependentChannel(ctx, c, userId))) {
        await auditUser(ctx, c, userId, "auth.recovery.refused", { detail: { path, reason: "no_second_channel" } });
        await notifyUser(ctx, c, userId, { kind: "recovery.unavailable", dedupeKey: `recovery-refused:${crypto.randomUUID()}`, subject: "A recovery request was refused",
          text: "Someone asked to recover your Mosshatch account by email alone. That path is not available because your account has no verified second address on a different mail domain. If this was you, use a recovery code with an emailed code instead." });
        return;
      }
      const cooling = path === "email_only" ? new Date(now.getTime() + COOLING_OFF_MS) : null;
      const ins = await c.query(
        "insert into recovery_requests (user_id, path, status, cooling_off_until, created_at, updated_at) values ($1,$2,$3,$4,$5,$5) on conflict do nothing returning *",
        [userId, path, path === "email_only" ? "cooling_off" : "pending", cooling, now],
      );
      r = (ins.rows[0] as RequestRow | undefined) ?? (await currentRequest(c, userId));
      if (!r) return;
      if (ins.rowCount === 1) {
        await auditUser(ctx, c, userId, "auth.recovery.started", { resourceKind: "recovery_request", resourceId: r.id, detail: { path } });
        const until = (cooling ?? now).getTime() + DAY;
        const { token } = await mintEmailActionToken(ctx, c, { userId, purpose: "recovery_cancel", eventId: r.id, ttlMs: until - now.getTime() });
        // Always sent at once: neither the class A nor the class B bucket can hold this notice back.
        await notifyUser(ctx, c, userId, {
          kind: "recovery.started", immediate: true, dedupeKey: `recovery-start:${r.id}`, subject: "Someone started recovery on your Mosshatch account",
          text: `Recovery was started on your account (${path === "email_only" ? "email only, with a 72 hour wait" : "recovery code and emailed code"}). If this was not you, cancel it now: ${emailActionUrl(ctx, token)}\nSigning in with a passkey also cancels it.`,
        });
      }
    }
    if (r.status === "holding") return;
    const ready = r.status === "pending" || (r.status === "cooling_off" && r.cooling_off_until !== null && new Date(r.cooling_off_until) <= now);
    if (!ready) return;
    // The emailed code goes to the login address only. A live code is never replaced, so a flood of starts cannot rotate it.
    if (await hasLiveCode(ctx, c, "recovery", email, userId)) return;
    const acct = await withNoUser(ctx.runtime, (cc) => hit(ctx, cc, userId, RECOVERY_MAIL_ACCOUNT));
    if (!acct.allowed) return;
    if (!(await classAAllowed(ctx, email, "recovery")).allowed) return;
    const { id, code } = await putEmailCode(ctx, c, "recovery", email, userId, RECOVERY_EMAIL_CODE_TTL_MS);
    await sendMail(c, ctx.email, {
      dedupeKey: `recovery-code:${id}`, kind: "recovery.code", userId, to: [email], klass: "A", subject: "Your Mosshatch recovery code",
      text: `Your recovery code is ${code}. It works for 24 hours and dies after 5 wrong tries. If you did not ask for it, ignore this message.`,
    });
  });
}

/* ---- redeem ---- */

const redeemBody = z.object({ email: emailSchema, code: z.string().trim().min(4).max(16), recoveryCode: z.string().max(64).optional() });

/**
 * Redeem the emailed code (with a recovery code on the codes_email path) and receive registration options for the
 * new credential. No account or source limit applies here; the only counters are the code's own five tries and the
 * ten-an-hour recovery-code bucket, which guards the recovery code and never touches passkey sign-in.
 */
async function redeemHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const b = parseBody(redeemBody, req.body);
  const u = (await withNoUser(ctx.runtime, (c) => c.query("select * from auth_user_by_email($1)", [b.email]))).rows[0];
  if (!u || u.status !== "active") throw new HttpError(401, "invalid_code");
  const pre = newPre();
  const out = await withUser(ctx.runtime, u.id, async (c) => {
    await settleRecoveries(ctx, c, u.id);
    const now = ctx.clock.now();
    const r = await currentRequest(c, u.id);
    if (!r || !(r.status === "pending" || (r.status === "cooling_off" && r.cooling_off_until !== null && new Date(r.cooling_off_until) <= now))) return { fail: true as const };
    const chk = await checkEmailCode(ctx, c, "recovery", b.email, b.code, { userId: u.id, consume: false });
    if (!chk.ok) return { fail: true as const };
    if (r.path === "codes_email") {
      if (!b.recoveryCode) return { fail: true as const };
      const lim = await withNoUser(ctx.runtime, (cc) => hit(ctx, cc, u.id, RECOVERY_CODE_ATTEMPTS));
      if (!lim.allowed) return { limited: lim.retryAfterSeconds };
      if (!(await spendRecoveryCode(ctx, c, u.id, b.recoveryCode))) return { fail: true as const };
    }
    if (!(await consumeCode(ctx, c, chk.codeId))) return { fail: true as const };
    const options = await issueRegistrationOptions(ctx, c, { id: u.id, email: b.email, handle: Buffer.from(u.webauthn_user_handle) }, { preHash: pre.hash, recoveryId: r.id });
    await auditUser(ctx, c, u.id, "auth.recovery.redeemed", { resourceKind: "recovery_request", resourceId: r.id, detail: { path: r.path } });
    return { options };
  });
  if ("limited" in out && out.limited !== undefined) throw rateLimited(out.limited);
  if (!("options" in out) || !out.options) throw new HttpError(401, "invalid_code");
  return json({ options: out.options }, 200, { cookies: [cookieHeader(PRE_AUTH_COOKIE, pre.value, TICKET_TTL_S)] });
}

/* ---- cancel ---- */

const cancelBody = z.object({ token: z.string().max(128).optional() }).optional();

/**
 * Cancel with the emailed link token, or from a signed-in session. Never rate limited: it consults no account or source counter.
 */
async function cancelHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const b = parseBody(cancelBody, req.body ?? undefined);
  if (b?.token) {
    const res = await runEmailAction(ctx, b.token, { expectPurpose: "recovery_cancel" });
    if (!res) throw new HttpError(404, "not_found");
    return json({ ok: true, cancelled: res.changed });
  }
  if (req.principal.kind !== "session" || !req.principal.userId) throw new HttpError(401, "unauthorized");
  const userId = req.principal.userId;
  const changed = await withUser(ctx.runtime, userId, async (c) => {
    const r = (await c.query("select id from recovery_requests where user_id = $1 and status in ('pending','cooling_off') order by created_at desc limit 1", [userId])).rows[0];
    return r ? cancelRequest(ctx, c, userId, r.id, "session") : false;
  });
  return json({ ok: true, cancelled: changed });
}

/* ---- completion (called from register/verify) and undo (called from login/verify) ---- */

/**
 * The new credential exists: open the hold, revoke every session and binding, suspend (not delete) the old credentials.
 * Runs before the new credential is inserted, inside the registration transaction, so all of it commits or none does.
 */
export async function completeRecovery(ctx: AppContext, c: PoolClient, userId: string, requestId: string): Promise<{ holdUntil: Date; path: RecoveryPath }> {
  const now = ctx.clock.now();
  const cur = (await c.query("select * from recovery_requests where id = $1 and user_id = $2 for update", [requestId, userId])).rows[0] as RequestRow | undefined;
  if (!cur || !["pending", "cooling_off"].includes(cur.status)) throw new HttpError(409, "recovery_not_open");
  if (cur.path === "email_only" && (!cur.cooling_off_until || new Date(cur.cooling_off_until) > now)) throw new HttpError(409, "recovery_not_open");
  const holdUntil = new Date(now.getTime() + HOLD_MS[cur.path]);
  const upd = await c.query("update recovery_requests set status = 'holding', completed_at = $3, hold_until = $4, updated_at = $3 where id = $1 and user_id = $2 and status in ('pending','cooling_off') returning id", [requestId, userId, now, holdUntil]);
  if (upd.rowCount !== 1) throw new HttpError(409, "recovery_not_open");
  await c.query("insert into action_holds (user_id, scope, until, recovery_id, created_at) values ($1,'all_held',$2,$3,$4)", [userId, holdUntil, requestId, now]);
  const susp = await c.query("update passkeys set suspended_at = $2, suspended_by_recovery_id = $3 where user_id = $1 and revoked_at is null and suspended_at is null", [userId, now, requestId]);
  const sess = await c.query("update sessions set revoked_at = $2 where user_id = $1 and revoked_at is null", [userId, now]);
  // Grants approved but not yet claimed would otherwise outlive the recovery: a device grant approved and not yet polled for mints a
  // command-line token at the next poll, and an open consent issues a grant at its code exchange (ST-48). Both are denied before the
  // bindings are revoked, in the lock order those claim paths use (grant first, then binding).
  const devices = await c.query("update device_requests set state = 'denied', decided_at = $2 where user_id = $1 and state = 'approved'", [userId, now]);
  const consents = await c.query("update oauth_authorizations set status = 'denied', decided_at = $2 where user_id = $1 and status in ('pending','approved')", [userId, now]);
  const bind = await c.query("update bindings set revoked_at = $2 where user_id = $1 and revoked_at is null", [userId, now]);
  await auditUser(ctx, c, userId, "auth.recovery.completed", { resourceKind: "recovery_request", resourceId: requestId, detail: { path: cur.path, suspended: susp.rowCount, sessions: sess.rowCount, bindings: bind.rowCount, device_grants: devices.rowCount, consents: consents.rowCount } });
  await notifyUser(ctx, c, userId, {
    kind: "recovery.completed", immediate: true, dedupeKey: `recovery-done:${requestId}`, subject: "Your Mosshatch account was recovered",
    text: `Recovery finished and a new passkey was added. Sensitive actions stay on hold until ${holdUntil.toISOString()}. Your old passkeys are suspended for 30 days: if this was not you, sign in with an old passkey to undo it.`,
  });
  return { holdUntil, path: cur.path };
}

/**
 * An assertion from a credential that a recovery suspended: restore what it suspended, revoke what it created, and apply the hold again.
 * "What it created" is every passkey created since that recovery completed: the recovery's own credential, passkeys that
 * credential's sessions added, and the credentials of any later recovery (all of which hang off it). Later recoveries are
 * cancelled too. Also revokes every session (the caller issues a fresh one afterwards and cancels any request still open) and
 * every token the recovery's sessions enabled (agent and CLI tokens, connected apps, unclaimed grants, pending requests).
 */
export async function undoRecovery(ctx: AppContext, c: PoolClient, userId: string, requestId: string): Promise<void> {
  const now = ctx.clock.now();
  const req = (await c.query("select * from recovery_requests where id = $1 and user_id = $2 for update", [requestId, userId])).rows[0] as RequestRow | undefined;
  const since = req?.completed_at ? new Date(req.completed_at) : null;
  // The credentials this recovery suspended predate it; everything else created since it completed is revoked.
  const revoked = await c.query(
    `update passkeys set revoked_at = $3 where user_id = $1 and revoked_at is null and suspended_by_recovery_id is distinct from $2
       and (created_by_recovery_id = $2 or ($4::timestamptz is not null and created_at >= $4::timestamptz))`,
    [userId, requestId, now, since]);
  const restored = await c.query("update passkeys set suspended_at = null, suspended_by_recovery_id = null where user_id = $1 and suspended_by_recovery_id = $2 and suspended_at is not null", [userId, requestId]);
  await c.query("update sessions set revoked_at = $2 where user_id = $1 and revoked_at is null", [userId, now]);
  // What the recovery's sessions enabled beyond passkeys: agent and CLI tokens, connected apps, their refresh tokens, device
  // grants and consents not yet claimed, and pending requests. The completion revoked every binding, so every live one was
  // created after it; the "Send all visitors home" path revokes them in this transaction.
  const home = await sendAllHomeIn(ctx, c, userId, "recovery_undone", { notify: false });
  let later = 0;
  if (since) {
    const l = await c.query("update recovery_requests set status = 'cancelled', cancelled_by = 'credential_restore', updated_at = $3 where user_id = $1 and id <> $2 and status in ('holding','completed') and completed_at >= $4", [userId, requestId, now, since]);
    later = l.rowCount ?? 0;
  }
  if (req) {
    await c.query("update recovery_requests set status = 'cancelled', cancelled_by = 'credential_restore', updated_at = $3 where id = $1 and user_id = $2 and status in ('pending','cooling_off','holding','completed')", [requestId, userId, now]);
    await c.query("insert into action_holds (user_id, scope, until, recovery_id, created_at) values ($1,'all_held',$2,$3,$4)", [userId, new Date(now.getTime() + HOLD_MS[req.path]), requestId, now]);
  }
  await auditUser(ctx, c, userId, "auth.recovery.undone", { resourceKind: "recovery_request", resourceId: requestId, detail: { restored: restored.rowCount, revoked: revoked.rowCount, later_recoveries: later, bindings: home.revoked } });
  await notifyUser(ctx, c, userId, {
    kind: "recovery.undone", immediate: true, dedupeKey: `recovery-undo:${crypto.randomUUID()}`, subject: "Account recovery was undone",
    text: "An old passkey was used to sign in, so the recovery was undone. The passkeys the recovery added are revoked, every token and connected app was revoked, every session was signed out, and sensitive actions are on hold again.",
  });
}

/** A legitimate sign-in cancels any request that has not completed. */
export async function cancelOpenOnSignIn(ctx: AppContext, c: PoolClient, userId: string): Promise<number> {
  const open = (await c.query("select id from recovery_requests where user_id = $1 and status in ('pending','cooling_off')", [userId])).rows as { id: string }[];
  let n = 0;
  for (const r of open) if (await cancelRequest(ctx, c, userId, r.id, "sign_in")) n++;
  return n;
}

export const recoveryRoutes: Route[] = [
  { method: "POST", path: "/api/v1/auth/recovery/start", principals: ["anonymous"], handler: startHandler, tag: "auth" },
  { method: "POST", path: "/api/v1/auth/recovery/redeem", principals: ["anonymous"], handler: redeemHandler, tag: "auth" },
  { method: "POST", path: "/api/v1/auth/recovery/cancel", principals: ["anonymous", "session"], handler: cancelHandler, tag: "auth" },
];
