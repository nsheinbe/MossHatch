import { startAuthentication } from "@simplewebauthn/browser";
import { api, ApiError } from "./api";
import { explain } from "./account";
import type { DomainSummary, EggSummary } from "./groveState";

// ---- read models ---------------------------------------------------------------------------------------------------------------------

export interface DomainDetail extends DomainSummary {
  nameservers: string[]; ds_present: boolean; dns_hosted_here: boolean; dispute_lock_state: string | null; transfer_away: boolean;
  registry_statuses: string[]; released: { at: string | null } | null;
  renewal: DomainSummary["renewal"] & { state: string | null; held_reason: string | null; price_ceiling_minor: string | null; currency: string };
  mandate: { accepted_at: string | null; price_ceiling_minor: string; term_years: number; charge_days_before_expiry: number } | null;
  /** The accredited registrar that holds the registration. */
  registrar?: { name: string; short: string; iana_id: number };
  /** When the owner first changed this name's DNS records or nameservers here, or null. */
  connected_at?: string | null;
}
export interface Security {
  domain: string; state: string; attention: { kind: string; message: string } | null; locked: boolean;
  dispute_lock: { state: string; message: string } | null; transfer_lock_until: string | null;
  transfer_code: { issued_at: string | null; replaced: boolean; replace_at: string | null };
  nameservers: string[]; dns_hosted_here: boolean; ds_present: boolean;
  contact_change: { id: string; state: string; registrant_change: boolean; approval_deadline_at: string | null } | null;
  registrant_verification: { state: string; reason: string; deadline_at: string | null; verified_at: string | null } | null;
  account_frozen: boolean; registrar_writes_paused: boolean;
}
export interface TransferState {
  domain: string; state: "none" | "requested" | "unrequested" | "stopped_pending"; stop_available: boolean; note: string | null; message: string | null; timing: string;
  /** False where transfers away cannot be watched automatically: "none" then means none seen. */
  tracked?: boolean;
  transfers: { id: string; gaining_registrar: string | null; requested_at: string | null; requested_by_you: boolean }[];
}
export interface DnsRecordView { id: string; type: string; name: string; value: string; priority?: number; weight?: number; port?: number; sensitive: boolean; reasons: string[] }
export interface DnsView { domain: string; hosted: boolean; read_only: boolean; records: DnsRecordView[]; nameservers?: string[]; message?: string; snapshots: number }
export interface Snapshot { id: string; reason: string; added: number; removed: number; sensitive: number; taken_at: string; rolled_back_at: string | null }
export interface DsView { supported: boolean; note: string; records: { keyTag: number; algorithm: number; digestType: number; digest: string }[]; ds_present: boolean }
export interface LedgerEntry {
  order_id: string; kind: string; fqdn: string; state: string; years: number; subtotal_minor: string; total_minor: string; charged_minor: string | null; tax_minor: string | null;
  refunded_minor: string; payment_status: string | null; dispute: string | null; captured_at: string | null; created_at: string; domain_id: string | null;
}
export interface LedgerRefund { id: string; order_id: string; amount_minor: string; reason: string | null; created_at: string }

const enc = encodeURIComponent;
export const listDomains = () => api<{ domains: DomainSummary[]; eggs: EggSummary[] }>("GET", "/api/v1/domains");
export const getDomain = (id: string) => api<DomainDetail>("GET", `/api/v1/domains/${enc(id)}`);
export const getLedger = () => api<{ entries: LedgerEntry[]; refunds: LedgerRefund[] }>("GET", "/api/v1/ledger");
/** `consent`: the auto-renew authorisation hash, sent only when its box is ticked; a Checkout for this renewal then also saves the card. */
export const renewNow = (id: string, consent?: string) => api<{ status: string; order_id: string; checkout_url?: string }>("POST", `/api/v1/domains/${enc(id)}/renew`, consent ? { auto_renew_consent: consent } : {});
export const autoRenewOff = (id: string) => api<{ auto_renew: false }>("DELETE", `/api/v1/domains/${enc(id)}/auto-renew`);
export const refundOrder = (orderId: string) => api("POST", `/api/v1/orders/${enc(orderId)}/refund`, { confirm_delete: true });

