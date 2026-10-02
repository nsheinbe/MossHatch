import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@mosshatch/db/testing";
import { FakeEmail } from "../email.ts";
import { FakeClock } from "../testing/app.ts";
import { waitlistFetch, handleWaitlist } from "./http.ts";
import { EMAIL_LIMIT, NET_LIMIT, consentHash, sha256, type WaitlistDeps } from "./service.ts";
import { CONSENT_TEXT, QUESTION_TEXT } from "./text.ts";
import { createInvites, formatStats, waitlistStats } from "./owner.ts";

/**
 * The standalone waitlist (POST /api/waitlist, confirm, unsubscribe) against a real PostgreSQL, as the runtime role.
 * WL ids: WL-01 validation, WL-02 double opt-in, WL-03 enumeration resistance, WL-04 rate limits, WL-05 unsubscribe,
 * WL-06 honeypot and size limits, WL-07 nothing personal in logs or rows, WL-08 place in line, WL-09 owner scripts.
 */
const ORIGIN = "https://mosshatch.test";
let db: TestDb;
let d: WaitlistDeps;
let email: FakeEmail;
let clock: FakeClock;
const warnings: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  email = new FakeEmail();
  clock = new FakeClock();
  d = { pool: db.runtime, clock, email, secret: Buffer.alloc(32, 7), origin: ORIGIN, warn: (l) => warnings.push(l) };
}, 120_000);
afterAll(async () => { await db?.drop(); });
beforeEach(async () => {
  await db.owner.query("delete from waitlist");
  await db.owner.query("delete from rate_counters where bucket like 'waitlist.%'");
  email.clear();
  warnings.length = 0;
});

let ipN = 0;
const freshIp = () => `203.0.${(++ipN) % 250}.9`;
async function post(body: unknown, o: { ip?: string; form?: boolean; headers?: Record<string, string>; path?: string; raw?: string } = {}) {
  const h = new Headers({ "content-type": o.form ? "application/x-www-form-urlencoded" : "application/json", "x-forwarded-for": o.ip ?? freshIp(), ...(o.headers ?? {}) });
  const payload = o.raw ?? (o.form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body));
  const res = await waitlistFetch(d, new Request(ORIGIN + (o.path ?? "/api/waitlist"), { method: "POST", headers: h, body: payload }));
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, headers: res.headers };
}
async function get(p: string) {
  const res = await waitlistFetch(d, new Request(ORIGIN + p, { headers: { "x-forwarded-for": freshIp() } }));
  return { status: res.status, text: await res.text(), headers: res.headers };
}
const good = (over: Record<string, unknown> = {}) => ({ email: "fern@example.com", name: "moonfern.com", answer: "maybe", consent: true, ...over });
const linkIn = (text: string, p: string) => new RegExp(`${ORIGIN}${p}\\?t=([A-Za-z0-9_-]{43})`).exec(text)?.[1];
const row = async (e = "fern@example.com") => (await db.owner.query("select * from waitlist where email = $1", [e])).rows[0];

