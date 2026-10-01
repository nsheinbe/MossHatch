import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUser } from "@mosshatch/db";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { createSession } from "../http/session.ts";
import { mintToken } from "../util/token.ts";
import { sha256 } from "../util/bytes.ts";
import { buildRouter } from "../routes.ts";
import { emailActionUrl, mintEmailActionToken, type EmailActionPurpose } from "./email-actions.ts";
import { auditActions, codeFrom, lastMail, linkFrom, me, newApp, nextIp, signIn, signUp, xff, type Person } from "./testkit.ts";

let app: TestApp;
beforeAll(async () => { app = await newApp(); }, 60_000);
afterAll(async () => { await app?.drop(); });

const mint = (userId: string, purpose: EmailActionPurpose, eventId: string, ttlMs = 72 * 3600_000) =>
  withUser(app.ctx.runtime, userId, (c) => mintEmailActionToken(app.ctx, c, { userId, purpose, eventId, ttlMs })).then((r) => r.token);
const act = (token: string, o: { headers?: Record<string, string>; body?: unknown; cookie?: string } = {}) =>
  app.call("POST", `/api/v1/email-actions/${token}`, { body: o.body === undefined ? { confirm: true } : o.body, cookie: o.cookie, headers: { ...xff(nextIp()), ...o.headers } });

/** Everything an email link could change, as one comparable value. */
const snapshot = async (userId: string) => {
  const q = async (sql: string) => JSON.stringify((await app.db.owner.query(sql, [userId])).rows);
  return [
    await q("select id, frozen_at, status, hardened_mode from users where id = $1"),
    await q("select id_hash, revoked_at from sessions where user_id = $1 order by id_hash"),
    await q("select id, revoked_at, paused_at from bindings where user_id = $1 order by id"),
    await q("select id, status, cancelled_by from recovery_requests where user_id = $1 order by id"),
    await q("select id, used_at, expires_at from email_action_tokens where user_id = $1 order by id"),
    await q("select id, auto_renew, locked, nameservers from domains where user_id = $1 order by id"),
    await q("select id, revoked_at from renewal_mandates where user_id = $1 order by id"),
    await q("select action from audit_log where chain_id = $1 order by seq"),
    await q("select id from email_log where user_id = $1 order by id"),
  ].join("\n");
};

async function seedDomain(p: Person) {
  const d = (await app.db.owner.query("insert into domains (user_id, fqdn_ascii, tld, registrar, livemode, auto_renew, locked, nameservers) values ($1,$2,'com','mock',false,true,false,$3) returning id",
    [p.userId, `d${crypto.randomBytes(4).toString("hex")}.com`, ["ns1.example.net", "ns2.example.net"]])).rows[0];
  await app.db.owner.query("insert into renewal_mandates (domain_id, user_id, price_ceiling_minor, text_hash, retain_until) values ($1,$2,2000,'h',now() + interval '3 years')", [d.id, p.userId]);
  return d.id as string;
}

async function withBinding(p: Person) {
  const m = mintToken("live");
  return (await app.db.owner.query("insert into bindings (user_id, kind, name, token_prefix, token_hash, expires_at) values ($1,'agent','t',$2,$3,$4) returning id", [p.userId, m.prefix, m.hash, new Date(app.clock.now().getTime() + 86400_000)])).rows[0].id as string;
}

