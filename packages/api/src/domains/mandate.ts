import { z } from "zod";
import type { PoolClient } from "@mosshatch/db";
import { HttpError } from "../http/router.ts";
import type { AppContext } from "../ports.ts";
import { registerActionSpec, type ActionSpec } from "../stepup/specs.ts";
import { appendAudit } from "../audit.ts";
import { mintEmailActionToken } from "../auth/email-actions.ts";
import { sendMail } from "../email.ts";
import { buildMail } from "../mail/templates.ts";
import { customerAddresses } from "../orders/support.ts";
import { CHARGE_DAYS_BEFORE_EXPIRY, DAY_MS, UUID_RE, addDays, loadDomain, type DomainRow, type Q } from "./common.ts";
import { renewalQuote } from "./terms.ts";

/**
 * Auto-renew is opt-in and never pre-checked (D-008, C-31). A mandate is a passkey-signed `mandate.sign` action that carries the
 * domain, a price ceiling, the term, the charge day and the hash of the authorisation text; the same request writes a `consents` row
 * (kind auto_renew_mandate) so the record survives the mandate. It is kept for three years after the last renewal.
 * Turning it off is one click with no passkey (C-34), from the dashboard or from a protective email link.
 *
 * Retention (C-19, C-31, C-38): `retain_until` is three years from the signature when it is written, and every renewal charged for the
 * domain moves the mandate's and its consent's `retain_until` to three years after that charge (COMPLIANCE C-31: "kept at least 3
 * years after the last renewal"). That is done by the database (migration 0670, trigger on `payments`), so every payment path and
 * every way a mandate is switched off are covered, and it outlasts the charge's card dispute window: PLAN and COMPLIANCE state no
 * figure for that window, so the longest card-network window, 540 days, is the (unverified) own figure it is checked against.
 */
export const AUTO_RENEW_DOC = "auto_renew_authorisation";
export const MANDATE_RETAIN_MS = 3 * 365 * DAY_MS;
/** The card dispute window of a charge (own, unverified figure: no figure in PLAN or COMPLIANCE). */
export const DISPUTE_WINDOW_MS = 540 * DAY_MS;
/** How long after the last renewal charge a mandate and its consent are kept (C-31); must stay at least DISPUTE_WINDOW_MS. Mirrors 0670. */
export const MANDATE_KEEP_AFTER_CHARGE_MS = Math.max(MANDATE_RETAIN_MS, DISPUTE_WINDOW_MS);

export interface MandateRow {
  id: string; domainId: string; userId: string; paymentMethodRef: string | null; customerRef: string | null; priceCeilingMinor: bigint;
  chargeDaysBeforeExpiry: number; textHash: string; termYears: number; signedActionId: string | null; consentId: string | null; acceptedAt: Date; revokedAt: Date | null;
  /** Set when the card network replaced the card with another brand (C-38): no charge until a fresh signature. */
  reconsentRequiredAt: Date | null; cardUpdatedAt: Date | null;
}
const rowToMandate = (r: Record<string, any>): MandateRow => ({
  id: r.id, domainId: r.domain_id, userId: r.user_id, paymentMethodRef: r.stripe_payment_method_ref, customerRef: r.stripe_customer_ref, priceCeilingMinor: BigInt(r.price_ceiling_minor),
  chargeDaysBeforeExpiry: r.charge_days_before_expiry, textHash: r.text_hash, termYears: r.term_years, signedActionId: r.signed_action_id, consentId: r.consent_id,
  acceptedAt: new Date(r.accepted_at), revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
  reconsentRequiredAt: r.reconsent_required_at ? new Date(r.reconsent_required_at) : null, cardUpdatedAt: r.card_updated_at ? new Date(r.card_updated_at) : null,
});

export async function activeMandate(q: Q, domainId: string): Promise<MandateRow | null> {
  const r = await q.query("select * from renewal_mandates where domain_id = $1 and revoked_at is null", [domainId]);
  return r.rows[0] ? rowToMandate(r.rows[0]) : null;
}

/** The text hash in force: the current `auto_renew_authorisation` document version. Null when none is published. */
export async function currentAuthorisationHash(q: Q, now: Date): Promise<string | null> {
  const r = await q.query(
    "select version_hash from document_versions where kind = $1 and effective_at <= $2 and (retired_at is null or retired_at > $2) order by effective_at desc limit 1", [AUTO_RENEW_DOC, now]);
  return (r.rows[0]?.version_hash as string | undefined) ?? null;
}

