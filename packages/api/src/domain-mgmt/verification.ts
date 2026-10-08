import { tx, withNoUser, withUser, type PoolClient } from "@mosshatch/db";
import type { RegistrarPort, RegistrantVerificationState } from "@mosshatch/registrar/port";
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
import { addBusinessDays, audit, DAY_MS, ownedDomain, registrarOf, userIdOf, type DomainRow } from "./common.ts";
import { currentRegistrant } from "./contact.ts";

/** C-16: verify the registrant email within 15 days of registration, transfer in, change of registrant or a bounce; reminder at day 10. */
export const VERIFY_WINDOW_MS = 15 * DAY_MS;
export const VERIFY_REMINDER_AT_MS = 10 * DAY_MS;
const CODE_TTL_MS = 30 * 60_000;
const MAX_ATTEMPTS = 5;

export type VerificationReason = "registration" | "change_of_registrant" | "bounce";

/**
 * Who runs the check. `provider`: the registrar emails the registrant its own link and suspends the name itself (Openprovider does, for every
 * gTLD); our row then mirrors its state and our code verifies nothing there, so it is not offered. `reseller`: the emailed code below.
 * 2026-10-08: the first live owner used the registrar's link and was still told to verify, and would have been "put on hold" by us at day 15.
 */
export type VerificationSource = "provider" | "reseller";
export function verificationSource(ctx: Pick<AppContext, "services">): VerificationSource {
  try { return registrarOf(ctx).capabilities().registrantVerification === "provider" ? "provider" : "reseller"; } catch { return "reseller"; }
}

interface VerificationRow { id: string; state: string; reason: string; started_at: string; deadline_at: string; verified_at: string | null; suspended_at: string | null }
interface ProviderView { status: RegistrantVerificationState["status"]; suspended: boolean; reason: string | null; expires_at: string | null }
const providerView = (up: RegistrantVerificationState): ProviderView => ({ status: up.status, suspended: up.suspended, reason: up.reason ?? null, expires_at: up.expiresAt?.toISOString() ?? null });

/** The provider's check for the name: null when it holds none, undefined when it cannot answer (then our row is left as it is). */
async function providerState(ctx: Pick<AppContext, "services">, fqdn: string): Promise<RegistrantVerificationState | null | undefined> {
  let port: RegistrarPort;
  try { port = registrarOf(ctx); } catch { return undefined; }
  if (typeof port.getRegistrantVerification !== "function") return undefined;
  try { return await port.getRegistrantVerification(fqdn); } catch { return undefined; }
}

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

/**
 * The registrar's verified state verifies our row: the owner may have used the registrar's link and never our code. Lifts a hold we recorded
 * and closes its ticket. Inside the caller's transaction; closing the alert is the caller's job after the commit (the runtime role may not).
 */
async function adoptVerified(ctx: AppContext, c: PoolClient, userId: string, d: Pick<DomainRow, "id">, v: Pick<VerificationRow, "id" | "state">, detail: Record<string, unknown> = {}): Promise<{ lifted: boolean } | null> {
  const now = ctx.clock.now();
  const u = await c.query("update registrant_verifications set state = 'verified', verified_at = $2, code_hash = null where id = $1 and state in ('pending','suspended') returning id", [v.id, now]);
  if (u.rowCount !== 1) return null;
  const lifted = v.state === "suspended";
  if (lifted) await c.query("update domain_tickets set state = 'closed', closed_at = $2 where domain_id = $1 and kind = 'client_hold_request' and state = 'open'", [d.id, now]);
  await audit(ctx, c, userId, "domain.registrant_verified", { resourceKind: "domain", resourceId: d.id, detail: { via: "registrar", was_suspended: lifted, ...detail } });
  return { lifted };
}

