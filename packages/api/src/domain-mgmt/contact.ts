import { z } from "zod";
import { tx, withUser, type PoolClient } from "@mosshatch/db";
import type { Registrant } from "@mosshatch/registrar/port";
import type { AppContext, Envelope } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import type { JobRow } from "../jobs/registry.ts";
import { markExecuted } from "../stepup/gate.ts";
import { sendMail } from "../email.ts";
import { appendAudit } from "../audit.ts";
import { canonicalJson } from "../util/bytes.ts";
import { loadRegistrant, REGISTRANT_FIELDS } from "../orders/registrant.ts";
import { assertWritesOpen, audit, COR_LOCK_MS, DAY_MS, emailHash, ensureSecurityRow, mapRegistrarError, normalizeFqdn, notifyDomainEvent, ownedDomain, registrarOf, takeFuse, userIdOf, type DomainRow } from "./common.ts";
import { startRegistrantVerification } from "./verification.ts";

/** Approval of a change of registrant is by email, from the upstream, to both parties; it lapses after 5 days (own target). */
export const APPROVAL_WINDOW_MS = 5 * DAY_MS;

export const ContactBody = z.strictObject({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().regex(/^\+\d{1,3}\.\d{4,14}$/),          // EPP format +CC.number
  street: z.string().trim().min(3).max(200),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(2).max(20),
  country: z.string().trim().length(2).toUpperCase(),
});

const aad = (userId: string, changeId: string, field: string) => `contactchange:${userId}:${changeId}:${field}`;
const lc = (s: string) => s.trim().toLowerCase();

async function decryptChange(ctx: Pick<AppContext, "pii">, userId: string, id: string, enc: Record<string, Envelope>): Promise<Registrant> {
  const out: Partial<Registrant> = {};
  for (const f of REGISTRANT_FIELDS) out[f] = await ctx.pii.decrypt(enc[f]!, aad(userId, id, f));
  return out as Registrant;
}

/** What the registrar holds now: the last applied change on this domain, else the contact given at checkout. */
export async function currentRegistrant(ctx: AppContext, c: PoolClient, userId: string, domainId: string): Promise<Registrant | null> {
  const last = (await c.query("select id, fields_enc from contact_changes where domain_id = $1 and state = 'applied' order by applied_at desc nulls last limit 1", [domainId])).rows[0];
  if (last) return decryptChange(ctx, userId, last.id, last.fields_enc);
  return loadRegistrant(ctx, userId);
}

/** Every address the person signs in with or is mailed at as their login: a registrant address equal to one of them is the weakness ST-121 warns about. */
async function loginAddresses(c: PoolClient, userId: string): Promise<string[]> {
  const a = (await c.query("select address::text as a from notification_addresses where user_id = $1 and removed_at is null and kind = 'login'", [userId])).rows.map((r) => lc(r.a as string));
  const u = (await c.query("select email::text as e from users where id = $1", [userId])).rows[0];
  return [...new Set([...a, ...(u?.e ? [lc(u.e as string)] : [])])];
}

export const REGISTRANT_MATCHES_LOGIN = "The registrant email is the same as your login email. Anyone who can read that mailbox could approve a transfer or a change of registrant. Use a different address.";

/** The form's starting values: the registrant address is a different one from the login address whenever the person has one (ST-121). */
export async function contactHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  return withUser(ctx.runtime, userId, async (c) => {
    const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
    const cur = await currentRegistrant(ctx, c, userId, d.id);
    const login = await loginAddresses(c, userId);
    const reg = (await c.query("select address::text as a from notification_addresses where user_id = $1 and removed_at is null and kind = 'registrant' order by created_at limit 1", [userId])).rows[0];
    const suggested = reg?.a && !login.includes(lc(reg.a as string)) ? (reg.a as string) : null;
    const matches = !!cur && login.includes(lc(cur.email));
    return json({
      domain: d.fqdn_ascii,
      current: cur ? { name: cur.name, email: cur.email, country: cur.country } : null,
      suggested_email: suggested,
      login_email_matches: matches,
      warning: matches ? { code: "registrant_matches_login", message: REGISTRANT_MATCHES_LOGIN } : null,
      dispute_lock: !!d.dispute_lock_state,
    });
  });
}

