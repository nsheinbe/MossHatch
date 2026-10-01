import { ApiError } from "./api";
import { explain } from "./account";

/**
 * Rescue (transfer in) and the Gate (transfer out), PLAN 4.3b. The auth code goes up once in POST /transfers and is never kept
 * here, in the store, in storage or in the URL. Transfer ids are opaque and live in component state.
 */
export type TransferState =
  | "awaiting_confirmation" | "awaiting_payment" | "submitting" | "submitted" | "pending_owner_approval" | "pending_registry"
  | "completed" | "failed" | "nacked" | "cancelled" | "expired";
export interface TransferView {
  id: string; order_id: string; fqdn: string; years: number; state: TransferState; message: string;
  completed: boolean; completed_at: string | null; domain_id: string | null;
  failure: { code: string; nack_reason: string | null; message: string | null } | null;
  owner_deadline_at: string | null; registry_deadline_at: string | null;
  payment: { order_state: string | null; total_minor: string | null; charged_minor: string | null; charged_before_completion: boolean; refunded: boolean; note: string | null };
  can_cancel: boolean; code_stored: boolean; timing: string; created_at: string;
}
export interface Started { transfer_id: string; order_id: string; state: TransferState; message: string; timing: string }

export interface GateBlock { code: string; message: string; until: string | null }
export interface GateView {
  domain: string; domain_id: string; state: "left" | "needs_attention" | "traveling" | "blocked" | "code_requested" | "code_issued" | "unlocked" | "locked";
  locked: boolean; unlocked_at: string | null;
  code: { issued_at: string | null; replace_at: string | null; outstanding: boolean; shown_once: boolean; by_support: boolean; request: { opened_at: string | null; due_at: string | null; message: string } | null };
  transferable: boolean; transferable_from: string | null; blocks: GateBlock[];
  pending: { requested_at: string | null; gaining_registrar: string | null; upstream_status: string | null; requested_by_you: boolean; decline_by: string; stopped: boolean; stop_available: boolean } | null;
  steps: string[]; approval: string; cancel: string; can_cancel_upstream: boolean; billing_blocks_transfer: boolean; timing: string;
  released: { at: string | null; cause: string | null } | null;
}

/** An API error with the extra fields the transfer routes add (`reason`, `transferable_from`, `attempts_left`, `years`). */
export class TransferError extends ApiError {
  constructor(status: number, code: string, public extra: Record<string, unknown>) { super(status, code, typeof extra.reason === "string" ? extra.reason : undefined); }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", ...headers } };
  if (method !== "GET") {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    (init.headers as Record<string, string>)["X-MH-Client"] = "web";
    init.body = JSON.stringify(body ?? {});
  }
  let res: Response;
  try { res = await fetch(path, init); } catch { throw new ApiError(0, "network"); }
  let json: Record<string, unknown> = {};
  try { const t = await res.text(); json = t ? JSON.parse(t) : {}; } catch { /* not JSON */ }
  if (!res.ok) {
    const e = (json.error && typeof json.error === "object" ? json.error : {}) as Record<string, unknown>;
    throw new TransferError(res.status, typeof e.code === "string" ? e.code : "error", e);
  }
  return json as T;
}

const enc = encodeURIComponent;
/** Start a transfer. The code is sent here once; the caller clears its field right after. */
export const startTransfer = (fqdn: string, years: number, authCode: string, accept: Record<string, string>, key: string) =>
  call<Started>("POST", "/api/v1/transfers", { fqdn, years, auth_code: authCode, accept }, { "Idempotency-Key": key });
export const getTransferView = (id: string) => call<TransferView>("GET", `/api/v1/transfers/${enc(id)}`);
export const confirmTransfer = (id: string, code: string) => call<TransferView & { checkout_url: string | null }>("POST", `/api/v1/transfers/${enc(id)}/confirm`, { code });
export const cancelTransfer = (id: string) => call<TransferView>("POST", `/api/v1/transfers/${enc(id)}/cancel`, {});
export const getGate = (domainId: string) => call<GateView>("GET", `/api/v1/domains/${enc(domainId)}/gate`);

/** Years a transfer adds (the registry's rule; the server refuses anything else and says the right number). */
export const transferYears = (fqdn: string) => (fqdn.endsWith(".ai") ? 2 : 1);

/** Where a transfer is, in the order the person sees it. Nothing here says "done" unless the server said `completed`. */
export const LIVE: readonly TransferState[] = ["awaiting_payment", "submitting", "submitted", "pending_owner_approval", "pending_registry"];
export const ENDED: readonly TransferState[] = ["completed", "failed", "nacked", "cancelled", "expired"];
export const isDone = (v: Pick<TransferView, "state" | "completed">) => v.completed === true && v.state === "completed";
export const isOver = (v: Pick<TransferView, "state">) => ENDED.includes(v.state);

