import crypto from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { axe } from "./axe";

/**
 * The sensitive screens against a scripted API (runs in the "account" project on the dev server; every /api/ request is answered
 * by the test, so each case is deterministic and fast). A virtual passkey signs real WebAuthn assertions for the mocked prepare.
 * Covers: a value that arrives while the page is hidden, focus after hiding, a step-up whose request changes while it is shown,
 * choices that stay editable during a step-up (device approval, card listing), the card and DNS roll-back copy, the transfer
 * code's re-hide time from tampered preferences, "Try again" after an expired challenge, and a token kept out of a live region.
 */

const UID = "0190f0f0-0000-7000-8000-0000000000aa";
const DOMAIN_ID = "0190f0f0-0000-7000-8000-0000000000d1";
const SID = "0190f0f0-0000-7000-8000-0000000000e1";
const FQDN = "fern-harness.com";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const D_ID = `^/api/v1/domains/${esc(DOMAIN_ID)}`;
const D_FQ = `^/api/v1/domains/${esc(FQDN)}`;

interface Call { method: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string>; search?: string }
type Reply = { status?: number; json?: unknown } | undefined;
type Handler = (c: Call) => Reply | Promise<Reply>;

const detail = {
  id: DOMAIN_ID, fqdn: FQDN, tld: "com", state: "thriving", state_text: "Healthy", adapter_state: "active", locked: false,
  expires_at: "2027-09-30T00:00:00.000Z", days_to_expiry: 365, auto_renew: true, age_days: 100, confirmed: true,
  renewal: { price_minor: "1500", years: 1, charge_at: null, auto_renew: true, state: null, held_reason: null, price_ceiling_minor: null, currency: "usd" },
  nameservers: ["ns1.mosshatch.net", "ns2.mosshatch.net"], ds_present: true, dns_hosted_here: true, dispute_lock_state: null, transfer_away: false,
  registry_statuses: [], released: null, mandate: null,
};
const security = {
  domain: FQDN, state: "thriving", attention: null, locked: false, dispute_lock: null, transfer_lock_until: null,
  transfer_code: { issued_at: null, replaced: false, replace_at: null }, nameservers: detail.nameservers, dns_hosted_here: true, ds_present: true,
  contact_change: null, registrant_verification: null, account_frozen: false, registrar_writes_paused: false,
};
const secretRow = { id: SID, env: "dev", name: "API_KEY", version: 1, updated_at: "2026-09-30T10:00:00.000Z" };
const nest = { domain: FQDN, envs: { dev: { count: 1, secrets: [secretRow] }, preview: { count: 0, secrets: [] }, prod: { count: 0, secrets: [] } }, connections: [] };

