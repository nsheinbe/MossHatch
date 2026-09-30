import { test, expect } from "@playwright/test";

/**
 * ST-14 for the pages that approve things (PLAN 4.3a header table, threat row 18): the OAuth consent screen, the device approval
 * page and the app shell that carries the approval card and the reveal send `frame-ancestors 'none'` and its legacy twin
 * `X-Frame-Options: DENY` (for engines that ignore CSP frame-ancestors), and `Cross-Origin-Resource-Policy: same-origin`.
 */
test("ST-14 consent, device and app pages refuse framing in both header forms and send CORP", async ({ request }) => {
  for (const url of ["/", "/device", "/?oauth_request=0190f0f0-0000-7000-8000-000000000001", "/boot.js", "/fees.html"]) {
    const h = (await request.get(url)).headers();
    expect(h["content-security-policy"], url).toContain("frame-ancestors 'none'");
    expect(h["x-frame-options"], url).toBe("DENY");
    expect(h["cross-origin-resource-policy"], url).toBe("same-origin");
  }
});
