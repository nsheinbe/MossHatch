import { test, expect } from "@playwright/test";
import { axe } from "./axe";

// The pre-rendered public pages of mosshatch.com, served from apps/web/dist with vercel.json's headers.
// /fees.html is owned by another module and checked there.
const PAGES = ["/commitments.html", "/legal/", "/legal/terms.html", "/legal/privacy.html", "/legal/abuse-dmca.html", "/legal/registrant-rights.html", "/legal/accessibility.html", "/legal/cookies.html", "/security.html", "/report.html"];

test("public pages are complete static HTML: real content with JavaScript off", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  for (const url of PAGES) {
    const res = await page.goto(url);
    expect(res!.status(), url).toBe(200);
    await expect(page.locator("h1"), url).toBeVisible();
    expect(await page.locator("script").count(), url).toBe(0);
  }
  await ctx.close();
});

test("axe: every public page at desktop and phone sizes", async ({ page }) => {
  for (const size of [{ width: 1280, height: 720 }, { width: 375, height: 740 }]) {
    await page.setViewportSize(size);
    for (const url of PAGES) {
      await page.goto(url);
      const r = await axe(page).analyze();
      expect(r.violations.map((v) => `${url} ${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`)).toEqual([]);
    }
  }
});

test("clean URLs resolve, and an unknown page is the branded 404 with status 404", async ({ page }) => {
  expect((await page.goto("/security"))!.status()).toBe(200);
  const res = await page.goto("/no-such-page");
  expect(res!.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Nothing hatched here" })).toBeVisible();
  expect((await axe(page).analyze()).violations).toEqual([]);
  await page.goto("/500.html");
  await expect(page.getByRole("heading", { name: "The grove is resting" })).toBeVisible();
  expect((await axe(page).analyze()).violations).toEqual([]);
});

test("D-032 security.txt, and D-035 sitemap and robots list only indexable public pages", async ({ request }) => {
  const sec = await request.get("/.well-known/security.txt");
  expect(sec.status()).toBe(200);
  const text = await sec.text();
  for (const f of ["Contact: mailto:security@mosshatch.com", "Expires: ", "Policy: https://mosshatch.com/security", "Canonical: https://mosshatch.com/.well-known/security.txt", "Preferred-Languages: en"]) expect(text).toContain(f);
  const sitemap = await (await request.get("/sitemap.xml")).text();
  for (const u of ["https://mosshatch.com/", "https://mosshatch.com/commitments", "https://mosshatch.com/legal/", "https://mosshatch.com/security"]) expect(sitemap).toContain(`<loc>${u}</loc>`);
  expect(sitemap).not.toMatch(/404|500|debug/);
  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toContain("Disallow: /api/"); expect(robots).toContain("Sitemap: https://mosshatch.com/sitemap.xml");
});

test("C-21 the home page links to the abuse report page without sign-in, before and after the app starts", async ({ browser, page }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const off = await ctx.newPage();
  await off.goto("/");
  await expect(off.getByRole("link", { name: "Report abuse" })).toHaveAttribute("href", "/report.html");
  await ctx.close();
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: "Report abuse" })).toHaveAttribute("href", "/report.html");
});
