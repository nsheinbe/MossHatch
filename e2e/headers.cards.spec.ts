import { test, expect } from "@playwright/test";
import { CARDS_CSP_DEPARTURES, EXACT_ROWS, expectedCsp, planHeader, planHeaderTable, planMergedCsp } from "./plan-headers";

/**
 * ST-14 on hatchkind.com (the `cards` project, served by e2e/serve-cards.mjs with apps/cards/vercel.json's rules): PLAN 4.3a
 * sets the response-header set "for every route of `web` and `cards`". Every value is the plan's, except the one recorded
 * departure (D-051): no `script-src`, because the card host runs no script at all (ST-145).
 */
test("ST-14 cards: every route class sends the PLAN 4.3a header set, value for value", async ({ request }) => {
  const csp = expectedCsp(CARDS_CSP_DEPARTURES);
  expect(planMergedCsp().filter((d) => !csp.split("; ").includes(d))).toEqual(["script-src 'self'"]);
  expect(csp).not.toContain("script-src");
  expect(csp.startsWith("default-src 'none';")).toBe(true);
  const css = (await (await request.get("/")).text()).match(/href="(\/assets\/[^"]+\.css)"/)![1]!;
  const routes: [string, number][] = [["/", 200], ["/about/", 200], ["/ember-fox.example/", 200], ["/lantern-moth.example", 200],
    [css, 200], ["/fonts/young-serif-latin-400-normal.woff2", 200], ["/img/ember-fox.example.svg", 200],
    ["/.well-known/security.txt", 200], ["/robots.txt", 200], ["/sitemap.xml", 200], ["/never-published.example/", 404]];
  for (const [url, status] of routes) {
    const res = await request.get(url);
    expect(res.status(), url).toBe(status);
    const h = res.headers();
    expect(h["content-security-policy"], url).toBe(csp);
    expect(h["content-security-policy-report-only"], url).toBeUndefined();
    for (const name of EXACT_ROWS) expect(h[name.toLowerCase()], `${url} ${name}`).toBe(planHeader(name));
    expect(h["strict-transport-security"], url).not.toMatch(/includeSubDomains|preload/i);
    expect(h["permissions-policy"], url).not.toContain("interest-cohort");
    // PLAN: "The public card-image route on `cards` sends `cross-origin`"; every other route is same-origin.
    expect(h["cross-origin-resource-policy"], url).toBe(url.startsWith("/img/") ? "cross-origin" : planHeader("Cross-Origin-Resource-Policy"));
    expect(h["set-cookie"], url).toBeUndefined();
    expect(h["clear-site-data"], url).toBeUndefined();
  }
});

test("ST-14 cards: the plan's Cache-Control and Clear-Site-Data rows name routes the card host does not have", async ({ request }) => {
  const cache = planHeaderTable().find((r) => r.name === "Cache-Control")!;
  expect(cache.value).toContain("`/api/*`");
  expect(cache.note).toContain("`/boot.js`");
  expect(planHeaderTable().find((r) => r.name === "Clear-Site-Data")!.value).toContain("on logout");
  // No functions, no boot sentinel and no sign-in on hatchkind.com: these are the branded 404. The CSP report endpoint is
  // one of them, so violation reports from cards are dropped until cards has a report function (D-051).
  for (const url of ["/api/csp-report", "/api/v1/session", "/boot.js"]) expect((await request.get(url)).status(), url).toBe(404);
});
