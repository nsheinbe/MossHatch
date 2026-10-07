import { api } from "./api";

export interface OrderView {
  id: string; kind?: string; state: string; fqdn: string; years: number; currency: string;
  total_minor: string; charged_minor: string | null; message: string | null;
  /** While the card is only held: when the hold ends (nothing is charged if registration is not confirmed by then). */
  hold_until?: string | null;
  /** capture_failed: the name is registered and can still be paid until this time. */
  pay_by?: string | null;
}

/** Start a checkout. The client sends the name and term only; the server owns the price. */
export async function startCheckout(fqdn: string, years: number, accept: Record<string, string>, autoRenew = false, idempotencyKey: string = crypto.randomUUID()): Promise<{ order_id: string; checkout_url: string | null }> {
  return api("POST", "/api/v1/orders", { fqdn, years, accept, ...(autoRenew ? { auto_renew: true } : {}) }, { "Idempotency-Key": idempotencyKey });
}

export interface LegalDoc { kind: string; version: string; url: string }
/** The documents checkout shows: terms and agreement, the auto-renew authorisation (its own consent), and the registry terms for .ai and .io. */
export const getDocuments = async (tld?: string) => {
  const include = ["auto_renew", ...(tld === "ai" || tld === "io" ? [`tld_${tld}`] : [])].join(",");
  return (await api<{ documents: LegalDoc[] }>("GET", `/api/v1/documents?include=${include}`)).documents;
};

export interface ContactInput { name: string; email: string; phone: string; street: string; city: string; region: string; postalCode: string; country: string }
export const getContact = () => api<{ present: boolean; email?: string }>("GET", "/api/v1/contact");
export const saveContact = (c: ContactInput) => api("POST", "/api/v1/contact", c);

export const getOrder = (id: string) => api<OrderView>("GET", `/api/v1/orders/${encodeURIComponent(id)}`);
export const reconcileOrder = (id: string, sessionId: string) => api<OrderView>("GET", `/api/v1/orders/${encodeURIComponent(id)}/return?session_id=${encodeURIComponent(sessionId)}`);
/** capture_failed only: the order's pay link on Stripe (the name is registered; this pays for it). */
export const payLink = (id: string) => api<{ checkout_url: string }>("POST", `/api/v1/orders/${encodeURIComponent(id)}/pay-link`, {});

/** States after which nothing more will happen without a person. */
export const TERMINAL = new Set(["captured", "voided", "refunded", "partially_refunded", "refund_failed", "checkout_expired", "payment_failed", "renewed"]);

const when = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
};

/**
 * What is true right now, in words a buyer can trust (docs/AUDIT-2026-10-07.md F8): a hold is never called a charge or "nothing", and a
 * name is called yours only after the registrar confirmed it.
 */
export function orderStory(o: Pick<OrderView, "state"> & Partial<Pick<OrderView, "hold_until" | "pay_by">>): string {
  const hold = when(o.hold_until);
  const release = hold ? ` If we can't confirm it by ${hold}, the hold is released and nothing is charged.` : " If we can't confirm it, the hold is released and nothing is charged.";
  switch (o.state) {
    case "checkout_open": case "draft": return "Secure checkout is open on Stripe. Nothing is charged until the registration is confirmed.";
    case "authorized": case "review_hold": case "registering": return `Your card has a temporary hold, not a charge. We're registering the name now.${release}`;
    case "outcome_unknown": return `We're confirming the registration with the registry. This can take a few minutes; your card only has a hold.${release}`;
    case "registrar_unavailable": return `Our registrar is busy, so we'll keep trying automatically. Your card only has a hold.${release}`;
    case "paid_before_registration": return "Paid. We're registering the name now. If it can't be registered, you get a full refund.";
    case "registered": case "capturing": return "Registered. Completing your payment.";
    case "captured": return "Registered and paid. This name is yours.";
    case "capture_failed": { const by = when(o.pay_by); return `Your name is registered, but the payment didn't go through.${by ? ` Pay by ${by} to keep it.` : " Write to support@mosshatch.com to keep it."}`; }
    case "voided": case "canceling": return "This order was cancelled. Nothing was charged.";
    case "registration_failed": return "The registration didn't go through. Your card hold is being released; nothing is charged.";
    case "checkout_expired": return "This checkout ended before payment. Nothing was charged.";
    case "payment_failed": return "The payment didn't go through. Nothing was charged.";
    case "refund_pending": return "Your refund is on its way.";
    case "refunded": case "partially_refunded": return "Refunded. Your bank shows it in a few days.";
    case "refund_failed": return "We couldn't complete your refund automatically. We're on it; write to support@mosshatch.com if you have questions.";
    case "renewing_upstream": return "Paid. Renewing the name with the registry.";
    case "renewed": return "Renewed. The payment is complete.";
    default: return "Checking the order…";
  }
}

/** The buying journey as one sequence (C3): which step an order is on, and whether it stopped. Practice hatches never use it. */
export type Step = "choose" | "pay" | "register" | "yours";
export function journeyOf(state: string): { at: Step; stopped: boolean } {
  if (["checkout_open", "draft", "payment_failed"].includes(state)) return { at: "pay", stopped: state === "payment_failed" };
  if (["authorized", "review_hold", "registering", "outcome_unknown", "registrar_unavailable", "paid_before_registration"].includes(state)) return { at: "register", stopped: false };
  if (["registered", "capturing", "captured", "capture_failed", "renewed"].includes(state)) return { at: "yours", stopped: state === "capture_failed" };
  return { at: "pay", stopped: true };
}

/**
 * The checkout a person started and has not finished, kept in this tab only (sessionStorage, cleared with the tab) so Back from Stripe,
 * Stripe's own back link (/checkout/cancelled) or a reload can offer to resume it (docs/AUDIT-2026-10-07.md D4, D5). It holds the request
 * the person sent (name, term, the document versions they accepted, the auto-renew box) and its idempotency key, so resuming replays the
 * same order and the same Checkout instead of creating a second one. No price, token or payment detail is kept.
 */
export interface PendingCheckout { orderId: string; fqdn: string; years: number; accept: Record<string, string>; autoRenew: boolean; key: string; at: number }
const PENDING = "mh.checkout";
const PENDING_TTL_MS = 2 * 3600_000;
export function rememberCheckout(p: Omit<PendingCheckout, "at">): void {
  try { sessionStorage.setItem(PENDING, JSON.stringify({ ...p, at: Date.now() })); } catch { /* storage can be off; resuming then starts over */ }
}
export function pendingCheckout(): PendingCheckout | null {
  try {
    const raw = sessionStorage.getItem(PENDING);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingCheckout>;
    const ok = typeof p.orderId === "string" && /^[0-9a-f-]{36}$/i.test(p.orderId) && typeof p.fqdn === "string" && /^[a-z0-9-]{1,63}\.[a-z]{2,24}$/.test(p.fqdn)
      && typeof p.years === "number" && typeof p.key === "string" && p.key.length <= 200 && typeof p.autoRenew === "boolean" && !!p.accept && typeof p.accept === "object"
      && typeof p.at === "number" && Date.now() - p.at < PENDING_TTL_MS;
    if (!ok) { sessionStorage.removeItem(PENDING); return null; }
    return p as PendingCheckout;
  } catch { return null; }
}
export function forgetCheckout(): void { try { sessionStorage.removeItem(PENDING); } catch { /* nothing kept */ } }
