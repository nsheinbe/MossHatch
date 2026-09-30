import { z } from "zod";
import type { EmailMessage } from "../ports.ts";

/**
 * Every email Phase 2 modules send (PLAN 4.6 rows 43; ST-149). Rules enforced here rather than trusted to callers:
 *  - each template takes a strict schema of formatted fields (no free text), so nothing can carry a vault secret,
 *    bearer token or approval link through a variable;
 *  - the only URLs in a body are `<origin>/api/v1/email-actions/<token>` (protective purposes only: freeze, recovery cancel,
 *    turn off auto-renew) and the bare site origin; a scan of the finished text refuses anything else;
 *  - plain text, sentence case, active voice, no apologies. A pay link is never emailed for agent flows: there is no template for one.
 */
export const EMAIL_ACTION_PURPOSES = ["freeze", "recovery_cancel", "auto_renew_off"] as const;
export type EmailActionPurpose = (typeof EMAIL_ACTION_PURPOSES)[number];

/** >= 128 bits of base64url. A bearer token (`mh_live_...+crc`) contains `+` and cannot match. */
const actionToken = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/).refine((s) => !/^mh_(live|cli|clr)_/.test(s));
const iso = z.iso.datetime();
const fqdn = z.string().max(253).regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/);
const digits = z.string().regex(/^\d{1,12}$/);
const ref8 = z.string().regex(/^[0-9a-f]{8}$/);
const hours = z.number().int().min(1).max(720);

export interface RenderedMail { subject: string; text: string }
interface Def<S extends z.ZodType> {
  klass: "A" | "B" | "C";
  schema: S;
  /** Present when the body carries an email-action link built from the token field `tokenField`. */
  link?: { purpose: EmailActionPurpose; field: string; optional?: boolean };
  render(v: z.infer<S>, l: { action: string | null; home: string }): RenderedMail;
}
const def = <S extends z.ZodType>(d: Def<S>): Def<S> => d;

const when = (s: string) => s.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, " UTC");
const day = (s: string) => s.slice(0, 10);
const usd = (minor: string) => { const n = minor.padStart(3, "0"); return `USD ${n.slice(0, -2)}.${n.slice(-2)}`; };
const notYou = (action: string | null, tail: string) => action ? `If this was not you, freeze your account with this link: ${action}\nThe link works once. ${tail}` : tail;

