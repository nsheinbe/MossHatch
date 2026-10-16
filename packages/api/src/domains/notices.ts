import { tx, type PoolClient } from "@mosshatch/db";
import type { AppContext, EmailMessage } from "../ports.ts";
import { mintEmailActionToken } from "../auth/email-actions.ts";
import { sendMail } from "../email.ts";
import { buildMail } from "../mail/templates.ts";
import { customerAddresses } from "../orders/support.ts";
import { DAY_MS, HOUR_MS, rowToDomain, type DomainRow, renewalYears } from "./common.ts";
import { activeMandate } from "./mandate.ts";
import { renewalQuote, rowToTerm, type TermRow } from "./terms.ts";

/**
 * Notices (PLAN "Renewal-notice policy", C-26, C-32, C-33). Sent from the `notices` ledger: one row per (domain, kind, term), inserted in the
 * same transaction as the mail, so a repeat run sends nothing and a failed send leaves no row and is tried again.
 *
 *   renewal.notice      E-43, E-32 (also the ICANN first pre-expiry notice), C-8 = E-18 (before the E-10 charge), E+1 (the ICANN post-expiry notice)
 *   expiry.notice       the ICANN second pre-expiry notice at E-7, sent whether or not auto-renew is on (C-26, until counsel answers Q5)
 *   expiry.lastchance   E+7, E+21, E+35 while the name is still renewable
 *   price_change.notice as soon as a changed renewal price is seen, and again 21 days before the charge
 *
 * Each stage has a window that runs until the next stage begins, so a job that was down still sends the notice the person is due, once.
 */
export type RenewalStage = "e43" | "e32" | "c8" | "e_plus_1";
export const RENEWAL_STAGES: { stage: RenewalStage; from: number; to: number }[] = [
  { stage: "e43", from: -43, to: -32 }, { stage: "e32", from: -32, to: -18 }, { stage: "c8", from: -18, to: -10 }, { stage: "e_plus_1", from: 1, to: 6 },
];
export const LASTCHANCE_STAGES: { stage: "e7" | "e21" | "e35"; from: number; to: number }[] = [
  { stage: "e7", from: 7, to: 14 }, { stage: "e21", from: 21, to: 28 }, { stage: "e35", from: 35, to: 40 },
];
export const ICANN_E7 = { from: -7, to: -4 };
export const PRICE_REMINDER_DAYS = 21;

const inWindow = (now: Date, termEnd: Date, w: { from: number; to: number }) => {
  const t = now.getTime() - termEnd.getTime();
  return t >= w.from * DAY_MS && t < w.to * DAY_MS;
};
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const TEMPLATE_VERSION = "2026-10-a";
const RETAIN_NOTICE_MS = 3 * 365 * DAY_MS;

interface Ctx { ctx: AppContext; d: DomainRow; t: TermRow }

/** Write the ledger row and send the mail in one transaction. False when the row exists already or nobody can be mailed yet. */
async function once(x: Ctx, kind: string, termKey: string, stage: string, mk: (c: PoolClient, to: string[]) => Promise<EmailMessage>): Promise<boolean> {
  const { ctx, d } = x;
  return tx(ctx.cron, async (c) => {
    const ins = await c.query(
      "insert into notices (kind, domain_id, user_id, sent_at, template_version, retain_until, term_key, stage) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (domain_id, kind, term_key) where term_key is not null do nothing returning id",
      [kind, d.id, d.userId, ctx.clock.now(), TEMPLATE_VERSION, new Date(ctx.clock.now().getTime() + RETAIN_NOTICE_MS), termKey, stage]);
    if (ins.rowCount !== 1) return false;
    const to = await customerAddresses(c, d.userId);
    if (to.length === 0) throw new NoRecipient();
    const msg = await mk(c, to);
    await sendMail(c, ctx.email, msg);
    const log = await c.query("select id from email_log where dedupe_key = $1", [msg.dedupeKey]);
    if (log.rows[0]) await c.query("update notices set email_log_id = $2 where id = $1", [ins.rows[0].id, log.rows[0].id]);
    return true;
  }).catch((e) => { if (e instanceof NoRecipient) return false; throw e; });
}
class NoRecipient extends Error { override name = "NoRecipient"; }

