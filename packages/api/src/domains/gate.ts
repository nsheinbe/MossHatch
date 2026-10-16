import { RegistrarError, type RegistrarPort } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { SELL_GATE_MIN_FUNDS_MINOR } from "../orders/types.ts";
import { defaultPriceTable } from "../pricing/registrar.ts";
import { DAY_MS, flagNumber, registrarOf, type Q } from "./common.ts";

/**
 * The sell gate (PLAN 4.3b "Empty prepaid balance", C-30, ST-109).
 *
 * `POST /orders` and the renewal scheduler refuse when available funds, less the wholesale already promised, fall below the floor
 * (USD 250, `flags.sell_gate.min_funds_minor`). Promised wholesale is: orders in authorized or registering; renewals already charged and
 * not yet renewed upstream; and renewals due within 14 days. Renewals rank AHEAD of new registrations: a registration is checked against
 * funds minus renewal reserves minus registration reserves, a renewal against funds minus renewal reserves only, so when money is short
 * registrations stop first and the renewals a customer already paid for still go through.
 */
export const RESERVING_REGISTER_STATES = ["review_hold", "authorized", "registering", "outcome_unknown", "registrar_unavailable", "paid_before_registration"];
export const RENEWAL_LOOKAHEAD_MS = 14 * DAY_MS;

export async function floorMinor(q: Q): Promise<bigint> { return flagNumber(q, "sell_gate.min_funds_minor", SELL_GATE_MIN_FUNDS_MINOR); }

/** Wholesale reserved for renewals: charged and waiting on the registrar, plus terms whose charge falls within 14 days. */
export async function reservedRenewalsMinor(q: Q, now: Date, opts: { excludeTermId?: string; excludeFunded?: boolean } = {}): Promise<bigint> {
  const charged = (await q.query(
    "select coalesce(sum((quote->>'wholesale_minor')::bigint),0)::text as s from orders where kind = 'renew' and state = 'renewing_upstream' and (not $1::boolean or funding_reserved_minor = 0)", [opts.excludeFunded ?? false])).rows[0].s as string;
  const due = (await q.query(
    `select coalesce(sum(current_wholesale_minor),0)::text as s from renewal_terms
      where state in ('scheduled','held','charging','payment_failed') and charge_at <= $1 and ($2::uuid is null or id <> $2::uuid) and (order_id is null or ($3::boolean and exists (select 1 from orders o where o.id = renewal_terms.order_id and o.kind = 'renew' and o.state = 'draft' and o.funding_reserved_minor = 0)))`,
    [new Date(now.getTime() + RENEWAL_LOOKAHEAD_MS), opts.excludeTermId ?? null, opts.excludeFunded ?? false])).rows[0].s as string;
  return BigInt(charged) + BigInt(due);
}
export async function reservedRegistrationsMinor(q: Q): Promise<bigint> {
  return BigInt((await q.query("select coalesce(sum((quote->>'wholesale_minor')::bigint),0)::text as s from orders where kind = 'register' and state = any($1)", [RESERVING_REGISTER_STATES])).rows[0].s as string);
}

export type GateVerdict = { ok: true; availableMinor: bigint | null; floorMinor: bigint } | { ok: false; reason: "below_floor" | "registrar_unavailable"; availableMinor: bigint | null; floorMinor: bigint };

/** Available funds at the registrar (balance less what it holds), or null when the adapter cannot say. */
export async function availableFunds(ctx: AppContext): Promise<bigint | null> {
  const r = registrarOf(ctx);
  if (!r.capabilities().funding) return null;
  return (await r.getBalance()).available.minor;
}

/** The lowest register wholesale in force across the extensions sold at the live registrar: what one registration needs at the least. Null when no row. */
export async function cheapestRegisterWholesale(q: Q, now: Date, registrar: string = defaultPriceTable()): Promise<bigint | null> {
  const r = (await q.query(
    `select min(amount_minor)::text as m from (select distinct on (tld) amount_minor from wholesale_prices where registrar = $1 and kind = 'register' and effective_from <= $2::date order by tld, effective_from desc) x`,
    [registrar, now])).rows[0]?.m as string | null | undefined;
  return r ? BigInt(r) : null;
}

/** The balance snapshot the hourly job wrote within the last two hours, or null. */
const SNAPSHOT_FRESH_MS = 2 * 3600_000;
export async function fundingSnapshot(q: Q, now: Date): Promise<{ availableMinor: bigint; reservedMinor: bigint } | null> {
  const s = (await q.query("select available_minor, reserved_renewals_minor, reserved_registrations_minor from registrar_balance_snapshots where at > $1 order by at desc limit 1", [new Date(now.getTime() - SNAPSHOT_FRESH_MS)])).rows[0];
  return s ? { availableMinor: BigInt(s.available_minor), reservedMinor: BigInt(s.reserved_renewals_minor) + BigInt(s.reserved_registrations_minor) } : null;
}

/**
 * Before checkout (the quote): can this registration be funded now, by the same arithmetic as `sellGate`? The hourly snapshot answers
 * first, with no registrar call; only when it says no is the registrar read live, so a top-up shows at once and an open gate costs
 * nothing. Null when the registrar cannot say (no funding capability, or a read that failed): the order path's own gate decides then.
 * 2026-10-08: the first live buyer reached Pay with USD 15.01 at the registrar, a USD 10.46 wholesale and a USD 5 floor; the sheet
 * had said nothing, and the refusal text sat below the fold.
 */
export async function fundingOpenFor(ctx: AppContext, registrar: RegistrarPort, wholesaleMinor: bigint): Promise<boolean | null> {
  if (!registrar.capabilities().funding) return null;
  const now = ctx.clock.now();
  const floor = await floorMinor(ctx.cron);
  const snap = await fundingSnapshot(ctx.cron, now);
  if (snap && snap.availableMinor - snap.reservedMinor - wholesaleMinor >= floor) return true;
  let funds: bigint;
  try { funds = (await registrar.getBalance()).available.minor; }
  catch (e) { if (e instanceof RegistrarError) return null; throw e; }
  const left = funds - await reservedRenewalsMinor(ctx.cron, now) - await reservedRegistrationsMinor(ctx.cron) - wholesaleMinor;
  return left >= floor;
}

export async function sellGate(ctx: AppContext, kind: "register" | "renew", wholesaleMinor: bigint, opts: { excludeTermId?: string } = {}): Promise<GateVerdict> {
  const floor = await floorMinor(ctx.cron);
  let funds: bigint | null;
  try { funds = await availableFunds(ctx); }
  catch (e) { if (e instanceof RegistrarError) return { ok: false, reason: "registrar_unavailable", availableMinor: null, floorMinor: floor }; throw e; }
  if (funds === null) return { ok: true, availableMinor: null, floorMinor: floor };
  const now = ctx.clock.now();
  const renewals = await reservedRenewalsMinor(ctx.cron, now, opts);
  const registrations = kind === "register" ? await reservedRegistrationsMinor(ctx.cron) : 0n;
  const left = funds - renewals - registrations - wholesaleMinor;
  return left < floor ? { ok: false, reason: "below_floor", availableMinor: funds, floorMinor: floor } : { ok: true, availableMinor: funds, floorMinor: floor };
}