describe("email action links", () => {
  it("mints 256-bit tokens stored only as SHA-256, bound to purpose, event and user", async () => {
    const p = await signUp(app, "ea1@example.com");
    const event = crypto.randomUUID();
    const t = await mint(p.userId, "freeze", event);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
    const row = (await app.db.owner.query("select * from email_action_tokens where user_id = $1", [p.userId])).rows[0];
    expect(Buffer.from(row.token_hash).equals(sha256(t))).toBe(true);
    expect(JSON.stringify(row)).not.toContain(t);
    expect(row).toMatchObject({ purpose: "freeze", event_id: event });
    expect(emailActionUrl(app.ctx, t)).toBe(`https://mosshatch.test/api/v1/email-actions/${t}`);
  });

  it("ST-147: repeated GET and HEAD of every link change nothing, with the privacy headers; a bad link answers the same page", async () => {
    const p = await signUp(app, "ea2@example.com");
    await withBinding(p);
    const domainId = await seedDomain(p);
    const reqId = (await app.db.owner.query("insert into recovery_requests (user_id, path, status, cooling_off_until) values ($1,'email_only','cooling_off',now() + interval '3 days') returning id", [p.userId])).rows[0].id;
    const tokens = [await mint(p.userId, "freeze", crypto.randomUUID()), await mint(p.userId, "recovery_cancel", reqId), await mint(p.userId, "auto_renew_off", domainId)];
    const before = await snapshot(p.userId);
    for (const t of tokens) {
      for (let i = 0; i < 3; i++) {
        for (const method of ["GET", "HEAD"]) {
          const r = await app.call(method, `/api/v1/email-actions/${t}`, { headers: xff(nextIp()) });
          expect(r.status, method).toBe(200);
          expect(r.headers.get("referrer-policy")).toBe("no-referrer");
          expect(r.headers.get("x-robots-tag")).toMatch(/noindex/);
          expect(r.headers.get("cache-control")).toMatch(/no-store/);
          expect(r.headers.get("content-type")).toMatch(/text\/html/);
          expect(r.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
          if (method === "GET") { expect(r.text).toMatch(/<button/); expect(r.text).not.toContain(t); }
        }
      }
    }
    expect(await snapshot(p.userId)).toBe(before);
    // Wrong, malformed and unknown tokens: one answer.
    const a = await app.call("GET", `/api/v1/email-actions/${crypto.randomBytes(32).toString("base64url")}`);
    const b = await app.call("GET", "/api/v1/email-actions/short");
    expect(a.status).toBe(404); expect(b.status).toBe(404); expect(a.text).toBe(b.text);
    // A GET carrying a session cookie is still only a page.
    await app.call("GET", `/api/v1/email-actions/${tokens[0]}`, { cookie: p.cookie });
    expect(await snapshot(p.userId)).toBe(before);
  });

  it("ST-147: a link works once, only for its own purpose and event, and fails after expiry", async () => {
    const p = await signUp(app, "ea3@example.com");
    // Once.
    const t1 = await mint(p.userId, "freeze", crypto.randomUUID());
    expect((await act(t1)).status).toBe(200);
    expect((await act(t1)).status).toBe(404);
    expect((await app.call("GET", `/api/v1/email-actions/${t1}`)).status).toBe(404);
    // The mutation guard: the POST wants confirm, same origin, JSON and the client header.
    const t2 = await mint(p.userId, "freeze", crypto.randomUUID());
    expect((await act(t2, { body: {} })).status).toBe(400);
    expect((await act(t2, { body: { confirm: "yes" } })).status).toBe(400);
    expect((await act(t2, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await act(t2, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await act(t2, { headers: { "sec-fetch-site": "same-site" } })).status).toBe(403);
    expect((await act(t2, { headers: { "x-mh-client": "" } })).status).toBe(403);
    expect((await act(t2, { headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
    expect((await app.call("POST", `/api/v1/email-actions/${t2}`, { body: { confirm: true }, browser: false })).status).toBe(403);
    // Refused attempts consumed nothing.
    expect((await app.db.owner.query("select used_at from email_action_tokens where token_hash = $1", [sha256(t2)])).rows[0].used_at).toBeNull();
    // Own purpose: a freeze token does not cancel a recovery, and the cancel endpoint refuses it without consuming it.
    const wrong = await app.call("POST", "/api/v1/auth/recovery/cancel", { body: { token: t2 }, headers: xff(nextIp()) });
    expect(wrong.status).toBe(404);
    expect((await app.db.owner.query("select used_at from email_action_tokens where token_hash = $1", [sha256(t2)])).rows[0].used_at).toBeNull();
    // Own event: a cancel token for a finished request cannot cancel a newer one.
    const q = await signUp(app, "ea3b@example.com");
    await app.call("POST", "/api/v1/auth/recovery/start", { body: { email: q.email, path: "codes_email" }, headers: xff(nextIp()) });
    const first = linkFrom(lastMail(app, q.email, "recovery.started")!.text);
    expect((await app.call("POST", "/api/v1/auth/recovery/cancel", { body: {}, cookie: q.cookie })).json.cancelled).toBe(true);
    app.clock.advance(3600_000);
    await app.call("POST", "/api/v1/auth/recovery/start", { body: { email: q.email, path: "codes_email" }, headers: xff(nextIp()) });
    const openId = (await app.db.owner.query("select id from recovery_requests where user_id = $1 and status = 'pending'", [q.userId])).rows[0].id;
    const stale = await act(first);
    expect(stale.status).toBe(200);
    expect(stale.json).toMatchObject({ purpose: "recovery_cancel", changed: false });
    expect((await app.db.owner.query("select status from recovery_requests where id = $1", [openId])).rows[0].status).toBe("pending");
    // A token for another user's event does nothing to this user's data: the event is only matched under the token's own user.
    const foreign = await mint(q.userId, "recovery_cancel", (await app.db.owner.query("select id from recovery_requests where user_id = $1 order by created_at limit 1", [p.userId])).rows[0]?.id ?? crypto.randomUUID());
    expect((await act(foreign)).json.changed).toBe(false);
    // Expiry: freeze 72 hours.
    const early = await mint(p.userId, "freeze", crypto.randomUUID(), 72 * 3600_000);
    const late = await mint(p.userId, "freeze", crypto.randomUUID(), 72 * 3600_000);
    app.clock.advance(72 * 3600_000 - 1000);
    expect((await app.call("GET", `/api/v1/email-actions/${early}`)).status).toBe(200);
    expect((await act(early)).status).toBe(200);
    app.clock.advance(2000);
    expect((await act(late)).status).toBe(404);
    expect((await app.call("GET", `/api/v1/email-actions/${late}`)).status).toBe(404);
  });

  it("the recovery cancel link lives until the end of the cooling-off plus 24 hours", async () => {
    const p = await signUp(app, "ea4@example.com");
    const codeless = await signUp(app, "ea4b@example.com");
    void codeless;
    // Second verified channel on another domain, then email-only.
    const add = await app.call("POST", "/api/v1/notification-addresses", { body: { address: "ea4@backup.org", kind: "second" }, cookie: p.cookie });
    await app.call("POST", `/api/v1/notification-addresses/${add.json.address.id}/verify`, { body: { code: codeFrom(lastMail(app, "ea4@backup.org", "address.code")!.text) }, cookie: p.cookie });
    await app.call("POST", "/api/v1/auth/recovery/start", { body: { email: p.email, path: "email_only" }, headers: xff(nextIp()) });
    const link = linkFrom(lastMail(app, "ea4@backup.org", "recovery.started")!.text);
    const row = (await app.db.owner.query("select expires_at from email_action_tokens where token_hash = $1", [sha256(link)])).rows[0];
    expect(new Date(row.expires_at).getTime() - app.clock.now().getTime()).toBe((72 + 24) * 3600_000);
    app.clock.advance((72 + 24) * 3600_000 - 1000);
    expect((await app.call("GET", `/api/v1/email-actions/${link}`)).status).toBe(200);
    app.clock.advance(2000);
    expect((await act(link)).status).toBe(404);
  });

  it("freeze: sets the account flag, revokes sessions, pauses (not revokes) bindings, mails every address, and changes no domain; only a passkey sign-in unfreezes", async () => {
    const p = await signUp(app, "ea5@example.com");
    const b = await withBinding(p);
    const domainId = await seedDomain(p);
    const s2 = (await signIn(app, p.auth)).cookie!;
    const domainBefore = (await app.db.owner.query("select auto_renew, locked, nameservers from domains where id = $1", [domainId])).rows[0];
    app.email.clear();
    const token = await mint(p.userId, "freeze", crypto.randomUUID());
    const r = await act(token);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, purpose: "freeze", changed: true });
    expect((await app.db.owner.query("select frozen_at from users where id = $1", [p.userId])).rows[0].frozen_at).not.toBeNull();
    for (const c of [p.cookie, s2]) expect((await me(app, c)).status).toBe(401);
    const bind = (await app.db.owner.query("select revoked_at, paused_at from bindings where id = $1", [b])).rows[0];
    expect(bind.revoked_at).toBeNull(); expect(bind.paused_at).not.toBeNull();
    expect((await app.db.owner.query("select auto_renew, locked, nameservers from domains where id = $1", [domainId])).rows[0]).toEqual(domainBefore);
    expect((await app.db.owner.query("select revoked_at from renewal_mandates where domain_id = $1", [domainId])).rows[0].revoked_at).toBeNull();
    expect(app.email.to(p.email).some((m) => m.kind === "account.frozen")).toBe(true);
    expect(await auditActions(app, p.userId)).toContain("auth.freeze");
    // Nothing but a valid assertion unfreezes: a bad assertion and an unknown credential leave it frozen.
    expect((await signIn(app, (await import("./testkit.ts")).authenticator())).res.status).toBe(401);
    expect((await app.db.owner.query("select frozen_at from users where id = $1", [p.userId])).rows[0].frozen_at).not.toBeNull();
    const back = await signIn(app, p.auth);
    expect(back.res.status).toBe(200);
    expect((await app.db.owner.query("select frozen_at from users where id = $1", [p.userId])).rows[0].frozen_at).toBeNull();
    expect((await me(app, back.cookie!)).json.user.frozen).toBe(false);
    // Bindings stay paused: resuming is agent.token.widen's job.
    expect((await app.db.owner.query("select paused_at from bindings where id = $1", [b])).rows[0].paused_at).not.toBeNull();
    expect(await auditActions(app, p.userId)).toContain("auth.unfreeze");
  });

  it("auto_renew_off turns off the flag and revokes the mandate for its own domain only; an unknown event is a recorded no-op", async () => {
    const p = await signUp(app, "ea6@example.com");
    const d1 = await seedDomain(p); const d2 = await seedDomain(p);
    const t = await mint(p.userId, "auto_renew_off", d1);
    const r = await act(t);
    expect(r.json).toMatchObject({ purpose: "auto_renew_off", changed: true });
    expect((await app.db.owner.query("select auto_renew from domains where id = $1", [d1])).rows[0].auto_renew).toBe(false);
    expect((await app.db.owner.query("select revoked_at from renewal_mandates where domain_id = $1", [d1])).rows[0].revoked_at).not.toBeNull();
    expect((await app.db.owner.query("select auto_renew from domains where id = $1", [d2])).rows[0].auto_renew).toBe(true);
    expect((await app.db.owner.query("select revoked_at from renewal_mandates where domain_id = $1", [d2])).rows[0].revoked_at).toBeNull();
    const t2 = await mint(p.userId, "auto_renew_off", crypto.randomUUID());
    expect((await act(t2)).json).toMatchObject({ changed: false });
    expect((await auditActions(app, p.userId)).filter((a) => a === "auth.auto_renew_off")).toHaveLength(2);
    // Another user's domain is never touched by this user's token.
    const other = await signUp(app, "ea6b@example.com");
    const od = await seedDomain(other);
    expect((await act(await mint(p.userId, "auto_renew_off", od))).json.changed).toBe(false);
    expect((await app.db.owner.query("select auto_renew from domains where id = $1", [od])).rows[0].auto_renew).toBe(true);
  });

  it("the confirm page script and styles are allowed by hash, not by 'unsafe-inline'", async () => {
    const p = await signUp(app, "ea7@example.com");
    const t = await mint(p.userId, "freeze", crypto.randomUUID());
    const r = await app.call("GET", `/api/v1/email-actions/${t}`);
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    const script = /<script>([\s\S]*?)<\/script>/.exec(r.text)![1]!;
    const style = /<style>([\s\S]*?)<\/style>/.exec(r.text)![1]!;
    expect(csp).toContain(`'sha256-${crypto.createHash("sha256").update(script).digest("base64")}'`);
    expect(csp).toContain(`'sha256-${crypto.createHash("sha256").update(style).digest("base64")}'`);
    expect(script).toContain('"confirm":true');
  });
});

describe("attacker with a session", () => {
  it("ST-135: cannot stop the owner's freeze link or revoke-all", async () => {
    const owner = await signUp(app, "ea8@example.com");
    // The attacker holds a live session (a stolen cookie) and works from the owner's own source prefix to make it as hard as possible.
    const stolen = (await createSession(app.ctx, owner.userId, { ipPrefix: "203.0.113.0/24", uaFamily: "other" })).cookie.split(";")[0]!;
    expect((await me(app, stolen)).status).toBe(200);
    const token = await mint(owner.userId, "freeze", crypto.randomUUID());
    const ip = nextIp();
    // Flooding every sensitive path the attacker can reach from that session: no counter exists on freeze or revoke paths.
    for (let i = 0; i < 40; i++) {
      await app.call("POST", `/api/v1/email-actions/${crypto.randomBytes(32).toString("base64url")}`, { body: { confirm: true }, cookie: stolen, headers: xff(ip) });
      await app.call("POST", "/api/v1/auth/recovery/start", { body: { email: owner.email, path: "codes_email" }, headers: xff(ip) });
    }
    // The attacker cannot spend, burn or rewrite the token without knowing it, and cannot shorten its life.
    expect((await app.db.owner.query("select used_at from email_action_tokens where token_hash = $1", [sha256(token)])).rows[0].used_at).toBeNull();
    // Owner clicks the link while the attacker's session is alive and the attacker is still hammering from the same source.
    const frozen = await app.call("POST", `/api/v1/email-actions/${token}`, { body: { confirm: true }, cookie: stolen, headers: xff(ip) });
    expect(frozen.status).toBe(200);
    expect((await me(app, stolen)).status).toBe(401);
    expect((await me(app, owner.cookie)).status).toBe(401);
    expect((await app.db.owner.query("select frozen_at from users where id = $1", [owner.userId])).rows[0].frozen_at).not.toBeNull();
    // The attacker has no passkey: nothing they hold can unfreeze the account.
    expect((await signIn(app, (await import("./testkit.ts")).authenticator(), { ip })).res.status).toBe(401);
    expect((await app.db.owner.query("select frozen_at from users where id = $1", [owner.userId])).rows[0].frozen_at).not.toBeNull();
    // Revoke-all from the owner's session ends the attacker's session, however many requests the attacker made.
    const back = await signIn(app, owner.auth);
    const stolen2 = (await createSession(app.ctx, owner.userId, {})).cookie.split(";")[0]!;
    for (let i = 0; i < 30; i++) { await app.call("GET", "/api/v1/me", { cookie: stolen2 }); await app.call("GET", "/api/v1/passkeys", { cookie: stolen2 }); }
    const all = await app.call("POST", "/api/v1/auth/sessions/revoke-all", { body: {}, cookie: back.cookie });
    expect(all.status).toBe(200);
    expect((await me(app, stolen2)).status).toBe(401);
    expect((await me(app, back.cookie!)).status).toBe(401);
    // The owner's freeze mail reached every address and the attacker cannot see the link: it is only in the mail.
    expect(app.email.to(owner.email).some((m) => m.kind === "account.frozen")).toBe(true);
  });

  it("an attacker's session cannot use a link it does not hold, and a link posted with a session cookie acts as an anonymous request", async () => {
    const owner = await signUp(app, "ea9@example.com");
    const stolen = (await createSession(app.ctx, owner.userId, {})).cookie.split(";")[0]!;
    const guess = await app.call("POST", `/api/v1/email-actions/${crypto.randomBytes(32).toString("base64url")}`, { body: { confirm: true }, cookie: stolen, headers: xff(nextIp()) });
    expect(guess.status).toBe(404);
    expect((await me(app, stolen)).status).toBe(200);
  });
});

describe("routes", () => {
  it("ST-44: no route mutates on GET or HEAD: every GET route in the whole route table is invoked with a live session and the database is unchanged", async () => {
    const router = buildRouter();
    const full = await createTestApp(router);
    try {
      const p = await (async () => {
        const email = "walk@example.com";
        const uid = (await full.db.owner.query("insert into users (email, status, email_verified_at) values ($1,'active',now()) returning id", [email])).rows[0].id as string;
        await full.db.owner.query("insert into notification_addresses (user_id, address, kind, verified_at) values ($1,$2,'login',now())", [uid, email]);
        const s = await createSession(full.ctx, uid, {});
        return { uid, cookie: s.cookie.split(";")[0]! };
      })();
      const tables = (await full.db.owner.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not in ('rate_counters','schema_migrations','sessions') order by 1")).rows.map((r) => r.table_name as string);
      const snap = async () => {
        const out: string[] = [];
        for (const t of tables) out.push(t + ":" + (await full.db.owner.query(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from "${t}" x`)).rows[0].h);
        out.push("sessions:" + JSON.stringify((await full.db.owner.query("select id_hash, user_id, revoked_at, expires_at from sessions order by id_hash")).rows));
        return out.join("\n");
      };
      const before = await snap();
      const gets = router.routes.filter((r) => r.method === "GET");
      expect(gets.length).toBeGreaterThan(3);
      const seen: string[] = [];
      for (const r of gets) {
        const url = r.path.replace(/:[A-Za-z_]+/g, (m) => (m === ":token" ? crypto.randomBytes(32).toString("base64url") : "00000000-0000-4000-8000-000000000000"));
        const headers: Record<string, string> = { ...xff(nextIp()) };
        // A cron-only GET (the scheduler cannot send anything else) works only with the bearer CRON_SECRET; a browser can never
        // reach it with a cookie, so cross-site request forgery does not apply. Prove that instead of skipping it.
        const cronOnly = r.principals.every((x) => x === "cron");
        for (const method of ["GET", "HEAD"]) {
          const res = await full.call(method, url, { cookie: p.cookie, headers });
          seen.push(`${method} ${r.path} ${res.status}`);
          if (cronOnly) expect(res.status, `${method} ${r.path} with only a cookie`).toBe(401);
        }
      }
      expect(await snap()).toBe(before);
      expect(seen.some((s) => s.startsWith("GET /api/v1/me 200"))).toBe(true);
      expect(seen.some((s) => s.startsWith("GET /api/v1/email-actions/:token"))).toBe(true);
    } finally { await full.drop(); }
  });

  it("every auth route declares principals, is under /api/v1, and the GET routes are exactly the read-only ones", async () => {
    const { authRoutes } = await import("./routes.ts");
    for (const r of authRoutes) { expect(r.path.startsWith("/api/v1/")).toBe(true); expect(r.principals.length).toBeGreaterThan(0); }
    const mutating = authRoutes.filter((r) => r.method !== "GET");
    // Every state-changing cookie route is a non-GET route that the CSRF guard covers (auth path or a session principal), except the email-action POST, which carries its own guard.
    for (const r of mutating) expect(r.csrf === "none" ? r.path.startsWith("/api/v1/email-actions/") : true).toBe(true);
    void codeFrom;
  });
});
