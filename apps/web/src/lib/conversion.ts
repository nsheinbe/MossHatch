/** First-party, aggregate measurement. No search text, URLs, cookies or durable visitor identifier. */
const campaign: Record<string,string> = {};
if (typeof location !== 'undefined') for (const key of ['utm_source','utm_medium','utm_campaign']) {
  const v = new URLSearchParams(location.search).get(key);
  if (v && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(v)) campaign[key] = v.toLowerCase();
}
const sent = new Set<string>();
const device = () => matchMedia('(max-width: 720px)').matches ? 'mobile' : 'desktop';
export function trackConversion(event: 'visit' | 'search' | 'available' | 'selected' | 'checkout', preview: boolean) {
  if (import.meta.env.VITE_API_ENABLED !== '1') return;
  if (navigator.doNotTrack === '1' || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return;
  const mode = preview ? 'preview' : 'live', key = `${mode}:${event}`;
  if (sent.has(key)) return;
  sent.add(key);
  void fetch('/api/v1/conversion/events', { method: 'POST', credentials: 'omit', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, mode, device: device(), campaign }) }).catch(() => undefined);
}
export async function attribution(orderId: string) {
  if (import.meta.env.VITE_API_ENABLED !== '1') return;
  if (navigator.doNotTrack === '1' || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return;
  // Keepalive allows the request to finish during the redirect to Stripe; it is never a checkout dependency.
  await fetch('/api/v1/conversion/orders', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-MH-Client': 'web' }, body: JSON.stringify({ order_id: orderId, device: device(), campaign }) }).catch(() => undefined);
}
