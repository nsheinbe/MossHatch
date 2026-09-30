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