const D = (fqdn: string) => `/api/v1/domains/${enc(fqdn)}`;
export const getSecurity = (f: string) => api<Security>("GET", `${D(f)}/security`);
export const getTransfer = (f: string) => api<TransferState>("GET", `${D(f)}/transfer`);
export const lockDomain = (f: string) => api("POST", `${D(f)}/lock`, {});
export const stopTransfer = (f: string) => api<{ message: string }>("POST", `${D(f)}/transfer/stop`, {});
export const getDns = (f: string) => api<DnsView>("GET", `${D(f)}/dns`);
export const getSnapshots = async (f: string) => (await api<{ snapshots: Snapshot[] }>("GET", `${D(f)}/dns-snapshots`)).snapshots;
export interface NewRecord { type: string; name: string; value: string; priority?: number; weight?: number; port?: number }
export const addRecords = (f: string, records: NewRecord[]) => api<{ changed: boolean; sensitive?: boolean }>("POST", `${D(f)}/dns`, { records });
export const deleteRecord = (f: string, id: string) => api<{ changed: boolean; sensitive?: boolean }>("DELETE", `${D(f)}/dns/${enc(id)}`);
export const rollback = (f: string, sid: string) => api<{ changed: boolean; sensitive?: boolean }>("POST", `${D(f)}/dns-snapshots/${enc(sid)}/rollback`, {});
export const getDs = (f: string) => api<DsView>("GET", `${D(f)}/ds`);
export const getVerification = (f: string) => api<{ verification: { state: string; reason: string; deadline_at: string | null; days_left: number } | null }>("GET", `${D(f)}/registrant-verification`);
export const sendVerification = (f: string) => api<{ sent: boolean }>("POST", `${D(f)}/registrant-verification/send`, {});
export const verifyRegistrant = (f: string, code: string) => api<{ verified: boolean }>("POST", `${D(f)}/registrant-verification/verify`, { code });
export const getContactStart = (f: string) => api<{ current: { name: string; email: string; country: string } | null; login_email_matches: boolean; warning: { message: string } | null; dispute_lock: boolean }>("GET", `${D(f)}/contact`);
export interface ContactFields { name: string; email: string; phone: string; street: string; city: string; region: string; postalCode: string; country: string }
export const draftContact = (f: string, c: ContactFields) => api<{ id: string; registrant_change: boolean; transfer_lock_days: number; warnings: { code: string; message: string }[] }>("POST", `${D(f)}/contact-drafts`, c);

export const authorisationDoc = async () => (await api<{ documents: { kind: string; version: string; url: string }[] }>("GET", "/api/v1/documents?include=auto_renew")).documents.find((d) => d.kind === "auto_renew_authorisation") ?? null;

// ---- step-up: prepare, passkey, commit ------------------------------------------------------------------------------------------------

export interface Prepared { actionId: string; summary: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }
export type StepUpType = "card.publish" | "mandate.sign" | "domain.unlock" | "domain.transfer_out" | "domain.nameservers.change" | "domain.contact.change" | "device.approve";

/** Step one: the server works out exactly what will be signed and says it in words. Nothing is signed yet. */
export async function prepareStepUp(type: StepUpType, target: string, userInput?: unknown): Promise<Prepared> {
  const out = await api<{ action_id: string; summary: string; webauthn_options: Prepared["options"] }>("POST", "/api/v1/actions/prepare", { type, target_id: target, ...(userInput ? { user_input: userInput } : {}) });
  return { actionId: out.action_id, summary: out.summary, options: out.webauthn_options };
}
/** Step two, from a click: the passkey signs, the server checks it and marks the action committed. The id goes on the one gated request in `X-MH-Action-Id`. */
export async function commitStepUp(p: Prepared): Promise<string> {
  const assertion = await startAuthentication({ optionsJSON: p.options });
  await api("POST", `/api/v1/actions/${enc(p.actionId)}/commit`, { assertion });
  return p.actionId;
}
export const gated = (actionId: string) => ({ "X-MH-Action-Id": actionId });

export const setAutoRenewOn = (id: string, consentHash: string, actionId: string) => api("POST", `/api/v1/domains/${enc(id)}/auto-renew`, { consent_hash: consentHash }, gated(actionId));
export const unlockDomain = (f: string, actionId: string) => api("POST", `${D(f)}/unlock`, {}, gated(actionId));
export const issueTransferCode = (f: string, actionId: string) => api<{ code?: string; status?: string; message?: string; replaced_at?: string }>("POST", `${D(f)}/transfer-out`, {}, gated(actionId));
export const changeNameservers = (f: string, actionId: string) => api("POST", `${D(f)}/nameservers`, {}, gated(actionId));
export const changeDs = (f: string, actionId: string) => api("POST", `${D(f)}/ds`, {}, gated(actionId));
export const submitContact = (f: string, actionId: string) => api<{ status: string; verification_required: boolean; approval_deadline_at: string | null; transfer_lock_days: number }>("POST", `${D(f)}/contact`, {}, gated(actionId));

// ---- words ---------------------------------------------------------------------------------------------------------------------------------