/**
 * The card the mandate would charge: the payment method of the person's latest paid order whose Checkout saved the card for
 * off-session use (`setup_future_usage=off_session`, set only when the auto-renew box was ticked, C-31) and that was not detached since.
 * A card used once at Checkout is never charged again without the person.
 */
export async function savedCard(q: Q, userId: string): Promise<{ customer: string; paymentMethod: string } | null> {
  const r = await q.query(
    `select stripe_customer_id, payment_method_ref from orders where user_id = $1 and payment_method_ref is not null and stripe_customer_id is not null
        and card_reusable and card_detached_at is null and state in ('captured','renewing_upstream','renewed','refunded','partially_refunded') order by created_at desc limit 1`, [userId]);
  const row = r.rows[0];
  return row ? { customer: row.stripe_customer_id as string, paymentMethod: row.payment_method_ref as string } : null;
}

// ---- the mandate.sign spec: what the person sees and signs ------------------------------------------------------------------------

const input = z.object({}).strict();
export const mandateSignSpec: ActionSpec<z.infer<typeof input>> = {
  type: "mandate.sign", held: false, userInput: input,
  async derive(ctx, client, userId, targetId) {
    if (!UUID_RE.test(targetId)) throw new HttpError(404, "not_found");
    const d = await loadDomain(client, targetId);
    if (!d || d.userId !== userId || d.releasedAt) throw new HttpError(404, "not_found");
    const now = ctx.clock.now();
    const q = await renewalQuote(client, d.fqdn, now);
    const hash = await currentAuthorisationHash(client, now);
    if (!q || !hash) throw new HttpError(503, "documents_unavailable");
    const card = await savedCard(client, userId);
    if (!card) throw new HttpError(409, "no_saved_card");
    // Ceiling = the price shown now for the term; a renewal above it waits for a fresh signature (C-33).
    return {
      params: {
        domain_id: d.id, price_ceiling_minor: q.subtotalMinor.toString(), term_years: q.years, charge_days_before_expiry: CHARGE_DAYS_BEFORE_EXPIRY,
        text_hash: hash, payment_method_ref: card.paymentMethod, currency: "usd",
      },
      resourceId: d.id,
    };
  },
  summary: (p) => `Turn on auto-renew for this domain. Ten days before it expires we charge the renewal price to your saved card, up to ${usd(String(p.price_ceiling_minor))} for ${String(p.term_years)} ${Number(p.term_years) === 1 ? "year" : "years"}. You can turn it off at any time with one click.`,
};
const usd = (minor: string) => { const n = minor.padStart(3, "0"); return `USD ${n.slice(0, -2)}.${n.slice(-2)}`; };
export function registerMandateSpec(): void { registerActionSpec(mandateSignSpec); }

// ---- turning it on and off --------------------------------------------------------------------------------------------------------

export type EnableResult = { ok: true; mandate: MandateRow } | { ok: false; code: "already_on" | "not_found" | "terms_not_accepted" | "params_mismatch" };

/**
 * Runs inside the request's user-scoped transaction after the step-up gate: the signed params must match this domain, the consent the
 * person gave apart from the terms (the hash of the authorisation text they were shown) must equal the text in force, and the mandate,
 * the consent row and `domains.auto_renew` change together.
 */
