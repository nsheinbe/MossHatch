import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 1280, height: 844 }, { width: 390, height: 844 }]) {
  test.describe(`homepage measurement ${viewport.width}px`, () => {
    test.use({ viewport });
    test('one request per document, no secrets or cookies, no duplicate in-page navigation', async ({ page }) => {
      const requests: { body: string | null; headers: Record<string, string> }[] = [];
      await page.context().addCookies([{ name: 'qa_sensitive_cookie', value: 'do-not-send', url: 'http://localhost:5176' }]);
      await page.route('**/api/v1/pageviews', async route => {
        requests.push({ body: route.request().postData(), headers: await route.request().allHeaders() });
        await route.fulfill({ status: 202, json: { accepted: true } });
      });
      await page.goto('/?utm_source=private%40example.com#find=private-example.com');
      await expect.poll(() => requests.length).toBe(1);
      expect(requests[0]!.body).toBe('{"page":"home"}');
      expect(requests[0]!.headers.cookie).toBeUndefined();
      expect(requests[0]!.headers.referer).toBeUndefined();
      await expect(page.locator('#root')).not.toBeEmpty();
      await page.getByRole('button', { name: 'Find a name', exact: true }).click();
      await page.evaluate(() => { history.pushState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); });
      await page.goBack();
      await page.waitForTimeout(300);
      expect(requests).toHaveLength(1);
      await page.reload();
      await expect.poll(() => requests.length).toBe(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
    test('honors GPC', async ({ page }) => {
      const requests: string[] = [];
      await page.route('**/api/v1/pageviews', async route => { requests.push(route.request().url()); await route.fulfill({ status: 202, json: {} }); });
      await page.addInitScript(() => Object.defineProperty(navigator, 'globalPrivacyControl', { value: true }));
      await page.goto('/');
      await expect(page.locator('[data-booted="1"]')).toBeAttached();
      expect(requests).toHaveLength(0);
    });
    test('excludes OAuth and invite entries without relying on opt-out', async ({ page }) => {
      const requests: string[] = [];
      await page.route('**/api/v1/pageviews', async route => { requests.push(route.request().url()); await route.fulfill({ status: 202, json: {} }); });
      for (const path of ['/?oauth_request=00000000-0000-0000-0000-000000000000', '/invite?t=private-test-token', '/checkout/cancelled?order=00000000-0000-0000-0000-000000000000']) {
        await page.goto(path);
        await expect(page.locator('[data-booted="1"]')).toBeAttached();
        expect(requests).toHaveLength(0);
      }
    });
  });
}
