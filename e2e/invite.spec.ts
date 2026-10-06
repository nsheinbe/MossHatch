import { test, expect, type Page } from "@playwright/test";

/**
 * The invite-only live build (VITE_SITE_MODE=invite; docs/GO-LIVE.md). One build: a visitor keeps the demo (banner, practice hatch from
 * the public registry lookup, labelled test prices, waitlist); an account that signed up with an invite gets the shop and no banner; signing out
 * brings the demo back. Real API router on a local PostgreSQL (scripts/e2e-server.mjs) with MH_INVITE_ONLY=1 and MH_LIVE_GATE=1.
 */
async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}
const banner = (page: Page) => page.getByRole("complementary", { name: "Preview notice" });

test("visitors keep the demo; an invited account gets the shop without the banner; signing out brings the demo back", async ({ page, request }) => {
  const shopCalls: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (/^\/api\/v1\/(search|quote|orders)/.test(u.pathname)) shopCalls.push(u.pathname); });
  await virtualAuthenticator(page);
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  await expect(banner(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Invited? Sign in" })).toBeVisible({ timeout: 20_000 });
  // The demo search: registered-or-not from the public registry lookup, labelled test pricing, and never the registrar-backed shop routes.
  await page.fill("#name-input", "moonfern");
  await expect(page.locator(".chip").first()).toBeVisible({ timeout: 20_000 });
  for (const chip of await page.locator("button.chip").all()) {
    await expect(chip).toContainText(/\$\d/);
    await expect(chip).toContainText('test price may change');
  }
  await page.locator('button.chip').first().click();
  await expect(page.getByRole('button', {name:'Preview creature', exact:true})).toBeVisible();
  await expect(page.getByRole('button', {name:/Buy domain & hatch/})).toHaveCount(0);
  await page.getByRole('button', {name:'Keep exploring',exact:true}).click();
  expect(shopCalls).toEqual([]);

  // The owner invites themself (scripts/waitlist-invite.mjs --email; here through the dev server) and follows the emailed link.
  const email = `owner${Date.now()}@example.org`;
  expect(await (await request.get(`/__dev/invite?email=${encodeURIComponent(email)}`)).json()).toMatchObject({ invited: 1 });
  const invite = (await (await request.get(`/__dev/mail?to=${encodeURIComponent(email)}`)).json()).find((m: { kind: string }) => m.kind === "waitlist.invite");
  const link = /https?:\/\/\S+(\/invite\?t=\S+)/.exec(invite.text)![1]!;
  await page.goto(link);
  await page.waitForSelector("html[data-booted='1']");
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

  // Invited and signed in: no banner, and the search goes to the shop with prices.
  await expect(banner(page)).toBeHidden();
  await expect(page.locator("html")).not.toHaveAttribute("data-site", "demo");
  await page.fill("#name-input", "moonfernshop");
  await expect(page.locator("button.chip", { hasText: ".com" })).toContainText(/\$\d/, { timeout: 20_000 });
  expect(shopCalls).toContain("/api/v1/search");

  // Signing out: the demo again.
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(banner(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Invited? Sign in" })).toBeVisible({ timeout: 20_000 });
});
