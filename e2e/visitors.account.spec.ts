import crypto from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { axe } from "./axe";

/**
 * Phase 5 visitor experience in the browser (runs in the "account" project: the real API router on a local PostgreSQL with Fake
 * Stripe). Create a token with a passkey, let a scripted agent propose a registration over REST, review the approval card and
 * approve it with the passkey (the browser goes to Stripe Checkout), connect an OAuth app through the consent screen, and send
 * every visitor home. axe (WCAG 2.2 AA) runs on each new view.
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
const clean = async (page: Page, what: string) => { const v = (await axe(page).analyze()).violations; expect(v.map((x) => `${what}: ${x.id} ${x.nodes[0]?.html.slice(0, 80)}`)).toEqual([]); };
const openVisitors = async (page: Page) => {
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("button", { name: "Visitors" }).click();
  await expect(page.getByRole("region", { name: "Visitors", exact: true })).toBeVisible();
};

test("visitors: token with passkey, agent proposal, approval card, OAuth consent, send everyone home", async ({ page, request, baseURL }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/GPU stall|GL Driver|Download the React DevTools|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await virtualAuthenticator(page);
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  const email = `visitor${Date.now()}@example.org`;
  await signUp(page, request, email);

  // The registrant contact a registration needs (the Hatch sheet saves it the same way).
  const contact = await page.request.post("/api/v1/contact", { headers: { "x-mh-client": "web", origin: baseURL!, "sec-fetch-site": "same-origin" }, data: { name: "Ada Moss", email, phone: "+1.5555550100", street: "1 Fern Lane", city: "Portland", region: "OR", postalCode: "97201", country: "US" } });
  expect(contact.status(), await contact.text()).toBeLessThan(300);

  // The Visitors view, and a token created with the passkey (shown once).
  await openVisitors(page);
  await clean(page, "visitors");
  await page.getByLabel("Name", { exact: true }).fill("Build bot");
  await page.getByRole("checkbox", { name: /Suggest names to buy/ }).check();
  await page.getByLabel("Most it can ask you to spend, in dollars").fill("100");
  await page.getByRole("button", { name: "Create with passkey" }).click();
  await expect(page.getByRole("heading", { name: "Confirm with your passkey" })).toBeVisible();
  await expect(page.getByText(/Create a token named "Build bot"/)).toBeVisible();
  await page.getByRole("button", { name: "Approve with passkey" }).click();
  const token = (await page.locator("code.token-once").textContent())!.trim();
  expect(token).toMatch(/^mh_live_/);
  await page.getByRole("button", { name: "I stored it" }).click();

  // A scripted agent proposes a registration with that token (REST equivalent of the MCP tool).
  const name = `free-visit${Date.now().toString(36)}.com`;
  const prop = await request.post("/api/v1/agent/proposals", { headers: { authorization: `Bearer ${token}` }, data: { kind: "register", domain: name } });
  expect(prop.status()).toBe(202);
  const approvalId = (await prop.json()).approval_id as string;
  const state = async () => (await (await request.get(`/api/v1/approvals/${approvalId}`, { headers: { authorization: `Bearer ${token}` } })).json()).status as string;
  expect(await state()).toBe("pending_human_approval");

  // The owner reviews the card and approves with the passkey; the browser goes to Stripe, and nothing is charged before that.
  await page.getByRole("button", { name: "Close" }).last().click();
  await openVisitors(page);
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("heading", { name: "Register a name" })).toBeVisible();
  await expect(page.getByText("You pay on Stripe next. Nothing is charged until you do.")).toBeVisible();
  await clean(page, "approval card");
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeDisabled();
  await page.getByLabel("Type the name to approve it").fill(name);
  let stripe = "";
  await page.route("https://checkout.stripe.test/**", async (route) => { stripe = route.request().url(); await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Checkout</title><h1>Checkout</h1>" }); });
  await approve.click();
  await expect(page.getByRole("heading", { name: "Confirm with your passkey" })).toBeVisible();
  await page.getByRole("button", { name: "Approve with passkey" }).click();
  await page.waitForURL(/checkout\.stripe\.test/);
  expect(stripe).toMatch(/^https:\/\/checkout\.stripe\.test\//);
  expect(await state()).toBe("approved_awaiting_payment");

  // An MCP connector asks through OAuth: consent screen, passkey, back to the app's registered address with a code.
  const reg = await request.post("/api/v1/oauth/register", { data: { redirect_uris: ["https://client.example/cb"], client_name: "E2E client" } });
  expect(reg.status()).toBe(201);
  const clientId = (await reg.json()).client_id as string;
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  let back = "";
  await page.route("https://client.example/**", async (route) => { back = route.request().url(); await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Client</title><h1>Connected</h1>" }); });
  await page.goto(`${baseURL}/api/v1/oauth/authorize?` + new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://client.example/cb", code_challenge: challenge, code_challenge_method: "S256", state: "e2e-state" }));
  await expect(page.getByRole("region", { name: "Connect an app to your account" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("client.example")).toBeVisible();
  await expect(page.getByText("E2E client")).toBeVisible();
  await clean(page, "oauth consent");
  await page.getByRole("button", { name: "Allow with passkey" }).click();
  await page.getByRole("button", { name: "Approve with passkey" }).click();
  await page.waitForURL(/client\.example/);
  const u = new URL(back);
  expect(u.searchParams.get("code")).toBeTruthy();
  expect(u.searchParams.get("state")).toBe("e2e-state");
  const tok = await request.post("/api/v1/oauth/mcp/token", { form: { grant_type: "authorization_code", code: u.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: "https://client.example/cb" } });
  expect(tok.status()).toBe(200);

  // Send every visitor home: the token and the connected app stop working at once.
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  await openVisitors(page);
  await expect(page.getByText("Connected app").first()).toBeVisible();
  await page.getByRole("button", { name: "Send all visitors home" }).click();
  await page.getByRole("button", { name: "Yes, send them all home" }).click();
  await expect(page.getByText(/Every visitor was sent home/)).toBeVisible();
  await clean(page, "visitors after send-home");
  expect((await request.get("/api/v1/whoami", { headers: { authorization: `Bearer ${token}` } })).status()).toBe(401);
  expect(errors).toEqual([]);
});
