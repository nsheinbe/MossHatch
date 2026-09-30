import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { raiseAlertOnce } from "../ops/alerts.ts";
import type { StripeEvent } from "./port.ts";

/**
 * C-40 dispute-rate alarm. Each tier is config: the network whose ratio it reads, the ratio and event-count floors (both must
 * be reached), and the denominator. Sources (COMPLIANCE C-40, accessed 2026-09-29; the per-event fee is unverified):
 * - own target 0.5% (C-40 "alarm at 0.5%", PLAN 4.6 row 25): warns early, before any network program;
 * - Stripe reviews accounts from about 0.75%;
 * - Visa VAMP, Stripe-documented Non-compliant tier: 0.5% and 5 events, where Visa "may assess fees" (reachable at launch volume);
 * - Visa VAMP Excessive (US, since 1 Apr 2026): 1.5% and 1,500 events;
 * - Mastercard ECM: 100 chargebacks and 1.5%, against the previous month's transactions.
 * VAMP counts fraud reports (TC40, our early fraud warnings) plus disputes (TC15) over the month's settled transactions, and a
 * transaction in both counts twice; ECM counts chargebacks only.
 *
 * Brand attribution: a payment's brand comes from its latest charge; an event whose brand is unknown counts against every
 * network (a conservative numerator), and a network with no attributed transactions but some events reads as 100%.
 * Blended ratios (all cards) drive the own target and the Stripe line. All counts are Stripe-mode specific (`livemode`).
 */
export type DisputeNetwork = "all" | "visa" | "mastercard";
export interface DisputeTier {
  id: string;
  network: DisputeNetwork;
  minRatio: number;
  minEvents: number;
  severity: "warn" | "page";
  counts: "vamp" | "chargebacks";
  denominator: "same_month" | "previous_month";
}
export const DISPUTE_TIERS: DisputeTier[] = [
  { id: "own_target", network: "all", minRatio: 0.005, minEvents: 1, severity: "warn", counts: "vamp", denominator: "same_month" },
  { id: "stripe_review", network: "all", minRatio: 0.0075, minEvents: 1, severity: "page", counts: "vamp", denominator: "same_month" },
  { id: "visa_vamp_non_compliant", network: "visa", minRatio: 0.005, minEvents: 5, severity: "page", counts: "vamp", denominator: "same_month" },
  { id: "visa_vamp_excessive", network: "visa", minRatio: 0.015, minEvents: 1500, severity: "page", counts: "vamp", denominator: "same_month" },
  { id: "mastercard_ecm", network: "mastercard", minRatio: 0.015, minEvents: 100, severity: "page", counts: "chargebacks", denominator: "previous_month" },
];

const RISK_TYPES: Record<string, "dispute" | "early_fraud_warning"> = { "charge.dispute.created": "dispute", "radar.early_fraud_warning.created": "early_fraud_warning" };

/** Record a dispute or early fraud warning once per Stripe event (called from the verified webhook, inside its transaction). */
export async function recordRiskEvent(c: Pick<PoolClient, "query">, ev: StripeEvent, orderId: string | null): Promise<boolean> {
  const kind = RISK_TYPES[ev.type];
  if (!kind) return false;
  const o = ev.data.object as Record<string, any>;
  const brand = typeof o.payment_method_details?.card?.brand === "string" ? String(o.payment_method_details.card.brand).toLowerCase() : null;
  const r = await c.query(
    `insert into payment_risk_events (stripe_event_id, kind, payment_intent_id, order_id, card_brand, livemode, occurred_at)
     values ($1,$2,$3,$4,$5,$6,to_timestamp($7)) on conflict (stripe_event_id) do nothing`,
    [ev.id, kind, typeof o.payment_intent === "string" ? o.payment_intent : null, orderId, brand, !!ev.livemode, ev.created]);
  return (r.rowCount ?? 0) === 1;
}

export interface TierReading { tier: string; month: string; events: number; transactions: number; ratio: number; tripped: boolean }

const monthStart = (d: Date, delta = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1));
const label = (d: Date) => d.toISOString().slice(0, 7);

async function transactions(q: Pick<PoolClient, "query">, livemode: boolean, network: DisputeNetwork, from: Date, to: Date): Promise<number> {
  return (await q.query(
    `select count(*)::int as n from payments where livemode = $1 and status = 'succeeded' and captured_at >= $2 and captured_at < $3 and ($4 = 'all' or card_brand = $4)`,
    [livemode, from, to, network])).rows[0].n as number;
}
async function events(q: Pick<PoolClient, "query">, livemode: boolean, network: DisputeNetwork, counts: DisputeTier["counts"], from: Date, to: Date): Promise<number> {
  return (await q.query(
    `select count(*)::int as n from payment_risk_events e left join payments p on p.stripe_payment_intent_id = e.payment_intent_id
      where e.livemode = $1 and e.occurred_at >= $2 and e.occurred_at < $3 and ($4 = 'vamp' or e.kind = 'dispute')
        and ($5 = 'all' or coalesce(e.card_brand, p.card_brand) is null or coalesce(e.card_brand, p.card_brand) = $5)`,
    [livemode, from, to, counts, network])).rows[0].n as number;
}

/**
 * `stripe.dispute_rate` (hourly): read every tier for this month and the previous one (disputes on last month's charges keep
 * arriving) and raise one alert per tripped tier and month through ops/alerts (never repeated for the same tier and month).
 */
export async function checkDisputeRates(ctx: Pick<AppContext, "cron" | "clock" | "config" | "services">): Promise<TierReading[]> {
  const now = ctx.clock.now();
  const out: TierReading[] = [];
  for (const back of [0, -1]) {
    const from = monthStart(now, back), to = monthStart(now, back + 1);
    for (const t of DISPUTE_TIERS) {
      const dFrom = t.denominator === "previous_month" ? monthStart(now, back - 1) : from;
      const dTo = t.denominator === "previous_month" ? from : to;
      const n = await events(ctx.cron, ctx.config.livemode, t.network, t.counts, from, to);
      const d = await transactions(ctx.cron, ctx.config.livemode, t.network, dFrom, dTo);
      const ratio = d === 0 ? (n > 0 ? 1 : 0) : n / d;
      const tripped = n >= t.minEvents && ratio >= t.minRatio;
      out.push({ tier: t.id, month: label(from), events: n, transactions: d, ratio, tripped });
      if (tripped) {
        // One alert per tier and month, even after an operator closes it.
        await raiseAlertOnce(ctx, ctx.cron, { severity: t.severity, kind: "stripe.dispute_rate", subject: `${t.id}:${label(from)}`,
          detail: { tier: t.id, network: t.network, month: label(from), events: n, transactions: d, ratio_bps: Math.round(ratio * 10_000) } });
      }
    }
  }
  return out;
}
