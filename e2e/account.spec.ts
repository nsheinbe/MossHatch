import { test, expect, type Page } from "@playwright/test";
import { axe } from "./axe";

/**
 * Sign up with a passkey, fill the registrant contact, accept the terms, pay on (fake) Checkout, and watch the name hatch.
 * Runs against the real API router on a local PostgreSQL with FakeStripe and a recording mailbox (see scripts/e2e-server.mjs).
 */
async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}

test("sign up, contact, accept, pay, hatch, and sign out", async ({ page, request, baseURL }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/GPU stall|GL Driver|Download the React DevTools/.test(m.text())) errors.push(m.text()); });
  await virtualAuthenticator(page);
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");                                   // ends the Arrival demo

  const email = `walker${Date.now()}@example.org`;
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("New here? Your email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByLabel("Eight-digit code")).toBeVisible();
  const mail = await (await request.get(`/__dev/mail?to=${encodeURIComponent(email)}`)).json();
  const code = /\b(\d{8})\b/.exec(mail.find((m: { kind: string }) => m.kind === "signup.code").text)![1]!;
  await page.getByLabel("Eight-digit code").fill(code);
  await page.getByRole("button", { name: "Create my passkey" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  expect(await page.locator(".codes code").count()).toBe(10);
  expect((await axe(page).analyze()).violations.map((v) => v.id)).toEqual([]);
  await page.getByRole("button", { name: "I saved them" }).click();
  await expect(page.getByRole("button", { name: "Account" })).toBeVisible();

  // Search, pick, fill the contact, accept, pay.
  await page.fill("#name-input", "moonfern");
  const chip = page.locator("button.chip", { hasText: ".com" });
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await chip.click();
  await expect(page.getByRole("button", { name: /Pay .* and hatch/ })).toHaveCount(0);       // no contact yet
  for (const [label, value] of [["Full name", "Ada Moss"], ["Phone, like +1.5555550100", "+1.5555550100"], ["Street address", "1 Fern Lane"], ["City", "Portland"], ["State or region", "OR"], ["Postal code", "97201"]] as const) await page.getByLabel(label).fill(value);
  await page.getByRole("button", { name: "Save contact" }).click();
  const pay = page.getByRole("button", { name: /Pay .* and hatch/ });
  await expect(pay).toBeDisabled();                                                               // acceptance is not pre-checked
  expect((await axe(page).analyze()).violations.map((v) => v.id)).toEqual([]);
  const shown = (await pay.textContent())!.match(/\$([\d.]+)/)![1]!;
  await page.getByLabel(/I accept the/).check();
  await expect(pay).toBeEnabled();

  // Checkout is Stripe's page; the fake one is handed back to the dev server's /__dev/pay.
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
  await expect(page.getByRole("region", { name: "Your order" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("region", { name: /has hatched$/ })).toBeVisible({ timeout: 300_000 });
  expect(await page.locator("img.card-img").getAttribute("src")).toMatch(/^data:image\/png/);

  // The price on the button is the subtotal; the order panel reports what was charged (tax included, zero in the fake).
  await expect(page.getByRole("region", { name: "Your order" })).toContainText(`Charged ${shown} USD`);   // the amount charged equals the amount shown
  const rows = await (await request.get(`/__dev/mail?to=${encodeURIComponent(email)}`)).json();
  expect(rows.some((m: { kind: string }) => /receipt/.test(m.kind))).toBe(true);

  await page.getByRole("button", { name: "Hatch another" }).click();
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});
