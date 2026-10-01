/**
 * Checkout is a full-page trip to Stripe. For a transfer, the page it returns to needs the transfer's opaque id to show its status;
 * it is kept for that one trip in this tab's sessionStorage beside its order id and removed as soon as it is read. Never a code.
 */
const KEY = "mh.transfer";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function keepHandoff(orderId: string, transferId: string): void {
  try { sessionStorage.setItem(KEY, JSON.stringify({ order: orderId, transfer: transferId })); } catch { /* the return page then shows the order only */ }
}
export function takeHandoff(orderId: string): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as { order?: unknown; transfer?: unknown };
    if (o.order !== orderId || typeof o.transfer !== "string" || !UUID.test(o.transfer)) return null;
    sessionStorage.removeItem(KEY);
    return o.transfer;
  } catch { return null; }
}
