import type { PoolClient } from "@mosshatch/db";
import { RegistrarError, type RegistrarPort } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { floorMinor, reservedRenewalsMinor } from "../domains/gate.ts";
import { requireFundingAdmission, type FundingAdmissionLease } from "../registrar-rpc/funding-control.ts";
import type { OrderRow } from "./types.ts";

/** Commercial activation requires the new funding protocol on both deployments. Tests explicitly inject it. */
export function fundedAdmissionEnabled(ctx: AppContext): boolean { return ctx.services.fundedAdmission === true; }
export async function readFundingLease(ctx: AppContext, registrar: RegistrarPort): Promise<FundingAdmissionLease | null> {
  if (!fundedAdmissionEnabled(ctx)) return null;
  const lease = await requireFundingAdmission(registrar).beginFundingAdmission();
  if (!lease.available || lease.available.currency !== "usd" || (ctx.config.livemode && lease.available.source !== "live")) {
    await requireFundingAdmission(registrar).endFundingAdmission(lease.token).catch(() => undefined);
    throw new RegistrarError("unavailable", "verified funding unavailable", { retryable: false, outcomeUnknown: false, code: "funding_unverified" });
  }
  return lease;
}
export async function releaseFundingLease(registrar: RegistrarPort, lease: FundingAdmissionLease | null): Promise<void> {
  if (lease) await requireFundingAdmission(registrar).endFundingAdmission(lease.token).catch(() => { console.warn(JSON.stringify({ event: "funding_lease_release_failed" })); });
}

/**
 * Called after locking the order, inside the transaction that authorizes fulfillment or commits the off-session intent.
 * Vendor HTTP is complete and the shared vendor lease remains held. The DB lock also protects independent admission callers.
 */
export async function reserveFunding(ctx: AppContext, c: PoolClient, o: Pick<OrderRow, "id" | "quote">, lease: FundingAdmissionLease | null, opts: { excludeTermId?: string } = {}): Promise<boolean> {
  if (!lease) return true;
  // This transaction must finish well before the Redis lease can expire.
  if (!lease.available || lease.expiresAt.getTime() - ctx.clock.now().getTime() < 30_000) return false;
  await c.query("set local statement_timeout = '15s'");
  await c.query("set local idle_in_transaction_session_timeout = '15s'");
  await c.query("set local lock_timeout = '5s'");
  await c.query("select pg_advisory_xact_lock(727023)");
  const wholesale = BigInt(o.quote.wholesale_minor);
  const promised = BigInt((await c.query("select coalesce(sum(funding_reserved_minor),0)::text as s from orders where id <> $1", [o.id])).rows[0].s);
  const renewals = await reservedRenewalsMinor(c, ctx.clock.now(), { ...opts, excludeFunded: true });
  const floor = await floorMinor(c);
  if (lease.available.minor - promised - renewals - wholesale < floor) return false;
  await c.query("update orders set funding_reserved_minor = $2 where id = $1", [o.id, wholesale]);
  return true;
}