/** Store the proposed contact, encrypted, and say what submitting it will do (C-07: warn first). No registrar call yet. */
export async function draftHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const parsed = ContactBody.safeParse(req.body);
  if (!parsed.success) throw new HttpError(422, "invalid_contact");
  const f = parsed.data;
  return withUser(ctx.runtime, userId, async (c) => {
    const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
    if (d.dispute_lock_state) throw new HttpError(423, "dispute_lock");
    const cur = await currentRegistrant(ctx, c, userId, d.id);
    const registrantChange = !cur || lc(cur.name) !== lc(f.name) || lc(cur.email) !== lc(f.email);
    const matches = (await loginAddresses(c, userId)).includes(lc(f.email));
    const id = (await c.query("select uuidv7() as id")).rows[0].id as string;
    const enc: Record<string, Envelope> = {};
    for (const k of REGISTRANT_FIELDS) enc[k] = await ctx.pii.encrypt(f[k], aad(userId, id, k));
    const fieldsHash = (await ctx.kms.hmac("email-token", Buffer.from("contact|" + canonicalJson(f)))).toString("hex");
    await c.query("update contact_changes set state = 'expired' where domain_id = $1 and state = 'draft'", [d.id]);
    await c.query(
      "insert into contact_changes (id, user_id, domain_id, state, fields_enc, fields_hash, new_email_hash, registrant_change, email_matches_login, created_at) values ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9)",
      [id, userId, d.id, enc, fieldsHash, emailHash(f.email), registrantChange, matches, ctx.clock.now()]);
    const warnings = [...(matches ? [{ code: "registrant_matches_login", message: REGISTRANT_MATCHES_LOGIN }] : []),
      ...(registrantChange ? [{ code: "change_of_registrant", message: "Changing the registrant name or email is a change of registrant. Both the current and the new registrant must approve it by email, and the domain cannot be transferred to another registrar for 60 days afterwards." }] : [])];
    return json({ id, domain: d.fqdn_ascii, registrant_change: registrantChange, email_matches_login: matches, transfer_lock_days: registrantChange ? 60 : 0, warnings }, 201);
  });
}

/** Submit a draft. Gated by `domain.contact.change`; the action's params name the draft, so a different draft is not this action. */
export async function submitHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const a = req.action!;
  const p = a.params as Record<string, unknown>;
  const fqdn = normalizeFqdn(req.params.fqdn ?? "");
  if (p.op !== "contact" || !fqdn || p.fqdn !== fqdn) throw new HttpError(403, "step_up_required", undefined, undefined, { type: a.type });
  await takeFuse(ctx, "contact_change");
  try {
    return await withUser(ctx.runtime, userId, async (c) => {
      await assertWritesOpen(c);
      const d = await ownedDomain(c, userId, fqdn);
      if (d.id !== p.domain_id) throw new HttpError(403, "step_up_required");
      if (d.dispute_lock_state) throw new HttpError(423, "dispute_lock");
      const ch = (await c.query("select * from contact_changes where id = $1 and user_id = $2 and domain_id = $3 and state = 'draft'", [p.change_id, userId, d.id])).rows[0];
      if (!ch || ch.fields_hash !== p.fields_hash) throw new HttpError(409, "params_changed");
      await markExecuted(c, a);
      const registrant = await decryptChange(ctx, userId, ch.id, ch.fields_enc);
      const res = await registrarOf(ctx).updateContact(d.fqdn_ascii, registrant);
      const now = ctx.clock.now();
      const applied = res.status === "applied";
      await c.query("update contact_changes set state = $2, submitted_at = $3, applied_at = $4, approval_deadline_at = $5, action_id = $6 where id = $1",
        [ch.id, applied ? "applied" : "awaiting_approval", now, applied ? now : null, applied ? null : new Date(now.getTime() + APPROVAL_WINDOW_MS), a.id]);
      await ensureSecurityRow(c, d);
      if (applied && res.transferLock60d) await c.query("update domain_security set transfer_lock_until = $2, transfer_lock_reason = 'change_of_registrant' where domain_id = $1", [d.id, new Date(now.getTime() + COR_LOCK_MS)]);
      if (applied && res.verificationRequired) await startRegistrantVerification(ctx, c, { userId, domainId: d.id, reason: "change_of_registrant" });
      await audit(ctx, c, userId, "domain.contact_change_submitted", { resourceKind: "domain", resourceId: d.id, detail: { change: ch.id, registrant_change: res.registrantChange, status: res.status, verification: res.verificationRequired } });
      await notifyDomainEvent(ctx, c, userId, {
        kind: "domain.contact_change", domainId: d.id, subject: "The contact details of a domain on your Mosshatch account are changing",
        text: applied
          ? `The contact details of ${d.fqdn_ascii} were updated with your passkey.`
          : `A change of registrant for ${d.fqdn_ascii} was started with your passkey. The current registrant and the new registrant must each approve it from the email the registrar sends. Until then the domain cannot be unlocked. After it completes, the domain cannot move to another registrar for 60 days.`,
      });
      if (!applied) {
        // The new registrant is told what is coming and where to approve. This message carries no freeze link: it goes to a mailbox we do not know is the owner's.
        await sendMail(c, ctx.email, { dedupeKey: `cor-new:${ch.id}`, kind: "domain.cor_new_registrant", userId, to: [registrant.email], subject: "You were named as the new registrant of a domain",
          text: `${registrant.name}, ${d.fqdn_ascii} has a pending change of registrant that names you. Approve or decline it from the email our registrar sends you. If you did not expect this, decline it.`, klass: "B" });
      }
      return json({ change_id: ch.id, domain: d.fqdn_ascii, status: applied ? "applied" : "awaiting_approval", registrant_change: res.registrantChange, verification_required: res.verificationRequired, transfer_lock_days: res.registrantChange ? 60 : 0, approval_deadline_at: applied ? null : new Date(now.getTime() + APPROVAL_WINDOW_MS).toISOString() }, applied ? 200 : 202);
    });
  } catch (e) { throw mapRegistrarError(e); }
}

