import { RegistrarError } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { SELL_GATE_MIN_FUNDS_MINOR } from "../orders/types.ts";
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
export async function reservedRenewalsMinor(q: Q, now: Date, opts: { excludeTermId?: string } = {}): Promise<bigint> {
  const charged = (await q.query(
    "select coalesce(sum((quote->>'wholesale_minor')::bigint),0)::text as s from orders where kind = 'renew' and state = 'renewing_upstream'")).rows[0].s as string;
  const due = (await q.query(
    `select coalesce(sum(current_wholesale_minor),0)::text as s from renewal_terms
      where state in ('scheduled','held','charging','payment_failed') and charge_at <= $1 and ($2::uuid is null or id <> $2::uuid) and order_id is null`,
    [new Date(now.getTime() + RENEWAL_LOOKAHEAD_MS), opts.excludeTermId ?? null])).rows[0].s as string;
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
