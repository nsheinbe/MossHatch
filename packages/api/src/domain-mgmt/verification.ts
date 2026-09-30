import { tx, withNoUser, withUser, type PoolClient } from "@mosshatch/db";
import type { RegistrarPort } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import type { JobRow } from "../jobs/registry.ts";
import { appendAudit } from "../audit.ts";
import { sendMail } from "../email.ts";
import { hit } from "../ratelimit.ts";
import { safeEqual } from "../util/bytes.ts";
import { hashEmailCode, numericCode } from "../auth/common.ts";
import { notifyUser } from "../auth/mail.ts";
import { raiseAlert, closeAlerts } from "../ops/alerts.ts";
import { addBusinessDays, audit, DAY_MS, ownedDomain, registrarOf, userIdOf } from "./common.ts";
import { currentRegistrant } from "./contact.ts";

/** C-16: verify the registrant email within 15 days of registration, transfer in, change of registrant or a bounce; reminder at day 10. */
export const VERIFY_WINDOW_MS = 15 * DAY_MS;
export const VERIFY_REMINDER_AT_MS = 10 * DAY_MS;
const CODE_TTL_MS = 30 * 60_000;
const MAX_ATTEMPTS = 5;

export type VerificationReason = "registration" | "change_of_registrant" | "bounce";

/** Start (or keep) the 15-day clock. The orders module calls this when a registration completes; a bounce webhook calls `restartOnBounce`. */
export async function startRegistrantVerification(ctx: Pick<AppContext, "clock">, c: PoolClient, o: { userId: string; domainId: string; reason: VerificationReason }): Promise<void> {
  const now = ctx.clock.now();
  await c.query(
    `insert into registrant_verifications (user_id, domain_id, reason, started_at, deadline_at) values ($1,$2,$3,$4,$5)
     on conflict (domain_id) where state in ('pending','suspended') do nothing`,
    [o.userId, o.domainId, o.reason, now, new Date(now.getTime() + VERIFY_WINDOW_MS)]);
}

/** A bounce of the registrant address clears verification and starts the clock again on every live domain of the person (C-16). */
export async function restartOnBounce(ctx: AppContext, c: PoolClient, userId: string): Promise<number> {
  const ds = (await c.query("select id from domains where user_id = $1 and released_at is null", [userId])).rows;
  for (const d of ds) await startRegistrantVerification(ctx, c, { userId, domainId: d.id, reason: "bounce" });
  return ds.length;
}

export async function verificationStatusHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  return withUser(ctx.runtime, userId, async (c) => {
    const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
    const v = (await c.query("select state, reason, started_at, deadline_at, verified_at, suspended_at from registrant_verifications where domain_id = $1 order by created_at desc limit 1", [d.id])).rows[0];
    const iso = (x: unknown) => (x ? new Date(x as string).toISOString() : null);
    return json({ domain: d.fqdn_ascii, verification: v ? { state: v.state, reason: v.reason, started_at: iso(v.started_at), deadline_at: iso(v.deadline_at), verified_at: iso(v.verified_at), suspended_at: iso(v.suspended_at), days_left: Math.max(0, Math.ceil((new Date(v.deadline_at).getTime() - ctx.clock.now().getTime()) / DAY_MS)) } : null });
  });
}

/** Send a one-time code to the registrant address. The response never says where it went. */
export async function verificationSendHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const rl = await withNoUser(ctx.runtime, (c) => hit(ctx, c, `regverify:${userId}`, { bucket: "regverify_send", max: 5, windowSeconds: 3600 }));
  if (!rl.allowed) throw new HttpError(429, "rate_limited", "rate_limited", { "Retry-After": String(rl.retryAfterSeconds) });
  return withUser(ctx.runtime, userId, async (c) => {
    const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
    const v = (await c.query("select id from registrant_verifications where domain_id = $1 and state in ('pending','suspended')", [d.id])).rows[0];
    if (!v) return json({ sent: false, reason: "nothing_to_verify" });
    const reg = await currentRegistrant(ctx, c, userId, d.id);
    if (!reg) throw new HttpError(409, "no_registrant");
    const code = numericCode(8);
    const hash = await hashEmailCode(ctx, "registrant_verify", reg.email, code);
    await c.query("update registrant_verifications set code_hash = $2, code_expires_at = $3, code_attempts = 0 where id = $1", [v.id, hash, new Date(ctx.clock.now().getTime() + CODE_TTL_MS)]);
    await sendMail(c, ctx.email, { dedupeKey: `regverify:${v.id}:${ctx.clock.now().getTime()}`, kind: "domain.registrant_verify", userId, to: [reg.email], subject: "Verify the registrant email of your domain",
      text: `Your code to verify the registrant email of ${d.fqdn_ascii} is ${code}. It works for 30 minutes. If you did not ask for it, ignore this message.`, klass: "B" });
    return json({ sent: true, expires_in_seconds: CODE_TTL_MS / 1000 });
  });
}

