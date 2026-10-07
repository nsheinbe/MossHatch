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
async function buy(page: Page, request: import("@playwright/test").APIRequestContext, baseURL: string, label: string, o: { autoRenew?: boolean } = {}): Promise<string> {
  await page.fill("#name-input", label);
  const chip = page.locator("button.chip", { hasText: ".com" });
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await chip.click();
  for (const [l, value] of [["Full name", "Ada Moss"], ["Phone, like +1.5555550100", "+1.5555550100"], ["Street address", "1 Fern Lane"], ["City", "Portland"], ["State or region", "OR"], ["Postal code", "97201"]] as const) await page.getByLabel(l).fill(value);
  await page.getByRole("button", { name: "Save contact" }).click();
  const pay = page.getByRole("button", { name: /Buy domain & hatch/ });
  const shown = (await pay.textContent())!.match(/\$([\d.]+)/)![1]!;
  // C-31: the auto-renew box is unticked by default and separate from the terms box.
  // The auto-renew choice is visible beside the price with its full terms (docs/AUDIT-2026-10-07.md P5), not folded away.
  const save = page.getByLabel("Save my card for auto-renew (optional)", { exact: true });
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
  const shown = await buy(page, request, baseURL!, label, { autoRenew: true });
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
  await expect(page.getByRole("button", { name: /Buy domain & hatch/ })).toBeDisabled();       // no contact yet
  for (const [label, value] of [["Full name", "Ada Moss"], ["Phone, like +1.5555550100", "+1.5555550100"], ["Street address", "1 Fern Lane"], ["City", "Portland"], ["State or region", "OR"], ["Postal code", "97201"]] as const) await page.getByLabel(label).fill(value);
  await page.getByRole("button", { name: "Save contact" }).click();
  const pay = page.getByRole("button", { name: /Buy domain & hatch/ });
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

test("domain management: transfer code shown once, Stop a hostile transfer, DNSSEC, nameservers, contact change, registrant verification, Renew now on Checkout", async ({ page, request, baseURL }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !quiet(m.text())) errors.push(m.text()); });
  await virtualAuthenticator(page);
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  const email = `manager${Date.now()}@example.org`;
  await signUp(page, request, email);
  const label = "free-mgmt-fern";
  const fqdn = `${label}.com`;
  await buy(page, request, baseURL!, label);
  await page.getByRole("button", { name: "Hatch another" }).click();
  await page.getByRole("region", { name: "Your order" }).getByRole("button", { name: "Close" }).click();
  let panel = await openDomain(page, label);

  // ---- A transfer nobody asked for (before any code was issued, so nothing explains it): needs attention, Stop re-locks and replaces the code (ST-125) ------------------------------------
  const sim = await request.get(`/__dev/transfer-away?fqdn=${encodeURIComponent(fqdn)}`);
  expect((await sim.json()).unrequested).toBe(1);
  await panel.getByRole("button", { name: "Close" }).click();
  panel = await openDomain(page, label);
  const banner = panel.getByRole("alert").filter({ hasText: "Needs you" });
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await clean(page, "hostile transfer banner");
  await banner.getByRole("button", { name: "Stop this transfer" }).click();
  await expect(panel.getByText("Stopped. The name is locked again and its code was replaced.", { exact: false })).toBeVisible({ timeout: 20_000 });
  await clean(page, "after stop");
  await expect(panel.getByText("Transfer lock", { exact: true }).locator("xpath=following-sibling::dd")).toHaveText("On", { timeout: 20_000 });

  // ---- Unlock with the passkey, get the code once, re-hide it, lock again (ST-120, ST-122) ------------------------------------------
  const xfer = panel.getByRole("group", { name: "Transfer to another registrar" });
  await xfer.getByRole("button", { name: "Unlock for transfer" }).click();
  await approve(page, xfer, "unlock");
  await expect(xfer.getByText("Unlocked. The name can now be transferred.")).toBeVisible({ timeout: 20_000 });
  await xfer.getByRole("button", { name: "Get a transfer code" }).click();
  await approve(page, xfer, "code");
  const box = xfer.getByRole("group", { name: "Transfer code" });
  await expect(box).toBeVisible({ timeout: 20_000 });
  const code = (await box.locator("code.xfer-code").textContent())!.trim();
  expect(code.length).toBeGreaterThanOrEqual(8);
  await expect(box.locator("code.xfer-code")).toBeFocused();
  expect((await axe(page).include(".code-box").analyze()).violations.map((v) => `code box: ${v.id}`)).toEqual([]);
  // The code lives only in the component: not in storage, not in the URL.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
  expect(stored).not.toContain(code);
  await box.getByRole("button", { name: "Hide it now" }).click();
  await expect(box).toHaveCount(0);
  await expect(xfer.getByText("The code is hidden. We cannot show it again.", { exact: false })).toBeVisible();
  expect(await page.getByText(code).count()).toBe(0);
  await xfer.getByRole("button", { name: "Lock it again" }).click();
  await expect(xfer.getByText("Locked again.", { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText("Transfer lock", { exact: true }).locator("xpath=following-sibling::dd")).toHaveText("On");

  // ---- DNS tab: DNSSEC first, then a nameserver change that keeps DNSSEC working (C-20, ST-122) -----------------------------------------
  await panel.getByRole("tab", { name: "DNS" }).click();
  const dnssec = panel.getByRole("group", { name: "DNSSEC" });
  await expect(dnssec.getByText("No DNSSEC records are set.")).toBeVisible({ timeout: 20_000 });
  await dnssec.getByLabel("Key tag").fill("12345");
  await dnssec.getByLabel("Digest, in hex").fill("a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90");
  await dnssec.getByRole("button", { name: "Add DNSSEC record" }).click();
  await approve(page, dnssec, "ds add");
  await expect(panel.getByText("DNSSEC record added.")).toBeVisible({ timeout: 20_000 });
  await expect(dnssec.getByText("Key tag 12345", { exact: false })).toBeVisible({ timeout: 20_000 });
  await clean(page, "dnssec");

  const ns = panel.getByRole("group", { name: "Nameservers" });
  await ns.getByLabel("Nameservers, one per line").fill("ns1.example-dns.net\nns2.example-dns.net");
  await ns.getByLabel("These nameservers serve a DNSSEC-signed zone").check();
  await ns.getByRole("button", { name: "Change nameservers" }).click();
  await approve(page, ns, "nameservers");
  await expect(panel.getByText("Nameservers changed. We emailed you.")).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText("hosted elsewhere", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  const nsMail = await (await request.get(`/__dev/mail?to=${encodeURIComponent(email)}`)).json();
  expect(nsMail.some((m: { kind: string }) => /nameserver/i.test(m.kind))).toBe(true);
  await clean(page, "nameservers");

  // ---- Registrant verification (C-16): the code goes to the registrant address -----------------------------------------------------------
  const contact = panel.getByRole("group", { name: "Contact and registrant" });
  await expect(contact.getByText("Verify the registrant email within", { exact: false })).toBeVisible({ timeout: 20_000 });
  await clean(page, "verification banner");
  await contact.getByRole("button", { name: "Email me a code" }).click();
  await expect(contact.getByText("If the address can be reached, a code is on its way.")).toBeVisible({ timeout: 20_000 });
  const vm = await (await request.get(`/__dev/mail?to=${encodeURIComponent(email)}`)).json();
  const vcode = /\b(\d{8})\b/.exec(vm.filter((m: { kind: string }) => m.kind === "domain.registrant_verify").at(-1).text)![1]!;
  await contact.getByLabel("Eight-digit code").fill(vcode);
  await contact.getByRole("button", { name: "Verify" }).click();
  await expect(contact.getByText("The registrant email is verified.")).toBeVisible({ timeout: 20_000 });
  await expect(contact.getByText("Verify the registrant email within", { exact: false })).toHaveCount(0);

  // ---- Contact change with the passkey (ST-121, ST-123) --------------------------------------------------------------------------------
  await contact.getByRole("button", { name: "Change contact details" }).click();
  const form = contact.getByRole("form", { name: "New contact details" });
  await expect(form.getByLabel("Full name")).toHaveValue("Ada Moss", { timeout: 20_000 });
  for (const [l, v] of [["Phone, like +1.5555550100", "+1.5555550199"], ["Street address", "2 Moss Road"], ["City", "Salem"], ["State or region", "OR"], ["Postal code", "97301"]] as const) await form.getByLabel(l).fill(v);
  await clean(page, "contact form");
  await form.getByRole("button", { name: "Review the change" }).click();
  await approve(page, contact, "contact");
  await expect(contact.getByText(/Contact details updated\.|Sent\. Both the current and the new registrant must approve it by email\./)).toBeVisible({ timeout: 20_000 });

  // ---- Renew now with no saved card: Stripe Checkout, then the registry, then the ledger ---------------------------------------------------
  await panel.getByRole("tab", { name: "Overview" }).click();
  let resolveRenew!: (id: string) => void;
  const renewOrder = new Promise<string>((r) => { resolveRenew = r; });
  await page.route("**/api/v1/domains/*/renew", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (body.order_id) resolveRenew(body.order_id);
    expect(body.status).toBe("checkout");
    await route.fulfill({ response: res, json: body });
  });
  await page.route("https://checkout.stripe.test/**", async (route) => {
    await route.fulfill({ status: 302, headers: { location: `${baseURL}/__dev/pay?order=${await renewOrder}` } });
  });
  await panel.getByRole("button", { name: "Renew now" }).click();
  const back = page.getByRole("region", { name: "Your order" });
  await expect(back).toBeVisible({ timeout: 60_000 });
  await expect(back).toContainText("Renewed. The payment is complete.", { timeout: 60_000 });
  await clean(page, "renewal return");
  await back.getByRole("button", { name: "Close" }).click();
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Ledger" }).click();
  const renewalRow = page.getByRole("row", { name: new RegExp(`Renewal.*${fqdn.replace(".", "\\.")}`) });
  await expect(renewalRow).toBeVisible({ timeout: 20_000 });
  await expect(renewalRow).toContainText("Paid");
  await clean(page, "ledger after renewal");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("refund inside the window: confirm, the name is deleted and the ledger shows the refund", async ({ page, request, baseURL }) => {
  test.setTimeout(480_000);
  const errors: string[] = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !quiet(m.text())) errors.push(m.text()); });
  await virtualAuthenticator(page);
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  await signUp(page, request, `refunder${Date.now()}@example.org`);
  const label = "refund-brook";
  await buy(page, request, baseURL!, label);
  await page.getByRole("button", { name: "Hatch another" }).click();
  await page.getByRole("region", { name: "Your order" }).getByRole("button", { name: "Close" }).click();
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Ledger" }).click();
  const row = page.getByRole("row", { name: new RegExp(`${label}\\.com`) });
  await expect(row).toContainText("Paid", { timeout: 20_000 });
  await row.getByRole("button", { name: `Ask for a refund of ${label}.com` }).click();
  const confirm = row.getByRole("group", { name: `Confirm the refund of ${label}.com` });
  await expect(confirm).toContainText("A refund can delete the name.");
  await clean(page, "refund confirm");
  await confirm.getByRole("button", { name: "Refund and delete" }).click();
  await expect(page.getByText("Refund started.", { exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("Refunded in full", { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Refunds" })).toBeVisible();
  await clean(page, "ledger after refund");
  expect(errors, errors.join("\n")).toEqual([]);
});
