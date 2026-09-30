import { test, expect, type Page } from "@playwright/test";
import { axe } from "./axe";

/**
 * Publish a hatchkind.com card from the domain panel: the portrait is rasterised in the browser, its hash is signed with the passkey,
 * the server re-encodes and stores it, and the card can be taken down in one click. Real API router on a local PostgreSQL
 * (scripts/e2e-server.mjs) with the in-memory card storage and Web Risk fake that local mode installs.
 */
async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}

async function signUp(page: Page, request: import("@playwright/test").APIRequestContext, email: string) {
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

/** Search a name, save the contact, accept, pay on the fake Checkout and wait for the hatch. Returns the price shown on the button. */
async function buy(page: Page, request: import("@playwright/test").APIRequestContext, baseURL: string, label: string, o: { autoRenew?: boolean } = {}): Promise<string> {
  await page.fill("#name-input", label);
  const chip = page.locator("button.chip", { hasText: ".com" });
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await chip.click();
  for (const [l, value] of [["Full name", "Ada Moss"], ["Phone, like +1.5555550100", "+1.5555550100"], ["Street address", "1 Fern Lane"], ["City", "Portland"], ["State or region", "OR"], ["Postal code", "97201"]] as const) await page.getByLabel(l).fill(value);
  await page.getByRole("button", { name: "Save contact" }).click();
  const pay = page.getByRole("button", { name: /Pay .* and hatch/ });
  const shown = (await pay.textContent())!.match(/\$([\d.]+)/)![1]!;
  // C-31: the auto-renew box is unticked by default and separate from the terms box.
  const save = page.getByLabel("Save my card for auto-renew. This is separate from the terms.");
  await expect(save).not.toBeChecked();
  if (o.autoRenew) await save.check();
  await page.getByLabel(/I accept the/).check();
  let resolveOrder!: (id: string) => void;
  const orderId = new Promise<string>((resolve) => { resolveOrder = resolve; });
  await page.route("**/api/v1/orders", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const res = await route.fetch();
    if (res.ok()) resolveOrder((await res.json()).order_id);
    await route.fulfill({ response: res });
  });
  await page.route("https://checkout.stripe.test/**", async (route) => {
    const order = await orderId;
    await route.fulfill({ status: 302, headers: { location: `${baseURL}/__dev/pay?order=${order}` } });
  });
  await pay.click();
  await expect(page.getByRole("region", { name: /has hatched$/ })).toBeVisible({ timeout: 300_000 });
  void request;
  return shown;
}

const clean = async (page: Page, what: string) => { const v = (await axe(page).analyze()).violations; expect(v.map((x) => `${what}: ${x.id}`)).toEqual([]); };

/** Open the domain panel for a name from the grove. */
async function openDomain(page: Page, label: string) {
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "My grove" }).click();
  const tag = page.getByRole("button", { name: new RegExp(`${label}\\.com.*Open details`) });
  await expect(tag).toBeVisible({ timeout: 30_000 });
  await tag.click();
  const panel = page.getByRole("region", { name: `Details for ${label}.com` });
  await expect(panel.getByRole("heading", { name: `${label}.com` })).toBeVisible();
  return panel;
}
/** Approve the step-up shown inside a region with the virtual passkey. */
async function approve(page: Page, scope: import("@playwright/test").Locator, what: string) {
  const group = scope.getByRole("group", { name: "Confirm with your passkey" });
  await expect(group.getByRole("button", { name: "Approve with passkey" })).toBeVisible({ timeout: 20_000 });
  await clean(page, `step-up ${what}`);
  await group.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(group).toHaveCount(0, { timeout: 20_000 });
}
const quiet = (m: string) => /GPU stall|GL Driver|Download the React DevTools/.test(m);

test("ST-145 publish a card with a passkey, see it in the export, and take it down", async ({ page, request, baseURL }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !quiet(m.text())) errors.push(m.text()); });
  await virtualAuthenticator(page);
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  await signUp(page, request, `carder${Date.now()}@example.org`);
  const label = `free-card-${Date.now().toString(36)}`;
  await buy(page, request, baseURL!, label);
  await page.getByRole("button", { name: "Hatch another" }).click();
  await page.getByRole("region", { name: "Your order" }).getByRole("button", { name: "Close" }).click();
  const panel = await openDomain(page, label);
  const card = panel.getByRole("region", { name: "Public card" });
  await expect(card.getByRole("button", { name: "Publish card" })).toBeVisible({ timeout: 20_000 });
  await clean(page, "card section");
  await card.getByLabel("Let search engines list this card").check();
  await card.getByRole("button", { name: "Publish card" }).click();
  await expect(card.getByText(/Search engines may list it\./)).toBeVisible({ timeout: 20_000 });
  await approve(page, card, "card.publish");
  await expect(card.getByText(/Published at/)).toBeVisible({ timeout: 20_000 });
  const exported = await (await request.get("/api/v1/cards/public")).json();
  const mine = exported.cards.find((c: { slug: string }) => c.slug === `${label}.com`);
  expect(mine).toMatchObject({ indexable: true, image: { width: 256, height: 320 } });
  expect(Object.keys(mine).sort()).toEqual(["family", "hatched_on", "image", "indexable", "published_at", "rarity", "slug", "species", "traits"]);
  await card.getByRole("button", { name: "Take the card down" }).click();
  await expect(card.getByText("Your card is taken down.")).toBeVisible();
  const after = await (await request.get("/api/v1/cards/public")).json();
  expect(after.cards.some((c: { slug: string }) => c.slug === `${label}.com`)).toBe(false);
  expect(errors, errors.join("\n")).toEqual([]);
});
