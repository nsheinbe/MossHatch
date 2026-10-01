import { test, expect, type Page } from "@playwright/test";
import { axe } from "./axe";

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
  expect((await axe(page).analyze()).violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 90)}`)).toEqual([]);
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
  const r = await axe(page).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`)).toEqual([]);
});

test("axe: My grove view", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await cancelDemo(page);
  await page.getByRole("button", { name: "My grove" }).click();
  await page.getByRole("button", { name: "Preview a sample grove" }).click();
  await expect(page.locator(".tag").first()).toBeVisible();
  const r = await axe(page).analyze();
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
  const r = await axe(page).analyze();
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

test("C-53 canary: a search sends one same-origin GET to /api/lookup with the name in the query, and nothing else anywhere", async ({ page }) => {
  const reqs: URL[] = [];
  const methods: string[] = [];
  page.on("request", (r) => { reqs.push(new URL(r.url())); methods.push(r.method()); });
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await cancelDemo(page);
  await page.waitForTimeout(500);
  const before = reqs.length;
  await page.fill("#name-input", "secretcanaryname");
  await expect(page.locator(".chip").first()).toBeVisible({ timeout: 15000 });
  const after = reqs.slice(before), how = methods.slice(before);
  const named = after.filter((u) => /canary/i.test(u.href));
  expect(named.map((u) => u.pathname + u.search)).toEqual(["/api/lookup?name=secretcanaryname"]);
  expect(after.every((u) => u.origin === "http://127.0.0.1:4173")).toBe(true);
  expect(how.every((m) => m === "GET")).toBe(true);
  expect(after.some((u) => /canary/i.test(u.pathname))).toBe(false);
  await expect(page.getByRole("link", { name: "commitments" })).toBeVisible();
});

// Phase 3 (C-13, C-26 to C-29, C-53, C-59, C-60, C-62): the fee page and the .ai/.io addenda are static pages under the strict CSP, axe clean.
test("fee page and registry addenda: static HTML under the CSP, axe clean at desktop and phone sizes", async ({ page, browser }) => {
  const pages = ["/fees.html", "/legal/tld-addendum-ai.html", "/legal/tld-addendum-io.html"];
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const nojs = await ctx.newPage();
  for (const url of pages) {
    const res = await nojs.goto(url);
    expect(res!.status(), url).toBe(200);
    expect(res!.headers()["content-security-policy"], url).toContain("default-src 'none'");
    await expect(nojs.locator("h1"), url).toBeVisible();
    expect(await nojs.locator("script").count(), url).toBe(0);
  }
  await expect(nojs.getByRole("table", { name: "What each action costs, per extension" })).toHaveCount(0);   // last page is the .io addendum
  await nojs.goto("/fees.html");
  await expect(nojs.getByRole("table", { name: "What each action costs, per extension" })).toBeVisible();
  await expect(nojs.getByText("Tucows Domains Inc. (IANA ID 69)", { exact: false }).first()).toBeVisible();
  await ctx.close();
  const violations: string[] = [];
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  for (const size of [{ width: 1280, height: 720 }, { width: 375, height: 740 }]) {
    await page.setViewportSize(size);
    for (const url of pages) {
      await page.goto(url);
      const r = await axe(page).analyze();
      expect(r.violations.map((v) => `${url} ${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${url} no sideways scroll`).toBe(true);
    }
  }
  expect(violations).toEqual([]);
});

test("ST-38 Trusted Types is enforced with zero violations", async ({ page }) => {
  const bad = watch(page);
  await page.addInitScript(() => {
    (window as unknown as { __tt: string[] }).__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __tt: string[] }).__tt.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const res = await page.goto("/");
  const csp = res!.headers()["content-security-policy"];
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(csp).toContain("trusted-types mosshatch");
  await page.waitForSelector("html[data-booted='1']");
  await page.waitForFunction(() => document.querySelector("canvas.world"));
  await page.waitForTimeout(3000);
  await cancelDemo(page);
  await page.fill("#name-input", "lanternfern");
  await expect(page.locator(".chip").first()).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "My grove" }).click();
  await page.getByRole("button", { name: "Preview a sample grove" }).click();
  await expect(page.locator(".tag").first()).toBeVisible();
  await page.waitForTimeout(300);
  // Everything the app did so far raised no violation of any kind.
  expect(await page.evaluate(() => (window as unknown as { __tt: string[] }).__tt)).toEqual([]);
  const probe = await page.evaluate(() => {
    const out: string[] = [];
    try { document.createElement("div").innerHTML = "<b>x</b>"; out.push("innerHTML allowed"); } catch (e) { out.push((e as Error).name); }
    try { const s = document.createElement("script"); s.src = "/assets/x.js"; out.push("script src allowed"); } catch (e) { out.push((e as Error).name); }
    const tt = (window as unknown as { trustedTypes?: { createPolicy(n: string, r: object): unknown } }).trustedTypes;
    try { tt!.createPolicy("default", { createHTML: (s: string) => s }); out.push("default policy allowed"); } catch (e) { out.push((e as Error).name); }
    try { tt!.createPolicy("mosshatch", {}); out.push("second mosshatch policy allowed"); } catch (e) { out.push((e as Error).name); }
    return out;
  });
  expect(probe).toEqual(["TypeError", "TypeError", "TypeError", "TypeError"]);
  // The probes above are refused by design, and reported as Trusted Types violations (so the reporting path works).
  await page.waitForTimeout(300);
  const reported = await page.evaluate(() => (window as unknown as { __tt: string[] }).__tt);
  expect(reported.length).toBeGreaterThan(0);
  expect(reported.filter((r) => !/trusted-types|require-trusted-types-for/.test(r))).toEqual([]);
  expect(bad.filter((b) => !/Trusted Type|TrustedHTML|TrustedScriptURL|trusted-types|Trusted Types/i.test(b))).toEqual([]);
});

test("ST-70 /device ignores a code in the URL, and the page is accessible", async ({ page }) => {
  const bad = watch(page);
  const calls: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/")) calls.push(r.url()); });
  await page.goto("/device?user_code=BCDF-GHJK");
  await page.waitForSelector("html[data-booted='1']");
  const input = page.getByLabel("Code from your terminal");
  await expect(input).toBeVisible({ timeout: 15000 });
  await expect(input).toHaveValue("");
  await expect(page.getByRole("heading", { name: "Approve a command-line sign-in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Look up" })).toBeDisabled();
  expect(calls.filter((u) => /oauth\/device/.test(u))).toEqual([]);
  const r = await axe(page).include(".panel.device").analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`)).toEqual([]);
  expect(bad).toEqual([]);
});
