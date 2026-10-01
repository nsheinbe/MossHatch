import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { axe } from "./axe";

/**
 * Download my data, Close my account, and the .dev HTTPS notice (closure module; design docs/design/account-closure-export-erasure.md,
 * C-28, C-48, C-58). Runs in the "account" project: the real API router on a local PostgreSQL with a recording mailbox. The export job
 * runs through the real cron tick. axe (WCAG 2.2 AA) runs on each new view.
 */
const CRON = "Bearer e2e-cron-secret-0123456789abcdef0123456789";

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
const mails = async (request: import("@playwright/test").APIRequestContext, to: string) => (await (await request.get(`/__dev/mail?to=${encodeURIComponent(to)}`)).json()) as { kind: string; text: string }[];

test("account data: download my data with a passkey, close my account, sign in to cancel; the .dev HTTPS notice at checkout", async ({ page, request }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/GPU stall|GL Driver|Download the React DevTools|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await virtualAuthenticator(page);
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  const email = `leaver${Date.now()}@example.org`;
  await signUp(page, request, email);

  // C-58: the checkout sheet for a .dev name says it works over HTTPS only.
  await page.fill("#name-input", `free-quiet-fern${Date.now().toString(36)}`);   // "free-" labels are always available in the mock, so the .dev chip is always offered
  const chip = page.locator("button.chip", { hasText: ".dev" });
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await chip.click();
  await expect(page.getByText(/\.dev names work only over HTTPS/)).toBeVisible();
  await page.getByRole("button", { name: "Not yet" }).click();

  // Download my data: ask with the passkey, the job runs, the copy downloads as a ZIP.
  const panel = page.getByRole("region", { name: "Your account" });
  await page.getByRole("button", { name: "Account" }).click();
  await panel.getByRole("button", { name: "Download my data" }).click();
  await expect(panel.getByRole("heading", { name: "Download my data" })).toBeVisible();
  await clean(page, "download my data");
  await panel.getByRole("button", { name: "Make a new copy" }).click();
  await expect(panel.getByRole("heading", { name: "Confirm with your passkey" })).toBeVisible();
  await expect(panel.getByText(/Make a copy of your account data/)).toBeVisible();
  await clean(page, "export step-up");
  await panel.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(panel.getByText(/We are making your copy/).first()).toBeVisible();
  const tick = await request.get("/api/cron/tick", { headers: { authorization: CRON } });
  expect(tick.status(), await tick.text()).toBeLessThan(300);
  await expect.poll(async () => (await mails(request, email)).some((m) => m.kind === "account_export_ready"), { timeout: 60_000 }).toBe(true);
  await panel.getByRole("button", { name: "Back" }).click();
  await panel.getByRole("button", { name: "Download my data" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), panel.getByRole("button", { name: "Download", exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/^mosshatch-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const file = fs.readFileSync((await download.path())!);
  expect(file.subarray(0, 4).toString("hex")).toBe("504b0304");                 // a ZIP
  expect(file.includes(Buffer.from("export.json"))).toBe(true);
  await expect(panel.getByText("Your copy is downloading.")).toBeVisible();
  await clean(page, "export ready");
  await panel.getByRole("button", { name: "Back" }).click();

  // Close my account: what it does, the passkey, then signed out with the way back.
  await panel.getByRole("button", { name: "Close my account" }).click();
  await expect(panel.getByRole("heading", { name: "Close my account" })).toBeVisible();
  await expect(panel.getByText(/signing in with your passkey cancels it/)).toBeVisible();
  await clean(page, "close my account");
  await panel.getByRole("button", { name: "Close with my passkey" }).click();
  await expect(panel.getByText(/Close your account\. We sign out every session/)).toBeVisible();
  await clean(page, "close step-up");
  await panel.getByRole("button", { name: "Approve with passkey" }).click();
  const out = page.getByRole("region", { name: "Sign in or create an account" });
  await expect(out.getByText(/Your account is closing\. To keep it, sign in with your passkey before/)).toBeVisible();
  await clean(page, "closing");
  expect((await mails(request, email)).some((m) => m.kind === "account_closing")).toBe(true);
  expect((await page.request.get("/api/v1/session")).ok()).toBe(true);
  expect((await (await page.request.get("/api/v1/session")).json()).signedIn).toBe(false);

  // Signing in with the passkey inside the cooling-off keeps the account.
  await out.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("button", { name: "Account" })).toBeVisible();
  expect((await mails(request, email)).some((m) => m.kind === "account_closure_cancelled")).toBe(true);
  expect(errors).toEqual([]);
});
