import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { axe } from "./axe";

async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const add = () => cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const first = await add();
  return { replace: async () => { await cdp.send("WebAuthn.removeVirtualAuthenticator", first); await add(); } };
}
async function mailCode(request: APIRequestContext, email: string, kind: string) {
  let code = "";
  await expect.poll(async () => {
    const mail = await (await request.get(`/__dev/mail?to=${encodeURIComponent(email)}`)).json();
    const message = mail.findLast((item: { kind: string }) => item.kind === kind);
    code = /\b(\d{8})\b/.exec(message?.text ?? "")?.[1] ?? "";
    return !!code;
  }).toBe(true);
  return code;
}
async function signup(page: Page, request: APIRequestContext, email: string) {
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("New here? Your email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Eight-digit code", { exact: true }).fill(await mailCode(request, email, "signup.code"));
  await page.getByRole("button", { name: "Create my passkey" }).click();
  await expect(page.locator(".codes code")).toHaveCount(10);
  const codes = await page.locator(".codes code").allTextContents();
  await page.getByRole("button", { name: "I saved them" }).click();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  return codes;
}
const accessible = async (page: Page) => expect((await axe(page).analyze()).violations.map((violation) => violation.id)).toEqual([]);

test("ST-55 owner passkey setup cancels abandoned approvals and ignores repeated clicks", async ({ page, request }) => {
  const auth = await authenticator(page);
  await signup(page, request, `owner-passkey-${Date.now()}@example.test`);
  const panel = page.getByRole("region", { name: "Your account", exact: true });
  await expect(panel).toContainText("passwordless sign-in");
  await accessible(page);
  let commits = 0, creates = 0;
  let release!: () => void, received!: () => void, fulfilled!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const sent = new Promise<void>((resolve) => { received = resolve; });
  const delivered = new Promise<void>((resolve) => { fulfilled = resolve; });
  await page.route("**/api/v1/actions/*/commit", async (route) => {
    commits++;
    const response = await route.fetch(); received(); await held;
    await route.fulfill({ response }); fulfilled();
  });
  page.on("request", (req) => { if (req.method() === "POST" && req.url().endsWith("/api/v1/passkeys")) creates++; });
  await panel.getByRole("button", { name: "Add a passkey", exact: true }).click();
  await panel.getByLabel("Name for the new passkey").fill("Travel key");
  await panel.getByRole("button", { name: "Continue", exact: true }).click();
  const approve = panel.getByRole("button", { name: "Approve with passkey" });
  await expect(approve).toBeVisible();
  await approve.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await sent;
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  release();
  await delivered;
  await page.unroute("**/api/v1/actions/*/commit");
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Create the new passkey" })).toHaveCount(0);
  expect(commits).toBe(1); expect(creates).toBe(0);

  await panel.getByRole("button", { name: "Add a passkey", exact: true }).click();
  await panel.getByLabel("Name for the new passkey").fill("Travel key");
  await panel.getByRole("button", { name: "Continue", exact: true }).click();
  await panel.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(panel.getByRole("button", { name: "Create the new passkey" })).toBeVisible();
  await auth.replace();
  await panel.getByRole("button", { name: "Create the new passkey" }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(panel).toContainText("Passkey added.");
  expect(creates).toBe(1);
  await expect(panel.getByText("Travel key", { exact: true })).toBeVisible();
  await accessible(page);
});

test("ST-49 recovery spends codes once, retries a cancelled prompt and exposes the sensitive-action hold", async ({ page, request }) => {
  const auth = await authenticator(page);
  const email = `owner-recovery-${Date.now()}@example.test`;
  const codes = await signup(page, request, email);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await auth.replace();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Lost your passkey?" }).click();
  await page.getByLabel("Your account email").fill(email);
  await accessible(page);
  await page.getByRole("button", { name: "Start recovery" }).click();
  await page.getByLabel("Eight-digit code from the email").fill(await mailCode(request, email, "recovery.code"));
  await page.getByLabel("One saved recovery code").fill(codes[0]!);
  let redeems = 0;
  page.on("request", (req) => { if (req.url().endsWith("/auth/recovery/redeem")) redeems++; });
  await page.getByRole("button", { name: "Verify recovery codes" }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  const create = page.getByRole("button", { name: "Create replacement passkey" });
  await expect(create).toBeVisible();
  await page.evaluate(() => {
    const original = navigator.credentials.create.bind(navigator.credentials);
    let cancelled = false;
    navigator.credentials.create = (options) => {
      if (!cancelled) { cancelled = true; return Promise.reject(new DOMException("Cancelled by fixture", "NotAllowedError")); }
      return original(options);
    };
  });
  await create.click();
  await expect(page.getByRole("alert")).toContainText("closed or timed out");
  await create.click();
  await expect(page.getByRole("region", { name: "Your account", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your account was recovered" })).toBeVisible();
  expect(redeems).toBe(1);
  await accessible(page);
});

test("ST-55 replacing an in-flight approval cannot execute the old request or leave the new request disabled", async ({ page, request }) => {
  await authenticator(page);
  await signup(page, request, `owner-replacement-${Date.now()}@example.test`);
  await page.getByRole("button", { name: "Visitors", exact: true }).click();
  const panel = page.getByRole("region", { name: "Visitors", exact: true });
  await panel.getByLabel("Name", { exact: true }).fill("Old request");
  await panel.getByRole("button", { name: "Create with passkey" }).click();
  let release!: () => void, received!: () => void, fulfilled!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const sent = new Promise<void>((resolve) => { received = resolve; });
  const delivered = new Promise<void>((resolve) => { fulfilled = resolve; });
  await page.route("**/api/v1/actions/*/commit", async (route) => {
    const response = await route.fetch(); received(); await hold;
    await route.fulfill({ response }); fulfilled();
  });
  let created = 0;
  page.on("request", (req) => { if (req.method() === "POST" && req.url().endsWith("/api/v1/bindings")) created++; });
  await panel.getByRole("button", { name: "Approve with passkey" }).click();
  await sent;
  await panel.getByLabel("Name", { exact: true }).fill("Replacement request");
  await panel.getByRole("button", { name: "Create with passkey" }).click();
  const approve = panel.getByRole("button", { name: "Approve with passkey" });
  await expect(approve).toBeEnabled();
  await expect(panel.getByRole("group", { name: "Confirm with your passkey" })).toContainText("Replacement request");
  release(); await delivered;
  await page.unroute("**/api/v1/actions/*/commit");
  await expect(approve).toBeEnabled();
  expect(created).toBe(0);
  await approve.click();
  await expect(panel.locator("code.token-once")).toBeVisible();
  expect(created).toBe(1);
});
