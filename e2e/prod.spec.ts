import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const watch = (page: Page) => {
  const bad: string[] = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/GPU stall|GL Driver/.test(m.text())) bad.push(m.text()); });
  page.on("pageerror", (e) => bad.push("pageerror: " + e.message));
  return bad;
};
const cancelDemo = async (page: Page) => { await page.keyboard.press("Escape"); await page.locator("#name-input").waitFor(); };

test("ST-36 CSP is enforced and the app runs with zero violations", async ({ page }) => {
  const bad = watch(page);
  const res = await page.goto("/");
  expect(res!.headers()["content-security-policy"]).toContain("script-src 'self'");
  await page.waitForSelector("html[data-booted='1']");
  await page.waitForFunction(() => document.querySelector("canvas.world"));
  await page.waitForTimeout(4000);
  await cancelDemo(page);
  await page.fill("#name-input", "grovekeeper");
  await expect(page.locator(".chip").first()).toBeVisible({ timeout: 15000 });
  expect(bad).toEqual([]);
});

test("ST-14 header set on page, script and asset routes", async ({ request }) => {
  for (const url of ["/", "/boot.js", "/fonts/young-serif-latin-400-normal.woff2"]) {
    const h = (await request.get(url)).headers();
    for (const k of ["content-security-policy", "x-content-type-options", "strict-transport-security", "referrer-policy", "permissions-policy", "cross-origin-opener-policy"]) expect(h[k], `${url} ${k}`).toBeTruthy();
  }
});

test("first paint shows real content before the scene loads", async ({ page }) => {
  await page.route("**/assets/main-*.js", (r) => r.abort());
  await page.goto("/");
  await expect(page.locator("#boot-panel")).toBeVisible(); // script failure message from /boot.js
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 90)}`)).toEqual([]);
  await expect(page.getByRole("heading", { name: "Every name hatches." })).toBeVisible();
  await expect(page.locator(".static-prices li, .static-find li").first()).toBeVisible();
});

test("axe: Find view, results, and deal popover", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await cancelDemo(page);
  await page.fill("#name-input", "emberwick");
  await expect(page.locator(".chip").first()).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "The deal" }).click();
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`)).toEqual([]);
});

test("axe: My grove view", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await cancelDemo(page);
  await page.getByRole("button", { name: "My grove" }).click();
  await page.getByRole("button", { name: "Preview a sample grove" }).click();
  await expect(page.locator(".tag").first()).toBeVisible();
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`)).toEqual([]);
});

test("keyboard: tab to a chip, open the sheet, escape closes it", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await cancelDemo(page);
  await page.fill("#name-input", "emberwick");
  const chip = page.locator("button.chip").first();
  await expect(chip).toBeVisible({ timeout: 15000 });
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: /^Hatch / })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2 }).first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: /^Hatch / })).toBeHidden();
});

test("no JavaScript: same page, static prices readable", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, baseURL: "http://127.0.0.1:4173" });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Every name hatches." })).toBeVisible();
  await expect(page.getByText(".com")).toBeVisible();
  expect(await page.locator("noscript").first().textContent()).toContain("needs JavaScript");
  await ctx.close();
});

test("no WebGL2: in-brand fallback with a working plain search, CSP clean", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  await ctx.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    // @ts-expect-error test shim
    HTMLCanvasElement.prototype.getContext = function (t: string, ...a: unknown[]) { return t === "webgl2" ? null : orig.call(this, t, ...a); };
  });
  const page = await ctx.newPage();
  const bad = watch(page);
  await page.goto("/");
  await expect(page.getByText("This browser can't light the lanterns.")).toBeVisible();
  await page.fill("#fb-name", "moonfern");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("moonfern.com")).toBeVisible();
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.map((v) => v.id)).toEqual([]);
  expect(bad).toEqual([]);
  await ctx.close();
});

test("persisted state is limited to calm, sound and rehideSeconds", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await cancelDemo(page);
  await page.getByRole("button", { name: /Calm/ }).click();
  await page.fill("#name-input", "emberwick");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("mosshatch.prefs") ?? "{}"));
  expect(Object.keys(stored.state).sort()).toEqual(["calm", "rehideSeconds", "sound"]);
  expect(stored.state.calm).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage).length)).toBeLessThanOrEqual(1);
});