export async function verificationVerifyHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const code = (req.body as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !/^\d{8}$/.test(code)) throw new HttpError(422, "invalid_code");
  // Attempts are counted in their own committed statement, before the comparison.
  const state = await withUser(ctx.runtime, userId, async (c) => {
    const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
    const v = (await c.query("update registrant_verifications set code_attempts = code_attempts + 1 where domain_id = $1 and state in ('pending','suspended') returning id, code_hash, code_expires_at, code_attempts, state", [d.id])).rows[0];
    return { d, v };
  });
  const { d, v } = state;
  if (!v || !v.code_hash || new Date(v.code_expires_at) <= ctx.clock.now() || v.code_attempts > MAX_ATTEMPTS) throw new HttpError(400, "invalid_code");
  return withUser(ctx.runtime, userId, async (c) => {
    const reg = await currentRegistrant(ctx, c, userId, d.id);
    if (!reg) throw new HttpError(409, "no_registrant");
    const want = await hashEmailCode(ctx, "registrant_verify", reg.email, code);
    if (!safeEqual(want, v.code_hash)) throw new HttpError(400, "invalid_code");
    const now = ctx.clock.now();
    const u = await c.query("update registrant_verifications set state = 'verified', verified_at = $2, code_hash = null where id = $1 and state in ('pending','suspended') returning id", [v.id, now]);
    if (u.rowCount !== 1) throw new HttpError(409, "already_verified");
    if (v.state === "suspended") {
      await c.query("update domain_tickets set state = 'closed', closed_at = $2 where domain_id = $1 and kind = 'client_hold_request' and state = 'open'", [d.id, now]);
    }
    await audit(ctx, c, userId, "domain.registrant_verified", { resourceKind: "domain", resourceId: d.id, detail: { was_suspended: v.state === "suspended" } });
    return json({ verified: true, domain: d.fqdn_ascii, hold_lift_requested: v.state === "suspended" });
  }).then(async (res) => {
    // The runtime role may add alerts but not change them; the system role closes this one after the commit.
    if (v.state === "suspended") await closeAlerts(ctx.cron, "domain.registrant_suspended", d.id);
    return res;
  });
}

/** The optional hold call on a port that has it. The registrar port has no clientHold method yet, so today this only records the request. */
type HoldCapable = RegistrarPort & { requestClientHold?: (fqdn: string) => Promise<void> };

/**
 * Job `registrant.verify_sweep` (hourly). Day 10: a reminder. Day 15: the hold is requested and a ticket opened, the domain shows
 * "needs attention", and the operator is warned. Also the annual registration-data reminder (RDRP, C-16 second half): once a year,
 * before the creation-date anniversary, to every address, with a `notices` row as proof.
 */
