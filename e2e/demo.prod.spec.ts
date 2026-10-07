import { test, expect, type Page } from "@playwright/test";
import { axe } from "./axe";

/**
 * Demo mode (the public preview build, prod project): the permanent banner everywhere (app, WebGL fallback, pages without scripts),
 * honest practice-hatch wording, the waitlist (dialog and no-JS page; the API is faked by e2e/serve-dist.mjs), and the SEO basics.
 */
const BANNER = "Mosshatch isn't open yet. This is a preview — nothing you hatch is registered or charged.";
const violations = async (page: Page, include?: string) => {
  const a = include ? axe(page).include(include) : axe(page);
  return (await a.analyze()).violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 90)}`);
};
const cancelDemo = async (page: Page) => { await page.keyboard.press("Escape"); await page.locator("#name-input").waitFor(); };
const watch = (page: Page) => {
  const bad: string[] = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/GPU stall|GL Driver/.test(m.text())) bad.push(m.text()); });
  page.on("pageerror", (e) => bad.push("pageerror: " + e.message));
  return bad;
};

test("demo banner: in the app, permanent, axe clean; no account or purchase entry point", async ({ page }) => {
  const bad = watch(page);
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await cancelDemo(page);
  const banner = page.getByRole("complementary", { name: "Preview notice" });
  await expect(banner).toBeVisible();
  await expect(banner).toHaveText(BANNER + "Join the waitlist");
  await expect(banner.getByRole("link", { name: "Join the waitlist" })).toHaveAttribute("href", "/waitlist");
  // The header sits below the banner, not under it.
  const b = await banner.boundingBox(), h = await page.locator(".site-header").boundingBox();
  expect(h!.y).toBeGreaterThanOrEqual(b!.y + b!.height - 1);
  await expect(page.getByRole("button", { name: /Sign in/ })).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
  expect(bad).toEqual([]);
});

test("demo: registered-or-not comes from the registry lookup, no made-up prices, and the practice hatch says the name isn't registered", async ({ page }) => {
  const bad = watch(page);
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.waitForFunction(() => document.querySelector("canvas.world"));
  await cancelDemo(page);
  const noPriceOrSimulation = async () => {
    for (const chip of await page.locator(".chip").all()) {
      expect(await chip.textContent()).not.toMatch(/simulated|\$\d|sample price/i);
      expect(await chip.getAttribute("aria-label")).not.toMatch(/simulated|\$\d|sample price/i);
    }
  };
  // Registered everywhere (the fake registries in e2e/serve-dist.mjs): every chip is taken, with no "Simulated" tag.
  await page.fill("#name-input", "google");
  await expect(page.locator(".chip.taken")).toHaveCount(6, { timeout: 15000 });
  await expect(page.locator(".chip.taken").first()).toHaveText(/Taken · already registered/);
  expect(await page.locator(".chip.taken").first().getAttribute("aria-label")).toMatch(/: taken$/);
  await expect(page.locator("button.chip")).toHaveCount(0);
  await noPriceOrSimulation();
  // A registry that cannot be asked: "Couldn't check right now", and nothing to hatch.
  await page.fill("#name-input", "nocheckfern");
  await expect(page.locator(".chip.unknown")).toHaveCount(6, { timeout: 15000 });
  await expect(page.locator(".chip.unknown").first()).toHaveText(/Couldn't check right now/);
  await expect(page.locator("button.chip")).toHaveCount(0);
  expect(await violations(page, ".shop-results")).toEqual([]);
  // Unregistered names: hatchable, with no dollar figure.
  await page.fill("#name-input", "emberwick");
  await expect(page.locator("button.chip").first()).toBeVisible({ timeout: 15000 });
  for (const chip of await page.locator("button.chip").all()) await expect(chip).toContainText("Looks unregistered · test price may change");
  await expect(page.locator("button.chip").first()).toContainText("$");
  await expect(page.locator("button.chip").first()).toContainText("Current renewal");
  await expect(page.getByText(/stay in this browser/)).toHaveCount(0);
  await page.getByRole("button", { name: "The deal" }).click();
  await expect(page.getByText("These are published invite-only test prices. A practice hatch never registers or reserves a domain.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Got it" }).press("Enter");
  await page.locator("button.chip").first().press("Enter");
  const sheet = page.getByRole("region", { name: /^Hatch / });
  await expect(sheet.getByText("Practice hatch — this name isn't registered.")).toBeVisible();
  await expect(sheet.getByText("Published test price", {exact:true})).toBeVisible();
  await expect(sheet.getByText("Preview only. A practice hatch does not purchase or reserve this name.", { exact: false })).toBeVisible();
  expect(await sheet.textContent()).toMatch(/\$\d/);
  await expect(sheet.getByRole("button", { name: /^Pay/ })).toHaveCount(0);
  expect(await violations(page, ".panel.side")).toEqual([]);
  const domain = (await sheet.getByRole("heading", { level: 2 }).textContent())!.trim();
  await sheet.getByRole("button", { name: "Preview creature", exact: true }).press("Enter");
  const card = page.getByRole("region", { name: `${domain} has hatched` });
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card.getByText("Practice hatch — this name isn't registered.")).toBeVisible();
  expect(await card.textContent()).not.toMatch(/\byou own\b|\breserved for you\b|\bis yours\b/i);
  expect(await violations(page, ".panel.side")).toEqual([]);
  await expect(card.getByRole("button", { name: "Copy card link" })).toHaveCount(0);
  const portrait = card.getByRole("link", { name: "Download portrait" });
  await expect(portrait).toHaveAttribute("download", `${domain}-mosshatch.png`);
  await expect(portrait).toHaveAttribute("href", /^data:image\/png/);
  // "Want it for real?" opens the waitlist with the hatched name filled in.
  await card.getByRole("button", { name: "Want it for real? Join the waitlist" }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Join the waitlist" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("The name you hatched (optional)")).toHaveValue(domain);
  expect(bad).toEqual([]);
});

test("waitlist dialog: consent unticked and required, says it reserves nothing, submits, focus returns; axe clean", async ({ page }) => {
  const bad = watch(page);
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await cancelDemo(page);
  const open = page.getByRole("link", { name: "Join the waitlist" });
  await open.click();
  const dialog = page.locator("dialog.waitlist");
  await expect(page.getByRole("dialog", { name: "Join the waitlist" })).toBeVisible();
  await expect(dialog.getByText("Joining does not reserve or register a name.")).toBeVisible();
  await expect(dialog.getByRole("link", { name: /Waitlist privacy note \(draft awaiting counsel\)/ })).toHaveAttribute("href", "/waitlist-privacy");
  const consent = dialog.getByRole("checkbox", { name: /Email me about Mosshatch/ });
  await expect(consent).not.toBeChecked();
  expect(await violations(page, "dialog.waitlist")).toEqual([]);
  const before = await (await page.request.get("/__e2e/waitlist")).json();
  await dialog.getByRole("textbox", { name: "Email" }).fill("fern@example.com");
  await dialog.getByText("One optional question", { exact: true }).click();
  await dialog.getByRole("radio", { name: "Maybe" }).check();
  await dialog.getByRole("button", { name: "Join the waitlist" }).click();
  // Not sent without the consent tick (the browser's required check).
  await expect(dialog.getByRole("heading", { name: "Join the waitlist" })).toBeVisible();
  expect(await (await page.request.get("/__e2e/waitlist")).json()).toEqual(before);
  await consent.check();
  await dialog.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(dialog.getByRole("heading", { name: "Check your email" })).toBeVisible();
  expect(await (await page.request.get("/__e2e/waitlist")).json()).toMatchObject({ email: "fern@example.com", answer: "maybe", consent: true, website: "", source: "app", form: false });
  expect(await violations(page, "dialog.waitlist")).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  expect(bad).toEqual([]);
});

test("no JavaScript: the banner is on the home page and the static pages, and the waitlist page works as a plain form", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, baseURL: "http://127.0.0.1:4173" });
  const page = await ctx.newPage();
  for (const url of ["/", "/fees.html", "/legal/terms.html", "/waitlist", "/no-such-page"]) {
    await page.goto(url);
    await expect(page.getByRole("complementary", { name: "Preview notice" }), url).toContainText(BANNER);
  }
  await page.goto("/");
  await page.getByRole("link", { name: "Join the waitlist" }).click();
  await expect(page).toHaveURL(/\/waitlist$/);
  await expect(page.getByText("Joining does not reserve or register a domain name.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Email me about Mosshatch/ })).not.toBeChecked();
  await page.getByRole("textbox", { name: "Email" }).fill("nojs@example.com");
  await page.getByLabel("The name you hatched (optional)").fill("moonfern.com");
  await page.getByText("One optional question", { exact: true }).click();
  await page.getByRole("radio", { name: "Yes" }).check();
  await page.getByRole("checkbox", { name: /Email me about Mosshatch/ }).check();
  await page.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(page).toHaveURL(/\/waitlist-sent$/);
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.goto("/waitlist-privacy");
  await expect(page.getByText("Draft awaiting counsel.")).toBeVisible();
  await ctx.close();
  const r = await (await (await browser.newContext()).request.get("http://127.0.0.1:4173/__e2e/waitlist")).json();
  expect(r).toMatchObject({ email: "nojs@example.com", name: "moonfern.com", answer: "yes", consent: "yes", source: "page", website: "", form: true });
});

test("axe: the waitlist pages at desktop and phone sizes, and the banner with no WebGL", async ({ page, browser }) => {
  for (const size of [{ width: 1280, height: 720 }, { width: 375, height: 740 }]) {
    await page.setViewportSize(size);
    for (const url of ["/waitlist", "/waitlist-sent", "/waitlist-privacy", "/fees.html", "/how-it-works"]) {
      await page.goto(url);
      expect((await violations(page)).map((v) => `${url} ${v}`)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${url} no sideways scroll`).toBe(true);
    }
  }
  const ctx = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  await ctx.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    // @ts-expect-error test shim
    HTMLCanvasElement.prototype.getContext = function (t: string, ...a: unknown[]) { return t === "webgl2" ? null : orig.call(this, t, ...a); };
  });
  const fb = await ctx.newPage();
  const bad = watch(fb);
  await fb.goto("/");
  await expect(fb.getByText("You're using the lightweight view. Search and checkout work without the animated grove.")).toBeVisible();
  await expect(fb.getByRole("complementary", { name: "Preview notice" })).toContainText(BANNER);
  await fb.fill("#name-input", "moonfern");
  await fb.getByRole("button", { name: "Search" }).click();
  await expect(fb.getByText("moonfern.com")).toBeVisible();
  // moonfern.com is registered (the fake registries mirror the real ones); the rest of the list says what the registry said, with no price.
  const rows = fb.locator(".shop-results .chip");
  await expect(rows.first()).toContainText("moonfern.comTaken · already registered");
  await expect(rows.filter({ hasText: "moonfern.dev" })).toContainText("Looks unregistered · test price may change");
  expect(await rows.allTextContents()).not.toContainEqual(expect.stringMatching(/simulated/));
  expect(await violations(fb)).toEqual([]);
  await fb.getByRole("link", { name: "Join the waitlist" }).click();
  await expect(fb.getByRole("dialog", { name: "Join the waitlist" })).toBeVisible();
  expect(await violations(fb, "dialog.waitlist")).toEqual([]);
  expect(bad).toEqual([]);
  await ctx.close();
});