export async function verificationStatusHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const source = verificationSource(ctx);
  const out = await withUser(ctx.runtime, userId, async (c) => {
    const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
    const read = async () => (await c.query("select id, state, reason, started_at, deadline_at, verified_at, suspended_at from registrant_verifications where domain_id = $1 order by created_at desc limit 1", [d.id])).rows[0] as VerificationRow | undefined;
    let v = await read();
    let provider: ProviderView | null = null; let lifted = false;
    if (source === "provider" && v && (v.state === "pending" || v.state === "suspended")) {
      const up = await providerState(ctx, d.fqdn_ascii);
      if (up) {
        provider = providerView(up);
        if (up.status === "verified") { lifted = !!(await adoptVerified(ctx, c, userId, d, v))?.lifted; v = await read(); }
        else if (up.expiresAt && v.state === "pending" && Math.abs(up.expiresAt.getTime() - new Date(v.deadline_at).getTime()) > 60_000) {
          // The provider's clock rules: our deadline follows it, so the days shown and the sweep agree with what the registrar will do.
          await c.query("update registrant_verifications set deadline_at = $2 where id = $1 and state = 'pending'", [v.id, up.expiresAt]); v = await read();
        }
      }
    }
    const iso = (x: unknown) => (x ? new Date(x as string).toISOString() : null);
    const verification = v ? { state: v.state, reason: v.reason, started_at: iso(v.started_at), deadline_at: iso(v.deadline_at), verified_at: iso(v.verified_at), suspended_at: iso(v.suspended_at), days_left: Math.max(0, Math.ceil((new Date(v.deadline_at).getTime() - ctx.clock.now().getTime()) / DAY_MS)) } : null;
    return { d, lifted, body: { domain: d.fqdn_ascii, source, provider, verification } };
  });
  if (out.lifted) await closeAlerts(ctx.cron, "domain.registrant_suspended", out.d.id);
  return json(out.body);
}

/** Send the verification email again: the registrar's own in provider mode, our one-time code otherwise. The response never says where it went. */
export async function verificationSendHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const rl = await withNoUser(ctx.runtime, (c) => hit(ctx, c, `regverify:${userId}`, { bucket: "regverify_send", max: 5, windowSeconds: 3600 }));
  if (!rl.allowed) throw new HttpError(429, "rate_limited", "rate_limited", { "Retry-After": String(rl.retryAfterSeconds) });
  const source = verificationSource(ctx);
  return withUser(ctx.runtime, userId, async (c) => {
    const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
    const v = (await c.query("select id from registrant_verifications where domain_id = $1 and state in ('pending','suspended')", [d.id])).rows[0];
    if (!v) return json({ sent: false, reason: "nothing_to_verify", source });
    if (source === "provider") {
      // Only the link in the registrar's own email counts there; a code of ours would verify nothing.
      const port = registrarOf(ctx);
      let sent = false;
      if (typeof port.resendRegistrantVerification === "function") { try { sent = (await port.resendRegistrantVerification(d.fqdn_ascii)).sent; } catch { sent = false; } }
      return json({ sent, source });
    }
    const reg = await currentRegistrant(ctx, c, userId, d.id);
    if (!reg) throw new HttpError(409, "no_registrant");
    const code = numericCode(8);
    const hash = await hashEmailCode(ctx, "registrant_verify", reg.email, code);
    await c.query("update registrant_verifications set code_hash = $2, code_expires_at = $3, code_attempts = 0 where id = $1", [v.id, hash, new Date(ctx.clock.now().getTime() + CODE_TTL_MS)]);
    await sendMail(c, ctx.email, { dedupeKey: `regverify:${v.id}:${ctx.clock.now().getTime()}`, kind: "domain.registrant_verify", userId, to: [reg.email], subject: "Verify the registrant email of your domain",
      text: `Your code to verify the registrant email of ${d.fqdn_ascii} is ${code}. It works for 30 minutes. If you did not ask for it, ignore this message.`, klass: "B" });
    return json({ sent: true, expires_in_seconds: CODE_TTL_MS / 1000, source });
  });
}

export async function verificationVerifyHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  if (verificationSource(ctx) === "provider") throw new HttpError(409, "provider_verification");
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

/** The system-role twin of `adoptVerified` for the sweep. */
async function adoptVerifiedSystem(ctx: AppContext, c: PoolClient, r: { id: string; user_id: string; domain_id: string }, detail: Record<string, unknown> = {}): Promise<void> {
  const now = ctx.clock.now();
  const u = await c.query("update registrant_verifications set state = 'verified', verified_at = $2, code_hash = null where id = $1 and state in ('pending','suspended') returning id", [r.id, now]);
  if (u.rowCount !== 1) return;
  await c.query("update domain_tickets set state = 'closed', closed_at = $2 where domain_id = $1 and kind = 'client_hold_request' and state = 'open'", [r.domain_id, now]);
  await appendAudit(ctx, c, { chainId: r.user_id, actorKind: "system", action: "domain.registrant_verified", resourceKind: "domain", resourceId: r.domain_id, detail: { verification: r.id, via: "registrar", ...detail } });
}