async function loadTerms(ctx: AppContext, from: number, to: number): Promise<Ctx[]> {
  const now = ctx.clock.now();
  // A term is relevant from 45 days before its end to 45 days after.
  const rows = (await ctx.cron.query(
    `select t.*, to_jsonb(d) as dom from renewal_terms t join domains d on d.id = t.domain_id
      where d.released_at is null and t.term_end between $1 and $2 order by t.term_end, t.id`,
    [new Date(now.getTime() + from * DAY_MS), new Date(now.getTime() + to * DAY_MS)])).rows;
  return rows.map((r) => ({ ctx, t: rowToTerm(r), d: rowToDomain(r.dom) }));
}

async function offToken(ctx: AppContext, c: PoolClient, d: DomainRow): Promise<string> {
  return (await mintEmailActionToken(ctx, c, { userId: d.userId, purpose: "auto_renew_off", eventId: d.id, ttlMs: 60 * DAY_MS })).token;
}

// ---- renewal.notice --------------------------------------------------------------------------------------------------------------

export async function renewalNoticeJob(ctx: AppContext): Promise<number> {
  const now = ctx.clock.now();
  let sent = 0;
  for (const x of await loadTerms(ctx, -6, 45)) {
    const { d, t } = x;
    const renewedOrBeingRenewed = ["renewing", "renewed", "refunded", "skipped"].includes(t.state);
    for (const w of RENEWAL_STAGES) {
      if (!inWindow(now, t.termEnd, w)) continue;
      // Before expiry these are about what to do next: nothing to say once the name is renewed. After expiry only an unrenewed name.
      if (renewedOrBeingRenewed) continue;
      if (w.stage === "e_plus_1" && (d.expiresAt?.getTime() !== t.termEnd.getTime())) continue;
      const mandate = await activeMandate(ctx.cron, d.id);
      const ok = await once(x, `renewal.${w.stage}`, dayOf(t.termEnd), w.stage, async (c, to) => {
        const token = mandate && w.stage !== "e_plus_1" ? await offToken(ctx, c, d) : undefined;
        return buildMail("renewal_notice", {
          fqdn: d.fqdn, stage: w.stage, expiresAt: t.termEnd.toISOString(), chargeAt: t.chargeAt.toISOString(), priceMinor: t.currentPriceMinor.toString(),
          autoRenew: !!mandate && w.stage !== "e_plus_1", ...(token ? { offToken: token } : {}), years: renewalYears(d.tld),
        }, { to, dedupeKey: `notice:renewal.${w.stage}:${d.id}:${dayOf(t.termEnd)}`, userId: d.userId, origin: ctx.config.origin });
      });
      if (ok) sent++;
    }
  }
  return sent;
}

// ---- expiry.notice: the ICANN second notice at E-7, regardless of auto-renew ------------------------------------------------------

export async function expiryNoticeJob(ctx: AppContext): Promise<number> {
  const now = ctx.clock.now();
  let sent = 0;
  for (const x of await loadTerms(ctx, -6, 10)) {
    const { d, t } = x;
    if (!inWindow(now, t.termEnd, ICANN_E7) || t.state === "skipped" || t.state === "refunded") continue;
    // If the charge already renewed the name, say so instead of warning of an expiry that will not happen.
    const renewed = t.state === "renewed" && d.expiresAt && d.expiresAt > t.termEnd ? d.expiresAt : null;
    const ok = await once(x, "expiry.e7", dayOf(t.termEnd), "e7", async (_c, to) =>
      buildMail("expiry_notice", { fqdn: d.fqdn, stage: "e7", expiresAt: t.termEnd.toISOString(), ...(renewed ? { renewedThrough: renewed.toISOString() } : {}) },
        { to, dedupeKey: `notice:expiry.e7:${d.id}:${dayOf(t.termEnd)}`, userId: d.userId, origin: ctx.config.origin }));
    if (ok) sent++;
  }
  return sent;
}

// ---- expiry.lastchance: E+7, E+21, E+35 ---------------------------------------------------------------------------------------------

