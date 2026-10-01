import { tx } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { appendAudit } from "../audit.ts";
import { mintEmailActionToken } from "../auth/email-actions.ts";
import { sendMail } from "../email.ts";
import { buildMail } from "../mail/templates.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { customerAddresses } from "../orders/support.ts";
import { StripeError, type StripeEvent } from "../stripe/port.ts";
import { DAY_MS, svcOf } from "./common.ts";

/**
 * Saved cards (C-31, C-38). Mosshatch never sees a card number: it holds Stripe ids and reads only the brand.
 *
 *  - `payment_method.automatically_updated`: the card network replaced a saved card's details. Every live mandate on that card records
 *    the update and the person is emailed (bring them back on-session, C-38). When `previous_attributes` shows the brand changed, Stripe
 *    treats it as a new card, so the mandate waits for a fresh passkey signature (`reconsent_required`) and nothing is charged meanwhile.
 *  - `card.detach_sweep`: a card saved at checkout for an order that ended without a name (voided or failed) is detached from the Stripe
 *    customer, unless a live mandate or another live order still relies on it (C-31: "detach a saved card if the order is cancelled").
 */
export async function cardAutomaticallyUpdated(ctx: AppContext, ev: StripeEvent): Promise<{ mandates: number; brandChanged: boolean }> {
  const pm = ev.data.object as { id?: unknown; card?: { brand?: unknown } };
  if (typeof pm.id !== "string" || !/^pm_[A-Za-z0-9_]{1,100}$/.test(pm.id)) return { mandates: 0, brandChanged: false };
  const prev = (ev.data.previous_attributes?.card ?? {}) as { brand?: unknown };
  const brandChanged = typeof prev.brand === "string" && prev.brand !== pm.card?.brand;
  const now = ctx.clock.now();
  const rows = (await ctx.cron.query(
    "select m.id, m.domain_id, m.user_id, d.fqdn_ascii from renewal_mandates m join domains d on d.id = m.domain_id where m.stripe_payment_method_ref = $1 and m.revoked_at is null", [pm.id])).rows;
  for (const r of rows) {
    await tx(ctx.cron, async (c) => {
      const upd = await c.query(
        `update renewal_mandates set card_updated_at = $2, reconsent_required_at = case when $3 then coalesce(reconsent_required_at, $2) else reconsent_required_at end,
                reconsent_reason = case when $3 then 'card_brand_changed' else reconsent_reason end where id = $1 and revoked_at is null`, [r.id, now, brandChanged]);
      if (upd.rowCount !== 1) return;
      if (brandChanged) await c.query("update renewal_terms set state = 'held', held_reason = 'reconsent_required' where domain_id = $1 and state = 'scheduled'", [r.domain_id]);
      await appendAudit(ctx, c, { chainId: r.user_id, actorKind: "system", action: "mandate.card_updated", resourceKind: "domain", resourceId: r.domain_id, detail: { mandate_id: r.id, brand_changed: brandChanged } });
      const to = await customerAddresses(c, r.user_id);
      if (to.length === 0) return;
      const { token } = await mintEmailActionToken(ctx, c, { userId: r.user_id, purpose: "auto_renew_off", eventId: r.domain_id, ttlMs: 60 * DAY_MS });
      await sendMail(c, ctx.email, buildMail("card_updated", { fqdn: r.fqdn_ascii, brandChanged, offToken: token }, { to, dedupeKey: `card_updated:${ev.id}:${r.id}`, userId: r.user_id, origin: ctx.config.origin }));
    });
  }
  return { mandates: rows.length, brandChanged };
}

/** States in which a registration order ended without a name: its saved card has no further use. */
const ENDED_WITHOUT_NAME = ["voided", "registration_failed", "checkout_expired", "payment_failed"];

export async function cardDetachSweep(ctx: AppContext): Promise<{ detached: number; kept: number; errors: number }> {
  const out = { detached: 0, kept: 0, errors: 0 };
  const rows = (await ctx.cron.query(
    `select id, user_id, payment_method_ref from orders where kind = 'register' and save_card and payment_method_ref is not null and card_detached_at is null
        and state = any($1) order by created_at limit 100`, [ENDED_WITHOUT_NAME])).rows;
  const svc = svcOf(ctx);
  for (const r of rows) {
    const pm = r.payment_method_ref as string;
    // Still relied on: a live mandate, or another order of this person that saved the same card and holds a name.
    const inUse = (await ctx.cron.query(
      `select 1 from renewal_mandates where stripe_payment_method_ref = $1 and revoked_at is null
       union all select 1 from orders where payment_method_ref = $1 and id <> $2 and card_reusable and card_detached_at is null and state not in (select unnest($3::text[])) limit 1`,
      [pm, r.id, ENDED_WITHOUT_NAME])).rowCount;
    if (inUse) {
      await ctx.cron.query("update orders set card_reusable = false, card_detached_at = $2 where id = $1 and card_detached_at is null", [r.id, ctx.clock.now()]);
      out.kept++; continue;
    }
    try {
      await svc.stripe.detachPaymentMethod(pm, `detach:${pm}`);
    } catch (e) {
      if (!(e instanceof StripeError)) throw e;
      // Already detached (or never attached): nothing is left to remove. Anything else is retried next run.
      if (!(e.kind === "invalid_request" && (e.code === "payment_method_unexpected_state" || e.code === "resource_missing"))) {
        out.errors++;
        await tx(ctx.cron, (c) => raiseAlert(ctx, c, { severity: "warn", kind: "card_detach_failed", subject: r.id, detail: { order_id: r.id, code: e.code ?? e.kind } }));
        continue;
      }
    }
    await tx(ctx.cron, async (c) => {
      await c.query("update orders set card_reusable = false, card_detached_at = $3 where user_id = $1 and payment_method_ref = $2 and card_detached_at is null", [r.user_id, pm, ctx.clock.now()]);
      await appendAudit(ctx, c, { chainId: r.user_id, actorKind: "system", action: "card.detached", resourceKind: "order", resourceId: r.id, detail: {} });
    });
    out.detached++;
  }
  return out;
}
