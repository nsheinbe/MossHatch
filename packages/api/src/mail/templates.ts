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
    // C-34: a notice about an automatic charge always carries the one-click turn-off link; the schema refuses one without it.
    klass: "C", schema: z.strictObject({ fqdn, stage: z.enum(["e43", "e32", "c8", "e_plus_1"]), expiresAt: iso, chargeAt: iso, priceMinor: digits, autoRenew: z.boolean(), offToken: actionToken.optional() })
      .refine((v) => !v.autoRenew || v.stage === "e_plus_1" || !!v.offToken),
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
    klass: "C", schema: z.strictObject({ fqdn, kind: z.enum(["known", "reminder"]), oldMinor: digits, newMinor: digits, chargeAt: iso, autoRenew: z.boolean(), aboveCap: z.boolean(), offToken: actionToken.optional() })
      .refine((v) => !v.autoRenew || !!v.offToken),
    link: { purpose: "auto_renew_off", field: "offToken", optional: true },
    render: (v, l) => {
      const hold = v.autoRenew && v.aboveCap ? `\nThe new price is above the limit you set for auto-renew, so we will not charge it. Sign in at ${l.home} and confirm again with your passkey, or renew by hand.\n` : "";
      const off = v.autoRenew && l.action ? `\nTurn auto-renew off with one click: ${l.action}\nThe link works once and needs no sign-in.\n` : "";
      const when21 = v.kind === "reminder" ? "In 21 days" : "For the next renewal";
      return { subject: `New renewal price for ${v.fqdn}`, text: `${when21}, on ${day(v.chargeAt)}, the renewal price for ${v.fqdn} changes from ${usd(v.oldMinor)} to ${usd(v.newMinor)} for one year, plus tax where it applies.\n${hold}${off}\nSign in at ${l.home} to see the details.\n` };
    },
  }),
  renewal_failed: def({
    klass: "C", schema: z.strictObject({ fqdn, priceMinor: digits, nextTryAt: iso.optional(), deadline: iso, expiresAt: iso, offToken: actionToken.optional() }),
    link: { purpose: "auto_renew_off", field: "offToken", optional: true },
    render: (v, l) => ({ subject: `Your card was declined for ${v.fqdn}`, text: `We could not charge ${usd(v.priceMinor)} to renew ${v.fqdn}.\n\n${v.nextTryAt ? `We try the card again on ${day(v.nextTryAt)}. ` : "We will not try the card again. "}You have until ${day(v.deadline)} to renew another way: sign in at ${l.home}, update your card or press Renew now.\n\nThe name expires on ${day(v.expiresAt)}.\n${l.action ? `\nTurn auto-renew off with one click: ${l.action}\nThe link works once and needs no sign-in.\n` : ""}` }),
  }),
  auto_renew_on: def({
    klass: "C", schema: z.strictObject({ fqdn, ceilingMinor: digits, chargeAt: iso, offToken: actionToken }),
    link: { purpose: "auto_renew_off", field: "offToken" },
    render: (v, l) => ({ subject: `Auto-renew is on for ${v.fqdn}`, text: `You turned auto-renew on for ${v.fqdn} with your passkey. Ten days before it expires, on ${day(v.chargeAt)} for the current term, we charge the renewal price to your saved card, up to ${usd(v.ceilingMinor)} for one year. We email you before every charge.\n\nTurn it off with one click: ${l.action}\nThe link works once and needs no sign-in. You can also turn it off at ${l.home}.\n` }),
  }),
  // ---- Phase 3 finish: the renewal receipt keeps the mandate terms and the one-click cancel (C-33, C-34); the card updater (C-38) ----
  renewal_receipt: def({
    klass: "C", schema: z.strictObject({ orderId: z.uuid(), fqdn, years: z.number().int().min(1).max(10), totalMinor: digits, taxMinor: digits, paidAt: iso, ceilingMinor: digits.optional(), expiresAt: iso.optional(), offToken: actionToken.optional() }),
    link: { purpose: "auto_renew_off", field: "offToken", optional: true },
    render: (v, l) => {
      const terms = v.ceilingMinor
        ? `\nYour auto-renew authorisation: each year, ten days before the name expires, we charge your saved card the renewal price, up to ${usd(v.ceilingMinor)} for one year. We email you before every charge. A higher price is never charged without your passkey.\n${l.action ? `Turn auto-renew off with one click: ${l.action}\nThe link works once and needs no sign-in. ` : ""}You can also turn it off at ${l.home}.\n`
        : "";
      return { subject: `Your Mosshatch renewal receipt for ${v.fqdn}`, text: `You paid to renew ${v.fqdn}.\n\nOrder: ${v.orderId}\nTerm: ${v.years} ${v.years === 1 ? "year" : "years"}\nTotal: ${usd(v.totalMinor)} (tax included: ${usd(v.taxMinor)})\nPaid: ${when(v.paidAt)}\n${v.expiresAt ? `The name now runs to ${day(v.expiresAt)} once the registry confirms it.\n` : ""}${terms}\nKeep this email as the record of your renewal and its terms.\n` };
    },
  }),
  card_updated: def({
    klass: "C", schema: z.strictObject({ fqdn, brandChanged: z.boolean(), offToken: actionToken.optional() }),
    link: { purpose: "auto_renew_off", field: "offToken", optional: true },
    render: (v, l) => {
      const off = l.action ? `\nTurn auto-renew off with one click: ${l.action}\nThe link works once and needs no sign-in.\n` : "";
      return v.brandChanged
        ? { subject: `Confirm auto-renew for ${v.fqdn}`, text: `Your bank replaced the card saved for ${v.fqdn} with a card of another kind. That is a new card, so we will not charge it until you agree again.\n\nSign in at ${l.home} and turn auto-renew on again with your passkey, or press Renew now to pay by hand. Until then the name is not renewed automatically.\n${off}` }
        : { subject: `Your saved card was updated for ${v.fqdn}`, text: `Your bank sent us new details for the card saved for ${v.fqdn}, such as a new expiry date. Auto-renew stays on with the same limit and the same dates. Nothing was charged.\n\nSign in at ${l.home} to review it.\n${off}` };
    },
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
  // ---- Transfers (Phase 5): Rescue (transfer-in) and the Gate (transfer-out). No template carries a link to act on a transfer. ----
  transfer_confirm_code: def({
    klass: "A", schema: z.strictObject({ code: z.string().regex(/^[A-Z0-9]{8}$/), fqdn, ttlMinutes: z.number().int().min(1).max(1440) }),
    render: (v) => ({ subject: `Confirm the transfer of ${v.fqdn} to Mosshatch`, text: `Enter this code on Mosshatch to confirm that you want to move ${v.fqdn} to Mosshatch: ${v.code}\n\nThe code works for ${v.ttlMinutes} minutes. If you did not start a transfer, ignore this email and nothing moves.\n` }),
  }),
  transfer_submitted: def({
    klass: "C", schema: z.strictObject({ fqdn, orderId: z.uuid(), stage: z.enum(["pending_owner", "pending_registry"]), deadline: iso, timing: z.enum(["standard", "registry"]) }),
    render: (v, l) => {
      const timing = v.timing === "registry" ? "The registry sets the timing and we cannot predict it." : "A transfer can take several days and sometimes about two weeks. It stays Traveling until the registry confirms.";
      const step = v.stage === "pending_owner"
        ? `Our registrar, OpenSRS, emailed the owner of ${v.fqdn} to confirm the transfer. Someone must confirm it there by ${when(v.deadline)}, or the transfer ends.`
        : `The registry asked the current registrar to release ${v.fqdn}. It has until ${when(v.deadline)} to answer, and silence counts as agreement.`;
      return { subject: `We asked for ${v.fqdn} to move to Mosshatch`, text: `${step}\n\n${timing} We take the payment when the name arrives, or before your card hold ends, and refund it in full if the transfer fails.\n\nOrder: ${v.orderId}\nSign in at ${l.home} to follow it.\n` };
    },
  }),
  transfer_completed: def({
    klass: "C", schema: z.strictObject({ fqdn, expiresAt: iso, transferableFrom: iso }),
    render: (v, l) => ({ subject: `Your domain ${v.fqdn} now lives at Mosshatch`, text: `The registry confirmed the transfer: ${v.fqdn} is now in your Mosshatch account. It runs to ${day(v.expiresAt)} and is locked.\n\nA name can move to another registrar again 60 days after a transfer, so from ${day(v.transferableFrom)}.\n\nSign in at ${l.home} to manage it.\n` }),
  }),
  transfer_failed: def({
    klass: "C", schema: z.strictObject({
      fqdn,
      reason: z.enum(["invalid_auth_code", "owner_declined", "owner_timeout", "nack", "registry_lock", "locked_at_losing", "cancelled_by_us", "unknown", "not_transferable", "quote_increased", "price_guard", "auth_window", "auth_lost", "no_contact", "registrar_rejected", "unknown_deadline", "unconfirmed", "review_refused", "payment_failed"]),
      nackReason: z.enum(["fraud", "identity_dispute", "non_payment", "owner_objection", "within_60_days_creation", "within_60_days_transfer", "udrp", "urs", "court_order", "tdrp", "cor_lock", "unstated"]).optional(),
      money: z.enum(["nothing_charged", "refunding"]),
    }),
    render: (v, l) => {
      const why: Record<string, string> = {
        invalid_auth_code: "The registry did not accept the transfer code. Get a new code from your current registrar and start again.",
        owner_declined: "The transfer was declined in the confirmation email from our registrar.", owner_timeout: "Nobody confirmed the transfer in the email from our registrar within five days.",
        nack: "Your current registrar refused the transfer.", registry_lock: "The registry had locked the name when the request arrived.", locked_at_losing: "The name was locked at its current registrar when the request arrived.",
        cancelled_by_us: "You cancelled the transfer.", unknown: "The transfer ended without completing.", not_transferable: "The name could not be transferred when we checked again.",
        quote_increased: "The price rose before we sent the request.", price_guard: "This name is not sold at our standard price.", auth_window: "We could not send the request inside the payment hold.",
        auth_lost: "Your card hold ended before we could send the request.", no_contact: "We need a registrant contact before we can transfer a name.", registrar_rejected: "Our registrar refused the request.",
        unknown_deadline: "We could not confirm that the transfer started.", unconfirmed: "The transfer was not confirmed in time.", review_refused: "Your card issuer or our fraud checks did not clear the payment.", payment_failed: "The payment did not go through.",
      };
      const denial: Record<string, string> = {
        fraud: "It reported evidence of fraud.", identity_dispute: "It reported a dispute over who holds the name.", non_payment: "It reported an unpaid past or current registration period.",
        owner_objection: "The current owner had asked it to refuse transfers.", within_60_days_creation: "The name was registered less than 60 days ago.", within_60_days_transfer: "The name moved to that registrar less than 60 days ago.",
        udrp: "A UDRP dispute is open against the name.", urs: "A URS case is open against the name.", court_order: "A court order stops the transfer.", tdrp: "A transfer dispute is open.", cor_lock: "The owner changed less than 60 days ago.", unstated: "It gave no reason we can show.",
      };
      const nack = v.reason === "nack" && v.nackReason ? ` ${denial[v.nackReason]}` : "";
      const money = v.money === "refunding" ? "We are refunding your payment in full. Your bank shows the refund in a few days." : "Nothing was charged. Any hold on your card disappears when your bank releases it.";
      return { subject: `The transfer of ${v.fqdn} did not complete`, text: `${why[v.reason]}${nack}\n\n${money} The name stays where it was.\n\nSign in at ${l.home} to start again.\n` };
    },
  }),
  transfer_away_started: def({
    klass: "B", schema: z.strictObject({ fqdn, requestedAt: iso, declineBy: iso, freezeToken: actionToken.optional() }),
    link: { purpose: "freeze", field: "freezeToken", optional: true },
    render: (v, l) => ({ subject: `A transfer of ${v.fqdn} to another registrar started`, text: `A transfer of ${v.fqdn} to another registrar started on ${when(v.requestedAt)}, after you unlocked it and took its transfer code with your passkey.\n\nOur registrar, OpenSRS, emails the registrant to confirm or decline it. Silence until ${when(v.declineBy)} counts as agreement. To keep the name, decline in that email or press Stop this transfer on the domain page.\n\n${notYou(l.action, "Sign in to follow the transfer.")}\n` }),
  }),
  transfer_denied: def({
    klass: "C", schema: z.strictObject({ fqdn, reason: z.enum(["fraud", "identity_dispute", "non_payment", "owner_objection", "within_60_days_creation", "within_60_days_transfer", "udrp", "urs", "court_order", "tdrp", "cor_lock"]) }),
    render: (v) => {
      const why: Record<string, string> = {
        fraud: "evidence of fraud", identity_dispute: "a dispute over who holds the name", non_payment: "an unpaid past or current registration period", owner_objection: "your standing instruction to refuse transfers",
        within_60_days_creation: "the name is less than 60 days old", within_60_days_transfer: "the name moved here less than 60 days ago", udrp: "an open UDRP dispute", urs: "an open URS case", court_order: "a court order", tdrp: "an open transfer dispute", cor_lock: "a change of registrant less than 60 days ago",
      };
      return { subject: `We refused a transfer of ${v.fqdn}`, text: `We asked our registrar to refuse the transfer of ${v.fqdn} to another registrar. The reason: ${why[v.reason]}.\n\nThis is one of the reasons the ICANN Transfer Policy allows or requires. If you think it is wrong, reply to this email or write to support@mosshatch.com.\n` };
    },
  }),
  // Account closure, export and erasure (closure module; design docs/design/account-closure-export-erasure.md, C-28).
  account_closing: def({
    klass: "B", schema: z.strictObject({ requestedAt: iso, coolingOffUntil: iso, domainCount: z.number().int().min(0).max(10_000) }),
    render: (v, l) => {
      const names = v.domainCount === 0 ? "" : `${v.domainCount === 1 ? "One name is" : `${v.domainCount} names are`} still in your account. After ${when(v.coolingOffUntil)} we ask the registry to delete ${v.domainCount === 1 ? "it" : "them"}, and deletion is final. To keep a name, sign in (which keeps your account open), transfer the name out, then close your account again.\n\n`;
      return { subject: "Your Mosshatch account is closing", text: `You asked to close your Mosshatch account on ${when(v.requestedAt)}. We signed out every session, revoked your tokens and connected apps, turned off auto-renew and took down your cards.\n\n${names}To keep your account, sign in with your passkey at ${l.home} before ${when(v.coolingOffUntil)}. Signing in cancels the closure.\n\nIf you did not ask for this, sign in now and write to security@mosshatch.com.\n` };
    },
  }),
  account_closure_cancelled: def({
    klass: "B", schema: z.strictObject({ at: iso }),
    render: (v) => ({ subject: "Your Mosshatch account stays open", text: `You signed in on ${when(v.at)}, so your account stays open and nothing more is deleted.\n\nWhat closing switched off stays off: sessions, tokens, connected apps, auto-renew and cards. Set up again the ones you need.\n` }),
  }),
  account_closed: def({
    klass: "B", schema: z.strictObject({ closedAt: iso }),
    render: (v) => ({ subject: "Your Mosshatch account is closed", text: `Your Mosshatch account closed on ${when(v.closedAt)}. We now erase your email addresses, contact details and passkeys, and we deleted your customer record at Stripe.\n\nThe law makes us keep receipts, payment records and the record of what you agreed to, under an account number instead of your name, until each one's retention ends. Our registrar, OpenSRS, keeps its own registration and payment records for 3 years. This is the last email we send you.\n` }),
  }),
  account_export_ready: def({
    klass: "B", schema: z.strictObject({ readyAt: iso, expiresAt: iso }),
    render: (v, l) => ({ subject: "Your Mosshatch data export is ready", text: `The copy of your account data you asked for is ready since ${when(v.readyAt)}.\n\nSign in at ${l.home}, open Your account and choose Download my data. The download works until ${when(v.expiresAt)}, and only while you are signed in.\n\nIf you did not ask for it, sign in and write to security@mosshatch.com.\n` }),
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
