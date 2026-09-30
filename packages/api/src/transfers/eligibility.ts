import { RegistrarError, type TransferInCheck } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { ordersSvc } from "../orders/support.ts";
import { BLOCK_TEXT, blockMessage, LIVE_STATES } from "./policy.ts";

/**
 * RDAP `secureDNS.delegationSigned` (plan 4.3b DNSSEC: "Rescue reads RDAP at step 1"). The adapter's pre-check does not say whether DS
 * records exist at OpenSRS, so production plugs an RDAP client in here. `null` means "could not tell".
 */
export interface DnssecLookup { delegationSigned(fqdn: string): Promise<boolean | null> }
export interface TransfersServices { dnssec?: DnssecLookup }
export function transfersSvc(ctx: Pick<AppContext, "services">): TransfersServices {
  return ((ctx.services as { transfers?: TransfersServices }).transfers) ?? {};
}
export function installTransfers(ctx: AppContext, s: TransfersServices): TransfersServices {
  (ctx.services as Record<string, unknown>).transfers = s;
  return s;
}

export type BlockCode = keyof typeof BLOCK_TEXT;
export type Eligibility =
  | { ok: true; check: TransferInCheck; dnssecChecked: boolean }
  | { ok: false; reason: BlockCode; message: string; transferableFrom: Date | null };

const addYears = (d: Date, y: number) => { const n = new Date(d); n.setUTCFullYear(n.getUTCFullYear() + y); return n; };

/**
 * The pre-transfer check (ST-126), cheapest first: already here, a live transfer of the name, the registrar's own check, the ten-year
 * cap, then DNSSEC. Each refusal carries a plain sentence and, for the 60-day rules, the date they lift (C-06).
 */
export async function checkEligibility(ctx: AppContext, userId: string, fqdn: string, years: number): Promise<Eligibility> {
  const no = (reason: BlockCode, from: Date | null = null): Eligibility => ({ ok: false, reason, message: blockMessage(reason, from), transferableFrom: from });
  const here = (await ctx.cron.query("select user_id from domains where fqdn_ascii = $1 and released_at is null", [fqdn])).rows[0];
  if (here) return no(here.user_id === userId ? "already_yours" : "already_here");
  const live = (await ctx.cron.query("select 1 from transfers_in where fqdn_ascii = $1 and state = any($2) limit 1", [fqdn, [...LIVE_STATES]])).rowCount ?? 0;
  if (live > 0) return no("pending_transfer");

  let check: TransferInCheck;
  try { check = await ordersSvc(ctx).registrar.checkTransferIn(fqdn); }
  catch (e) {
    if (e instanceof RegistrarError && (e.kind === "maintenance" || e.kind === "unavailable" || e.kind === "rate_limited")) throw new HttpError(503, "registrar_unavailable", "Transfers are paused while our registrar is in maintenance. Nothing was charged.");
    if (e instanceof RegistrarError && e.code === "unsupported_tld") throw new HttpError(422, "unsupported_tld");
    throw e;
  }
  if (!check.transferable) return no(check.reason ?? "other", check.transferableAt ?? null);
  const now = ctx.clock.now();
  if (check.expiresAt && addYears(check.expiresAt, years) > addYears(now, 10)) return no("ten_year_cap");

  // A signed domain whose DS records follow it to a registrar that will not serve its zone stops resolving (plan 4.3b DNSSEC).
  let signed: boolean | null = check.dsPresent ?? null;
  if (signed === null && transfersSvc(ctx).dnssec) { try { signed = await transfersSvc(ctx).dnssec!.delegationSigned(fqdn); } catch { signed = null; } }
  if (signed === true) return no("dnssec");
  return { ok: true, check, dnssecChecked: signed === false };
}