export const TEMPLATES = {
  signup_code: def({
    klass: "A", schema: z.strictObject({ code: z.string().regex(/^[A-Z0-9]{6,12}$/), ttlMinutes: z.number().int().min(1).max(1440) }),
    render: (v) => ({ subject: "Your Mosshatch sign-up code", text: `Your Mosshatch sign-up code is ${v.code}.\n\nEnter it within ${v.ttlMinutes} minutes. If you did not start a sign-up, ignore this email and nothing happens.\n` }),
  }),
  recovery_started: def({
    klass: "B", schema: z.strictObject({ coolingOffUntil: iso, cancelToken: actionToken }),
    link: { purpose: "recovery_cancel", field: "cancelToken" },
    render: (v, l) => ({ subject: "Account recovery started on your Mosshatch account", text: `Someone started account recovery on your Mosshatch account. Recovery finishes after a waiting period that ends ${when(v.coolingOffUntil)}.\n\nIf this was not you, cancel it now: ${l.action}\nCancelling needs no sign-in. The link works once.\n` }),
  }),
  recovery_completed: def({
    klass: "B", schema: z.strictObject({ holdUntil: iso }),
    render: (v) => ({ subject: "Account recovery finished on your Mosshatch account", text: `Account recovery finished, and a new passkey now protects your Mosshatch account. Sensitive changes stay on hold until ${when(v.holdUntil)}.\n\nIf this was not you, write to security@mosshatch.com now.\n` }),
  }),
  recovery_cancelled: def({
    klass: "B", schema: z.strictObject({}),
    render: () => ({ subject: "Account recovery cancelled on your Mosshatch account", text: "Someone cancelled account recovery on your Mosshatch account. Your account stays as it was.\n\nIf you did not cancel it, write to security@mosshatch.com.\n" }),
  }),
  credential_added: def({
    klass: "B", schema: z.strictObject({ credentialRef: ref8, at: iso, freezeToken: actionToken.optional() }),
    link: { purpose: "freeze", field: "freezeToken", optional: true },
    render: (v, l) => ({ subject: "A passkey was added to your Mosshatch account", text: `A passkey ending ${v.credentialRef} joined your Mosshatch account on ${when(v.at)}.\n\n${notYou(l.action, "Sign in and remove it, or write to security@mosshatch.com.")}\n` }),
  }),
  credential_removed: def({
    klass: "B", schema: z.strictObject({ credentialRef: ref8, at: iso, freezeToken: actionToken.optional() }),
    link: { purpose: "freeze", field: "freezeToken", optional: true },
    render: (v, l) => ({ subject: "A passkey was removed from your Mosshatch account", text: `The passkey ending ${v.credentialRef} left your Mosshatch account on ${when(v.at)}.\n\n${notYou(l.action, "Sign in to review your passkeys, or write to security@mosshatch.com.")}\n` }),
  }),
  address_changed: def({
    klass: "B", schema: z.strictObject({ change: z.enum(["added", "removed"]), addressKind: z.enum(["login", "second"]), at: iso, freezeToken: actionToken.optional() }),
    link: { purpose: "freeze", field: "freezeToken", optional: true },
    render: (v, l) => ({ subject: "A notification address changed on your Mosshatch account", text: `Someone ${v.change === "added" ? "added" : "removed"} a ${v.addressKind} notification address on your Mosshatch account on ${when(v.at)}.\n\n${notYou(l.action, "Sign in to review your addresses, or write to security@mosshatch.com.")}\n` }),
  }),
  freeze_link: def({
    klass: "B", schema: z.strictObject({ freezeToken: actionToken, expiresInHours: hours }),
    link: { purpose: "freeze", field: "freezeToken" },
    render: (v, l) => ({ subject: "Freeze your Mosshatch account", text: `Use this link to freeze your Mosshatch account: ${l.action}\n\nA freeze signs out every session and pauses every agent token. It does not unlock domains or change nameservers, and renewals continue. You unfreeze by signing in with a passkey.\n\nThe link works once and expires in ${v.expiresInHours} hours.\n` }),
  }),
  receipt: def({
    klass: "C", schema: z.strictObject({ orderId: z.uuid(), fqdn, years: z.number().int().min(1).max(10), totalMinor: digits, taxMinor: digits, paidAt: iso }),
    render: (v, l) => ({ subject: `Your Mosshatch receipt for ${v.fqdn}`, text: `You paid for ${v.fqdn}.\n\nOrder: ${v.orderId}\nTerm: ${v.years} ${v.years === 1 ? "year" : "years"}\nTotal: ${usd(v.totalMinor)} (tax included: ${usd(v.taxMinor)})\nPaid: ${when(v.paidAt)}\n\nSign in at ${l.home} to manage the domain.\n` }),
  }),
  void_notice: def({
    klass: "C", schema: z.strictObject({ orderId: z.uuid(), fqdn }),
    render: (v) => ({ subject: `Your order for ${v.fqdn} was voided`, text: `We voided your order for ${v.fqdn}, so nothing was charged. The hold on your card disappears when your bank releases it.\n\nOrder: ${v.orderId}\n` }),
  }),
  // ---- Domains core (Phase 3): renewal notices (D-008, C-26, C-32, C-33, C-34), price-change reminders and release ----
  renewal_notice: def({
    klass: "C", schema: z.strictObject({ fqdn, stage: z.enum(["e43", "e32", "c8", "e_plus_1"]), expiresAt: iso, chargeAt: iso, priceMinor: digits, autoRenew: z.boolean(), offToken: actionToken.optional() }),
    link: { purpose: "auto_renew_off", field: "offToken", optional: true },
    render: (v, l) => {
      const off = v.autoRenew && l.action ? `\nTurn auto-renew off with one click: ${l.action}\nThe link works once and needs no sign-in.\n` : "";
      const keep = `Renewal price: ${usd(v.priceMinor)} for one year, plus tax where it applies.`;
      if (v.stage === "e_plus_1") {
        return { subject: `Your domain ${v.fqdn} expired`, text: `${v.fqdn} expired on ${day(v.expiresAt)}. You can still renew it at ${l.home}. ${keep}\n\nIf nobody renews it, the registry holds it for a grace period, then in redemption where restoring costs more, and then deletes it.\n` };
      }
      if (v.autoRenew) {
        const lead = v.stage === "c8" ? "In 8 days" : v.stage === "e32" ? "About a month before it expires" : "Your renewal is coming up";
        return { subject: `Your domain ${v.fqdn} renews on ${day(v.chargeAt)}`, text: `${lead}: auto-renew is on for ${v.fqdn}. On ${day(v.chargeAt)} we charge ${usd(v.priceMinor)} to your saved card and renew the name for one year. It expires on ${day(v.expiresAt)}.\n${off}\nSign in at ${l.home} to renew sooner or to review the price.\n` };
      }
      return { subject: `Your domain ${v.fqdn} expires on ${day(v.expiresAt)}`, text: `${v.fqdn} expires on ${day(v.expiresAt)}. Auto-renew is off, so nothing renews unless you renew it.\n\nRenew it now at ${l.home}. ${keep}\n` };
    },
  }),
  expiry_notice: def({
    klass: "C", schema: z.strictObject({ fqdn, stage: z.enum(["e7"]), expiresAt: iso, renewedThrough: iso.optional() }),
    render: (v, l) => v.renewedThrough
      ? { subject: `Your domain ${v.fqdn} was renewed`, text: `${v.fqdn} was due to expire on ${day(v.expiresAt)}. We renewed it, and it now runs to ${day(v.renewedThrough)}. You need to do nothing.\n\nWe send this expiry notice to every address on your account, whether or not auto-renew is on.\n\nSign in at ${l.home} for details.\n` }
      : { subject: `Your domain ${v.fqdn} expires in about a week`, text: `${v.fqdn} expires on ${day(v.expiresAt)}. Renew it at ${l.home} to keep it.\n\nWe send this expiry notice to every address on your account, whether or not auto-renew is on.\n` },
  }),
  expiry_lastchance: def({
    klass: "C", schema: z.strictObject({ fqdn, stage: z.enum(["e7", "e21", "e35"]), expiredAt: iso, priceMinor: digits }),
    render: (v, l) => {
      const days = v.stage === "e7" ? 7 : v.stage === "e21" ? 21 : 35;
      return { subject: `Last chance to renew ${v.fqdn}`, text: `${v.fqdn} expired ${days} days ago, on ${day(v.expiredAt)}. You can still renew it for ${usd(v.priceMinor)} plus tax where it applies. Renew at ${l.home}.\n\nWhen the grace period ends the name goes into redemption, where restoring costs more, and then the registry deletes it. Email at the domain stops working while it is expired.\n` };
    },
  }),
  price_change_notice: def({
    klass: "C", schema: z.strictObject({ fqdn, kind: z.enum(["known", "reminder"]), oldMinor: digits, newMinor: digits, chargeAt: iso, autoRenew: z.boolean(), aboveCap: z.boolean(), offToken: actionToken.optional() }),
    link: { purpose: "auto_renew_off", field: "offToken", optional: true },
    render: (v, l) => {
      const hold = v.autoRenew && v.aboveCap ? `\nThe new price is above the limit you set for auto-renew, so we will not charge it. Sign in at ${l.home} and confirm again with your passkey, or renew by hand.\n` : "";
      const off = v.autoRenew && l.action ? `\nTurn auto-renew off with one click: ${l.action}\nThe link works once and needs no sign-in.\n` : "";
      const when21 = v.kind === "reminder" ? "In 21 days" : "For the next renewal";
      return { subject: `New renewal price for ${v.fqdn}`, text: `${when21}, on ${day(v.chargeAt)}, the renewal price for ${v.fqdn} changes from ${usd(v.oldMinor)} to ${usd(v.newMinor)} for one year, plus tax where it applies.\n${hold}${off}\nSign in at ${l.home} to see the details.\n` };
    },
  }),
  renewal_failed: def({
    klass: "C", schema: z.strictObject({ fqdn, priceMinor: digits, nextTryAt: iso.optional(), deadline: iso, expiresAt: iso }),
    render: (v, l) => ({ subject: `Your card was declined for ${v.fqdn}`, text: `We could not charge ${usd(v.priceMinor)} to renew ${v.fqdn}.\n\n${v.nextTryAt ? `We try the card again on ${day(v.nextTryAt)}. ` : "We will not try the card again. "}You have until ${day(v.deadline)} to renew another way: sign in at ${l.home}, update your card or press Renew now.\n\nThe name expires on ${day(v.expiresAt)}.\n` }),
  }),
  auto_renew_on: def({
    klass: "C", schema: z.strictObject({ fqdn, ceilingMinor: digits, chargeAt: iso, offToken: actionToken }),
    link: { purpose: "auto_renew_off", field: "offToken" },
    render: (v, l) => ({ subject: `Auto-renew is on for ${v.fqdn}`, text: `You turned auto-renew on for ${v.fqdn} with your passkey. Ten days before it expires, on ${day(v.chargeAt)} for the current term, we charge the renewal price to your saved card, up to ${usd(v.ceilingMinor)} for one year. We email you before every charge.\n\nTurn it off with one click: ${l.action}\nThe link works once and needs no sign-in. You can also turn it off at ${l.home}.\n` }),
  }),
  renewal_refunded: def({
    klass: "C", schema: z.strictObject({ fqdn, totalMinor: digits, expiresAt: iso }),
    render: (v, l) => ({ subject: `We refunded your renewal of ${v.fqdn}`, text: `We charged ${usd(v.totalMinor)} to renew ${v.fqdn}, but the registrar did not complete the renewal before the day it expires, so we refunded the full amount. Your bank shows the refund in a few days.\n\nThe name expires on ${day(v.expiresAt)}. Sign in at ${l.home} and press Renew now to try again.\n` }),
  }),
  domain_released: def({
    klass: "C", schema: z.strictObject({ fqdn, cause: z.enum(["lapsed", "transferred_out", "unpaid", "refunded", "account_closed", "deleted"]), holdUntil: iso }),
    render: (v, l) => {
      const why = { lapsed: "expired and the registry deleted it", transferred_out: "moved to another registrar", unpaid: "could not be paid for", refunded: "was refunded", account_closed: "left when your account closed", deleted: "was deleted" }[v.cause];
      return { subject: `Your domain ${v.fqdn} left your account`, text: `${v.fqdn} ${why}, so it has left your account. Its agent tokens are revoked, its auto-renew is off and its card is unpublished.\n\nYou can export its record until ${day(v.holdUntil)}. After that we destroy the secrets and settings stored for it. Sign in at ${l.home} to export.\n` };
    },
  }),
} as const;

