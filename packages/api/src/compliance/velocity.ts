import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";

/**
 * New-account velocity and exposure limits (PLAN.md 4.6 row 37; own targets, all tunable through `flags`).
 * - Global: at most `limits.daily_registrations` registrations across all accounts in the trailing 24 hours.
 * - First 30 days of an account: at most USD 300 (`limits.new_account_exposure_minor`) of wholesale exposure in flight and
 *   `limits.new_account_daily_registrations` (5) registrations a day.
 * - `users.risk_state = 'review'`: an order above USD 50 wholesale (`limits.review_order_wholesale_minor`) waits for a person.
 * Run it inside the request's `withUser` transaction (or as the cron role) so the row-level security sees the account's own orders.
 */
export const NEW_ACCOUNT_DAYS = 30;
/** Order states that already hold wholesale exposure: authorized but not yet captured and settled. */
export const EXPOSURE_STATES = ["review_hold", "authorized", "registering", "registered", "capturing", "capture_failed", "outcome_unknown", "registrar_unavailable", "paid_before_registration", "renewing_upstream"];
/** Order states that never reached payment authorization and so do not count as a registration. */
const PRE_COMMIT_STATES = ["draft", "checkout_open", "checkout_expired", "payment_failed"];

export type VelocityReason = "global_daily_cap" | "global_total_cap" | "review_hold" | "new_account_daily_registrations" | "new_account_exposure" | "account_not_found";
export type VelocityDecision = { allowed: true; newAccount: boolean } | { allowed: false; reasons: VelocityReason[]; newAccount: boolean };

/**
 * The dogfood spend fuse (docs/GO-LIVE.md): a live process caps registrations below the flags so a bug cannot drain the registrar
 * balance. `daily` lowers `limits.daily_registrations` (trailing 24 hours, all accounts); `total` caps every registration ever
 * taken (with `limits.total_live_registrations`). Null means no extra cap. Read from the environment once at boot (`spendFuseFromEnv`).
 */
export interface SpendFuse { daily: number | null; total: number | null }
export const LIVE_DEFAULT_FUSE: SpendFuse = { daily: 3, total: 10 };
/** MH_LIVE_DAILY_REGISTRATIONS / MH_LIVE_TOTAL_REGISTRATIONS (whole numbers; 0 stops registrations). Live processes default to 3 a day and 10 in total. */
export function spendFuseFromEnv(env: Record<string, string | undefined>, livemode: boolean): SpendFuse {
  const num = (v: string | undefined, dflt: number | null) => (v !== undefined && /^\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : dflt);
  return { daily: num(env.MH_LIVE_DAILY_REGISTRATIONS, livemode ? LIVE_DEFAULT_FUSE.daily : null), total: num(env.MH_LIVE_TOTAL_REGISTRATIONS, livemode ? LIVE_DEFAULT_FUSE.total : null) };
}

/** The spend fuse `bootFromEnv` puts on the context; absent in tests that never set one. */
export const spendFuseOf = (ctx: Pick<AppContext, "services">): SpendFuse | undefined => (ctx.services as { spendFuse?: SpendFuse }).spendFuse;

async function flagNumber(c: PoolClient, name: string, dflt: number): Promise<number> {
  const v = (await c.query("select value from flags where name = $1", [name])).rows[0]?.value;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt;
}

export async function checkNewAccountLimits(c: PoolClient, userId: string, order: { wholesaleMinor: bigint; kind?: "register" | "renew" | "transfer_in" | "restore" }, now: Date, fuse?: SpendFuse): Promise<VelocityDecision> {
  const u = (await c.query("select created_at, risk_state from users where id = $1", [userId])).rows[0];
  if (!u) return { allowed: false, reasons: ["account_not_found"], newAccount: false };
  const newAccount = now.getTime() - new Date(u.created_at).getTime() < NEW_ACCOUNT_DAYS * 86_400_000;
  const since = new Date(now.getTime() - 86_400_000);
  const reasons: VelocityReason[] = [];
  const isRegistration = (order.kind ?? "register") === "register";

  const flagCap = await flagNumber(c, "limits.daily_registrations", 200);
  const cap = fuse?.daily != null ? Math.min(flagCap, fuse.daily) : flagCap;
  if (isRegistration) {
    const global = (await c.query("select velocity_global_registrations($1) as n", [since])).rows[0].n as number;
    if (global + 1 > cap) reasons.push("global_daily_cap");
    if (fuse?.total != null) {
      const totalCap = Math.min(fuse.total, await flagNumber(c, "limits.total_live_registrations", fuse.total));
      const total = (await c.query("select velocity_global_registrations($1) as n", [new Date(0)])).rows[0].n as number;
      if (total + 1 > totalCap) reasons.push("global_total_cap");
    }
  }
  if (u.risk_state === "review" && order.wholesaleMinor > BigInt(await flagNumber(c, "limits.review_order_wholesale_minor", 5000))) reasons.push("review_hold");
  if (newAccount) {
    if (isRegistration) {
      const perDay = await flagNumber(c, "limits.new_account_daily_registrations", 5);
      const n = (await c.query(`select count(*)::int as n from orders where user_id = $1 and kind = 'register' and created_at >= $2 and state <> all($3)`, [userId, since, PRE_COMMIT_STATES])).rows[0].n as number;
      if (n + 1 > perDay) reasons.push("new_account_daily_registrations");
    }
    const maxExposure = BigInt(await flagNumber(c, "limits.new_account_exposure_minor", 30000));
    const inFlight = BigInt((await c.query(`select coalesce(sum((quote->>'wholesale_minor')::bigint), 0)::text as s from orders where user_id = $1 and state = any($2)`, [userId, EXPOSURE_STATES])).rows[0].s);
    if (inFlight + order.wholesaleMinor > maxExposure) reasons.push("new_account_exposure");
  }
  return reasons.length ? { allowed: false, reasons, newAccount } : { allowed: true, newAccount };
}
