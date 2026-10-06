import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { axe } from "./axe";

/**
 * Account recovery from the sign-in panel (D-016, PLAN 4.5): "Lost your passkey?", a saved recovery code plus an emailed code, a new
 * passkey on a fresh authenticator, and the 24-hour hold shown on the signed-in account. Runs in the "account" project: the real API
 * router on a local PostgreSQL with a recording mailbox (scripts/e2e-server.mjs). axe (WCAG 2.2 AA) runs on each new view.
 */
const quiet = (m: string) => /GPU stall|GL Driver|Download the React DevTools/.test(m);
const clean = async (page: Page, what: string) => { const v = (await axe(page).analyze()).violations; expect(v.map((x) => `${what}: ${x.id} ${x.nodes[0]?.html.slice(0, 80)}`)).toEqual([]); };
const mails = async (request: import("@playwright/test").APIRequestContext, to: string) => (await (await request.get(`/__dev/mail?to=${encodeURIComponent(to)}`)).json()) as { kind: string; text: string }[];

async function addAuthenticator(cdp: CDPSession): Promise<string> {
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return authenticatorId;
}

/** Sign up through the panel and return the ten recovery codes it shows once. */
async function signUp(page: Page, request: import("@playwright/test").APIRequestContext, email: string): Promise<string[]> {
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("New here? Your email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByLabel("Eight-digit code")).toBeVisible();
  const code = /\b(\d{8})\b/.exec((await mails(request, email)).find((m) => m.kind === "signup.code")!.text)![1]!;
  await page.getByLabel("Eight-digit code").fill(code);
  await page.getByRole("button", { name: "Create my passkey" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  const codes = (await page.locator(".codes code").allTextContents()).map((c) => c.trim());
  await page.getByRole("button", { name: "I saved them" }).click();
  await expect(page.getByRole("button", { name: "Account" })).toBeVisible();
  return codes;
}

async function boot(page: Page) {
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");                                   // ends the Arrival demo
}

/** Sign up, sign out, then lose the passkey: its authenticator is removed and a fresh one, holding no credential, takes its place. */
async function signUpThenLose(page: Page, request: import("@playwright/test").APIRequestContext, cdp: CDPSession, email: string) {
  const lost = await addAuthenticator(cdp);
  await boot(page);
  const saved = await signUp(page, request, email);
  expect(saved).toHaveLength(10);
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: lost });
  const fresh = await addAuthenticator(cdp);
  expect((await cdp.send("WebAuthn.getCredentials", { authenticatorId: fresh })).credentials).toHaveLength(0);
  return { saved, fresh };
}

test("lost passkey: recover with a recovery code and an emailed code on a fresh authenticator, land signed in with the hold shown", async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !quiet(m.text())) errors.push(m.text()); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const email = `mislaid${Date.now()}@example.org`;
  const { saved, fresh } = await signUpThenLose(page, request, cdp, email);

  // "Lost your passkey?" on the sign-in step: the email, and which path, each explained with its wait and hold.
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("region", { name: "Sign in or create an account" }).getByRole("button", { name: "Lost your passkey?" }).click();
  const panel = page.getByRole("region", { name: "Recover your account" });
  await expect(panel.getByRole("heading", { name: "Recover your account" })).toBeFocused();
  await expect(panel.getByRole("radio", { name: "With a recovery code" })).toBeChecked();
  await expect(panel.getByText(/on hold for 24 hours/)).toBeVisible();
  await expect(panel.getByText(/72-hour wait, then we email you a code/)).toBeVisible();
  await expect(panel.getByText(/second verified email address on a different mail domain/)).toBeVisible();
  await clean(page, "recover start");
  await panel.getByLabel("Your account email").fill(email);
  await panel.getByRole("button", { name: "Email me a code" }).click();

  // The emailed code and a saved recovery code, then the new passkey.
  await expect(panel.getByRole("heading", { name: "Check your email" })).toBeFocused();
  await clean(page, "recover code");
  const sent = await mails(request, email);
  expect(sent.some((m) => m.kind === "recovery.started")).toBe(true);
  const emailed = /\b(\d{8})\b/.exec(sent.filter((m) => m.kind === "recovery.code").at(-1)!.text)![1]!;
  await panel.getByLabel("Eight-digit code from the email").fill(emailed);
  await panel.getByLabel("One of your recovery codes").fill(saved[3]!);
  await panel.getByRole("button", { name: "Add a new passkey" }).click();

  // Signed in, on the new passkey, with the hold in the banner.
  const account = page.getByRole("region", { name: "Your account" });
  await expect(account.getByRole("heading", { name: "Your account", exact: true })).toBeFocused({ timeout: 20_000 });
  await expect(account).toContainText(`Signed in as ${email}.`);
  expect((await cdp.send("WebAuthn.getCredentials", { authenticatorId: fresh })).credentials).toHaveLength(1);
  const banner = account.getByRole("status").filter({ hasText: "Your account was recovered" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("A new passkey was added with a recovery code.");
  await expect(banner).toContainText("Your old passkeys are paused for 30 days.");
  await expect(account.getByText("1 passkey, and 1 paused by the recovery.", { exact: false })).toBeVisible();
  await clean(page, "recovered account");

  // The server agrees: the request is holding for about 24 hours, and the banner shows exactly when it ends.
  const me = await page.evaluate(async () => (await fetch("/api/v1/session")).json());
  expect(me.signedIn).toBe(true);
  expect(me.recovery).toMatchObject({ status: "holding", path: "codes_email" });
  expect(me.hold.active).toBe(true);
  const left = new Date(me.recovery.holdUntil).getTime() - Date.now();
  expect(left).toBeGreaterThan(23 * 3600_000);
  expect(left).toBeLessThanOrEqual(24 * 3600_000);
  const until = await page.evaluate((iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }), me.recovery.holdUntil);
  await expect(banner).toContainText(`on hold until ${until}.`);
  expect((await mails(request, email)).some((m) => m.kind === "recovery.completed")).toBe(true);

  // The banner is shown at every sign-in: signing in again with the new passkey keeps the panel open on it.
  await account.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(account.getByRole("status").filter({ hasText: "Your account was recovered" })).toContainText(`on hold until ${until}.`, { timeout: 20_000 });
  expect(errors, errors.join("\n")).toEqual([]);
});