/** Answers every /api/ request from the routes registered here (the newest match wins); anything else is a 404. */
async function harness(page: Page) {
  const routes: { method: string; re: RegExp; h: Handler }[] = [];
  const calls: Call[] = [];
  const unmatched: string[] = [];
  const on = (method: string, re: string, h: Handler | object) => { routes.unshift({ method, re: new RegExp(re), h: typeof h === "function" ? (h as Handler) : () => ({ json: h }) }); };
  let n = 0;
  const api = {
    on, calls, unmatched,
    /** What prepare answers for one request: a summary, or an error reply. May wait. */
    prepare: async (c: Call): Promise<{ summary: string } | { status: number; json: unknown }> => ({ summary: `Do ${String(c.body?.type)} for ${String(c.body?.target_id)}.` }),
    commit: async (_c: Call): Promise<Reply> => ({ json: { state: "committed" } }),
    actionIds: () => calls.filter((c) => /^\/api\/v1\/actions\/[^/]+\/commit$/.test(c.path)).map((c) => c.path.split("/")[4]!),
  };
  on("GET", "^/api/v1/session$", { signedIn: true, user: { id: UID, email: "harness@example.org" }, credentials: [{ id: "cred1", label: "Harness key", backup_eligible: false }], addresses: [{ id: "a1", address: "harness@example.org", kind: "login", verified: true }], recovery: null });
  on("GET", "^/api/v1/domains$", { domains: [], eggs: [] });
  on("GET", `${D_ID}$`, detail);
  on("GET", `${D_FQ}/security$`, security);
  on("GET", `${D_FQ}/transfer$`, { domain: FQDN, state: "none", stop_available: false, note: null, message: null, timing: "", transfers: [] });
  on("GET", `${D_ID}/card$`, { card: null, eligible: true, address: `https://hatchkind.test/${FQDN}/` });
  on("GET", `${D_FQ}/nest$`, nest);
  on("GET", "^/api/v1/vault/reserved-names$", { version: 1, names: [], prefixes: [] });
  on("POST", "^/api/v1/actions/prepare$", async (c) => {
    const id = `act-${++n}`;
    const p = await api.prepare(c);
    if ("status" in p) return p;
    const options = { challenge: crypto.randomBytes(32).toString("base64url"), rpId: "localhost", allowCredentials: [], userVerification: "required", timeout: 120000 };
    return { json: { action_id: id, summary: p.summary, webauthn_options: options } };
  });
  on("POST", "^/api/v1/actions/[^/]+/commit$", (c) => api.commit(c));
  await page.route((u) => u.pathname.startsWith("/api/"), async (route) => {
    const r = route.request();
    const u = new URL(r.url());
    let body: Record<string, unknown> | null = null;
    try { body = r.postDataJSON() as Record<string, unknown> | null; } catch { body = null; }
    const c: Call = { method: r.method(), path: u.pathname, body, headers: r.headers(), search: u.search };
    calls.push(c);
    const hit = routes.find((x) => x.method === c.method && x.re.test(c.path));
    if (!hit) { unmatched.push(`${c.method} ${c.path}`); return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":{"code":"not_found"}}' }); }
    const out = (await hit.h(c)) ?? {};
    await route.fulfill({ status: out.status ?? 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(out.json ?? {}) });
  });
  return api;
}

/** A platform passkey that answers any assertion for rp "localhost" (the mocked prepare lists no credentials, so it is discovered). */
async function passkey(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: {
    credentialId: crypto.randomBytes(16).toString("base64"), isResidentCredential: true, rpId: "localhost",
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), userHandle: Buffer.from("harness-user").toString("base64"), signCount: 0,
  } });
}

/** Loads the app signed in. Escape ends the arrival demo; it also closes /device and Rescue, so those pages skip it. */
async function boot(page: Page, path = "/", o: { escape?: boolean } = {}) {
  await passkey(page);
  const api = await harness(page);
  await page.goto(path);
  await page.waitForSelector("html[data-booted='1']");
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible({ timeout: 20_000 });
  if (o.escape !== false) await page.keyboard.press("Escape");
  return api;
}
const storeState = (page: Page) => page.evaluate(async () => {
  const path = "/src/store/index.ts";
  const m = (await import(path)) as { useUi: { getState(): Record<string, unknown> } };
  const s = m.useUi.getState();
  return { rescue: s.rescue ?? null, domainPanel: s.domainPanel ?? null, visitorsOpen: s.visitorsOpen, rehideSeconds: s.rehideSeconds, calm: s.calm };
});

/** Opens the domain panel through the app's own store module (the dev server serves it at this path). */
async function openDomain(page: Page) {
  await page.evaluate(async (p) => {
    const path = "/src/store/index.ts";
    const m = (await import(path)) as { useUi: { getState(): { set(x: unknown): void } } };
    m.useUi.getState().set({ domainPanel: p });
  }, { id: DOMAIN_ID, fqdn: FQDN });
  const panel = page.getByRole("region", { name: `Details for ${FQDN}` });
  await expect(panel.getByRole("heading", { name: FQDN, exact: true })).toBeVisible({ timeout: 20_000 });
  return panel;
}