export async function verifySweepJob(ctx: AppContext, _job: JobRow): Promise<void> {
  const now = ctx.clock.now();
  const remind = (await ctx.cron.query(
    "select v.id, v.user_id, d.fqdn_ascii, v.deadline_at from registrant_verifications v join domains d on d.id = v.domain_id where v.state = 'pending' and v.reminder_sent_at is null and v.started_at + $1::interval <= $2 and v.deadline_at > $2 and d.released_at is null",
    [`${VERIFY_REMINDER_AT_MS} milliseconds`, now])).rows;
  for (const r of remind) {
    await tx(ctx.cron, async (c) => {
      const u = await c.query("update registrant_verifications set reminder_sent_at = $2 where id = $1 and reminder_sent_at is null returning id", [r.id, now]);
      if (u.rowCount !== 1) return;
      await notifyUser(ctx, c, r.user_id, { kind: "domain.registrant_reminder", dedupeKey: `regverify-remind:${r.id}`, immediate: true, subject: "Verify the registrant email of your domain",
        text: `Verify the registrant email of ${r.fqdn_ascii} by ${new Date(r.deadline_at).toISOString().slice(0, 10)}. If it is not verified in time, the domain is put on hold and stops working.` });
    });
  }
  const due = (await ctx.cron.query(
    "select v.id, v.user_id, v.domain_id, d.fqdn_ascii from registrant_verifications v join domains d on d.id = v.domain_id where v.state = 'pending' and v.deadline_at <= $1 and d.released_at is null", [now])).rows;
  for (const r of due) {
    const port = registrarOf(ctx) as HoldCapable;
    let requested = false;
    if (typeof port.requestClientHold === "function") { try { await port.requestClientHold(r.fqdn_ascii); requested = true; } catch { /* the ticket below is the fallback */ } }
    await tx(ctx.cron, async (c) => {
      const u = await c.query("update registrant_verifications set state = 'suspended', suspended_at = $2 where id = $1 and state = 'pending' returning id", [r.id, now]);
      if (u.rowCount !== 1) return;
      await c.query("insert into domain_tickets (user_id, domain_id, kind, detail, sla_due_at, opened_at) values ($1,$2,'client_hold_request',$3,$4,$5) on conflict do nothing",
        [r.user_id, r.domain_id, { verification: r.id, hold_called: requested }, addBusinessDays(now, 1), now]);
      await raiseAlert(ctx, c, { severity: "warn", kind: "domain.registrant_suspended", subject: r.domain_id, detail: { domain_id: r.domain_id, hold_called: requested } });
      await appendAudit(ctx, c, { chainId: r.user_id, actorKind: "system", action: "domain.registrant_suspended", resourceKind: "domain", resourceId: r.domain_id, detail: { verification: r.id, hold_called: requested } });
      await notifyUser(ctx, c, r.user_id, { kind: "domain.registrant_suspended", dedupeKey: `regverify-suspend:${r.id}`, immediate: true, subject: "A domain is being put on hold",
        text: `The registrant email of ${r.fqdn_ascii} was not verified within 15 days, so the domain is being put on hold. Verify the email on the domain page to lift the hold.` });
    });
  }

  // Annual reminder: anniversary of the creation date within the next 30 days, once per anniversary.
  const ds = (await ctx.cron.query(
    "select id, user_id, fqdn_ascii, coalesce(registry_created_at, registered_at) as created from domains where released_at is null and coalesce(registry_created_at, registered_at) is not null")).rows;
  for (const d of ds) {
    const created = new Date(d.created);
    let ann = new Date(Date.UTC(now.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate()));
    if (ann.getTime() < now.getTime() - DAY_MS) ann = new Date(Date.UTC(now.getUTCFullYear() + 1, created.getUTCMonth(), created.getUTCDate()));
    const daysTo = (ann.getTime() - now.getTime()) / DAY_MS;
    if (ann.getUTCFullYear() <= created.getUTCFullYear() || daysTo > 30) continue;
    const key = `rdrp:${d.id}:${ann.getUTCFullYear()}`;
    await tx(ctx.cron, async (c) => {
      const seen = await c.query("select 1 from notices where domain_id = $1 and kind = 'rdrp_annual' and sent_at > $2 limit 1", [d.id, new Date(now.getTime() - 300 * DAY_MS)]);
      if ((seen.rowCount ?? 0) > 0) return;
      await notifyUser(ctx, c, d.user_id, { kind: "domain.rdrp_annual", dedupeKey: key, immediate: true, subject: "Check the registration data for your domain",
        text: `Once a year we ask you to check the contact data registered for ${d.fqdn_ascii}: name, email, phone and postal address. Wrong data can lead to the domain being suspended, and giving false data is grounds for cancelling it. Update it on the domain page if anything is out of date.` });
      await c.query("insert into notices (kind, domain_id, user_id, sent_at, template_version, retain_until) values ('rdrp_annual',$1,$2,$3,'rdrp-v1',$4)", [d.id, d.user_id, now, new Date(now.getTime() + 3 * 365 * DAY_MS)]);
    });
  }
}