export async function contactChangesHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  return withUser(ctx.runtime, userId, async (c) => {
    const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
    const rows = (await c.query("select id, state, registrant_change, email_matches_login, submitted_at, applied_at, approval_deadline_at from contact_changes where domain_id = $1 and state <> 'draft' order by created_at desc limit 20", [d.id])).rows;
    const iso = (x: unknown) => (x ? new Date(x as string).toISOString() : null);
    return json({ domain: d.fqdn_ascii, changes: rows.map((r) => ({ id: r.id, state: r.state, registrant_change: r.registrant_change, submitted_at: iso(r.submitted_at), applied_at: iso(r.applied_at), approval_deadline_at: iso(r.approval_deadline_at) })) });
  });
}

/**
 * Job `contact.change.poll`: has the upstream completed a pending change of registrant? The owner email hash is the signal (a
 * name-only change leaves it unchanged, so it is treated as applied at the first poll; that only lengthens the 60-day lock).
 * A completed change starts the 60-day lock and the 15-day email verification. An unanswered one lapses after 5 days.
 */
export async function contactChangePollJob(ctx: AppContext, _job: JobRow): Promise<void> {
  const rows = (await ctx.cron.query(
    "select c.id, c.user_id, c.domain_id, c.new_email_hash, c.approval_deadline_at, d.fqdn_ascii from contact_changes c join domains d on d.id = c.domain_id where c.state = 'awaiting_approval' and d.released_at is null")).rows;
  const port = registrarOf(ctx);
  for (const r of rows) {
    const now = ctx.clock.now();
    let st; try { st = await port.getDomain(r.fqdn_ascii); } catch { continue; }
    const done = !!st && st.ownerEmailHash === r.new_email_hash;
    const lapsed = !done && new Date(r.approval_deadline_at) <= now;
    if (!done && !lapsed) continue;
    await tx(ctx.cron, async (c) => {
      const u = await c.query("update contact_changes set state = $2, applied_at = $3 where id = $1 and state = 'awaiting_approval' returning id", [r.id, done ? "applied" : "expired", done ? now : null]);
      if (u.rowCount !== 1) return;
      if (done) {
        await ensureSecurityRow(c, { id: r.domain_id, user_id: r.user_id });
        await c.query("update domain_security set transfer_lock_until = $2, transfer_lock_reason = 'change_of_registrant' where domain_id = $1", [r.domain_id, new Date(now.getTime() + COR_LOCK_MS)]);
        await startRegistrantVerification(ctx, c, { userId: r.user_id, domainId: r.domain_id, reason: "change_of_registrant" });
      }
      await appendAudit(ctx, c, { chainId: r.user_id, actorKind: "system", action: done ? "domain.contact_change_applied" : "domain.contact_change_expired", resourceKind: "domain", resourceId: r.domain_id, detail: { change: r.id } });
      await notifyDomainEvent(ctx, c, r.user_id, {
        kind: done ? "domain.contact_change_applied" : "domain.contact_change_expired", domainId: r.domain_id,
        subject: done ? "The change of registrant is complete" : "The change of registrant was not approved in time",
        text: done ? `The change of registrant for ${r.fqdn_ascii} is complete. The domain cannot be transferred to another registrar for 60 days. The new registrant email must be verified within 15 days.`
          : `Nobody approved the change of registrant for ${r.fqdn_ascii} in time, so it lapsed. Nothing changed. You can start it again.`,
      });
    });
  }
}

export type { DomainRow };
