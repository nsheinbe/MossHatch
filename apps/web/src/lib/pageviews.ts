/** One first-party homepage count per document, independent of React or API/session readiness. */
let counted = false;
export function trackHomepageLoad(): void {
  if (counted || import.meta.env.VITE_API_ENABLED !== '1') return;
  if (navigator.doNotTrack === '1' || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return;
  // Fail closed on app-only routes and unknown query parameters (OAuth, payment and recovery links).
  // Values, fragments and referrers are never sent, including domain names in contextual buy links.
  if (location.pathname !== '/' || [...new URLSearchParams(location.search).keys()].some(k => !['utm_source', 'utm_medium', 'utm_campaign'].includes(k))) return;
  counted = true;
  void fetch('/api/v1/pageviews', {
    method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: 'home' }),
  }).catch(() => undefined);
}
