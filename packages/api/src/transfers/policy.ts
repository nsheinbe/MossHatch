import type { TransferDenialReason, TransferInBlock, TransferInFailure } from "@mosshatch/registrar/port";
import type { PoolClient } from "@mosshatch/db";
import { priceTableFor } from "../pricing/registrar.ts";

/**
 * Transfer policy in one place (C-01, C-06, C-10). Every number here is today's Transfer Policy text or an own target, and each is also a
 * `tld_policy` column or a flag, so a change of ICANN rules (the TAC recommendations have no effective date yet) is a data change.
 */
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
/** The default registrar's policy rows; each extension is read from its own registrar's rows (`priceTableFor`). */
export const REGISTRAR = "opensrs";

/** The registrant-email confirmation code (C-08 inbound): lifetime and tries (own targets). */
export const CONFIRM_TTL_MS = 30 * 60_000;
export const CONFIRM_MAX_ATTEMPTS = 5;
/** An unconfirmed transfer expires after a day (own target). */
export const UNCONFIRMED_TTL_MS = DAY_MS;
/** Upstream status is read every five minutes while a transfer is pending (plan jobs table: "transfers every 5 minutes"). */
export const POLL_EVERY_MS = 5 * 60_000;
/** A card hold lasts about seven days and a transfer can take about two weeks (C-06): the charge is taken at completion, or this long
 * before the hold ends if the transfer is still pending, and refunded if the transfer then fails. 48 hours stays clear of the 36-hour alarm. */
export const EARLY_CAPTURE_BEFORE_HOLD_END_MS = 48 * HOUR_MS;
/** An operation `sent` whose answer was not seen, with no status upstream after this long, is outcome-unknown (plan: 90 seconds). */
export const UNKNOWN_AFTER_MS = 90_000;
/** After giving up on an unknown submit, keep watching the name this long (plan: late_registration_watch, 14 days). */
export const LATE_WATCH_MS = 14 * DAY_MS;
/** C-09 / C-10: transfer log retention, 15 months. */
export const LOG_RETENTION_MS = 457 * DAY_MS;
/** New accounts (first 30 days) may start at most this many transfers-in a day (own target, flag `limits.new_account_daily_transfers`). */
export const NEW_ACCOUNT_DAILY_TRANSFERS = 5;

/** C-06 timing copy: never "instant", never a fixed cap, never a typical duration. */
export const TIMING_STANDARD = "A transfer can take several days and sometimes about two weeks. It stays Traveling until the registry confirms.";
export const TIMING_REGISTRY = "The registry sets the timing and we cannot predict it.";
export const timingFor = (tld: string) => (tld === "ai" || tld === "io" ? TIMING_REGISTRY : TIMING_STANDARD);

export interface TldTransferPolicy { tld: string; addYears: number; lockDays: number; ownerConfirmDays: number; registryWindowDays: number | null; longestSeenDays: number | null; profile: string }
export async function transferPolicy(c: Pick<PoolClient, "query">, tld: string): Promise<TldTransferPolicy | null> {
  const r = (await c.query(
    "select tld, transfer_add_years, transfer_lock_days, owner_confirm_days, registry_window_days, longest_seen_days, policy_profile from tld_policy where registrar = $1 and tld = $2",
    [priceTableFor(tld), tld])).rows[0];
  if (!r) return null;
  return { tld, addYears: r.transfer_add_years, lockDays: r.transfer_lock_days, ownerConfirmDays: r.owner_confirm_days, registryWindowDays: r.registry_window_days, longestSeenDays: r.longest_seen_days, profile: r.policy_profile };
}

/** Plain sentences for the pre-check (ST-126). `{date}` is filled with the day the rule lifts. */
export const BLOCK_TEXT: Record<TransferInBlock | "dnssec" | "ten_year_cap" | "already_yours", string> = {
  not_registered: "This name is not registered. You can register it instead.",
  already_here: "This name is already managed here.",
  already_yours: "This name is already in your account.",
  locked_at_losing: "The name is locked at its current registrar. Unlock it there, then try again.",
  registry_lock: "The registry has locked this name against transfers. Ask your current registrar to lift the registry lock.",
  too_new: "A name can move only 60 days after it was registered. You can transfer it from {date}.",
  recently_transferred: "A name can move only 60 days after its last transfer. You can transfer it from {date}.",
  pending_transfer: "A transfer of this name is already in progress.",
  redemption: "This name expired and is in redemption. Restore it at your current registrar first.",
  pending_delete: "The registry is deleting this name, so it cannot move.",
  dispute: "This name is under a dispute and cannot move until the dispute ends.",
  other: "The registry or the current registrar refused the check. Ask your current registrar why.",
  dnssec: "Your domain has DNSSEC records that would make it unreachable. Remove them first.",
  ten_year_cap: "A transfer adds a year, and this name is already registered close to the ten-year limit.",
};
export const blockMessage = (b: keyof typeof BLOCK_TEXT, date?: Date | null) => BLOCK_TEXT[b].replace("{date}", date ? date.toISOString().slice(0, 10) : "a later date");

