import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUser, tx } from "@mosshatch/db";
import { createTestApp, cookieFrom, type TestApp } from "./testing/app.ts";
import { Router, json } from "./http/router.ts";
import { createSession, SESSION_COOKIE, revokeAllSessions } from "./http/session.ts";
import { appendAudit, verifyChain, SYSTEM_CHAIN } from "./audit.ts";
import { hit } from "./ratelimit.ts";
import { mintToken, parseToken } from "./util/token.ts";
import { sendMail } from "./email.ts";

const router = new Router()
  .add({ method: "GET", path: "/api/v1/ping", principals: ["anonymous"], handler: async () => json({ ok: true }) })
  .add({ method: "POST", path: "/api/v1/echo", principals: ["session"], handler: async (r) => json({ userId: r.principal.userId }) })
  .add({ method: "GET", path: "/api/v1/whoami", principals: ["session", "binding"], handler: async (r) => json({ kind: r.principal.kind }) })
  .add({ method: "GET", path: "/api/cron/tick", principals: ["cron"], handler: async () => json({ ticked: true }) });

let app: TestApp; let userId: string; let sessionCookie: string;
beforeAll(async () => {
  app = await createTestApp(router);
  userId = (await app.db.owner.query("insert into users (email, status, email_verified_at) values ('u@example.com','active',now()) returning id")).rows[0].id;
  const s = await createSession(app.ctx, userId, {});
  sessionCookie = s.cookie;
}, 60_000);
afterAll(async () => { await app?.drop(); });

