import { tx } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { appendAudit } from "../audit.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { eraseUser, purgeFromLedger, recordErasure, type ErasureLedger } from "../ops/erasure.ts";
import { closureSvc } from "./services.ts";

/**
 * Erasure (design sections 1 to 3, D-030, C-19, C-48).
 *
 * `eraseUser` (ops) deletes the identifying tables: addresses, contacts, passkeys, sessions, codes, tokens; it revokes bindings and
 * mandates and replaces the address with a placeholder. What it leaves, and what this module erases on top ("the residue"):
 *   - export files, tickets and storage references (an export is a full copy of the person's data);
 *   - free text the person chose: token names, and what they typed into a step-up (`actions.user_input`, `label` and `name` params);
 *   - the registrant contact envelopes of change-of-registrant drafts, network prefixes kept with agent requests, OAuth consents and
 *     device requests, and the hashes of their email addresses kept with domains and transfers;
 *   - Stripe's copies in the webhook log (a Checkout Session carries the buyer's email, name and address);
 *   - the Stripe customer itself (deleted at Stripe; `stripe_customers.deleted_at` records it).
 * Kept, as the law requires (C-19): orders, payments, refunds, consents, notices, mandates and the audit chain, all under opaque ids.
 *
 * Restore safety: every erasure is appended to the ledger OUTSIDE the database before anything is deleted. After any restore,
 * `replayErasures` re-applies the ledger (ops `purgeFromLedger`) and then this module's residue for every purged person, so an export
 * file, a Stripe customer or a token name that the restore brought back is erased again (design section 7, test 4; ST-143, ST-152).
 */

/** The ledger entry first, then the identifying tables, then the residue. Each step is idempotent. */
export async function eraseAccount(ctx: AppContext, ledger: ErasureLedger, userId: string, via: "closure" | "purge" = "closure"): Promise<{ erased: boolean }> {
  await recordErasure(ledger, userId, ctx.clock.now());
  const r = await eraseUser(ctx, userId, via);
  await eraseResidue(ctx, userId);
  return r;
}

/** Everything `eraseUser` leaves that names or reaches the person. Safe to run any number of times, for a purged person only. */
export async function eraseResidue(ctx: AppContext, userId: string): Promise<{ files: number; stripe: number }> {
  const now = ctx.clock.now();
  const store = closureSvc(ctx).exportStore;
  const who = (await ctx.cron.query("select status from users where id = $1", [userId])).rows[0];
  if (!who || who.status !== "purged") return { files: 0, stripe: 0 };
  const exports = (await ctx.cron.query("select id, storage_ref from account_exports where user_id = $1", [userId])).rows;
  for (const e of exports) await store.remove(ctx, e.id, e.storage_ref);
  const done = await tx(ctx.cron, async (c) => {
    const u = (await c.query("select status from users where id = $1 for update", [userId])).rows[0];
    if (!u || u.status !== "purged") return null;
    const files = await c.query("delete from account_export_files where user_id = $1", [userId]);
    await c.query("delete from account_export_tickets where user_id = $1", [userId]);
    await c.query(
      `update account_exports set storage_ref = null, file_deleted_at = coalesce(file_deleted_at, $2),
         state = case when state in ('requested','building') then 'cancelled' when state = 'ready' then 'expired' else state end
       where user_id = $1 and (storage_ref is not null or state in ('requested','building','ready'))`, [userId, now]);
    await c.query("update bindings set name = 'erased' where user_id = $1 and name <> 'erased'", [userId]);
    await c.query("update actions set user_input = null, params = params - 'label' - 'name' where user_id = $1 and (user_input is not null or params ? 'label' or params ? 'name')", [userId]);
    await c.query("update contact_changes set fields_enc = '{}'::jsonb where user_id = $1 and fields_enc <> '{}'::jsonb", [userId]);
    await c.query("update agent_requests set ip_prefix = null where user_id = $1 and ip_prefix is not null", [userId]);
    await c.query("update oauth_authorizations set ip_prefix = null, state_param = null where user_id = $1 and (ip_prefix is not null or state_param is not null)", [userId]);
    await c.query("update device_requests set ip_prefix = null, ua_family = null where user_id = $1 and (ip_prefix is not null or ua_family is not null)", [userId]);
    await c.query("update domains set owner_email_hash = null where user_id = $1 and owner_email_hash is not null", [userId]);
    await c.query("update transfers_in set confirm_email_hash = null where user_id = $1 and confirm_email_hash is not null", [userId]);
    await c.query("delete from security_notice_queue where user_id = $1", [userId]);
    // Stripe objects in the webhook log that belong to this person: matched by their customer, PaymentIntent and Checkout Session ids.
    await c.query(
      `insert into stripe_customers (user_id, stripe_customer_id, livemode)
       select distinct user_id, stripe_customer_id, livemode from orders where user_id = $1 and stripe_customer_id is not null
       on conflict (stripe_customer_id) do nothing`, [userId]);
    const ids = (await c.query(
      `select stripe_customer_id as id from stripe_customers where user_id = $1
       union select stripe_payment_intent_id from orders where user_id = $1 and stripe_payment_intent_id is not null
       union select stripe_checkout_session_id from orders where user_id = $1 and stripe_checkout_session_id is not null
       union select stripe_payment_intent_id from payments where user_id = $1`, [userId])).rows.map((r) => r.id as string).filter((x) => /^[A-Za-z0-9_]{6,255}$/.test(x));
    if (ids.length) await c.query("update webhook_events set payload = null where provider = 'stripe' and payload is not null and payload::text like any($1::text[])", [ids.map((i) => `%"${i}"%`)]);
    return { files: files.rowCount ?? 0 };
  });
  if (!done) return { files: 0, stripe: 0 };
  const stripe = await deleteStripeCustomers(ctx, userId);
  return { files: done.files, stripe };
}

