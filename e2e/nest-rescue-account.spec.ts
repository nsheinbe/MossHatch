import { test, expect, type Page, type APIRequestContext, type Locator } from "@playwright/test";
import { axe } from "./axe";

/**
 * Rescue (transfer in) through completion with the mock registrar's lifecycle, the Gate on the name that arrived, and the Nest:
 * add a secret, reveal it with the passkey, watch it hide again. Runs in the "account" project against the real API router on a
 * local PostgreSQL (scripts/e2e-server.mjs): FakeStripe, a recording mailbox, the mock registrar and the local vault KMS. No real
 * OpenSRS, Stripe, KMS or Resend call is made.
 */
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
const clean = async (page: Page, what: string, scope?: string) => {
  const b = axe(page);
  const v = (await (scope ? b.include(scope) : b).analyze()).violations;
  expect(v.map((x) => `${what}: ${x.id} ${x.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};
async function approve(page: Page, scope: Locator, what: string) {
  const group = scope.getByRole("group", { name: "Confirm with your passkey" });
  await expect(group.getByRole("button", { name: "Approve with passkey" })).toBeVisible({ timeout: 20_000 });
  await clean(page, `step-up ${what}`);
  await group.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(group).toHaveCount(0, { timeout: 20_000 });
}
const quiet = (m: string) => /GPU stall|GL Driver|Download the React DevTools/.test(m);
const collect = (page: Page) => { const all: string[] = [], errors: string[] = []; page.on("console", (m) => { all.push(m.text()); if (["error", "warning"].includes(m.type()) && !quiet(m.text())) errors.push(m.text()); }); return { all, errors }; };
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);

/** Does any string in the page's JavaScript heap contain `needle`? A full snapshot runs a GC first. */
async function heapHas(page: Page, needle: string): Promise<boolean> {
  const cdp = await page.context().newCDPSession(page);
  const chunks: string[] = [];
  cdp.on("HeapProfiler.addHeapSnapshotChunk", (e) => { chunks.push(e.chunk); });
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  await cdp.detach();
  return chunks.join("").includes(needle);
}

/**
 * Rescue in the UI: seed a name at "another registrar", search it, start the transfer with its code, confirm with the emailed code,
 * pay on the fake Checkout, see Traveling, let the mock lifecycle finish, and see Moved only after the server says so.
 */
async function rescue(page: Page, request: APIRequestContext, baseURL: string, email: string, label: string, check = true) {
  const fqdn = `${label}.com`;
  const AUTH = `Rz7Kq-${label.slice(-6)}-Auth9`;
  expect(await (await request.get(`/__dev/transfer-in?fqdn=${fqdn}&do=seed&code=${encodeURIComponent(AUTH)}`)).json()).toEqual({ state: null });

  await page.fill("#name-input", fqdn);
  const offer = page.getByRole("group", { name: "Bring a name you own" });
  await expect(offer.getByRole("button", { name: `Transfer ${fqdn} here` })).toBeVisible({ timeout: 20_000 });
  if (check) await clean(page, "rescue offer");
  await offer.getByRole("button", { name: `Transfer ${fqdn} here` }).click();
  const panel = page.getByRole("region", { name: `Transfer ${fqdn} here` });
  await expect(panel.getByRole("heading", { name: `Bring ${fqdn} here` })).toBeFocused();
  for (const [l, value] of [["Full name", "Ada Moss"], ["Phone", "+1.5555550100"], ["Street address", "1 Fern Lane"], ["City", "Portland"], ["State or region", "OR"], ["Postal code", "97201"]] as const) await panel.getByLabel(l).fill(value);
  await panel.getByRole("button", { name: "Save contact" }).click();

  const code = panel.getByLabel("Transfer code from your current registrar");
  await expect(code).toBeVisible({ timeout: 20_000 });
  await expect(code).toHaveAttribute("type", "password");
  await expect(code).toHaveAttribute("autocomplete", "off");
  const start = panel.getByRole("button", { name: "Check and start the transfer" });
  await expect(start).toBeDisabled();                                                            // the terms are never pre-ticked
  if (check) await clean(page, "rescue start");

  // A name that cannot move is refused with a plain reason, and the code field is cleared anyway.
  if (check) {
    await panel.getByLabel(/I accept the/).check();
    await code.fill("short");
    await start.click();
    await expect(panel.getByRole("alert")).toHaveText("Enter the transfer code exactly as your current registrar gave it. It is 6 to 64 characters with no spaces.", { timeout: 20_000 });
    await expect(code).toHaveValue("");
    await clean(page, "rescue refused");
  } else await panel.getByLabel(/I accept the/).check();

  let resolveOrder!: (id: string) => void;
  const orderId = new Promise<string>((r) => { resolveOrder = r; });
  await page.route("**/api/v1/transfers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    if (body.order_id) resolveOrder(body.order_id);
    await route.fulfill({ response: res, json: body });
  });
  await page.route("https://checkout.stripe.test/**", async (route) => { await route.fulfill({ status: 302, headers: { location: `${baseURL}/__dev/pay?order=${await orderId}` } }); });

  await code.fill(AUTH);
  await start.click();
  const confirm = panel.getByRole("form", { name: "Confirm the transfer" });
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await expect(code).toHaveCount(0);
  // The auth code is gone from the page, storage and the URL.
  expect(await page.content()).not.toContain(AUTH);
  expect(await stored(page)).not.toContain(AUTH);
  await expect(confirm).toContainText("You pay $");
  if (check) await clean(page, "rescue confirm");

  const mail = await (await request.get(`/__dev/mail?to=${encodeURIComponent(email)}`)).json();
  const m = mail.filter((x: { kind: string }) => x.kind === "transfer_confirm_code").at(-1);
  expect(m, "confirmation mail").toBeTruthy();
  expect(m.text).not.toContain(AUTH);
  const confirmCode = /: ([A-Z0-9]{8})\n/.exec(m.text)![1]!;
  await confirm.getByLabel("Eight-character code from the email").fill(confirmCode);
  await confirm.getByRole("button", { name: "Confirm and pay on Stripe" }).click();

  // Back from Stripe: the status is Traveling, and nothing says the name moved.
  const back = page.getByRole("region", { name: `Transfer ${fqdn} here` });
  const status = back.getByRole("group", { name: "Transfer status" });
  await expect(status).toBeVisible({ timeout: 120_000 });
  const headline = status.getByRole("status");
  await expect(headline).toContainText("Traveling", { timeout: 60_000 });
  await expect(headline).not.toContainText("Moved");
  expect(await stored(page)).not.toContain(AUTH);
  if (check) await clean(page, "transfer traveling");

  const done = await (await request.get(`/__dev/transfer-in?fqdn=${fqdn}&do=complete`)).json();
  expect(done.state).toBe("completed");
  await expect(headline).toHaveText("Moved to Mosshatch.", { timeout: 30_000 });
  if (check) await clean(page, "transfer completed");
  await status.getByRole("button", { name: `Open ${fqdn}` }).click();
  const dpanel = page.getByRole("region", { name: `Details for ${fqdn}` });
  await expect(dpanel.getByRole("heading", { name: fqdn })).toBeVisible({ timeout: 20_000 });
  return { fqdn, dpanel };
}

test("rescue: transfer a name in through completion, then its Gate shows the 60-day lock", async ({ page, request, baseURL }) => {
  test.setTimeout(420_000);
  const { errors } = collect(page);
  await virtualAuthenticator(page);
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  const email = `rescuer${Date.now()}@example.org`;
  await signUp(page, request, email);
  const { dpanel } = await rescue(page, request, baseURL!, email, `moss-rescue-${Date.now().toString(36)}`);

  await dpanel.getByRole("tab", { name: "Gate" }).click();
  await expect(dpanel.getByRole("tab", { name: "Gate", selected: true })).toBeVisible();
  const why = dpanel.getByRole("group", { name: "Why it cannot move yet" });
  await expect(why).toContainText("A name can move to another registrar 60 days after its last transfer.", { timeout: 20_000 });
  await expect(why).toContainText("This lifts on");
  await expect(dpanel.getByText("Transfer lock", { exact: true }).locator("xpath=following-sibling::dd")).toHaveText("On");
  await expect(dpanel.getByRole("group", { name: "Transfer to another registrar" })).toBeVisible();
  await clean(page, "gate");
  // Keyboard: the tabs cycle with the arrow keys.
  await dpanel.getByRole("tab", { name: "Gate" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dpanel.getByRole("tab", { name: "Overview", selected: true })).toBeFocused();
  // The one expected console line is the browser's own note on the deliberately refused code (422); nothing else.
  const refusedNote = /Failed to load resource: the server responded with a status of 422/;
  expect(errors.filter((e) => refusedNote.test(e))).toHaveLength(1);
  expect(errors.filter((e) => !refusedNote.test(e)), errors.join("\n")).toEqual([]);
});

test("nest: add a secret, reveal it with the passkey, it hides again; one step-up reveals once; a truncated reveal leaks nothing", async ({ page, request, baseURL }) => {
  test.setTimeout(480_000);
  const { all, errors } = collect(page);
  await virtualAuthenticator(page);
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  const email = `nester${Date.now()}@example.org`;
  await signUp(page, request, email);
  const { fqdn, dpanel } = await rescue(page, request, baseURL!, email, `moss-nest-${Date.now().toString(36)}`, false);

  await dpanel.getByRole("tab", { name: "Nest" }).click();
  await expect(dpanel.getByText("No secrets in development yet.")).toBeVisible({ timeout: 20_000 });
  await clean(page, "nest empty");

  // A reserved name is refused plainly before sending; the server refuses it too.
  const name = dpanel.getByLabel("Name, like DATABASE_URL");
  await name.fill("node_options");
  await expect(dpanel.getByText("NODE_OPTIONS is reserved. It changes how programs start, so the Nest does not store it.")).toBeVisible();
  await expect(dpanel.getByRole("button", { name: "Add secret" })).toBeDisabled();
  await clean(page, "nest reserved name");
  const refused = await page.request.put(`/api/v1/domains/${fqdn}/secrets/dev/NODE_OPTIONS`, { headers: { "X-MH-Client": "web", Origin: baseURL! }, data: { value: "--require ./x.js" } });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).error.code).toBe("invalid_name");

  // Add: the value goes up once and the field is cleared; the list shows the name only.
  const CANARY = `mh-nest-canary-${Date.now().toString(36)}-Zq7`;
  await name.fill("api_key");
  await dpanel.getByLabel("Value", { exact: true }).fill(CANARY);
  await dpanel.getByRole("button", { name: "Add secret" }).click();
  await expect(dpanel.getByText("Saved API_KEY in dev.")).toBeVisible({ timeout: 20_000 });
  await expect(dpanel.getByLabel("Value", { exact: true })).toHaveValue("");
  await expect(dpanel.getByRole("list", { name: "Development secret names" })).toContainText("API_KEY");
  expect(await page.content()).not.toContain(CANARY);
  await clean(page, "nest list");

  // The run command is the primary copy; production value copy is off until turned on.
  await dpanel.getByRole("button", { name: "Copy the run command" }).isVisible();
  await expect(dpanel.locator(".run-cmd")).toHaveText(`mosshatch run ${fqdn} --env dev -- npm start`);
  await dpanel.getByLabel(/Hide revealed values after/).selectOption("10");

  // Reveal with the keyboard (single activation), then the passkey.
  const actionIds: string[] = [];
  page.on("request", (r) => { if (/\/api\/v1\/secrets\/[^/]+\/reveal$/.test(r.url())) actionIds.push(r.headers()["x-mh-action-id"] ?? ""); });
  const hold = dpanel.getByRole("button", { name: "Hold to reveal API_KEY" });
  await hold.focus();
  await page.keyboard.press("Enter");
  await approve(page, dpanel, "reveal");
  const box = dpanel.getByRole("group", { name: "Value of API_KEY" });
  await expect(box).toBeVisible({ timeout: 20_000 });
  expect(await box.locator("code.secret-value").textContent()).toBe(CANARY);
  await expect(box.locator("code.secret-value")).toBeFocused();
  await expect(box).toContainText("Hides in");
  expect(await box.getAttribute("aria-live")).toBeNull();
  await clean(page, "nest value shown", ".secret-box");
  expect(await stored(page)).not.toContain(CANARY);

  // Auto re-hide after the chosen 10 seconds.
  await expect(box).toHaveCount(0, { timeout: 15_000 });
  await expect(dpanel.getByText("Hidden again. Reveal it with your passkey to see it again.")).toBeVisible();
  expect(await page.content()).not.toContain(CANARY);
  await clean(page, "nest after hide");

  // One step-up reveals once: the same action id is refused.
  expect(actionIds).toHaveLength(1);
  const secretId = await page.evaluate(async (f) => {
    const r = await fetch(`/api/v1/domains/${f}/nest`, { headers: { Accept: "application/json" } });
    return (await r.json()).envs.dev.secrets[0].id as string;
  }, fqdn);
  const replay = await page.request.post(`/api/v1/secrets/${secretId}/reveal`, { headers: { "X-MH-Client": "web", Origin: baseURL!, "X-MH-Action-Id": actionIds[0]! }, data: {} });
  expect(replay.status()).toBe(403);
  expect(await replay.text()).not.toContain(CANARY);


  // Pointer hold for one second, then Hide now.
  await hold.hover();
  await page.mouse.down();
  await page.waitForTimeout(1300);
  await page.mouse.up();
  await approve(page, dpanel, "reveal by hold");
  await expect(box).toBeVisible({ timeout: 20_000 });
  await box.getByRole("button", { name: "Hide now" }).click();
  await expect(box).toHaveCount(0);
  expect(await page.content()).not.toContain(CANARY);

  // A short click is not a hold: the single-activation path is offered instead.
  await hold.click();
  await expect(dpanel.getByRole("button", { name: "reveal API_KEY without holding" })).toBeVisible();
  await clean(page, "nest short press");

  // ST-19: a truncated reveal response shows a plain message and leaves no canary in the console.
  const TRUNC = `mh-trunc-canary-${Date.now().toString(36)}`;
  await page.route("**/api/v1/secrets/*/reveal", (route) => route.fulfill({ status: 200, contentType: "application/json", body: `{"secret_id":"${secretId}","name":"API_KEY","env":"dev","version":1,"value":"${TRUNC}` }));
  await dpanel.getByRole("button", { name: "reveal API_KEY without holding" }).click();
  await approve(page, dpanel, "truncated reveal");
  await expect(dpanel.getByText("The value did not arrive whole, so nothing was shown. Try again.")).toBeVisible({ timeout: 20_000 });
  await expect(box).toHaveCount(0);
  expect(all.filter((t) => t.includes(TRUNC))).toEqual([]);
  await page.unroute("**/api/v1/secrets/*/reveal");

  // Delete asks first, then destroys every version.
  await dpanel.getByRole("button", { name: "Delete API_KEY" }).click();
  const del = dpanel.getByRole("group", { name: "Confirm deleting API_KEY" });
  await clean(page, "nest delete confirm");
  await del.getByRole("button", { name: "Delete for good" }).click();
  await expect(dpanel.getByText(/^Deleted API_KEY from dev\./)).toBeVisible({ timeout: 20_000 });
  await expect(dpanel.getByText("No secrets in development yet.")).toBeVisible();
  // Production: the value copy is off until the person turns it on.
  await dpanel.getByRole("button", { name: /^Production/ }).click();
  await expect(dpanel.getByLabel(/Allow copying production values/)).not.toBeChecked();
  await clean(page, "nest prod");
  // ST-39: after the reveals, the hides and a forced collection, no string in the page's JavaScript heap holds either value. (Last,
  // because a heap snapshot in the middle of the run stalls the virtual authenticator's next assertion in this Chromium.)
  expect(await page.content()).not.toContain(CANARY);
  expect(await heapHas(page, CANARY), "revealed value retained in the JS heap after hide").toBe(false);
  expect(await heapHas(page, TRUNC), "truncated reveal body retained in the JS heap").toBe(false);
  // Control: the same snapshot does see a string the page still holds.
  const PROBE = `mh-heap-probe-${Date.now().toString(36)}`;
  await page.evaluate((p) => { (globalThis as { __heapProbe?: string }).__heapProbe = p.split("").join(""); }, PROBE);
  expect(await heapHas(page, PROBE), "heap snapshot control").toBe(true);
  expect(errors, errors.join("\n")).toEqual([]);
});