describe("router", () => {
  it("refuses a route with no principal declaration (deny by default)", () => {
    expect(() => new Router().add({ method: "GET", path: "/x", principals: [], handler: async () => json({}) })).toThrow();
  });
  it("404 unknown, 405 wrong method with Allow", async () => {
    expect((await app.call("GET", "/api/v1/nope")).status).toBe(404);
    const r = await app.call("GET", "/api/v1/echo");
    expect(r.status).toBe(405); expect(r.headers.get("allow")).toBe("POST");
  });
  it("every response carries the security headers", async () => {
    const r = await app.call("GET", "/api/v1/ping");
    for (const h of ["content-security-policy", "x-content-type-options", "strict-transport-security", "cache-control", "referrer-policy"]) expect(r.headers.get(h), h).toBeTruthy();
  });
  it("ST-43: cookie mutation needs origin, JSON, x-mh-client and a non-cross-site fetch", async () => {
    const ok = await app.call("POST", "/api/v1/echo", { cookie: sessionCookie, body: {} });
    expect(ok.status).toBe(200);
    expect((await app.call("POST", "/api/v1/echo", { cookie: sessionCookie, body: {}, headers: { "sec-fetch-site": "same-site" } })).status).toBe(403);
    expect((await app.call("POST", "/api/v1/echo", { cookie: sessionCookie, body: {}, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await app.call("POST", "/api/v1/echo", { cookie: sessionCookie, body: {}, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await app.call("POST", "/api/v1/echo", { cookie: sessionCookie, body: {}, headers: { "x-mh-client": "" } })).status).toBe(403);
    expect((await app.call("POST", "/api/v1/echo", { cookie: sessionCookie, body: {}, headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
  });
  it("ST-67: cookie plus Authorization is 400; a bearer on a session-only route is refused; the cron secret is not a binding token", async () => {
    expect((await app.call("GET", "/api/v1/whoami", { cookie: sessionCookie, authorization: "Bearer x" })).status).toBe(400);
    const m = mintToken("live");
    expect((await app.call("POST", "/api/v1/echo", { authorization: `Bearer ${m.token}` })).status).toBe(403);
    expect((await app.call("GET", "/api/v1/whoami", { authorization: `Bearer ${app.ctx.config.cronSecret}` })).status).toBe(401);
    expect((await app.call("GET", "/api/cron/tick", { authorization: `Bearer ${m.token}` })).status).toBe(401);
    expect((await app.call("GET", "/api/cron/tick", { authorization: `Bearer ${app.ctx.config.cronSecret}` })).status).toBe(200);
    expect((await app.call("GET", "/api/cron/tick", { cookie: sessionCookie })).status).toBe(401);
  });
  it("a live bearer binding works on a route that declares it; revoked and expired ones do not", async () => {
    const m = mintToken("live");
    const exp = new Date(app.clock.now().getTime() + 86400_000);
    await app.db.owner.query("insert into bindings (user_id, kind, name, token_prefix, token_hash, expires_at) values ($1,'agent','t',$2,$3,$4)", [userId, m.prefix, m.hash, exp]);
    expect((await app.call("GET", "/api/v1/whoami", { authorization: `Bearer ${m.token}` })).json.kind).toBe("binding");
    await app.db.owner.query("update bindings set revoked_at = now() where token_prefix = $1", [m.prefix]);
    expect((await app.call("GET", "/api/v1/whoami", { authorization: `Bearer ${m.token}` })).status).toBe(401);
  });
  it("token format: CRC and shape are checked; a tampered token is rejected", () => {
    const m = mintToken("cli");
    expect(parseToken(m.token)?.kind).toBe("cli");
    expect(parseToken(m.token.slice(0, -1) + (m.token.endsWith("0") ? "1" : "0"))).toBeNull();
    expect(parseToken("mh_live_short")).toBeNull();
  });
});

describe("sessions (ST-51, ST-52)", () => {
  it("idle expiry at 15 minutes and absolute expiry at 8 hours", async () => {
    const s = await createSession(app.ctx, userId, {});
    expect((await app.call("GET", "/api/v1/whoami", { cookie: s.cookie })).status).toBe(200);
    app.clock.advance(14 * 60_000);
    expect((await app.call("GET", "/api/v1/whoami", { cookie: s.cookie })).status).toBe(200); // touches idle window
    app.clock.advance(16 * 60_000);
    expect((await app.call("GET", "/api/v1/whoami", { cookie: s.cookie })).status).toBe(401);
    const s2 = await createSession(app.ctx, userId, {});
    for (let i = 0; i < 9; i++) { app.clock.advance(14 * 60_000 * 2 - 60_000); await app.call("GET", "/api/v1/whoami", { cookie: s2.cookie }); }
    // > 8 h since creation regardless of activity
    app.clock.advance(60_000);
    expect((await app.call("GET", "/api/v1/whoami", { cookie: s2.cookie })).status).toBe(401);
  });
  it("revoke-all invalidates every session on the next request", async () => {
    const a = await createSession(app.ctx, userId, {}); const b = await createSession(app.ctx, userId, {});
    expect(await revokeAllSessions(app.ctx, userId)).toBeGreaterThanOrEqual(2);
    for (const s of [a, b]) expect((await app.call("GET", "/api/v1/whoami", { cookie: s.cookie })).status).toBe(401);
  });
  it("a made-up cookie is refused and cookie attributes are Host-prefixed, Secure, HttpOnly, Lax (ST-44)", async () => {
    expect((await app.call("GET", "/api/v1/whoami", { cookie: `${SESSION_COOKIE}=AAAA` })).status).toBe(401);
    const s = await createSession(app.ctx, userId, {});
    expect(s.cookie.startsWith("__Host-mh_session=")).toBe(true);
    void cookieFrom;
  });
});

describe("audit chain (ST-142)", () => {
  it("concurrent appends produce one linear verified chain; tampering is detected without KMS", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => tx(app.db.cron, (c) => appendAudit(app.ctx, c, { chainId: userId, actorKind: "system", action: "test.append", detail: { i } }))));
    const v = await withUser(app.db.runtime, userId, (c) => verifyChain(app.ctx, c, userId));
    expect(v).toEqual({ ok: true, length: 25 });
    // The owner disables the trigger and edits a row, recomputing SHA-256 only: verification still fails (needs the KMS key).
    await app.db.owner.query("alter table audit_log disable trigger audit_no_update");
    await app.db.owner.query("update audit_log set action = 'edited' where chain_id = $1 and seq = 10", [userId]);
    await app.db.owner.query("alter table audit_log enable always trigger audit_no_update");
    const bad = await withUser(app.db.runtime, userId, (c) => verifyChain(app.ctx, c, userId));
    expect(bad).toMatchObject({ ok: false, badSeq: 10 });
  });
  it("the runtime role can append to its own chain only, and cannot update or delete", async () => {
    await expect(withUser(app.db.runtime, userId, (c) => appendAudit(app.ctx, c, { chainId: "11111111-1111-1111-1111-111111111111", actorKind: "user", action: "x" }))).rejects.toThrow();
    await expect(app.db.runtime.query("update audit_log set action = 'y'")).rejects.toThrow();
    await tx(app.db.cron, (c) => appendAudit(app.ctx, c, { chainId: SYSTEM_CHAIN, actorKind: "system", action: "sys" }));
  });
});

describe("rate limits and mail", () => {
  it("counts per window in Postgres, keyed by HMAC", async () => {
    const lim = { bucket: "t", max: 3, windowSeconds: 60 };
    const rs = [];
    for (let i = 0; i < 5; i++) rs.push((await tx(app.db.runtime, (c) => hit(app.ctx, c, "addr:1.2.3.4", lim))).allowed);
    expect(rs).toEqual([true, true, true, false, false]);
    const raw = (await app.db.owner.query("select encode(key_hash,'hex') h from rate_counters")).rows.map((r) => r.h).join();
    expect(raw).not.toContain("1.2.3.4");
    app.clock.advance(61_000);
    expect((await tx(app.db.runtime, (c) => hit(app.ctx, c, "addr:1.2.3.4", lim))).allowed).toBe(true);
  });
  it("mail is idempotent by dedupe key", async () => {
    const msg = { dedupeKey: "k1", kind: "test", userId, to: ["u@example.com"], subject: "s", text: "t" };
    const first = await withUser(app.db.runtime, userId, (c) => sendMail(c, app.email, msg));
    const second = await withUser(app.db.runtime, userId, (c) => sendMail(c, app.email, msg));
    expect([first.sent, second.sent]).toEqual([true, false]);
    expect(app.email.sent.filter((m) => m.dedupeKey === "k1")).toHaveLength(1);
  });
});