describe("waitlist", () => {
  it("WL-01 validates the email, name, answer and explicit consent", async () => {
    expect((await post(good({ email: "not-an-email" }))).json.error.code).toBe("invalid_email");
    expect((await post(good({ email: "a".repeat(250) + "@x.io" }))).json.error.code).toBe("invalid_email");
    expect((await post(good({ name: "<script>" }))).json.error.code).toBe("invalid_name");
    expect((await post(good({ answer: "definitely" }))).json.error.code).toBe("invalid_answer");
    expect((await post(good({ consent: undefined }))).json.error.code).toBe("consent_required");
    expect((await post(good({ consent: "true" }))).json.error.code).toBe("consent_required");   // JSON needs the boolean
    expect((await post(good(), { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await post(null, { raw: "{nope" })).json.error.code).toBe("bad_json");
    expect((await db.owner.query("select count(*)::int as n from waitlist")).rows[0].n).toBe(0);
    const ok = await post(good({ answer: undefined, name: undefined }));
    expect(ok.status).toBe(202);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const r = await row();
    expect(r.requested_names).toEqual([]);
    expect(r.answer).toBeNull();
    expect(Buffer.from(r.consent_hash).equals(consentHash(CONSENT_TEXT))).toBe(true);
  });

  it("WL-02 double opt-in: stored unconfirmed, confirmed only by a POST with the single-use link, which then dies", async () => {
    expect((await post(good())).status).toBe(202);
    let r = await row();
    expect(r.confirmed_at).toBeNull();
    expect(r.requested_names).toEqual(["moonfern.com"]);
    const m = email.last()!;
    expect(m.to).toEqual(["fern@example.com"]);
    expect(m.text).toContain("does not reserve or register a domain name");
    const t = linkIn(m.text, "/api/waitlist/confirm")!;
    const u = linkIn(m.text, "/api/waitlist/unsubscribe")!;
    // Only hashes are stored.
    const toks = (await db.owner.query("select hash, purpose from waitlist_tokens")).rows;
    expect(toks.map((x) => x.purpose).sort()).toEqual(["confirm", "unsubscribe"]);
    expect(toks.some((x) => Buffer.from(x.hash).equals(sha256(t)))).toBe(true);
    expect(JSON.stringify((await db.owner.query("select * from waitlist_tokens")).rows)).not.toContain(t);
    // A GET (a mail scanner following the link) shows a button and changes nothing.
    const page = await get(`/api/waitlist/confirm?t=${t}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Confirm my place");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await row()).confirmed_at).toBeNull();
    // The unsubscribe token cannot confirm, and the confirm token cannot unsubscribe (single purpose).
    expect((await post({ t: u }, { form: true, path: "/api/waitlist/confirm" })).status).toBe(404);
    expect((await get(`/api/waitlist/unsubscribe?t=${t}`)).status).toBe(404);
    // As a browser posts the confirm page's form: that page is no-referrer, so the Origin header is "null".
    const done = await post({ t }, { form: true, path: "/api/waitlist/confirm", headers: { origin: "null", "sec-fetch-site": "same-origin" } });
    expect(done.status).toBe(200);
    expect(done.text).toContain("You're #1 in line");
    r = await row();
    expect(r.confirmed_at).not.toBeNull();
    expect(email.last()!.subject).toBe("You're #1 in line for Mosshatch");
    // Used once.
    expect((await post({ t }, { form: true, path: "/api/waitlist/confirm" })).status).toBe(404);
    expect((await get(`/api/waitlist/confirm?t=${t}`)).status).toBe(404);
  });

  it("WL-02 a confirm link expires after 7 days", async () => {
    await post(good());
    const t = linkIn(email.last()!.text, "/api/waitlist/confirm")!;
    clock.advance(7 * 86_400_000 + 1000);
    try { expect((await post({ t }, { form: true, path: "/api/waitlist/confirm" })).status).toBe(404); }
    finally { clock.advance(-(7 * 86_400_000 + 1000)); }
    expect((await row()).confirmed_at).toBeNull();
  });

  it("WL-03 no enumeration: new, pending and confirmed addresses get the same response; the owner of the address is the only one told", async () => {
    const a = await post(good());
    const b = await post(good({ name: "emberwick" }));
    const t = linkIn(email.sent[1]!.text, "/api/waitlist/confirm")!;
    await post({ t }, { form: true, path: "/api/waitlist/confirm" });
    const c = await post(good({ name: "lanternfern.io" }));
    for (const x of [a, b, c]) { expect(x.status).toBe(202); expect(x.text).toBe(a.text); expect([...x.headers.keys()].sort()).toEqual([...a.headers.keys()].sort()); }
    // The confirmed person keeps their place and gets a note (not a new confirm link); names accumulate.
    expect(email.last()!.subject).toBe("You're already on the Mosshatch waitlist");
    expect(linkIn(email.last()!.text, "/api/waitlist/confirm")).toBeUndefined();
    expect((await row()).requested_names).toEqual(["moonfern.com", "emberwick", "lanternfern.io"]);
    // Form posts: the same redirect for every case.
    const f1 = await post({ email: "new@example.com", consent: "yes" }, { form: true });
    const f2 = await post({ email: "fern@example.com", consent: "yes" }, { form: true });
    expect([f1.status, f1.headers.get("location")]).toEqual([303, "/waitlist-sent"]);
    expect([f2.status, f2.headers.get("location")]).toEqual([303, "/waitlist-sent"]);
  });

  it("WL-04 rate limits per network (429) and per address (silent: same 202, no more mail)", async () => {
    const ip = "198.51.100.23";
    for (let i = 0; i < NET_LIMIT.max; i++) expect((await post(good({ email: `n${i}@example.com` }), { ip: i % 2 ? ip : "198.51.100.200" })).status).toBe(202);
    const blocked = await post(good({ email: "late@example.com" }), { ip });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("rate_limited");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await row("late@example.com")).toBeUndefined();
    // Another network is unaffected; the counter key is a keyed hash, never the address.
    expect((await post(good({ email: "other@example.com" }), { ip: "192.0.2.1" })).status).toBe(202);
    const keys = (await db.owner.query("select key_hash from rate_counters where bucket like 'waitlist.%'")).rows;
    expect(JSON.stringify(keys)).not.toMatch(/198\.51|example\.com/);
    email.clear();
    for (let i = 0; i < EMAIL_LIMIT.max + 2; i++) expect((await post(good({ email: "spam-me@example.com" }))).status).toBe(202);
    expect(email.to("spam-me@example.com")).toHaveLength(EMAIL_LIMIT.max);
  });

  it("WL-05 unsubscribe: GET shows a button, POST (or RFC 8058 one-click) leaves, the link stays harmless, and re-joining needs a new confirmation", async () => {
    await post(good());
    const first = email.last()!.text;
    await post({ t: linkIn(first, "/api/waitlist/confirm")! }, { form: true, path: "/api/waitlist/confirm" });
    const u = linkIn(first, "/api/waitlist/unsubscribe")!;
    expect((await get(`/api/waitlist/unsubscribe?t=${u}`)).text).toContain("Leave the waitlist");
    expect((await row()).unsubscribed_at).toBeNull();
    const out = await post("List-Unsubscribe=One-Click", { raw: "List-Unsubscribe=One-Click", form: true, path: `/api/waitlist/unsubscribe?t=${u}` });
    expect(out.status).toBe(200);
    expect((await row()).unsubscribed_at).not.toBeNull();
    expect((await post({ t: u }, { form: true, path: "/api/waitlist/unsubscribe" })).status).toBe(200);   // clicking again is fine
    expect((await post({ t: "x".repeat(43) }, { form: true, path: "/api/waitlist/unsubscribe" })).status).toBe(404);
    // Unsubscribed people are out of line and get no invite.
    expect((await createInvites(db.cron, email, ORIGIN, { next: 5 }, clock.now())).invited).toBe(0);
    email.clear();
    await post(good());
    expect(email.last()!.subject).toBe("Confirm your place on the Mosshatch waitlist");
    await post({ t: linkIn(email.last()!.text, "/api/waitlist/confirm")! }, { form: true, path: "/api/waitlist/confirm" });
    expect((await row()).unsubscribed_at).toBeNull();
  });

  it("WL-06 honeypot, size limit, cross-site posts and unknown paths", async () => {
    const bot = await post(good({ website: "http://spam.example" }));
    expect(bot.status).toBe(202);
    expect(await row()).toBeUndefined();
    expect(email.sent).toHaveLength(0);
    const botForm = await post({ email: "fern@example.com", consent: "yes", website: "x" }, { form: true });
    expect(botForm.headers.get("location")).toBe("/waitlist-sent");
    expect((await post(null, { raw: JSON.stringify(good({ name: "a".repeat(5000) })) })).status).toBe(413);
    expect((await post(good(), { headers: { origin: "https://evil.example" } })).json.error.code).toBe("cross_site");
    expect((await post(good(), { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await post(good(), { headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" } })).status).toBe(202);
    // Our pages are no-referrer, so a browser posts their forms with Origin: null; only a same-origin one is accepted.
    expect((await post(good(), { headers: { origin: "null", "sec-fetch-site": "same-origin" } })).status).toBe(202);
    expect((await post(good(), { headers: { origin: "null", "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await post(good(), { headers: { origin: "null" } })).status).toBe(403);
    expect((await get("/api/waitlist/else")).status).toBe(404);
    const html = await post({ email: "bad", consent: "yes" }, { form: true });
    expect(html.status).toBe(400);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.text).toContain("does not look right");
    expect(html.text).not.toContain("<script");
  });

  it("WL-07 never logs an address, name or token; stores a network hash, never the IP", async () => {
    const spy = vi.spyOn(console, "log"); const spyI = vi.spyOn(console, "info"); const spyW = vi.spyOn(console, "warn"); const spyE = vi.spyOn(console, "error");
    const failing: WaitlistDeps = { ...d, email: { send: async () => { throw Object.assign(new Error("resend_failed fern@example.com"), { code: "http_500" }); } } };
    try {
      const saved = d;
      d = failing;
      try { expect((await post(good(), { ip: "203.0.113.77" })).status).toBe(202); } finally { d = saved; }
      await post(good({ email: "canary-7Qx@example.com", name: "canaryname.dev" }), { ip: "203.0.113.78" });
      const printed = [...spy.mock.calls, ...spyI.mock.calls, ...spyW.mock.calls, ...spyE.mock.calls, warnings].flat().map(String).join("\n");
      expect(printed).not.toMatch(/@|canary|moonfern|203\.0\.113/);
      expect(warnings.join("\n")).toContain("waitlist.mail_failed kind=confirm code=http_500");
      const r = await row();
      expect(r.ip_hash).toHaveLength(32);
      expect(JSON.stringify(r)).not.toContain("203.0.113");
    } finally { spy.mockRestore(); spyI.mockRestore(); spyW.mockRestore(); spyE.mockRestore(); }
  });

  it("WL-08 place in line is by confirmation time and shown on the page and in the email", async () => {
    for (const who of ["a", "b", "c"]) {
      await post(good({ email: `${who}@example.com` }));
      clock.advance(1000);
    }
    const links = email.sent.map((m) => linkIn(m.text, "/api/waitlist/confirm")!);
    // c confirms first, then a.
    expect((await post({ t: links[2]! }, { form: true, path: "/api/waitlist/confirm" })).text).toContain("You're #1 in line");
    clock.advance(1000);
    expect((await post({ t: links[0]! }, { form: true, path: "/api/waitlist/confirm" })).text).toContain("You're #2 in line");
    expect(email.to("a@example.com").at(-1)!.text).toContain("You're #2 in line");
  });

  it("WL-01 the consent sentence and question are the same in the web form and the no-JS page", () => {
    const root = path.resolve(import.meta.dirname, "../../../..");
    const web = fs.readFileSync(path.join(root, "apps/web/src/ui/waitlistText.ts"), "utf8");
    const pg = fs.readFileSync(path.join(root, "apps/web/pages/waitlist.html"), "utf8");
    for (const s of [CONSENT_TEXT, QUESTION_TEXT]) { expect(web).toContain(JSON.stringify(s)); expect(pg).toContain(s); }
  });

  it("WL-09 handleWaitlist answers only its paths, and 503 without a database", async () => {
    expect(await handleWaitlist(new Request(ORIGIN + "/api/v1/session"), {})).toBeNull();
    expect(await handleWaitlist(new Request(ORIGIN + "/api/waitlistx", { method: "POST" }), {})).toBeNull();
    const r = await handleWaitlist(new Request(ORIGIN + "/api/waitlist", { method: "POST", body: "{}" }), {});
    expect(r!.status).toBe(503);
    expect((await r!.json()).error.code).toBe("not_configured");
  });

  it("WL-09 stats: sign-ups per day, confirmed rate, names, extensions, answers, invites; no addresses", async () => {
    await post(good({ email: "s1@example.com", name: "moonfern.com", answer: "yes" }));
    await post(good({ email: "s2@example.com", name: "moonfern.com", answer: "no" }));
    await post(good({ email: "s3@example.com", name: "emberwick", answer: undefined }));
    await post({ t: linkIn(email.to("s1@example.com")[0]!.text, "/api/waitlist/confirm")! }, { form: true, path: "/api/waitlist/confirm" });
    await createInvites(db.cron, email, ORIGIN, { next: 1 }, clock.now());
    const s = await waitlistStats(db.cron, clock.now());
    expect(s.totals).toMatchObject({ signups: 3, confirmed: 1, invited: 1, accepted: 0, invitesOpen: 1 });
    expect(s.totals.confirmedRate).toBeCloseTo(1 / 3);
    expect(s.topNames[0]).toEqual({ name: "moonfern.com", count: 2 });
    expect(s.topExtensions).toEqual([{ ext: "com", count: 2 }, { ext: "(none)", count: 1 }]);
    expect(s.answers).toEqual(expect.arrayContaining([{ answer: "yes", count: 1 }, { answer: "no", count: 1 }, { answer: "(no answer)", count: 1 }]));
    expect(s.perDay.at(-1)).toEqual({ day: "2026-10-01", signups: 3, confirmed: 1 });
    expect(formatStats(s)).not.toContain("@");
    // The runtime role cannot read the table directly (definer functions only).
    await expect(db.runtime.query("select email from waitlist")).rejects.toThrow(/permission denied/);
  });
});