/** Plain text for the codes the domain routes answer with. Never echoes server text. */
export function explainDomain(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "step_up_required": return "That needs your passkey. Try again.";
      case "assertion_invalid": case "challenge_unavailable": return "The passkey check did not go through. Try again.";
      case "no_passkey": return "Add a passkey to your account first.";
      case "consent_required": case "terms_not_accepted": return "Read and tick the auto-renew authorisation first.";
      case "no_saved_card": case "payment_method_required": return "Auto-renew needs a card saved for renewals. Tick the authorisation and press Renew now: you pay this renewal on Stripe and the card is kept. Then turn auto-renew on.";
      case "auto_renew_consent_required": return "Read and tick the auto-renew authorisation first.";
      case "documents_unavailable": return "The auto-renew authorisation is not published yet. Nothing was changed.";
      case "already_on": return "Auto-renew is already on.";
      case "not_renewable": return "This name cannot be renewed right now.";
      case "payment_declined": return "The card was declined. Nothing was renewed.";
      case "renewal_paused": case "sell_gate": return "Renewals are paused for a short while. Nothing was charged.";
      case "renew_by_support": return "This name has expired, so online renewal has closed. Write to support@mosshatch.com and we renew it for you once you confirm the price. Nothing was charged.";
      case "renewal_price_check": return "The registrar's renewal price needs checking before anything is charged. Nothing was charged; we email you once it is confirmed.";
      case "transfer_locked": return "This name cannot leave for 60 days after a change of registrant.";
      case "dispute_lock": return "A dispute lock is on. Transfers and contact changes are paused.";
      case "contact_change_pending": return "A contact change is waiting for approval. Finish that first.";
      case "already_unlocked": return "The name is already unlocked.";
      case "domain_locked": return "Unlock the name first.";
      case "dnssec_would_break": return "That would break DNSSEC. Remove the DNSSEC record first, or use signed nameservers.";
      case "glue_unsupported": case "bad_nameservers": return "Use two or more nameservers hosted under another domain.";
      case "unchanged": return "Those are already the nameservers.";
      case "bad_ds": return "Check the DNSSEC record. The digest is hex.";
      case "dnssec_unsupported": return "DNSSEC is not available for this extension.";
      case "dns_not_hosted": return "DNS for this name is hosted elsewhere, so it cannot be edited here.";
      case "invalid_record": case "mx_needs_priority": case "srv_needs_fields": case "cname_at_apex": case "cname_conflict": case "empty_value": case "txt_too_long": case "unsupported_record_type":
        return "Check the record. A CNAME cannot sit at the top of the domain or beside other records, and MX and SRV records need their numbers.";
      case "too_many_deletes": case "unrelated_delete": return "That change removes too much at once, so it was refused.";
      case "registrar_writes_paused": case "registrar_unavailable": return "Changes are paused while our registrar is in maintenance. Try again later.";
      case "outcome_unknown": return "We could not confirm the change. Look again before you retry.";
      case "fuse_tripped": return "Too many of these changes just now. Try again in a little while.";
      case "invalid_code": return "That code did not work. Ask for a new one.";
      case "refund_cap": return "Three refunds in 30 days is the limit.";
      case "window_closed": return "The refund window for this order has closed.";
      case "tld_non_refundable": return "This extension cannot be refunded.";
      case "domain_in_use": return "The name has DNS records, so it cannot be refunded.";
      case "not_refundable": return "This order cannot be refunded.";
      case "params_changed": return "Something changed while you were signing. Try again.";
    }
  }
  return explain(e);
}

/**
 * A roll back the server refuses (422). It keeps the write-safety rules: rolling back an older snapshot also undoes every change made
 * after it, so it may not remove mail, verification or service records those changes added, nor more than five records at once.
 */
export function explainRollback(e: unknown): string {
  if (e instanceof ApiError && e.code === "unrelated_delete") return "Nothing was changed. Rolling back this far would also undo the changes made after it, including mail, verification or service records they added. Roll back the newer changes first, one at a time from the top of the list.";
  if (e instanceof ApiError && e.code === "too_many_deletes") return "Nothing was changed. Rolling back this far would remove more than five records at once. Roll back the newer changes first, one at a time from the top of the list, or delete records one by one.";
  return explainDomain(e);
}

export function money(minor: string | null | undefined): string {
  if (minor === null || minor === undefined) return "";
  const neg = minor.startsWith("-"), digits = (neg ? minor.slice(1) : minor).padStart(3, "0");
  return `${neg ? "-" : ""}$${digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${digits.slice(-2)}`;
}
export const day = (iso: string | null | undefined): string => iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "";
