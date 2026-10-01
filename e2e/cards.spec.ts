import { test, expect, type Page } from "@playwright/test";
import { axe } from "./axe";

// hatchkind.com, built from the sample fixtures (apps/cards/fixtures) and served with apps/cards/vercel.json's headers.
const watch = (page: Page) => {
  const bad: string[] = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) bad.push(m.text()); });
  page.on("pageerror", (e) => bad.push("pageerror: " + e.message));
  return bad;
};
const PAGES = ["/", "/about/", "/ember-fox.example/", "/quiet-share.example/", "/lantern-moth.example"];

test("ST-145 the cards origin sets no cookies, runs no script and requests nothing from another origin", async ({ page, context, baseURL }) => {
  const bad = watch(page);
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  for (const url of PAGES) {
    const res = await page.goto(url);
    expect(res!.status(), url).toBe(200);
    const h = res!.headers();
    expect(h["set-cookie"], url).toBeUndefined();
    expect(h["content-security-policy"], url).toContain("default-src 'none'");
    expect(h["content-security-policy"], url).not.toContain("script-src");
    expect(await page.locator("script").count(), url).toBe(0);
    expect(await page.evaluate(() => document.cookie), url).toBe("");
  }
  expect(await context.cookies()).toEqual([]);
  expect(requests.filter((u) => !u.startsWith(baseURL!))).toEqual([]);
  expect(bad).toEqual([]);
});

test("ST-145 a card shows the name as text with no outbound link, and a noindex card is only reachable by its address", async ({ page }) => {
  await page.goto("/ember-fox.example/");
  await expect(page.getByRole("heading", { level: 1, name: "ember-fox.example" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Report this card" })).toHaveAttribute("href", "https://mosshatch.com/report.html#cards");
  const hrefs = await page.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
  for (const h of hrefs) expect(h.startsWith("/") || h.startsWith("#") || h.startsWith("https://mosshatch.com/"), h).toBe(true);
  expect(hrefs.some((h) => h.includes("ember-fox.example") && !h.startsWith("/"))).toBe(false);
  await page.goto("/quiet-share.example/");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  await page.goto("/");
  await expect(page.locator('a[href="/quiet-share.example/"]')).toHaveCount(0);
  await expect(page.locator('a[href="/ember-fox.example/"]')).toHaveCount(1);
  const sitemap = await (await page.request.get("/sitemap.xml")).text();
  expect(sitemap).toContain("/ember-fox.example/"); expect(sitemap).not.toContain("quiet-share");
});

test("an unknown or unpublished card is the same branded 404", async ({ page }) => {
  const res = await page.goto("/never-published.example/");
  expect(res!.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "No card here" })).toBeVisible();
  const r = await axe(page).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`)).toEqual([]);
});

test("axe: gallery, about and card pages at desktop and phone sizes", async ({ page }) => {
  for (const size of [{ width: 1280, height: 720 }, { width: 375, height: 740 }]) {
    await page.setViewportSize(size);
    for (const url of PAGES) {
      await page.goto(url);
      const r = await axe(page).analyze();
      expect(r.violations.map((v) => `${url} ${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`)).toEqual([]);
    }
  }
});

test("ST-14 cards headers on page, stylesheet, image and text routes; security.txt and robots.txt are served", async ({ request }) => {
  const css = (await (await request.get("/")).text()).match(/href="(\/assets\/[^"]+\.css)"/)![1]!;
  for (const url of ["/", "/ember-fox.example/", css, "/img/ember-fox.example.svg", "/.well-known/security.txt", "/robots.txt"]) {
    const res = await request.get(url);
    expect(res.status(), url).toBe(200);
    const h = res.headers();
    for (const k of ["content-security-policy", "x-content-type-options", "strict-transport-security", "referrer-policy", "permissions-policy", "cross-origin-opener-policy", "cross-origin-resource-policy"]) expect(h[k], `${url} ${k}`).toBeTruthy();
    expect(h["set-cookie"], url).toBeUndefined();
  }
  expect((await request.get("/img/ember-fox.example.svg")).headers()["cross-origin-resource-policy"]).toBe("cross-origin");
  expect(await (await request.get("/.well-known/security.txt")).text()).toContain("Contact: mailto:security@mosshatch.com");
  expect(await (await request.get("/robots.txt")).text()).toContain("Sitemap: https://hatchkind.com/sitemap.xml");
});