test("SEO: title, description, canonical and share tags; app-only routes are noindex; sitemap and robots list only indexable pages", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Mosshatch — every domain hatches a creature. Join the waitlist.");
  const meta = (sel: string) => page.locator(sel).first().getAttribute("content");
  expect(await meta('meta[name="description"]')).toContain("Mosshatch isn't open yet");
  expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toBe("https://mosshatch.com/");
  expect(await meta('meta[property="og:url"]')).toBe("https://mosshatch.com/");
  expect(await meta('meta[property="og:image"]')).toBe("https://mosshatch.com/og.png");
  expect(await meta('meta[name="twitter:card"]')).toBe("summary_large_image");
  const img = await request.get("/og.png");
  expect(img.status()).toBe(200);
  expect(img.headers()["content-type"]).toBe("image/png");
  const png = await img.body();
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  expect(png.length).toBeLessThan(400_000);
  for (const url of ["/fees.html", "/commitments.html", "/legal/terms.html", "/waitlist"]) {
    await page.goto(url);
    expect(await page.locator('link[rel="canonical"]').getAttribute("href"), url).toMatch(/^https:\/\/mosshatch\.com\//);
    expect(await meta('meta[name="description"]'), url).toBeTruthy();
    expect(await meta('meta[property="og:title"]'), url).toBeTruthy();
  }
  for (const url of ["/device", "/checkout/return", "/invite", "/?oauth_request=0190f0f0-0000-7000-8000-000000000001"]) {
    expect((await request.get(url)).headers()["x-robots-tag"], url).toBe("noindex");
  }
  expect((await request.get("/")).headers()["x-robots-tag"]).toBeUndefined();
  await page.goto("/device");
  await page.waitForSelector("html[data-booted='1']");
  expect(await page.locator('meta[name="robots"]').getAttribute("content")).toBe("noindex");
  await page.goto("/waitlist-sent");
  expect(await page.locator('meta[name="robots"]').getAttribute("content")).toBe("noindex");
  const sitemap = await (await request.get("/sitemap.xml")).text();
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
  expect(locs.length).toBeGreaterThan(5);
  for (const l of locs) expect(l).toMatch(/^https:\/\/mosshatch\.com\//);
  expect(locs).toContain("https://mosshatch.com/waitlist");
  expect(locs).toContain("https://mosshatch.com/how-it-works");
  for (const l of locs) expect(l).not.toMatch(/device|checkout|invite|oauth|waitlist-sent|404|500|debug|api/);
  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toContain("Sitemap: https://mosshatch.com/sitemap.xml");
});