/** Why a transfer ended, as stored in `transfers_in.failure`: the upstream failures plus the reasons we stop before or after submitting. */
export type TransferFailure = TransferInFailure | "not_transferable" | "quote_increased" | "price_guard" | "auth_window" | "auth_lost" | "no_contact"
  | "registrar_rejected" | "unknown_deadline" | "unconfirmed" | "review_refused" | "payment_failed";
export const FAILURE_TEXT: Record<TransferFailure, string> = {
  invalid_auth_code: "The registry did not accept the transfer code. Get a new code from your current registrar and start again.",
  owner_declined: "The transfer was declined in the confirmation email from our registrar.",
  owner_timeout: "Nobody confirmed the transfer in the email from our registrar within five days, so it ended.",
  nack: "Your current registrar refused the transfer.",
  registry_lock: "The registry had locked the name when the request arrived.",
  locked_at_losing: "The name was locked at its current registrar when the request arrived.",
  cancelled_by_us: "You cancelled the transfer.",
  unknown: "The transfer ended without completing.",
  not_transferable: "The name could not be transferred when we checked again before sending the request.",
  quote_increased: "The price rose before we sent the request, so we stopped. You can start again at the new price.",
  price_guard: "This name is not sold at our standard price, so we stopped.",
  auth_window: "We could not send the request inside the payment hold.",
  auth_lost: "Your card hold ended before we could send the request.",
  no_contact: "We need a registrant contact before we can transfer a name.",
  registrar_rejected: "Our registrar refused the request.",
  unknown_deadline: "We could not confirm that the transfer started, so we cancelled the payment hold.",
  unconfirmed: "The transfer was not confirmed in time.",
  review_refused: "Your card issuer or our fraud checks did not clear this payment.",
  payment_failed: "The payment did not go through.",
};
/** C-05: the reason a losing registrar gave, in plain words. */
export const DENIAL_TEXT: Record<TransferDenialReason, string> = {
  fraud: "It reported evidence of fraud.",
  identity_dispute: "It reported a dispute over who holds the name.",
  non_payment: "It reported that a past or current registration period was not paid.",
  owner_objection: "The current owner had asked it to refuse transfers.",
  within_60_days_creation: "The name was registered less than 60 days ago.",
  within_60_days_transfer: "The name moved to that registrar less than 60 days ago.",
  udrp: "A UDRP dispute is open against the name.",
  urs: "A URS case is open against the name.",
  court_order: "A court order stops the transfer.",
  tdrp: "A transfer dispute is open.",
  cor_lock: "The owner changed less than 60 days ago.",
  unstated: "It did not give a reason we can show.",
};
export const failureMessage = (f: string | null, nack?: string | null): string | null => {
  if (!f) return null;
  const base = (FAILURE_TEXT as Record<string, string>)[f] ?? FAILURE_TEXT.unknown;
  return f === "nack" && nack ? `${base} ${(DENIAL_TEXT as Record<string, string>)[nack] ?? DENIAL_TEXT.unstated}` : base;
};

/** States the customer sees. "completed" is written only after the adapter reported completion and the name read back as ours. */
export const LIVE_STATES = ["awaiting_payment", "submitting", "submitted", "pending_owner_approval", "pending_registry"] as const;
export const OPEN_STATES = ["awaiting_confirmation", ...LIVE_STATES] as const;
export const TERMINAL_STATES = ["completed", "failed", "nacked", "cancelled", "expired"] as const;
export type TransferState = (typeof OPEN_STATES)[number] | (typeof TERMINAL_STATES)[number];

export const STATE_TEXT: Record<TransferState, string> = {
  awaiting_confirmation: "Enter the code we sent to your registrant email to confirm the transfer.",
  awaiting_payment: "Pay on the checkout page. We hold the amount on your card and send the request right after.",
  submitting: "We are sending the transfer request to our registrar.",
  submitted: "Our registrar has the request. We are waiting for its first status.",
  pending_owner_approval: "Our registrar emailed the owner of the name. The transfer continues once someone confirms it there.",
  pending_registry: "The registry asked the current registrar to release the name. Silence for five days counts as agreement.",
  completed: "The name has moved to Mosshatch.",
  failed: "The transfer ended without completing.",
  nacked: "The current registrar refused the transfer.",
  cancelled: "The transfer was cancelled.",
  expired: "The transfer was not confirmed in time.",
};
