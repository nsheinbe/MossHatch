import { tx, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { raiseAlert, raiseAlertOnce } from "../ops/alerts.ts";
import { billingRegion } from "./tax.ts";

/**
 * C-43 `sales_ledger`: every captured payment and every refund becomes one entry for its billing region and month, and the
 * (region, month) aggregate is updated in the same transaction. The job is idempotent by source (a payment or refund is
 * entered once) and only counts this deployment's Stripe mode. Integer cents throughout (C-42).
 *
 * - Region: the Checkout billing address stored on the payment; an off-session renewal (no Checkout) takes the region of
 *   the same person's latest payment that has one; anything still unknown is entered under `unknown` and an operator is told.
 * - Gross: the amount before the sales tax we collected (at least 23 states count gross sales including nontaxable
 *   revenue, so nontaxable sales are counted too). A refund is a negative entry, pro-rated for tax, with no transaction count.
 * - Nexus: rolling 12 calendar months per region against the thresholds below, with alerts at 60% and 80% (C-43) and at 100%.
 *   Thresholds come from Stripe's per-state pages and were statute-checked only for some states (C-43): they are config for
 *   the accountant, not legal advice, and Stripe's own monitor stays advisory.
 */
export interface NexusRule { salesMinor: bigint; txns: number | null; both: boolean }
const DEFAULT_RULE: NexusRule = { salesMinor: 10_000_000n, txns: null, both: false };
const TXN_200 = ["AR", "DC", "GA", "HI", "MD", "MI", "MN", "NE", "NV", "NJ", "OH", "PR", "RI", "VT", "VA", "WV"];
export const NEXUS_RULES: Record<string, NexusRule> = {
  "US-CA": { salesMinor: 50_000_000n, txns: null, both: false },
  "US-TX": { salesMinor: 50_000_000n, txns: null, both: false },
  // New York: over USD 500,000 AND more than 100 sales.
  "US-NY": { salesMinor: 50_000_000n, txns: 100, both: true },
  "US-AL": { salesMinor: 25_000_000n, txns: null, both: false },
  "US-MS": { salesMinor: 25_000_000n, txns: null, both: false },
  ...Object.fromEntries(TXN_200.map((s) => [`US-${s}`, { salesMinor: 10_000_000n, txns: 200, both: false }])),
};
export const nexusRule = (region: string): NexusRule => NEXUS_RULES[region] ?? DEFAULT_RULE;
export const NEXUS_ALERT_LEVELS = [0.6, 0.8, 1] as const;

const periodOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const BATCH = 500;

async function entry(c: PoolClient, e: { kind: "payment" | "refund"; id: string; region: string; at: Date; gross: bigint; tax: bigint; txn: 0 | 1; livemode: boolean }): Promise<boolean> {
  const period = periodOf(e.at);
  const ins = await c.query(
    `insert into sales_ledger_entries (source_kind, source_id, region, period, gross_minor, tax_minor, txn_delta, livemode, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (source_kind, source_id) do nothing returning id`,
    [e.kind, e.id, e.region, period, e.gross, e.tax, e.txn, e.livemode, e.at]);
  if (ins.rowCount !== 1) return false;
  await c.query(
    `insert into sales_ledger (state, period, gross_minor, tax_minor, txn_count, updated_at) values ($1,$2,$3,$4,$5,$6)
     on conflict (state, period) do update set gross_minor = sales_ledger.gross_minor + excluded.gross_minor, tax_minor = sales_ledger.tax_minor + excluded.tax_minor,
       txn_count = sales_ledger.txn_count + excluded.txn_count, updated_at = excluded.updated_at`,
    [e.region, period, e.gross, e.tax, e.txn, e.at]);
  return true;
}

export interface SalesLedgerResult { payments: number; refunds: number; unattributed: number; alerts: string[] }

export async function recordSales(ctx: Pick<AppContext, "cron" | "clock" | "config" | "services">): Promise<SalesLedgerResult> {
  const livemode = ctx.config.livemode;
  let payments = 0, refunds = 0, unattributed = 0;
  for (;;) {
    const rows = (await ctx.cron.query(
      `select p.id, p.user_id, p.amount_minor::text as amount, p.tax_minor::text as tax, p.billing_state, p.billing_country, p.captured_at,
              (select coalesce(q.billing_state, q.billing_country) from payments q where q.user_id = p.user_id and q.id <> p.id and (q.billing_state is not null or q.billing_country is not null)
                order by q.created_at desc limit 1) as fallback
         from payments p
        where p.livemode = $1 and p.status = 'succeeded' and p.captured_at is not null
          and not exists (select 1 from sales_ledger_entries e where e.source_kind = 'payment' and e.source_id = p.id)
        order by p.captured_at limit ${BATCH}`, [livemode])).rows;
    for (const r of rows) {
      const region = r.billing_state ?? billingRegion({ country: r.billing_country, state: null }) ?? (r.fallback as string | null) ?? "unknown";
      if (region === "unknown") unattributed++;
      const tax = BigInt(r.tax);
      const done = await tx(ctx.cron, (c) => entry(c, { kind: "payment", id: r.id, region, at: r.captured_at, gross: BigInt(r.amount) - tax, tax, txn: 1, livemode }));
      if (done) payments++;
    }
    if (rows.length < BATCH) break;
  }
  for (;;) {
    const rows = (await ctx.cron.query(
      `select r.id, r.amount_minor::text as amount, r.created_at, p.amount_minor::text as paid, p.tax_minor::text as paid_tax, e.region
         from refunds r join payments p on p.id = r.payment_id
         join sales_ledger_entries e on e.source_kind = 'payment' and e.source_id = p.id
        where p.livemode = $1 and not exists (select 1 from sales_ledger_entries x where x.source_kind = 'refund' and x.source_id = r.id)
        order by r.created_at limit ${BATCH}`, [livemode])).rows;
    for (const r of rows) {
      const amount = BigInt(r.amount), paid = BigInt(r.paid), paidTax = BigInt(r.paid_tax);
      const tax = paid > 0n ? (amount * paidTax) / paid : 0n;
      const done = await tx(ctx.cron, (c) => entry(c, { kind: "refund", id: r.id, region: r.region, at: r.created_at, gross: -(amount - tax), tax: -tax, txn: 0, livemode }));
      if (done) refunds++;
    }
    if (rows.length < BATCH) break;
  }
  if (unattributed) await raiseAlert(ctx, ctx.cron, { severity: "warn", kind: "sales.unattributed_region", subject: "sales_ledger", detail: { count: unattributed } });
  const alerts = await checkNexus(ctx);
  return { payments, refunds, unattributed, alerts };
}

export interface NexusReading { region: string; salesMinor: bigint; txns: number; progress: number }

/** Rolling 12 calendar months (this month and the 11 before it) per region. */
export async function nexusReadings(ctx: Pick<AppContext, "cron" | "clock">): Promise<NexusReading[]> {
  const now = ctx.clock.now();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const rows = (await ctx.cron.query(
    "select state, sum(gross_minor)::text as gross, sum(txn_count)::int as txns from sales_ledger where period >= $1 and state <> 'unknown' group by state order by state", [from])).rows;
  return rows.map((r) => {
    const rule = nexusRule(r.state), sales = BigInt(r.gross);
    const bySales = Number(sales * 10_000n / rule.salesMinor) / 10_000;
    const byTxns = rule.txns ? r.txns / rule.txns : 0;
    const progress = rule.both ? Math.min(bySales, byTxns) : Math.max(bySales, byTxns);
    return { region: r.state, salesMinor: sales, txns: r.txns, progress };
  });
}

async function checkNexus(ctx: Pick<AppContext, "cron" | "clock" | "services">): Promise<string[]> {
  const raised: string[] = [];
  for (const r of await nexusReadings(ctx)) {
    const level = [...NEXUS_ALERT_LEVELS].reverse().find((l) => r.progress >= l);
    const state = level === 1 ? "over" : level === 0.8 ? "watch_80" : level === 0.6 ? "watch_60" : "below";
    await ctx.cron.query("update tax_regions set threshold_state = $2, updated_at = $3 where state = $1 and threshold_state <> $2", [r.region, state, ctx.clock.now()]);
    if (!level) continue;
    const pct = Math.round(level * 100);
    const a = await raiseAlertOnce(ctx, ctx.cron, { severity: level === 1 ? "page" : "warn", kind: "tax.nexus_threshold", subject: `${r.region}:${pct}`,
      detail: { region: r.region, level_pct: pct, progress_bps: Math.round(r.progress * 10_000), txns: r.txns } });
    if (a.created) raised.push(`${r.region}:${pct}`);
  }
  return raised;
}
