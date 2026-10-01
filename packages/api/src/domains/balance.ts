import { tx } from "@mosshatch/db";
import { RegistrarError } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { closeAlerts, raiseAlert } from "../ops/alerts.ts";
import { floorMinor, reservedRegistrationsMinor, reservedRenewalsMinor } from "./gate.ts";
import { registrarOf } from "./common.ts";

/**
 * `registrar.balance` (hourly): read the prepaid balance, subtract what is already promised, record the snapshot and alert. The same
 * arithmetic drives the sell gate (gate.ts): when the snapshot says the gate is closed, `POST /orders` refuses and renewals wait.
 * A negative balance is a material breach of the reseller agreement (C-30) and pages at once.
 */
export interface BalanceResult { gateOpen: boolean; availableMinor: bigint; freeMinor: bigint; floorMinor: bigint }

export async function runBalanceCheck(ctx: AppContext): Promise<BalanceResult | null> {
  const reg = registrarOf(ctx);
  if (!reg.capabilities().funding) return null;
  let b;
  try { b = await reg.getBalance(); }
  catch (e) {
    if (e instanceof RegistrarError) { await tx(ctx.cron, (c) => raiseAlert(ctx, c, { severity: "warn", kind: "registrar_balance_unavailable", subject: "registrar", detail: { code: e.kind } })); return null; }
    throw e;
  }
  const now = ctx.clock.now();
  const floor = await floorMinor(ctx.cron);
  const renewals = await reservedRenewalsMinor(ctx.cron, now);
  const regs = await reservedRegistrationsMinor(ctx.cron);
  const free = b.available.minor - renewals - regs;
  const gateOpen = free >= floor;
  await tx(ctx.cron, async (c) => {
    await c.query(
      "insert into registrar_balance_snapshots (at, balance_minor, held_minor, available_minor, reserved_renewals_minor, reserved_registrations_minor, floor_minor, gate_open) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [now, b.balance.minor, b.held.minor, b.available.minor, renewals, regs, floor, gateOpen]);
    const state = { negative: b.balance.minor < 0n, renewalsShort: b.available.minor < renewals, gateClosed: !gateOpen, warn: free < floor * 2n };
    if (state.negative) await raiseAlert(ctx, c, { severity: "page", kind: "registrar_balance_negative", subject: "registrar", detail: { free_minor: free.toString() } }); else await closeAlerts(c, "registrar_balance_negative", "registrar");
    if (state.renewalsShort) await raiseAlert(ctx, c, { severity: "page", kind: "renewals_underfunded", subject: "registrar", detail: { available_minor: b.available.minor.toString(), reserved_minor: renewals.toString() } }); else await closeAlerts(c, "renewals_underfunded", "registrar");
    if (state.gateClosed) await raiseAlert(ctx, c, { severity: "page", kind: "sell_gate_closed", subject: "registrar", detail: { free_minor: free.toString(), floor_minor: floor.toString() } }); else await closeAlerts(c, "sell_gate_closed", "registrar");
    if (!state.gateClosed && state.warn) await raiseAlert(ctx, c, { severity: "warn", kind: "registrar_balance_low", subject: "registrar", detail: { free_minor: free.toString() } }); else await closeAlerts(c, "registrar_balance_low", "registrar");
  });
  return { gateOpen, availableMinor: b.available.minor, freeMinor: free, floorMinor: floor };
}
