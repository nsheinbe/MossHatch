import Stripe from "stripe";
import { withUser } from "@mosshatch/db";
import type { AppContext, Envelope } from "../ports.ts";
import { STRIPE_API_VERSION } from "../stripe/real.ts";

/**
 * Where an export file lives. Every method is safe to repeat. `put` and `get` run as the tenant (runtime role and RLS), so a store
 * bug cannot hand one person's file to another; `remove` is the system role's (expiry, closure, erasure).
 */
export interface ExportStore {
  put(ctx: AppContext, userId: string, exportId: string, data: Buffer): Promise<string>;
  get(ctx: AppContext, userId: string, exportId: string, ref: string): Promise<Buffer | null>;
  remove(ctx: AppContext, exportId: string, ref: string | null): Promise<void>;
}

const aad = (exportId: string, userId: string) => `account_export:${exportId}:${userId}`;

/**
 * The default store: the ZIP is encrypted under the PII key (design section 4: "encrypted at rest with the PII key") and kept in
 * `account_export_files`. Exports are small (a JSON file and a CSV per table), so a row is enough and no blob credential is needed.
 */
export class DbExportStore implements ExportStore {
  async put(ctx: AppContext, userId: string, exportId: string, data: Buffer): Promise<string> {
    const env = await ctx.pii.encrypt(data.toString("base64"), aad(exportId, userId));
    await withUser(ctx.runtime, userId, (c) => c.query(
      "insert into account_export_files (export_id, user_id, envelope, created_at) values ($1,$2,$3,$4) on conflict (export_id) do update set envelope = excluded.envelope, created_at = excluded.created_at",
      [exportId, userId, env, ctx.clock.now()]));
    return `db:${exportId}`;
  }
  async get(ctx: AppContext, userId: string, exportId: string, ref: string): Promise<Buffer | null> {
    if (ref !== `db:${exportId}`) return null;
    const row = (await withUser(ctx.runtime, userId, (c) => c.query("select envelope from account_export_files where export_id = $1 and user_id = $2", [exportId, userId]))).rows[0];
    if (!row) return null;
    return Buffer.from(await ctx.pii.decrypt(row.envelope as Envelope, aad(exportId, userId)), "base64");
  }
  async remove(ctx: AppContext, exportId: string): Promise<void> {
    await ctx.cron.query("delete from account_export_files where export_id = $1", [exportId]);
  }
}

/** Deleting the Stripe customer at closure (design section 5). Charges and refunds stay in Stripe's own ledger under its retention. */
export interface StripeCustomerEraser {
  /** "missing" when Stripe no longer has it (already deleted, or deleted before a restore brought our row back). */
  deleteCustomer(customerId: string): Promise<"deleted" | "missing">;
}

/**
 * The real eraser over stripe-node: `DELETE /v1/customers/{id}` (`stripe.customers.del`). NEVER CALLED in this repository (no Stripe
 * access from the build container); the documented behaviour it relies on is that deleting an already deleted customer answers
 * 404 `resource_missing`, which is treated as done. Built only after the StripeReal constructor has passed the mode guard.
 */
export class StripeCustomerEraserReal implements StripeCustomerEraser {
  private s: Pick<Stripe, "customers">;
  constructor(o: { apiKey: string; client?: Pick<Stripe, "customers"> }) {
    this.s = o.client ?? new Stripe(o.apiKey, { apiVersion: STRIPE_API_VERSION as never, maxNetworkRetries: 0, timeout: 20_000, appInfo: { name: "mosshatch" } });
  }
  async deleteCustomer(customerId: string): Promise<"deleted" | "missing"> {
    try {
      await this.s.customers.del(customerId);
      return "deleted";
    } catch (e) {
      const err = e as { code?: string; statusCode?: number };
      if (err.code === "resource_missing" || err.statusCode === 404) return "missing";
      // Class name and status only: a Stripe error message can carry the id.
      throw Object.assign(new Error("stripe_customer_delete_failed"), { name: "StripeCustomerDeleteError", code: err.code ?? `http_${err.statusCode ?? 0}` });
    }
  }
}

/** Faithful fake: a second delete of the same customer is `missing`, as Stripe answers. */
export class FakeStripeCustomers implements StripeCustomerEraser {
  deleted = new Set<string>();
  calls: string[] = [];
  failNext = 0;
  async deleteCustomer(customerId: string): Promise<"deleted" | "missing"> {
    this.calls.push(customerId);
    if (this.failNext > 0) { this.failNext--; throw Object.assign(new Error("stripe_customer_delete_failed"), { name: "StripeCustomerDeleteError", code: "http_500" }); }
    if (this.deleted.has(customerId)) return "missing";
    this.deleted.add(customerId);
    return "deleted";
  }
}

export interface ClosureServices {
  exportStore: ExportStore;
  /** Absent: the closure records `stripe_not_configured` and raises one alert; the row stays for the operator. */
  stripeCustomers?: StripeCustomerEraser;
}

const DEFAULT_STORE = new DbExportStore();

export function closureSvc(ctx: Pick<AppContext, "services">): ClosureServices {
  const s = (ctx.services as { closure?: Partial<ClosureServices> }).closure ?? {};
  return { exportStore: s.exportStore ?? DEFAULT_STORE, stripeCustomers: s.stripeCustomers };
}

export function installClosure(ctx: Pick<AppContext, "services">, s: Partial<ClosureServices>): ClosureServices {
  (ctx.services as { closure?: Partial<ClosureServices> }).closure = { ...((ctx.services as { closure?: Partial<ClosureServices> }).closure ?? {}), ...s };
  return closureSvc(ctx);
}

/**
 * Boot wiring. A Stripe secret key gets the real eraser (bootFromEnv builds StripeReal first, so the mode guard has already run on the
 * same key); local mode with the fake Stripe gets the fake. The Resend side needs nothing: Mosshatch sends transactional mail only and
 * creates no Resend contacts, so there is no contact to remove; Resend's message logs expire after 30 days (Privacy Notice).
 */
export function installClosureFromEnv(ctx: AppContext, env: Record<string, string | undefined>): ClosureServices {
  if (env.STRIPE_SECRET_KEY) return installClosure(ctx, { stripeCustomers: new StripeCustomerEraserReal({ apiKey: env.STRIPE_SECRET_KEY }) });
  if (ctx.config.mode === "local" && env.MH_FAKE_STRIPE === "1") return installClosure(ctx, { stripeCustomers: new FakeStripeCustomers() });
  return closureSvc(ctx);
}