export type MailKind = keyof typeof TEMPLATES;
export const MAIL_KINDS = Object.keys(TEMPLATES) as MailKind[];
export type MailVars<K extends MailKind> = z.input<(typeof TEMPLATES)[K]["schema"]>;

export class MailRenderError extends Error {
  override name = "MailRenderError";
  constructor(public code: string) { super(code); }
}

const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
const URL_RE = /https?:\/\/[^\s)>"'<]+/gi;
const BEARER_RE = /mh_(live|cli|clr)_/i;

/** The last line of defence: whatever the template produced, only allowed URLs and no token-shaped strings. */
export function assertMailSafe(parts: RenderedMail, origin: string, allowedLink: string | null): void {
  for (const s of [parts.subject, parts.text]) {
    if (BEARER_RE.test(s)) throw new MailRenderError("bearer_token_in_mail");
    for (const u of s.match(URL_RE) ?? []) {
      const clean = u.replace(/[.,;:]+$/, "");
      if (clean === origin || clean === origin + "/") continue;
      if (allowedLink && clean === allowedLink) continue;
      throw new MailRenderError("disallowed_url_in_mail");
    }
    if (/approv(e|al)/i.test(s) && /https?:\/\//i.test(s) && !allowedLink) throw new MailRenderError("approval_link_in_mail");
  }
  if (parts.subject.includes("\n")) throw new MailRenderError("subject_newline");
}

export const actionLink = (origin: string, token: string) => `${origin}/api/v1/email-actions/${token}`;

export function renderMail<K extends MailKind>(kind: K, vars: MailVars<K>, opts: { origin?: string } = {}): RenderedMail & { klass: "A" | "B" | "C" } {
  const t = TEMPLATES[kind] as unknown as Def<z.ZodType>;
  if (!t) throw new MailRenderError("unknown_template");
  const origin = opts.origin ?? "https://mosshatch.com";
  if (!ORIGIN_RE.test(origin)) throw new MailRenderError("bad_origin");
  const parsed = t.schema.safeParse(vars);
  if (!parsed.success) throw new MailRenderError("invalid_variables");
  let action: string | null = null;
  if (t.link) {
    const tok = (parsed.data as Record<string, unknown>)[t.link.field];
    if (typeof tok === "string") action = actionLink(origin, tok);
    else if (!t.link.optional) throw new MailRenderError("invalid_variables");
  }
  const out = t.render(parsed.data, { action, home: origin });
  assertMailSafe(out, origin, action);
  return { ...out, klass: t.klass };
}

/** Render and wrap as an EmailMessage for `sendMail`. `to` is resolved by the caller from notification_addresses at send time. */
export function buildMail<K extends MailKind>(kind: K, vars: MailVars<K>, m: { to: string[]; dedupeKey: string; userId?: string; origin?: string }): EmailMessage {
  const r = renderMail(kind, vars, { origin: m.origin });
  return { kind, dedupeKey: m.dedupeKey, userId: m.userId, to: m.to, subject: r.subject, text: r.text, klass: r.klass };
}
