import { api } from "./api";

export interface OrderView {
  id: string; kind?: string; state: string; fqdn: string; years: number; currency: string;
  total_minor: string; charged_minor: string | null; message: string | null;
}

/** Start a checkout. The client sends the name and term only; the server owns the price. */
export async function startCheckout(fqdn: string, years: number, accept: Record<string, string>, autoRenew = false): Promise<{ order_id: string; checkout_url: string }> {
  return api("POST", "/api/v1/orders", { fqdn, years, accept, ...(autoRenew ? { auto_renew: true } : {}) }, { "Idempotency-Key": crypto.randomUUID() });
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

/** States after which nothing more will happen without a person. */
export const TERMINAL = new Set(["captured", "voided", "registration_failed", "refunded", "checkout_expired", "payment_failed", "renewed"]);

export function orderStory(state: string): string {
  switch (state) {
    case "checkout_open": return "Waiting for your payment on Stripe.";
    case "authorized": case "registering": case "outcome_unknown": return "Payment is on hold. Registering the name.";
    case "registered": case "capturing": return "Registered. Taking the payment.";
    case "captured": return "Hatched. The payment is complete.";
    case "voided": case "canceling": return "The order was cancelled. You were not charged.";
    case "registrar_unavailable": return "Registrations are paused while our registrar is in maintenance. Nothing was charged.";
    case "draft": return "Waiting for your payment on Stripe.";
    case "renewing_upstream": return "Paid. Renewing the name with the registry.";
    case "renewed": return "Renewed. The payment is complete.";
    default: return "Working on it.";
  }
}