/**
 * Delete every Stripe customer of the person (design section 5). "missing" counts as done: Stripe no longer has it, for example because
 * a restore brought back a row whose customer was deleted before. Failures leave `deleted_at` null for the next sweep and raise one alert.
 */
export async function deleteStripeCustomers(ctx: AppContext, userId: string): Promise<number> {
  const rows = (await ctx.cron.query("select id, stripe_customer_id from stripe_customers where user_id = $1 and deleted_at is null order by created_at", [userId])).rows;
  if (!rows.length) return 0;
  const eraser = closureSvc(ctx).stripeCustomers;
  if (!eraser) { await raiseAlert(ctx, ctx.cron, { severity: "warn", kind: "closure_stripe_not_configured", subject: userId, detail: { customers: rows.length } }); return 0; }
  let n = 0;
  for (const r of rows) {
    let outcome: "deleted" | "missing";
    try { outcome = await eraser.deleteCustomer(r.stripe_customer_id); }
    catch (e) {
      await raiseAlert(ctx, ctx.cron, { severity: "warn", kind: "stripe_customer_delete_failed", subject: r.id, detail: { row_id: r.id, code: (e as { code?: string }).code ?? "error" } });
      continue;
    }
    await tx(ctx.cron, async (c) => {
      const u = await c.query("update stripe_customers set deleted_at = $2 where id = $1 and deleted_at is null", [r.id, ctx.clock.now()]);
      if (u.rowCount === 1) { n++; await appendAudit(ctx, c, { chainId: userId, actorKind: "system", action: "stripe.customer_deleted", resourceKind: "stripe_customer", resourceId: r.id, detail: { outcome } }); }
    });
  }
  return n;
}

/** Purged people who still have residue: a restore brought it back, or a purge ran outside the closure flow. */
export async function residueSweep(ctx: AppContext, limit = 200): Promise<number> {
  const ids = (await ctx.cron.query(
    `select u.id from users u where u.status = 'purged' and (
        exists (select 1 from account_export_files f where f.user_id = u.id)
     or exists (select 1 from account_export_tickets t where t.user_id = u.id)
     or exists (select 1 from account_exports e where e.user_id = u.id and (e.storage_ref is not null or e.state in ('requested','building','ready')))
     or exists (select 1 from bindings b where b.user_id = u.id and b.name <> 'erased')
     or exists (select 1 from actions a where a.user_id = u.id and (a.user_input is not null or a.params ? 'label' or a.params ? 'name'))
     or exists (select 1 from stripe_customers s where s.user_id = u.id and s.deleted_at is null)
     or exists (select 1 from orders o where o.user_id = u.id and o.stripe_customer_id is not null and not exists (select 1 from stripe_customers s where s.stripe_customer_id = o.stripe_customer_id))
     or exists (select 1 from contact_changes k where k.user_id = u.id and k.fields_enc <> '{}'::jsonb)
     or exists (select 1 from domains d where d.user_id = u.id and d.owner_email_hash is not null)
    ) limit $1`, [limit])).rows.map((r) => r.id as string);
  let n = 0;
  for (const id of ids) { await eraseResidue(ctx, id); n++; }
  return n;
}

/**
 * The restore step (PLAN 4.3b restore runbook: "re-run retention.purge from the erasure ledger"): the ledger half from ops, then the
 * residue half from here. `account.closure` runs it on every sweep, so a restored database is repaired within the hour even if nobody
 * runs it by hand.
 */
export async function replayErasures(ctx: AppContext, ledger: ErasureLedger): Promise<{ ledgerEntries: number; erased: number; residue: number }> {
  const l = await purgeFromLedger(ctx, ledger);
  const residue = await residueSweep(ctx);
  return { ...l, residue };
}
