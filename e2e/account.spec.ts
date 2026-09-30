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
async function buy(page: Page, request: import("@playwright/test").APIRequestContext, baseURL: string, label: string): Promise<string> {
  await page.fill("#name-input", label);
  const chip = page.locator("button.chip", { hasText: ".com" });
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await chip.click();
  for (const [l, value] of [["Full name", "Ada Moss"], ["Phone, like +1.5555550100", "+1.5555550100"], ["Street address", "1 Fern Lane"], ["City", "Portland"], ["State or region", "OR"], ["Postal code", "97201"]] as const) await page.getByLabel(l).fill(value);
  await page.getByRole("button", { name: "Save contact" }).click();
  const pay = page.getByRole("button", { name: /Pay .* and hatch/ });
  const shown = (await pay.textContent())!.match(/\$([\d.]+)/)![1]!;
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

test("my domains: grove, overview, auto-renew on and off, DNS add and roll back, ledger", async ({ page, request, baseURL }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/GPU stall|GL Driver|Download the React DevTools/.test(m.text())) errors.push(m.text()); });
  await virtualAuthenticator(page);
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  await signUp(page, request, `keeper${Date.now()}@example.org`);
  const label = "free-brook";
  const shown = await buy(page, request, baseURL!, label);
  const fqdn = `${label}.com`;

  // Grove: a creature for the real domain, and its tag opens the domain panel.
  await page.getByRole("button", { name: "Hatch another" }).click();
  await page.getByRole("region", { name: "Your order" }).getByRole("button", { name: "Close" }).click();
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "My grove" }).click();
  const tag = page.getByRole("button", { name: new RegExp(`${label}\\.com.*Open details`) });
  await expect(tag).toBeVisible({ timeout: 30_000 });
  expect(await page.getByText("Sample grove.").count()).toBe(0);
  await clean(page, "grove");
  await tag.click();

  // Overview.
  const panel = page.getByRole("region", { name: `Details for ${fqdn}` });
  await expect(panel.getByRole("heading", { name: fqdn })).toBeVisible();
  await expect(panel.getByText("Auto-renew is off")).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText("Renewal price", { exact: true })).toBeVisible();
  await expect(panel.getByText("Transfer lock", { exact: true })).toBeVisible();
  const turnOn = panel.getByRole("button", { name: "Turn on auto-renew" });
  await expect(turnOn).toBeDisabled();                                                            // consent is never pre-ticked
  await clean(page, "overview");
  await panel.getByLabel(/I agree to this authorisation/).check();
  await turnOn.click();
  await expect(panel.getByRole("group", { name: "Confirm with your passkey" })).toContainText("Turn on auto-renew");
  await clean(page, "step-up");
  await panel.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(panel.getByText("Auto-renew is on.", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  const off = panel.getByRole("button", { name: "Turn off auto-renew" });
  await off.click();                                                                              // one click, no passkey
  await expect(panel.getByText("Auto-renew is off.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("group", { name: "Confirm with your passkey" })).toHaveCount(0);

  // DNS: keyboard to the tab, add a record, see it, roll back, see it gone.
  await panel.getByRole("tab", { name: "Overview" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(panel.getByRole("tab", { name: "DNS", selected: true })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Records", exact: true })).toBeVisible();
  await panel.getByLabel("Name, or @ for the domain itself").fill("blog");
  await panel.getByLabel("Value", { exact: true }).fill("192.0.2.10");
  await panel.getByRole("button", { name: "Add record" }).click();
  await expect(panel.getByRole("cell", { name: "192.0.2.10" })).toBeVisible({ timeout: 20_000 });
  await clean(page, "dns");
  await panel.getByRole("button", { name: /^Roll back to before the change/ }).first().click();
  await expect(panel.getByRole("cell", { name: "192.0.2.10" })).toHaveCount(0, { timeout: 20_000 });
  await expect(panel.getByRole("heading", { name: "DNSSEC", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Close" }).click();

  // Ledger: the price charged is the price shown at checkout.
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Ledger" }).click();
  const row = page.getByRole("row", { name: new RegExp(fqdn) });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText("Registration");
  await expect(row).toContainText("Paid");
  await expect(row).toContainText(`$${shown}`);
  await clean(page, "ledger");
  expect(errors, errors.join("\n")).toEqual([]);
});

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