export async function enableAutoRenew(ctx: AppContext, c: PoolClient, o: { userId: string; domainId: string; params: Record<string, unknown>; actionId: string; consentHash: unknown; ipPrefix: string; uaFamily: string }): Promise<EnableResult> {
  const d = await loadDomain(c, o.domainId);
  if (!d || d.userId !== o.userId || d.releasedAt) return { ok: false, code: "not_found" };
  const p = o.params;
  if (p.domain_id !== d.id) return { ok: false, code: "params_mismatch" };
  const now = ctx.clock.now();
  const hash = await currentAuthorisationHash(c, now);
  if (!hash || p.text_hash !== hash || o.consentHash !== hash) return { ok: false, code: "terms_not_accepted" };
  const existing = await activeMandate(c, d.id);
  if (existing) {
    // A live mandate is replaced only when it cannot be charged as it stands: the card changed brand (a new agreement, C-38) or the renewal
    // price rose above its ceiling (a fresh passkey approval, C-33). The old one is revoked in the same transaction as the new one is written.
    const q = await renewalQuote(c, d.fqdn, now);
    const aboveCap = !!q && q.subtotalMinor > existing.priceCeilingMinor;
    if (!existing.reconsentRequiredAt && !aboveCap) return { ok: false, code: "already_on" };
    await c.query("update renewal_mandates set revoked_at = $2, revoked_by = 'reconsent' where id = $1 and revoked_at is null", [existing.id, now]);
  }
  const card = await c.query("select stripe_customer_id from orders where user_id = $1 and payment_method_ref = $2 and stripe_customer_id is not null order by created_at desc limit 1", [o.userId, p.payment_method_ref]);
  const ip = await ctx.pii.encrypt(o.ipPrefix, `consent_ip:${o.actionId}`);
  const retain = new Date(now.getTime() + MANDATE_RETAIN_MS);
  const consent = await c.query(
    `insert into consents (user_id, kind, document_hash, version, accepted_at, ip_enc, ua_family, assertion_action_id, domain_id, actor_kind, retain_until)
     values ($1,'auto_renew_mandate',$2,$3,$4,$5,$6,$7,$8,'user',$9) returning id`,
    [o.userId, hash, hash.slice(0, 12), now, ip, o.uaFamily, o.actionId, d.id, retain]);
  const ins = await c.query(
    `insert into renewal_mandates (domain_id, user_id, stripe_payment_method_ref, stripe_customer_ref, price_ceiling_minor, charge_days_before_expiry, text_hash, term_years, signed_action_id, consent_id, accepted_at, retain_until)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict do nothing returning *`,
    [d.id, o.userId, p.payment_method_ref, card.rows[0]?.stripe_customer_id ?? null, BigInt(String(p.price_ceiling_minor)), Number(p.charge_days_before_expiry), hash, Number(p.term_years), o.actionId, consent.rows[0].id, now, retain]);
  if (ins.rowCount !== 1) return { ok: false, code: "already_on" };
  await c.query("update domains set auto_renew = true where id = $1", [d.id]);
  await appendAudit(ctx, c, { chainId: o.userId, actorKind: "user", actorId: o.userId, action: "mandate.signed", resourceKind: "domain", resourceId: d.id, detail: { mandate_id: ins.rows[0].id, action_id: o.actionId } });
  await mailAutoRenewOn(ctx, c, d, ins.rows[0].id, BigInt(String(p.price_ceiling_minor)));
  return { ok: true, mandate: rowToMandate(ins.rows[0]) };
}

async function mailAutoRenewOn(ctx: AppContext, c: PoolClient, d: DomainRow, mandateId: string, ceiling: bigint): Promise<void> {
  const to = await customerAddresses(c, d.userId);
  if (to.length === 0 || !d.expiresAt) return;
  const { token } = await mintEmailActionToken(ctx, c, { userId: d.userId, purpose: "auto_renew_off", eventId: d.id, ttlMs: 400 * DAY_MS });
  const msg = buildMail("auto_renew_on", { fqdn: d.fqdn, ceilingMinor: ceiling.toString(), chargeAt: addDays(d.expiresAt, -CHARGE_DAYS_BEFORE_EXPIRY).toISOString(), offToken: token }, { to, dedupeKey: `auto_renew_on:${mandateId}`, userId: d.userId, origin: ctx.config.origin });
  await sendMail(c, ctx.email, msg);
}

/** One click, no passkey, no retention step (C-34). Idempotent: switching off a domain that is already off changes nothing. */
export async function disableAutoRenew(ctx: AppContext, c: PoolClient, o: { userId: string; domainId: string; by: "user" | "agent" | "email_link" | "system" }): Promise<{ changed: boolean; found: boolean }> {
  const d = await loadDomain(c, o.domainId);
  if (!d || d.userId !== o.userId) return { changed: false, found: false };
  const now = ctx.clock.now();
  const m = await c.query("update renewal_mandates set revoked_at = $2, revoked_by = $3 where domain_id = $1 and revoked_at is null returning id", [d.id, now, o.by]);
  const a = await c.query("update domains set auto_renew = false where id = $1 and auto_renew", [d.id]);
  if ((m.rowCount ?? 0) + (a.rowCount ?? 0) > 0) {
    await appendAudit(ctx, c, { chainId: o.userId, actorKind: o.by === "agent" ? "agent" : "user", actorId: o.userId, action: "mandate.revoked", resourceKind: "domain", resourceId: d.id, detail: { by: o.by } });
    // A charge not yet started is held off; one already made stays (the customer keeps what they paid for).
    await c.query("update renewal_terms set state = 'held', held_reason = 'auto_renew_off' where domain_id = $1 and state = 'scheduled'", [d.id]);
  }
  return { changed: (m.rowCount ?? 0) + (a.rowCount ?? 0) > 0, found: true };
}

