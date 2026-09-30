import fs from "node:fs";
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

/** The value of one row of the PLAN 4.3a response-header table, read from the plan itself so the two cannot drift apart. */
function planHeader(name: string): string {
  const plan = fs.readFileSync("docs/PLAN.md", "utf8");
  const row = new RegExp("^\\| `" + name + "` \\| `([^`]+)` \\|", "m").exec(plan);
  if (!row) throw new Error(`PLAN 4.3a has no ${name} row`);
  return row[1]!;
}
const ROUTE_CLASSES = ["/", "/device", "/boot.js", "/fees.html", "/fonts/young-serif-latin-400-normal.woff2", "/no-such-page"];

test("ST-14 Permissions-Policy is exactly the PLAN 4.3a value on every route class (payment is off, passkeys are self only)", async ({ request }) => {
  const want = planHeader("Permissions-Policy");
  expect(want).toContain("payment=()");
  for (const url of ROUTE_CLASSES) {
    const h = (await request.get(url)).headers();
    expect(h["permissions-policy"], url).toBe(want);
    expect(h["permissions-policy"], url).not.toContain("payment=(self)");
  }
});

test("ST-14 CSP violations are reported: report-uri and report-to name the PLAN 4.3a endpoint, and Reporting-Endpoints defines it", async ({ request }) => {
  const endpoints = planHeader("Reporting-Endpoints");
  const url = /^csp="([^"]+)"$/.exec(endpoints)?.[1];
  expect(url, "PLAN names the csp endpoint").toBe("/api/csp-report");
  for (const u of ROUTE_CLASSES) {
    const h = (await request.get(u)).headers();
    const csp = (h["content-security-policy"] ?? "").split(";").map((d) => d.trim());
    expect(csp, u).toContain(`report-uri ${url}`);
    expect(csp, u).toContain("report-to csp");
    expect(h["reporting-endpoints"], u).toBe(endpoints);
  }
});
