import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_API_ENABLED', '1');
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('location', { pathname: '/', search: '', hash: '' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 202 }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('counts once per document without cookies, referrer, query values or contextual domain names', async () => {
  vi.stubGlobal('location', { pathname: '/', search: '?utm_source=person%40example.com&utm_campaign=secret', hash: '#find=private-name.com' });
  const { trackHomepageLoad } = await import('./pageviews');
  trackHomepageLoad(); trackHomepageLoad();
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/v1/pageviews', {
    method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: '{"page":"home"}',
  });
});
it.each([{ doNotTrack: '1' }, { globalPrivacyControl: true }])('honors the browser opt-out %j', async preference => {
  vi.stubGlobal('navigator', preference);
  (await import('./pageviews')).trackHomepageLoad();
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['/invite', '/device', '/checkout/return', '/checkout/cancelled', '/legal/privacy', '/unknown'])('never counts sensitive or uninstrumented route %s', async pathname => {
  vi.stubGlobal('location', { pathname, search: '?token=secret' });
  (await import('./pageviews')).trackHomepageLoad();
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['?oauth_request=secret', '?email=person@example.com', '?session_id=secret', '?utm_source=launch&token=secret'])('fails closed on query %s', async search => {
  vi.stubGlobal('location', { pathname: '/', search });
  (await import('./pageviews')).trackHomepageLoad();
  expect(fetch).not.toHaveBeenCalled();
});
it('does not send from an API-disabled build', async () => {
  vi.stubEnv('VITE_API_ENABLED', '0');
  (await import('./pageviews')).trackHomepageLoad();
  expect(fetch).not.toHaveBeenCalled();
});
it('fails quietly and never retries a failed count', async () => {
  vi.mocked(fetch).mockRejectedValue(new Error('offline'));
  const { trackHomepageLoad } = await import('./pageviews');
  trackHomepageLoad(); await Promise.resolve(); trackHomepageLoad();
  expect(fetch).toHaveBeenCalledTimes(1);
});