export async function expiryLastchanceJob(ctx: AppContext): Promise<number> {
  const now = ctx.clock.now();
  let sent = 0;
  for (const x of await loadTerms(ctx, -41, -6)) {
    const { d, t } = x;
    // Only a name that is still expired and renewable (not renewed elsewhere, not in redemption or deleted).
    if (d.expiresAt?.getTime() !== t.termEnd.getTime() || !["expired"].includes(d.state)) continue;
    for (const w of LASTCHANCE_STAGES) {
      if (!inWindow(now, t.termEnd, w)) continue;
      const ok = await once(x, `expiry.lastchance.${w.stage}`, dayOf(t.termEnd), w.stage, async (_c, to) =>
        buildMail("expiry_lastchance", { fqdn: d.fqdn, stage: w.stage, expiredAt: t.termEnd.toISOString(), priceMinor: t.currentPriceMinor.toString(), years: renewalYears(d.tld) },
          { to, dedupeKey: `notice:expiry.lastchance.${w.stage}:${d.id}:${dayOf(t.termEnd)}`, userId: d.userId, origin: ctx.config.origin }));
      if (ok) sent++;
    }
  }
  return sent;
}

// ---- price_change.notice ----------------------------------------------------------------------------------------------------------------

/** Refresh each open term's price at most daily; tell the person when it differs from what they were told, and again 21 days before the charge. */
export async function priceChangeNoticeJob(ctx: AppContext): Promise<{ known: number; reminders: number }> {
  const now = ctx.clock.now();
  const out = { known: 0, reminders: 0 };
  const rows = (await ctx.cron.query(
    `select t.*, to_jsonb(d) as dom from renewal_terms t join domains d on d.id = t.domain_id
      where d.released_at is null and t.state in ('scheduled','held') and t.term_end > $1 order by t.term_end, t.id`, [now])).rows;
  for (const r of rows) {
    let t = rowToTerm(r);
    const d = rowToDomain(r.dom);
    if (!t.priceCheckedAt || now.getTime() - t.priceCheckedAt.getTime() >= 23 * HOUR_MS) {
      const q = await tx(ctx.cron, (c) => renewalQuote(c, d.fqdn, now));
      if (q) {
        await ctx.cron.query("update renewal_terms set current_price_minor = $2, current_wholesale_minor = $3, price_checked_at = $4 where id = $1", [t.id, q.subtotalMinor, q.wholesaleMinor, now]);
        t = { ...t, currentPriceMinor: q.subtotalMinor, currentWholesaleMinor: q.wholesaleMinor, priceCheckedAt: now };
      }
    }
    const mandate = await activeMandate(ctx.cron, d.id);
    const x: Ctx = { ctx, d, t };
    const mail = (kind: "known" | "reminder", oldMinor: bigint) => async (c: PoolClient, to: string[]) => {
      const token = mandate ? await offToken(ctx, c, d) : undefined;
      return buildMail("price_change_notice", {
        fqdn: d.fqdn, kind, oldMinor: oldMinor.toString(), newMinor: t.currentPriceMinor.toString(), chargeAt: t.chargeAt.toISOString(), autoRenew: !!mandate,
        aboveCap: !!mandate && t.currentPriceMinor > mandate.priceCeilingMinor, ...(token ? { offToken: token } : {}), years: renewalYears(d.tld),
      }, { to, dedupeKey: `notice:price_change.${kind}:${d.id}:${dayOf(t.termEnd)}:${t.currentPriceMinor}`, userId: d.userId, origin: ctx.config.origin });
    };
    if (t.currentPriceMinor !== t.notifiedPriceMinor) {
      const ok = await once(x, "price_change.known", `${dayOf(t.termEnd)}:${t.currentPriceMinor}`, "known", mail("known", t.notifiedPriceMinor));
      if (ok) {
        await ctx.cron.query("update renewal_terms set notified_price_minor = $2, price_notice_at = $3 where id = $1", [t.id, t.currentPriceMinor, now]);
        out.known++;
      }
    }
    // The reminder 21 days before the charge, for any term whose price differs from what it started at.
    const remindFrom = t.chargeAt.getTime() - PRICE_REMINDER_DAYS * DAY_MS;
    if (t.currentPriceMinor !== t.baselinePriceMinor && now.getTime() >= remindFrom && now < t.chargeAt) {
      const ok = await once(x, "price_change.reminder", dayOf(t.termEnd), "reminder", mail("reminder", t.baselinePriceMinor));
      if (ok) out.reminders++;
    }
  }
  return out;
}
