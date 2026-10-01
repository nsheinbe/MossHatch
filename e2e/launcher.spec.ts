import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { axe } from "./axe";

/**
 * The brand launcher end to end (docs/LAUNCHER.md) on the real router and a local PostgreSQL, with the launcher's fakes
 * (MH_FAKE_LAUNCHER=1 in scripts/e2e-server.mjs: a scripted creature and the in-repo fake Slate; no model or Slate call).
 * Practice hatch -> Talk -> the creature greets by name -> three answers -> gold sparks and the brief on a scroll with its price ->
 * Approve -> runes -> preview -> "make it warmer" -> version 2 -> Undo -> Publish says what is true. Axe-clean, calm mode, phone.
 * Set LAUNCHER_SHOTS=<dir> to save the key moments as screenshots.
 */

const SHOTS = process.env.LAUNCHER_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}

async function signUp(page: Page, request: APIRequestContext, email: string) {
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("New here? Your email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByLabel("Eight-digit code")).toBeVisible();
  const mail = await (await request.get(`/__dev/mail?to=${encodeURIComponent(email)}`)).json();
  const code = /\b(\d{8})\b/.exec(mail.find((m: { kind: string }) => m.kind === "signup.code").text)![1]!;
  await page.getByLabel("Eight-digit code").fill(code);
  await page.getByRole("button", { name: "Create my passkey" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  await page.getByRole("button", { name: "I saved them" }).click();
  await expect(page.getByRole("button", { name: "Account" })).toBeVisible();
}

/** A signed-up account with the launcher on and credits, a practice hatch of `label`.com, and the conversation open. */
async function openTalk(page: Page, request: APIRequestContext, label: string, o: { calm?: boolean } = {}) {
  await virtualAuthenticator(page);
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  const email = `launch${Date.now()}${Math.floor(Math.random() * 1e4)}@example.org`;
  await signUp(page, request, email);
  // The owner's credit script and the flag (scripts/launcher-credits.mjs; here through the dev server).
  expect(await (await request.get(`/__dev/launcher-credits?email=${encodeURIComponent(email)}&cents=1000`)).json()).toEqual({ ok: true });
  await page.reload();
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Account" })).toBeVisible();
  if (o.calm) await page.getByRole("button", { name: "Calm off" }).click();
  await page.fill("#name-input", label);
  const chip = page.locator("button.chip", { hasText: ".com" });
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await chip.click();
  await page.getByRole("button", { name: "Practice hatch (nothing is bought)" }).click();
  const card = page.getByRole("region", { name: `${label}.com has hatched` });
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card.getByText("Practice hatch.", { exact: false })).toBeVisible();
  await card.getByRole("button", { name: /^Talk to / }).click();
  const panel = page.getByRole("region", { name: /^Talk to / });
  await expect(panel.getByRole("log")).toContainText("Oh! Hello.", { timeout: 20_000 });
  await expect(panel.getByRole("log")).toHaveAttribute("aria-busy", "false");
  return panel;
}

async function say(page: Page, words: string) {
  const panel = page.getByRole("region", { name: /^Talk to / });
  await page.locator("#lx-input").fill(words);
  await page.locator("#lx-input").press("Enter");
  await expect(panel.getByRole("log")).toContainText(words);
  await expect(panel.getByRole("log")).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
}

const clean = async (page: Page, what: string) => {
  const v = (await axe(page).include(".lx").analyze()).violations;
  expect(v.map((x) => `${what}: ${x.id} ${x.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};

test("talk -> brief with price -> approve -> runes -> preview -> revise -> undo -> publish note; axe clean", async ({ page, request }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/GPU stall|GL Driver|Download the React DevTools/.test(m.text())) errors.push(m.text()); });
  const panel = await openTalk(page, request, "free-lantern");
  await expect(panel.getByRole("heading", { level: 2 })).toContainText("free-lantern.com");
  await expect(panel.getByText("1,000 credits ($10.00)")).toBeVisible();
  // The creature introduced itself by name, and its words float at its head.
  await expect(panel.getByRole("log")).toContainText(/I'm [A-Za-z ]+, the creature of free-lantern\.com/);
  await expect(page.locator(".lx-bubble")).toContainText("Oh! Hello.");
  await clean(page, "greeting");

  // While it speaks: the live caption and the glowing bubble.
  await page.locator("#lx-input").fill("A lantern shop for night walkers");
  await page.locator("#lx-input").press("Enter");
  await expect(page.locator(".lx-bubble.is-speaking")).toBeVisible();
  await shot(page, "1-creature-talking");
  await expect(panel.getByRole("log")).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
  await say(page, "People who walk after dark and love warm light");
  await say(page, "Cosy and a little magical");

  // The brief on a scroll, with the price before anything is charged.
  const approve = panel.getByRole("button", { name: "Approve and build for 270 credits" });
  await expect(approve).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByRole("heading", { name: "Free Lantern" })).toBeFocused();
  await expect(panel.getByText("Nothing is charged until you press Approve.")).toBeVisible();
  await expect(panel.locator(".lx-swatch")).toHaveCount(4);
  await page.waitForTimeout(900);
  await shot(page, "2-gold-sparks-scroll");
  await clean(page, "brief");

  await approve.click();
  await expect(panel.getByText("730 credits ($7.30)")).toBeVisible();
  await expect(panel.locator(".lx-runes")).toBeVisible();
  await expect(panel.locator(".lx-rune.is-active")).toHaveCount(1, { timeout: 10_000 });
  await page.waitForTimeout(400);
  await expect(panel.getByRole("progressbar", { name: "Build progress" })).toBeVisible();
  await shot(page, "3-build-runes");
  await clean(page, "runes");

  const frame = panel.locator('iframe[title^="Preview of Free Lantern, version 1"]');
  await expect(frame).toBeVisible({ timeout: 30_000 });
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(page.frameLocator('iframe[title^="Preview of"]').getByRole("heading", { name: "Free Lantern" })).toBeVisible();
  await page.waitForTimeout(1200);
  await shot(page, "4-preview");

  // Iterate at a high level: the creature proposes the change, the price shows, approve, version 2.
  await say(page, "make it warmer");
  const approve2 = panel.getByRole("button", { name: "Approve and build for 90 credits" });
  await expect(approve2).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText("make it warmer").last()).toBeVisible();
  await approve2.click();
  const v2 = panel.getByRole("button", { name: "Version 2" });
  await expect(v2).toBeVisible({ timeout: 30_000 });
  await expect(v2).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByText("640 credits ($6.40)")).toBeVisible();
  await panel.getByRole("button", { name: "Undo to version 1" }).click();
  await expect(panel.getByRole("button", { name: "Version 1" })).toHaveAttribute("aria-pressed", "true");
  await shot(page, "5-versions");

  // Publish says what is true: not yet; the files can be downloaded.
  await panel.getByRole("button", { name: "Publish to free-lantern.com" }).click();
  await expect(panel.getByText("Publishing to your domain arrives next.")).toBeVisible();
  await expect(panel.getByText("does not point at this site", { exact: false })).toBeVisible();
  const dl = panel.getByRole("link", { name: "Download version 1" });
  await expect(dl).toHaveAttribute("href", /^\/api\/v1\/launcher\/builds\/[0-9a-f-]{36}\/export$/);
  const res = await page.request.get((await dl.getAttribute("href"))!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toMatch(/^attachment;/);
  await clean(page, "publish");
  await shot(page, "6-publish-note");

  // Keyboard: Escape closes the conversation.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: /^Talk to / })).toBeHidden();
  expect(errors).toEqual([]);
});

test("calm mode: the scroll and preview only fade, the creature's glow does not pulse", async ({ page, request }) => {
  test.setTimeout(240_000);
  const panel = await openTalk(page, request, "free-still", { calm: true });
  await expect(panel).toHaveAttribute("data-calm", "1");
  await say(page, "A quiet tea house");
  await say(page, "Tired people");
  await say(page, "Slow and gentle");
  await expect(panel.getByRole("button", { name: "Approve and build for 270 credits" })).toBeVisible({ timeout: 20_000 });
  expect(await panel.locator(".lx-unfurl .lx-sheet").evaluate((e) => getComputedStyle(e).animationName)).toBe("lx-fade");
  await shot(page, "7-calm-mode");
  await panel.getByRole("button", { name: "Approve and build for 270 credits" }).click();
  await expect(panel.locator(".lx-rune").first()).toBeVisible();
  const active = panel.locator(".lx-rune.is-active svg");
  if (await active.count()) expect(await active.first().evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
  await expect(panel.locator('iframe[title^="Preview of"]')).toBeVisible({ timeout: 30_000 });
  expect(await panel.locator(".lx-unroll").evaluate((e) => getComputedStyle(e).animationName)).toBe("lx-fade");
  await clean(page, "calm");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("the conversation is a bottom sheet under the creature, and still axe clean", async ({ page, request }) => {
    test.setTimeout(240_000);
    const panel = await openTalk(page, request, "free-pocket");
    await expect(panel).toHaveClass(/is-sheet/);
    const box = (await panel.boundingBox())!;
    expect(box.width).toBeGreaterThan(380);
    expect(box.y + box.height).toBeGreaterThan(830);
    await say(page, "A tiny bakery");
    await say(page, "Neighbours");
    await say(page, "Warm");
    await expect(panel.getByRole("button", { name: "Approve and build for 270 credits" })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1200);
    await shot(page, "8-phone");
    await clean(page, "phone");
  });
});