test("an open recovery shows on the signed-in account, which can cancel it", async ({ page, request, baseURL }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !quiet(m.text())) errors.push(m.text()); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await addAuthenticator(cdp);
  await boot(page);
  const email = `watchful${Date.now()}@example.org`;
  await signUp(page, request, email);

  // Someone else starts a recovery (the request context has no session, like a stranger's browser).
  const st = await request.post("/api/v1/auth/recovery/start", { data: { email, path: "codes_email" }, headers: { Origin: baseURL!, "X-MH-Client": "web" } });
  expect(st.status(), await st.text()).toBe(202);

  // The signed-in session (still open in this tab) sees it at the next load, and cancels it.
  await boot(page);
  await page.getByRole("button", { name: "Account" }).click();
  const account = page.getByRole("region", { name: "Your account" });
  const banner = account.getByRole("alert").filter({ hasText: "Someone started a recovery of this account" });
  await expect(banner).toContainText("with a recovery code");
  await expect(banner).toContainText("If this was not you, cancel it.");
  await clean(page, "open recovery banner");
  await banner.getByRole("button", { name: "Cancel the recovery" }).click();
  await expect(account.getByText("The recovery is cancelled. Nothing about your passkeys changed.")).toBeVisible({ timeout: 20_000 });
  await expect(account.getByText("Someone started a recovery of this account")).toHaveCount(0);
  const me = await page.evaluate(async () => (await fetch("/api/v1/session")).json());
  expect(me.recovery).toBeNull();
  expect((await mails(request, email)).some((m) => m.kind === "recovery.cancelled")).toBe(true);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("a passkey prompt closed after the codes are accepted is tried again without new codes", async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !quiet(m.text())) errors.push(m.text()); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const email = `shaky${Date.now()}@example.org`;
  const { saved, fresh } = await signUpThenLose(page, request, cdp, email);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Lost your passkey?" }).click();
  const panel = page.getByRole("region", { name: "Recover your account" });
  await panel.getByLabel("Your account email").fill(email);
  await panel.getByRole("button", { name: "Email me a code" }).click();
  await expect(panel.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const emailed = /\b(\d{8})\b/.exec((await mails(request, email)).filter((m) => m.kind === "recovery.code").at(-1)!.text)![1]!;

  // A wrong recovery code is refused without saying which code was wrong.
  await panel.getByLabel("Eight-digit code from the email").fill(emailed);
  await panel.getByLabel("One of your recovery codes").fill("A".repeat(26));
  await panel.getByRole("button", { name: "Add a new passkey" }).click();
  await expect(panel.getByRole("alert")).toHaveText("That did not work. Check the code from the email and the recovery code. Each recovery code works once.");

  // The codes are accepted but the passkey prompt fails (no user verification): the codes are spent, so only the passkey is asked again.
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId: fresh, isUserVerified: false });
  await panel.getByLabel("One of your recovery codes").fill(saved[0]!);
  await panel.getByRole("button", { name: "Add a new passkey" }).click();
  await expect(panel.getByRole("alert")).toContainText("Your codes are already accepted", { timeout: 20_000 });
  await expect(panel.getByRole("heading", { name: "Add your new passkey" })).toBeVisible();
  await expect(panel.getByLabel("One of your recovery codes")).toHaveCount(0);
  await clean(page, "retry passkey");
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId: fresh, isUserVerified: true });
  await panel.getByRole("button", { name: "Try the passkey again" }).click();
  const account = page.getByRole("region", { name: "Your account" });
  await expect(account.getByRole("status").filter({ hasText: "Your account was recovered" })).toContainText("on hold until", { timeout: 20_000 });
  expect((await cdp.send("WebAuthn.getCredentials", { authenticatorId: fresh })).credentials).toHaveLength(1);
  // A wrong code and a failed prompt are expected 401 and NotAllowedError answers, not page errors.
  expect(errors.filter((e) => !/401 \(Unauthorized\)/.test(e)), errors.join("\n")).toEqual([]);
});
