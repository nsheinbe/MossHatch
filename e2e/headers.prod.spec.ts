import fs from "node:fs";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { ASSERTED_ROWS, EXACT_ROWS, WEB_CSP_DEPARTURES, expectedCsp, planCsp, planHeader, planHeaderTable, planMergedCsp } from "./plan-headers";

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

/**
 * Every route class the `web` static host serves (served by e2e/serve-dist.mjs with vercel.json's rules): app shell and its
 * rewrites, the boot sentinel, hashed script and style, fonts, public and legal pages, text files, the branded 404, and a
 * path under /api/ (on Vercel that path is the API function, whose own headers override these; see the API note below).
 */
async function routeClasses(request: APIRequestContext): Promise<string[]> {
  const html = await (await request.get("/")).text();
  const js = /src="(\/assets\/main-[^"]+\.js)"/.exec(html)?.[1];
  const css = /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
  expect(js, "the shell names its module script").toBeTruthy();
  expect(css, "the shell names its stylesheet").toBeTruthy();
  return ["/", "/device", "/checkout/return", "/?oauth_request=0190f0f0-0000-7000-8000-000000000001", "/boot.js", js!, css!,
    "/fonts/young-serif-latin-400-normal.woff2", "/fees.html", "/legal/", "/.well-known/security.txt", "/robots.txt",
    "/sitemap.xml", "/no-such-page", "/api/v1/no-such-route"];
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

test("ST-14 the header tests cover every row of the PLAN 4.3a response-header table", () => {
  expect(planHeaderTable().map((r) => r.name).sort()).toEqual([...ASSERTED_ROWS].sort());
});

test("ST-14 web: every route class sends the PLAN 4.3a header set, value for value", async ({ request }) => {
  const csp = expectedCsp(WEB_CSP_DEPARTURES);
  // The plan's own directives are all there; only the two recorded departures (D-051) differ.
  expect(csp).toContain("upgrade-insecure-requests");
  expect(csp).toContain("worker-src 'self'");
  expect(csp).toContain("manifest-src 'self'");
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(planMergedCsp().filter((d) => !csp.split("; ").includes(d)).sort()).toEqual(["img-src 'self' blob:", "trusted-types"]);
  expect(csp).not.toMatch(/unsafe-|'nonce-|'sha(256|384|512)-/);
  for (const url of await routeClasses(request)) {
    const res = await request.get(url);
    const h = res.headers();
    expect(h["content-security-policy"], url).toBe(csp);
    // The Report-Only row is enforced now (merged into the policy above; the Nest has shipped), so no second policy is sent.
    expect(h["content-security-policy-report-only"], url).toBeUndefined();
    for (const name of EXACT_ROWS) expect(h[name.toLowerCase()], `${url} ${name}`).toBe(planHeader(name));
    expect(h["cross-origin-resource-policy"], url).toBe(planHeader("Cross-Origin-Resource-Policy"));
    expect(h["strict-transport-security"], url).not.toMatch(/includeSubDomains|preload/i);
    expect(h["set-cookie"], url).toBeUndefined();
  }
});

test("ST-14 web Cache-Control: every /api/* route is no-store, private and /boot.js revalidates, as PLAN 4.3a says", async ({ request }) => {
  const row = planHeaderTable().find((r) => r.name === "Cache-Control")!;
  expect(row.value).toContain("on every `/api/*` route");
  const boot = /`\/boot\.js` uses `([^`]+)`/.exec(row.note)?.[1];
  expect(boot).toBe("no-cache");
  for (const url of ["/api/v1/no-such-route", "/api/csp-report"]) expect((await request.get(url)).headers()["cache-control"], url).toBe(planHeader("Cache-Control"));
  expect((await request.get("/boot.js")).headers()["cache-control"]).toBe(boot);
  // vercel.json carries the /api rule itself, so it holds on Vercel for any /api path the function does not answer.
  const cfg = JSON.parse(fs.readFileSync("vercel.json", "utf8")) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
  expect(cfg.headers.find((r) => r.source === "/api/(.*)")?.headers).toEqual([{ key: "Cache-Control", value: planHeader("Cache-Control") }]);
});

test("ST-14 Clear-Site-Data on logout is the PLAN 4.3a value (the response itself is proven by ST-51 in packages/api)", () => {
  const src = fs.readFileSync("packages/api/src/auth/account.ts", "utf8");
  expect(/const CLEAR_SITE_DATA = '([^']+)'/.exec(src)?.[1]).toBe(planHeader("Clear-Site-Data"));
});

test("ST-14 the plan's CSP row is the policy these tests read (no silent parse of the wrong row)", () => {
  expect(planCsp().startsWith("default-src 'none'; script-src 'self';")).toBe(true);
  expect(planCsp().endsWith("report-uri /api/csp-report; report-to csp")).toBe(true);
});