/**
 * Job `registrant.verify_sweep` (hourly). Day 10: a reminder. Day 15: the hold is requested and a ticket opened, the domain shows
 * "needs attention", and the operator is warned. In provider mode the registrar is asked first at both points: verified there verifies here,
 * an open check there moves our deadline to its date, and only a suspension there is mirrored (with the alert, without a hold ticket: nobody
 * has to request what the registrar already did). Also the annual registration-data reminder (RDRP, C-16 second half): once a year, before
 * the creation-date anniversary, to every address, with a `notices` row as proof.
 */
export async function verifySweepJob(ctx: AppContext, _job: JobRow): Promise<void> {
  const now = ctx.clock.now();
  const source = verificationSource(ctx);
  const remind = (await ctx.cron.query(
    "select v.id, v.user_id, v.domain_id, d.fqdn_ascii, v.deadline_at from registrant_verifications v join domains d on d.id = v.domain_id where v.state = 'pending' and v.reminder_sent_at is null and v.started_at + $1::interval <= $2 and v.deadline_at > $2 and d.released_at is null",
    [`${VERIFY_REMINDER_AT_MS} milliseconds`, now])).rows;
  for (const r of remind) {
    if (source === "provider") {
      const up = await providerState(ctx, r.fqdn_ascii);
      if (up === null || up?.status === "verified") { await tx(ctx.cron, (c) => adoptVerifiedSystem(ctx, c, r, { provider_check: up ? "verified" : "none" })); continue; }
    }
    await tx(ctx.cron, async (c) => {
      const u = await c.query("update registrant_verifications set reminder_sent_at = $2 where id = $1 and reminder_sent_at is null returning id", [r.id, now]);
      if (u.rowCount !== 1) return;
      const by = new Date(r.deadline_at).toISOString().slice(0, 10);
      await notifyUser(ctx, c, r.user_id, { kind: "domain.registrant_reminder", dedupeKey: `regverify-remind:${r.id}`, immediate: true, subject: "Verify the registrant email of your domain",
        text: source === "provider"
          ? `Verify the registrant email of ${r.fqdn_ascii} by ${by}: use the link in the verification email from our registrar, or press "Send the email again" on the domain page. If it is not verified in time, the registrar puts the domain on hold and it stops working.`
          : `Verify the registrant email of ${r.fqdn_ascii} by ${by}. If it is not verified in time, the domain is put on hold and stops working.` });
    });
  }
  const due = (await ctx.cron.query(
    "select v.id, v.user_id, v.domain_id, d.fqdn_ascii from registrant_verifications v join domains d on d.id = v.domain_id where v.state = 'pending' and v.deadline_at <= $1 and d.released_at is null", [now])).rows;
  for (const r of due) {
    if (source === "provider") {
      const up = await providerState(ctx, r.fqdn_ascii);
      if (up === undefined) continue;                                   // the registrar could not answer: nothing goes on hold on our say-so; next hour
      if (up === null || up.status === "verified") { await tx(ctx.cron, (c) => adoptVerifiedSystem(ctx, c, r, { provider_check: up ? "verified" : "none" })); continue; }
      if (!up.suspended) {
        // Still open there: its clock rules ours. Without a date from it, look again in a day.
        const later = up.expiresAt && up.expiresAt.getTime() > now.getTime() ? up.expiresAt : new Date(now.getTime() + DAY_MS);
        await ctx.cron.query("update registrant_verifications set deadline_at = $2 where id = $1 and state = 'pending'", [r.id, later]);
        continue;
      }
      await tx(ctx.cron, async (c) => {
        const u = await c.query("update registrant_verifications set state = 'suspended', suspended_at = $2 where id = $1 and state = 'pending' returning id", [r.id, now]);
        if (u.rowCount !== 1) return;
        const detail = { domain_id: r.domain_id, by: "registrar", reason: up.reason ?? null };
        await raiseAlert(ctx, c, { severity: "warn", kind: "domain.registrant_suspended", subject: r.domain_id, detail });
        await appendAudit(ctx, c, { chainId: r.user_id, actorKind: "system", action: "domain.registrant_suspended", resourceKind: "domain", resourceId: r.domain_id, detail: { verification: r.id, ...detail } });
        await notifyUser(ctx, c, r.user_id, { kind: "domain.registrant_suspended", dedupeKey: `regverify-suspend:${r.id}`, immediate: true, subject: "A domain is on hold",
          text: `The registrant email of ${r.fqdn_ascii} was not verified in time, so our registrar has put the domain on hold and it has stopped working. Use the link in the registrar's verification email, or press "Send the email again" on the domain page, to lift the hold.` });
      });
      continue;
    }
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