const clean = async (page: Page, what: string) => {
  const v = (await axe(page).analyze()).violations;
  expect(v.map((x) => `${what}: ${x.id} ${x.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};
const deferred = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const setHidden = (page: Page, hidden: boolean) => page.evaluate((h) => {
  if (h) {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  } else {
    delete (document as unknown as Record<string, unknown>).hidden;
    delete (document as unknown as Record<string, unknown>).visibilityState;
  }
  document.dispatchEvent(new Event("visibilitychange"));
}, hidden);

async function openNestAndStartReveal(page: Page) {
  const panel = await openDomain(page);
  await panel.getByRole("tab", { name: "Nest" }).click();
  const hold = panel.getByRole("button", { name: "Hold to reveal API_KEY" });
  await expect(hold).toBeVisible({ timeout: 20_000 });
  await hold.focus();
  await page.keyboard.press("Enter");
  const group = panel.getByRole("group", { name: "Confirm with your passkey" });
  await expect(group.getByRole("button", { name: "Approve with passkey" })).toBeVisible({ timeout: 20_000 });
  return { panel, hold, group };
}

test("reveal: a value that arrives while the page is hidden is never shown", async ({ page }) => {
  const api = await boot(page);
  const CANARY = `mh-hidden-canary-${Date.now().toString(36)}`;
  const arrived = deferred(), release = deferred();
  api.on("POST", `^/api/v1/secrets/${esc(SID)}/reveal$`, async () => { arrived.open(); await release.p; return { json: { secret_id: SID, name: "API_KEY", env: "dev", version: 1, value: CANARY } }; });
  const { panel, group } = await openNestAndStartReveal(page);
  await group.getByRole("button", { name: "Approve with passkey" }).click();
  await arrived.p;
  // The person switches away while the value is on its way.
  await setHidden(page, true);
  release.open();
  await expect(group).toHaveCount(0, { timeout: 20_000 });
  await page.waitForTimeout(500);
  await expect(panel.getByRole("group", { name: "Value of API_KEY" })).toHaveCount(0);
  expect(await page.content()).not.toContain(CANARY);
  await setHidden(page, false);
  await expect(panel.getByText("Hidden because you left the page.")).toBeVisible();
  expect(await page.content()).not.toContain(CANARY);
});

test("reveal: after Hide now, focus returns to the reveal button (keyboard)", async ({ page }) => {
  const api = await boot(page);
  api.on("POST", `^/api/v1/secrets/${esc(SID)}/reveal$`, { secret_id: SID, name: "API_KEY", env: "dev", version: 1, value: "mh-focus-value-1" });
  const { panel, group } = await openNestAndStartReveal(page);
  await group.getByRole("button", { name: "Approve with passkey" }).click();
  const box = panel.getByRole("group", { name: "Value of API_KEY" });
  await expect(box).toBeVisible({ timeout: 20_000 });
  await box.getByRole("button", { name: "Hide now" }).focus();
  await page.keyboard.press("Enter");
  await expect(box).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Hold to reveal API_KEY" })).toBeFocused();
  await clean(page, "nest after hide now");
});

test("step-up: a new request replaces the shown one at once; the stale summary cannot be approved", async ({ page }) => {
  const api = await boot(page);
  const ds = (keyTag: number, c: string) => ({ keyTag, algorithm: 13, digestType: 2, digest: c.repeat(64) });
  api.on("GET", `${D_FQ}/dns$`, { domain: FQDN, hosted: true, read_only: false, records: [], snapshots: 0 });
  api.on("GET", `${D_FQ}/dns-snapshots$`, { snapshots: [] });
  api.on("GET", `${D_FQ}/ds$`, { supported: true, note: "DNSSEC records are optional.", records: [ds(11111, "a"), ds(22222, "b")], ds_present: true });
  api.on("GET", `${D_FQ}/registrant-verification$`, { verification: null });
  api.on("POST", `${D_FQ}/ds$`, { changed: true });
  const second = deferred();
  api.prepare = async (c) => {
    const tag = ((c.body?.user_input as { ds?: { keyTag?: number } })?.ds?.keyTag);
    if (tag === 22222) await second.p;
    return { summary: `Remove a DNSSEC record on ${FQDN}.` };
  };
  const panel = await openDomain(page);
  await panel.getByRole("tab", { name: "DNS" }).click();
  const dnssec = panel.getByRole("group", { name: "DNSSEC" });
  await dnssec.getByRole("button", { name: "Remove the DNSSEC record with key tag 11111" }).click();
  const group = dnssec.getByRole("group", { name: "Confirm with your passkey" });
  await expect(group.getByRole("button", { name: "Approve with passkey" })).toBeVisible({ timeout: 20_000 });
  // The person changes their mind and asks to remove the other record. Until that is prepared, nothing can be approved.
  await dnssec.getByRole("button", { name: "Remove the DNSSEC record with key tag 22222" }).click();
  await expect(group.getByText("Preparing.")).toBeVisible();
  await expect(group.getByRole("button", { name: "Approve with passkey" })).toHaveCount(0);
  await expect(group.getByText(`Remove a DNSSEC record on ${FQDN}.`)).toHaveCount(0);
  second.open();
  await expect(group.getByRole("button", { name: "Approve with passkey" })).toBeVisible({ timeout: 20_000 });
  await group.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(panel.getByText("DNSSEC record removed.")).toBeVisible({ timeout: 20_000 });
  expect(api.actionIds()).toEqual(["act-2"]);
  const gated = api.calls.filter((c) => c.method === "POST" && c.path.endsWith("/ds"));
  expect(gated.map((c) => c.headers["x-mh-action-id"])).toEqual(["act-2"]);
});

test("dns: rolling back an older snapshot that the server refuses (422) says why and what to do", async ({ page }) => {
  const api = await boot(page);
  api.on("GET", `${D_FQ}/dns$`, { domain: FQDN, hosted: true, read_only: false, records: [{ id: "r1", type: "TXT", name: "@", value: "v=spf1 -all", sensitive: true, reasons: ["txt_value"] }], snapshots: 2 });
  api.on("GET", `${D_FQ}/dns-snapshots$`, { snapshots: [
    { id: "0190f0f0-0000-7000-8000-0000000000f2", reason: "pre_write", added: 1, removed: 0, sensitive: 1, taken_at: "2026-09-30T10:00:00.000Z", rolled_back_at: null },
    { id: "0190f0f0-0000-7000-8000-0000000000f1", reason: "pre_write", added: 1, removed: 0, sensitive: 0, taken_at: "2026-09-29T10:00:00.000Z", rolled_back_at: null },
  ] });
  api.on("GET", `${D_FQ}/ds$`, { supported: true, note: "DNSSEC records are optional.", records: [], ds_present: false });
  api.on("GET", `${D_FQ}/registrant-verification$`, { verification: null });
  let code = "unrelated_delete";
  api.on("POST", `${D_FQ}/dns-snapshots/[^/]+/rollback$`, () => ({ status: 422, json: { error: { code } } }));
  const panel = await openDomain(page);
  await panel.getByRole("tab", { name: "DNS" }).click();
  const older = panel.getByRole("button", { name: /^Roll back to before the change of Sep 29, 2026/ });
  await expect(older).toBeVisible({ timeout: 20_000 });
  await older.click();
  await expect(panel.getByRole("status").filter({ hasText: "Nothing was changed." })).toContainText("Roll back the newer changes first", { timeout: 20_000 });
  await clean(page, "dns rollback refused");
  code = "too_many_deletes";
  await older.click();
  await expect(panel.getByRole("status").filter({ hasText: "Nothing was changed." })).toContainText("more than five records", { timeout: 20_000 });
});

test("card: the listing choice is locked while the passkey signs it, and a take-down (409) is explained", async ({ page }) => {
  const api = await boot(page);
  let publishReply: Reply = { status: 409, json: { error: { code: "card_taken_down" } } };
  api.on("POST", `${D_ID}/card$`, () => publishReply);
  const panel = await openDomain(page);
  const card = panel.getByRole("region", { name: "Public card" });
  const listed = card.getByLabel("Let search engines list this card");
  await listed.check();
  await card.getByRole("button", { name: "Publish card" }).click();
  const group = card.getByRole("group", { name: "Confirm with your passkey" });
  await expect(group.getByRole("button", { name: "Approve with passkey" })).toBeVisible({ timeout: 20_000 });
  // The passkey signs "listed"; the box that says so cannot change underneath it.
  await expect(listed).toBeDisabled();
  await expect(listed).toBeChecked();
  const prepared = api.calls.find((c) => c.path === "/api/v1/actions/prepare");
  expect((prepared!.body!.user_input as { indexable: boolean }).indexable).toBe(true);
  await group.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(group.getByRole("alert")).toContainText("taken down after a report", { timeout: 20_000 });
  await clean(page, "card taken down");
  // The same answer at prepare time reads the same.
  await group.getByRole("button", { name: /Close|Cancel/ }).click();
  await expect(listed).toBeEnabled();
  api.prepare = async () => ({ status: 409, json: { error: { code: "card_taken_down" } } });
  publishReply = { json: {} };
  await card.getByRole("button", { name: "Publish card" }).click();
  await expect(card.getByRole("group", { name: "Confirm with your passkey" }).getByRole("alert")).toContainText("taken down after a report", { timeout: 20_000 });
});

test("transfer code: tampered preferences cannot keep the code up past 100 seconds, nor plant other state", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mosshatch.prefs", JSON.stringify({ state: {
      calm: true, sound: false, rehideSeconds: 100000, rescue: { fqdn: "planted-name.com", transferId: null },
      domainPanel: { id: "0190f0f0-0000-7000-8000-0000000000ff", fqdn: "planted-panel.com" }, visitorsOpen: true,
    }, version: 1 }));
  });
  const api = await boot(page, "/", { escape: false });
  const CODE = `Xq7-${Date.now().toString(36)}-Lm2`;
  api.on("POST", `${D_FQ}/transfer-out$`, { code: CODE });
  // Only calm, sound and rehideSeconds come back from storage, and rehideSeconds only inside 5 to 100; nothing planted opens.
  await page.waitForTimeout(1000);
  await expect(page.getByRole("region", { name: "Transfer planted-name.com here" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Details for planted-panel.com" })).toHaveCount(0);
  const s = await storeState(page);
  expect(s).toMatchObject({ rescue: null, domainPanel: null, visitorsOpen: false, calm: true });
  expect(s.rehideSeconds).toBeLessThanOrEqual(100);
  await page.keyboard.press("Escape");
  const panel = await openDomain(page);
  const xfer = panel.getByRole("group", { name: "Transfer to another registrar" });
  await xfer.getByRole("button", { name: "Get a transfer code" }).click();
  const group = xfer.getByRole("group", { name: "Confirm with your passkey" });
  await group.getByRole("button", { name: "Approve with passkey" }).click();
  const box = xfer.getByRole("group", { name: "Transfer code" });
  await expect(box).toBeVisible({ timeout: 20_000 });
  const secs = Number(/hides in (\d+) seconds?/.exec((await box.textContent()) ?? "")?.[1]);
  expect(secs).toBeGreaterThanOrEqual(5);
  expect(secs).toBeLessThanOrEqual(100);
  await box.getByRole("button", { name: "Hide it now" }).click();
  await expect(box).toHaveCount(0);
  expect(await page.content()).not.toContain(CODE);
});

test("transfer code: when the code hides (Hide it now, or the timer), focus returns to the button that revealed it (keyboard)", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("mosshatch.prefs", JSON.stringify({ state: { calm: false, sound: false, rehideSeconds: 5 }, version: 1 })); });
  const api = await boot(page);
  const CODE = `Fk7-${Date.now().toString(36)}-Rb2`;
  api.on("POST", `${D_FQ}/transfer-out$`, { code: CODE });
  const panel = await openDomain(page);
  const xfer = panel.getByRole("group", { name: "Transfer to another registrar" });
  const get = xfer.getByRole("button", { name: "Get a transfer code" });
  const box = xfer.getByRole("group", { name: "Transfer code" });
  const reveal = async () => {
    await get.focus();
    await page.keyboard.press("Enter");
    await xfer.getByRole("group", { name: "Confirm with your passkey" }).getByRole("button", { name: "Approve with passkey" }).focus();
    await page.keyboard.press("Enter");
    await expect(box).toBeVisible({ timeout: 20_000 });
  };
  await reveal();
  await box.getByRole("button", { name: "Hide it now" }).focus();
  await page.keyboard.press("Enter");
  await expect(box).toHaveCount(0);
  await expect(get).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await clean(page, "transfer code hidden");
  // The timer hides it while the person is still on the code: their place moves back the same way.
  await reveal();
  await expect(xfer.locator("code.xfer-code")).toBeFocused();
  await expect(box).toHaveCount(0, { timeout: 10_000 });
  await expect(get).toBeFocused();
  expect(await page.content()).not.toContain(CODE);
});

test("step-up: an expired or refused challenge offers Try again with a new challenge (WCAG 2.2.1)", async ({ page }) => {
  const api = await boot(page);
  const CODE = `Tr7-${Date.now().toString(36)}-Ag2`;
  api.on("POST", `${D_FQ}/transfer-out$`, { code: CODE });
  let first = true;
  api.commit = async () => { if (first) { first = false; return { status: 409, json: { error: { code: "challenge_unavailable" } } }; } return { json: { state: "committed" } }; };
  const panel = await openDomain(page);
  const xfer = panel.getByRole("group", { name: "Transfer to another registrar" });
  await xfer.getByRole("button", { name: "Get a transfer code" }).click();
  const group = xfer.getByRole("group", { name: "Confirm with your passkey" });
  await group.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(group.getByRole("alert")).toHaveText("The passkey check did not go through. Try again.", { timeout: 20_000 });
  await clean(page, "step-up failed");
  await group.getByRole("button", { name: "Try again" }).click();
  await expect(group.getByRole("button", { name: "Approve with passkey" })).toBeVisible({ timeout: 20_000 });
  await group.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(xfer.getByRole("group", { name: "Transfer code" })).toBeVisible({ timeout: 20_000 });
  expect(api.actionIds()).toEqual(["act-1", "act-2"]);
});

async function deviceHarness(page: Page) {
  const api = await boot(page, "/device", { escape: false });
  const found = (id: string, address: string) => ({
    request_id: id, observed: { address, requested_at: "2026-09-30T10:00:00.000Z", expires_at: "2026-09-30T10:10:00.000Z" },
    reported: { client_name: "mosshatch", client_version: "1.0.0", scopes: [] }, default_envs: ["dev", "preview"], grant: [], prod_choices: [FQDN],
  });
  api.on("POST", "^/api/v1/oauth/device/lookup$", (c) => {
    const code = String(c.body?.user_code ?? "");
    if (code === "BCDF-GHJK") return { json: found("0190f0f0-0000-7000-8000-00000000c001", "203.0.113.0/24") };
    if (code === "KLMN-PQRS") return { json: found("0190f0f0-0000-7000-8000-00000000c002", "198.51.100.0/24") };
    return { status: 404, json: { error: { code: "not_found" } } };
  });
  api.prepare = async (c) => {
    const i = c.body?.user_input as { envs: string[]; prod_domains: string[] };
    return { summary: `Let the command-line tool use: ${[...i.envs, ...i.prod_domains.map((d) => `${d} prod`)].join(", ")}.` };
  };
  const region = page.getByRole("region", { name: "Approve a command-line sign-in" });
  await expect(region).toBeVisible({ timeout: 20_000 });
  const lookup = async (code: string) => {
    await region.getByLabel("Code from your terminal").fill(code);
    await region.getByRole("button", { name: "Look up" }).click();
    await expect(region.getByRole("heading", { name: "What we saw" })).toBeVisible({ timeout: 20_000 });
  };
  return { api, region, lookup };
}

test("device approval: the scopes cannot change while the passkey signs them", async ({ page }) => {
  const { api, region, lookup } = await deviceHarness(page);
  await lookup("BCDF-GHJK");
  await region.getByRole("button", { name: "Approve with passkey" }).click();
  const group = region.getByRole("group", { name: "Confirm with your passkey" });
  await expect(group).toContainText("Let the command-line tool use: dev, preview.", { timeout: 20_000 });
  const preview = region.getByRole("checkbox", { name: "preview" });
  const prod = region.getByRole("checkbox", { name: `${FQDN} (prod)` });
  await expect(preview).toBeDisabled();
  await expect(prod).toBeDisabled();
  await expect(region.getByRole("list").filter({ hasText: "domains.read" })).toContainText("secrets.read:*:preview");
  await clean(page, "device step-up");
  await group.getByRole("button", { name: "Cancel" }).click();
  await expect(preview).toBeEnabled();
  expect(api.calls.filter((c) => c.path === "/api/v1/oauth/device/approve")).toEqual([]);
});

test("device approval: changing the code drops the pending approval of the first request", async ({ page }) => {
  const { api, region, lookup } = await deviceHarness(page);
  await lookup("BCDF-GHJK");
  await region.getByRole("button", { name: "Approve with passkey" }).click();
  const group = region.getByRole("group", { name: "Confirm with your passkey" });
  await expect(group.getByRole("button", { name: "Approve with passkey" })).toBeVisible({ timeout: 20_000 });
  await region.getByLabel("Code from your terminal").fill("KLMN-PQRS");
  await expect(group).toHaveCount(0);
  await expect(region.getByRole("heading", { name: "What we saw" })).toHaveCount(0);
  await region.getByRole("button", { name: "Look up" }).click();
  await expect(region.getByText("198.51.100.0/24")).toBeVisible({ timeout: 20_000 });
  await expect(group).toHaveCount(0);
  await region.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(group.getByRole("button", { name: "Approve with passkey" })).toBeVisible({ timeout: 20_000 });
  const preps = api.calls.filter((c) => c.path === "/api/v1/actions/prepare").map((c) => [c.body?.target_id, (c.body?.user_input as { user_code: string }).user_code]);
  expect(preps.at(-1)).toEqual(["0190f0f0-0000-7000-8000-00000000c002", "KLMN-PQRS"]);
});

test("visitors: a new token is shown once and never inside a live region", async ({ page }) => {
  const api = await boot(page);
  const TOKEN = `mh_live_${crypto.randomBytes(16).toString("hex")}ABCD`;
  api.on("GET", "^/api/v1/visitors$", { visitors: [], pending_requests: 0, confirm_threshold_minor: "5000", device_login_enabled: true });
  api.on("GET", "^/api/v1/approvals$", { approvals: [] });
  api.on("POST", "^/api/v1/bindings$", { id: "0190f0f0-0000-7000-8000-00000000b001", token: TOKEN, prefix: TOKEN.slice(0, 12), expires_at: "2026-10-30T00:00:00.000Z", scopes: ["domains.read:*"] });
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Connected apps" }).click();
  const region = page.getByRole("region", { name: "Connected apps", exact: true });
  await expect(region.getByRole("heading", { name: "New token" })).toBeVisible({ timeout: 20_000 });
  await region.getByLabel("Name", { exact: true }).fill("Build bot");
  await region.getByRole("button", { name: "Create with passkey" }).click();
  await region.getByRole("group", { name: "Confirm with your passkey" }).getByRole("button", { name: "Approve with passkey" }).click();
  const shown = region.locator("code.token-once");
  await expect(shown).toHaveText(TOKEN, { timeout: 20_000 });
  // Screen readers announce live regions aloud; the token must not be in one.
  expect(await page.locator("[role=status] code.token-once, [aria-live] code.token-once, [role=alert] code.token-once").count()).toBe(0);
  await clean(page, "token shown once");
  await region.getByRole("button", { name: "I stored it" }).click();
  await expect(shown).toHaveCount(0);
  // Account and Connected apps never show together: opening one closes the other.
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByRole("region", { name: "Your account" })).toBeVisible();
  await expect(region).toHaveCount(0);
  await page.getByRole("button", { name: "Connected apps" }).click();
  await expect(region).toBeVisible();
  await expect(page.getByRole("region", { name: "Your account" })).toHaveCount(0);
  expect(await page.content()).not.toContain(TOKEN);
});

test("ST-72 approval card: more access signs the token's access as the server has it now plus exactly the scopes shown, never a stale list", async ({ page }) => {
  const api = await boot(page);
  const BID = "0190f0f0-0000-7000-8000-00000000b0b1";
  const RID = "0190f0f0-0000-7000-8000-00000000a0a1";
  const at = "2026-09-30T10:00:00.000Z", until = "2026-10-30T10:00:00.000Z";
  // The list loads while the token can still change DNS; afterwards the person narrows it in another tab.
  let held = ["domains.read:*", `dns.write:${FQDN}`];
  let asks = [`secrets.read:${FQDN}:dev`];
  api.on("GET", "^/api/v1/visitors$", () => ({ json: {
    visitors: [{ id: BID, kind: "agent", name: "Build bot", prefix: "mh_live_b0b1", scopes: held, connected_app: null, created_at: at, last_used_at: null, expires_at: until, revoked_at: null, paused: false,
      spend: { cap_minor: "0", spent_minor: "0", reserved_minor: "0" }, pending_requests: 1 }],
    pending_requests: 1, confirm_threshold_minor: "5000", device_login_enabled: true,
  } }));
  const summary = { id: RID, kind: "scope", state: "pending", domain: null, years: null, max_total_minor: "0", requested_at: at, expires_at: until, requester: { binding_id: BID, name: "Build bot" } };
  api.on("GET", "^/api/v1/approvals$", (c) => ({ json: { approvals: /state=pending/.test(c.search ?? "") ? [summary] : [] } }));
  api.on("GET", `^/api/v1/approvals/${esc(RID)}$`, () => ({ json: {
    id: RID, kind: "scope", state: "pending", agent_state: "pending", requested_at: at, age_seconds: 60, expires_at: until, new_network: false, decided_at: null, decision_reason: null, order_id: null,
    requester: { binding_id: BID, name: "Build bot", kind: "agent", connected_app: false, token_expires_at: until, live: true }, scopes: asks,
  } }));
  api.on("POST", `^/api/v1/bindings/${esc(BID)}/widen$`, {});
  api.on("POST", `^/api/v1/approvals/${esc(RID)}/resolve$`, { state: "completed" });
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Connected apps" }).click();
  const region = page.getByRole("region", { name: "Connected apps", exact: true });
  await region.getByRole("button", { name: "Review" }).click();
  const card = region.locator(".approval-card");
  await expect(card.getByRole("heading", { name: "Give a token more access" })).toBeVisible({ timeout: 20_000 });
  await expect(card.getByRole("listitem")).toHaveText(asks);
  held = ["domains.read:*"];
  const prepares = () => api.calls.filter((c) => c.path === "/api/v1/actions/prepare");

  // The request on the server no longer matches the card: nothing is prepared, the card shows the server's version.
  asks = [`secrets.read:${FQDN}:dev`, `secrets.read:${FQDN}:preview`];
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("This request changed. Check what it asks for now, then approve again.", { timeout: 20_000 });
  await expect(card.getByRole("listitem")).toHaveText(asks);
  expect(prepares()).toEqual([]);
  await clean(page, "approval card changed");

  // Approving now signs the token's current access plus exactly the shown scopes: the DNS access removed since the list loaded stays removed.
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  const group = card.getByRole("group", { name: "Confirm with your passkey" });
  await expect(group.getByRole("button", { name: "Approve with passkey" })).toBeVisible({ timeout: 20_000 });
  const signed = prepares().at(-1)!.body!;
  expect(signed).toMatchObject({ type: "agent.token.widen", target_id: BID });
  expect([...((signed.user_input as { scopes: string[] }).scopes)].sort()).toEqual(["domains.read:*", ...asks].sort());
  await group.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(region.getByText("Approved. The token can now do that.")).toBeVisible({ timeout: 20_000 });
  expect(api.calls.filter((c) => c.method === "POST" && c.path.endsWith("/widen")).map((c) => c.headers["x-mh-action-id"])).toEqual(api.actionIds());
});