export interface Step { label: string; status: "done" | "now" | "later" | "stopped" }
/** The timeline. A step is "done" only once a later server state proves it; "Moved to Mosshatch" needs `completed` from the server. */
export function steps(v: Pick<TransferView, "state" | "completed">): Step[] {
  const order: TransferState[] = ["awaiting_confirmation", "awaiting_payment", "submitting", "pending_registry", "completed"];
  const labels = ["Confirmed by the registrant email", "Paid (held on your card)", "Request sent to our registrar", "The current registrar releases the name", "Moved to Mosshatch"];
  const at = v.state === "submitted" ? 2 : v.state === "pending_owner_approval" ? 3 : order.indexOf(v.state);
  const ended = ["failed", "nacked", "cancelled", "expired"].includes(v.state);
  return labels.map((label, i) => {
    if (i === labels.length - 1) return { label, status: isDone(v) ? "done" : ended ? "stopped" : "later" };
    if (isDone(v)) return { label, status: "done" };
    if (ended) return { label, status: "stopped" };
    return { label, status: i < at ? "done" : i === at ? "now" : "later" };
  });
}

/** The one-line status. Mirrors the server's words; "moved" appears only for a server-completed transfer. */
export function headline(v: Pick<TransferView, "state" | "completed">): string {
  if (isDone(v)) return "Moved to Mosshatch.";
  switch (v.state) {
    case "awaiting_confirmation": return "Waiting for you to confirm.";
    case "awaiting_payment": return "Waiting for your payment.";
    case "submitting": case "submitted": return "Traveling. The request is on its way to our registrar.";
    case "pending_owner_approval": return "Traveling. Waiting for the owner to approve by email.";
    case "pending_registry": return "Traveling. Waiting for the current registrar to release the name.";
    case "completed": return "Traveling. Waiting for the registry to confirm.";
    case "nacked": return "Refused by the current registrar.";
    case "cancelled": return "Cancelled.";
    case "expired": return "Not confirmed in time.";
    default: return "Ended without moving.";
  }
}

// The pre-check's reasons (server policy.ts BLOCK_TEXT), mirrored so no server text is echoed.
const BLOCK: Record<string, string> = {
  not_registered: "This name is not registered. You can register it instead.",
  already_here: "This name is already managed here.",
  already_yours: "This name is already in your account.",
  locked_at_losing: "The name is locked at its current registrar. Unlock it there, then try again.",
  registry_lock: "The registry has locked this name against transfers. Ask your current registrar to lift the registry lock.",
  too_new: "A name can move only 60 days after it was registered.",
  recently_transferred: "A name can move only 60 days after its last transfer.",
  pending_transfer: "A transfer of this name is already in progress.",
  redemption: "This name expired and is in redemption. Restore it at your current registrar first.",
  pending_delete: "The registry is deleting this name, so it cannot move.",
  dispute: "This name is under a dispute and cannot move until the dispute ends.",
  other: "The registry or the current registrar refused the check. Ask your current registrar why.",
  dnssec: "Your domain has DNSSEC records that would make it unreachable. Remove them first.",
  ten_year_cap: "A transfer adds a year, and this name is already registered close to the ten-year limit.",
};

export const day = (iso: string | null | undefined): string => iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "";

/** Plain words for the transfer routes' codes. */
export function explainTransfer(e: unknown): string {
  if (e instanceof ApiError) {
    const x = e instanceof TransferError ? e.extra : {};
    switch (e.code) {
      case "not_transferable": {
        const base = BLOCK[e.reason ?? ""] ?? BLOCK.other!;
        const from = typeof x.transferable_from === "string" ? x.transferable_from : null;
        return from ? `${base} You can transfer it from ${day(from)}.` : base;
      }
      case "invalid_fqdn": return "Enter the whole name, like example.com.";
      case "unsupported_tld": return "Transfers of this extension are not offered yet.";
      case "invalid_term": return `A transfer of this name adds ${typeof x.years === "number" ? x.years : "a set number of"} ${x.years === 1 ? "year" : "years"}.`;
      case "invalid_auth_code_format": return "Enter the transfer code exactly as your current registrar gave it. It is 6 to 64 characters with no spaces.";
      case "contact_required": return "Add your registrant contact first.";
      case "terms_not_accepted": return "Accept the terms and the registration agreement to continue.";
      case "documents_unavailable": return "The terms are not published yet, so transfers cannot start. Nothing was charged.";
      case "email_unverified": return "Verify your email address first.";
      case "account_frozen": return "Your account is frozen, so transfers cannot start.";
      case "account_inactive": return "This account cannot start transfers.";
      case "orders_paused": case "sell_gate": case "registrar_unavailable": case "mode_inconsistent": return "Transfers are paused for a short while. Nothing was charged.";
      case "price_not_standard": return "This name is not sold at our standard price, so it cannot be transferred here.";
      case "new_account_daily_transfers": return "New accounts can start five transfers a day. Try again tomorrow.";
      case "request_in_progress": case "idempotency_key_reuse": return "That request is already being handled. Look again in a moment.";
      case "invalid_code": return typeof x.attempts_left === "number" ? `That code did not work. ${x.attempts_left} ${x.attempts_left === 1 ? "try" : "tries"} left.` : "That code did not work. It is eight letters and digits.";
      case "code_expired": return "The code expired. Start the transfer again.";
      case "not_awaiting_confirmation": return "This transfer is past that step. Look at its status below.";
      case "transfer_in_flight": return "We are still confirming the request with our registrar. Try again in a few minutes.";
      case "not_cancellable": return "The transfer can no longer be cancelled.";
      case "not_found": return "That transfer is not in your account.";
    }
  }
  return explain(e);
}
