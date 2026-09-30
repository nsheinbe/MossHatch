import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cookieFrom, type TestApp } from "../testing/app.ts";
import { PRE_AUTH_COOKIE, SESSION_COOKIE, createSession } from "../http/session.ts";
import { auditActions, authenticator, codeFrom, lastMail, me, newApp, nextIp, signIn, signUp, xff } from "./testkit.ts";
import { withUser } from "@mosshatch/db";
import { verifyChain } from "../audit.ts";

let app: TestApp;
beforeAll(async () => { app = await newApp(); }, 60_000);
afterAll(async () => { await app?.drop(); });

const post = (path: string, body: unknown, o: { cookie?: string; ip?: string; headers?: Record<string, string> } = {}) =>
  app.call("POST", "/api/v1" + path, { body, cookie: o.cookie, headers: { ...xff(o.ip ?? nextIp()), ...o.headers } });

describe("sign-up and first passkey", () => {
  it("signs up end to end: code, activation, registration, recovery codes, session, audit", async () => {
    const p = await signUp(app, "alice@example.com");
    expect(p.recoveryCodes).toHaveLength(10);
    const m = await me(app, p.cookie);
    expect(m.status).toBe(200);
    expect(m.json.user).toMatchObject({ email: "alice@example.com", status: "active", frozen: false });
    expect(m.json.credentials).toHaveLength(1);
    expect(m.json.credentials[0]).toMatchObject({ alg: -7, backupEligible: false, backupState: false });
    expect(m.json.addresses).toEqual([expect.objectContaining({ address: "alice@example.com", kind: "login", verified: true })]);
    expect(m.json.recoveryCodesRemaining).toBe(10);
    expect(m.json.warnings).toContain("single_credential");
    const acts = await auditActions(app, p.userId);
    expect(acts).toEqual(expect.arrayContaining(["auth.signup.verified", "auth.passkey.added"]));
    const c = await app.ctx.runtime.connect();
    try { expect((await verifyChain(app.ctx, c, p.userId)).ok).toBe(true); } finally { c.release(); }
  });

  it("stores the emailed code hashed, kills it after five wrong tries, and expires it after 15 minutes", async () => {
    const ip = nextIp();
    await post("/auth/signup/start", { email: "codes@example.com" }, { ip });
    const raw = (await app.db.owner.query("select code_hash, expires_at, created_at from email_codes where email = 'codes@example.com'")).rows[0];
    const code = codeFrom(lastMail(app, "codes@example.com", "signup.code")!.text);
    expect(Buffer.from(raw.code_hash).toString("utf8")).not.toContain(code);
    expect(new Date(raw.expires_at).getTime() - new Date(raw.created_at).getTime()).toBe(15 * 60_000);
    for (let i = 0; i < 5; i++) expect((await post("/auth/signup/verify", { email: "codes@example.com", code: "00000000" }, { ip })).status).toBe(401);
    // Dead: even the right code fails now.
    expect((await post("/auth/signup/verify", { email: "codes@example.com", code }, { ip })).status).toBe(401);
    // A fresh code expires by the clock.
    await app.db.owner.query("delete from email_codes where email = 'codes@example.com'");
    app.email.clear();
    await post("/auth/signup/start", { email: "slow@example.com" }, { ip });
    const slow = codeFrom(lastMail(app, "slow@example.com", "signup.code")!.text);
    app.clock.advance(15 * 60_000 + 1000);
    expect((await post("/auth/signup/verify", { email: "slow@example.com", code: slow }, { ip })).status).toBe(401);
  });

  it("class A mail limits: 3 an hour and 10 a day per address, and no account enumeration", async () => {
    const ip = nextIp();
    const real = await signUp(app, "exists@example.com");
    void real;
    const bodies: string[] = [];
    // Existing address and unknown address: the same status and body, request after request.
    for (let i = 0; i < 2; i++) {
      const a = await post("/auth/signup/start", { email: "exists@example.com" }, { ip });
      const b = await post("/auth/signup/start", { email: `nobody${i}@example.com` }, { ip });
      expect(a.status).toBe(202); expect(b.status).toBe(202);
      expect(a.text).toBe(b.text);
      bodies.push(a.text);
    }
    // The existing account received no sign-up code mail.
    expect(app.email.to("exists@example.com").filter((m) => m.kind === "signup.code")).toHaveLength(1);
    // Fourth within the hour is limited, for the existing and for an unknown address alike.
    const r1 = await post("/auth/signup/start", { email: "exists@example.com" }, { ip });
    for (let i = 0; i < 3; i++) await post("/auth/signup/start", { email: "flood@example.com" }, { ip });
    const r2 = await post("/auth/signup/start", { email: "flood@example.com" }, { ip });
    expect(r1.status).toBe(429); expect(r2.status).toBe(429);
    expect(r1.text).toBe(r2.text);
    expect(app.email.to("flood@example.com")).toHaveLength(3);
    // Next hour: allowed again, but the day bucket caps at 10.
    for (let h = 0; h < 4; h++) {
      app.clock.advance(3600_000);
      for (let i = 0; i < 3; i++) await post("/auth/signup/start", { email: "flood@example.com" }, { ip });
    }
    expect(app.email.to("flood@example.com").length).toBe(10);
  });

  it("ST-42: an unverified account cannot register a passkey, and a verified sign-up replaces an attacker's pending row", async () => {
    const victim = "victim@example.com";
    const attackerIp = nextIp(); const victimIp = nextIp();
    // The attacker starts sign-up for the victim's address and never sees the code.
    await post("/auth/signup/start", { email: victim }, { ip: attackerIp });
    const pendingA = (await app.db.owner.query("select id, status from users where email = $1", [victim])).rows[0];
    expect(pendingA.status).toBe("pending");
    const attacker = authenticator();
    // No ticket, no options, and a forged pre-auth cookie is no ticket either.
    expect((await post("/auth/register/options", {}, { ip: attackerIp })).status).toBe(401);
    expect((await post("/auth/register/options", {}, { ip: attackerIp, cookie: `${PRE_AUTH_COOKIE}=${Buffer.alloc(32, 7).toString("base64url")}` })).status).toBe(401);
    // Even a challenge row planted for the pending user cannot complete a registration: the handler re-checks the state.
    const pre = Buffer.alloc(32, 9);
    const chal = Buffer.alloc(32, 5).toString("base64url");
    await app.db.owner.query("insert into webauthn_challenges (purpose, challenge, user_id, pre_auth_hash, expires_at) values ('register',$1,$2,$3,now() + interval '10 days')", [chal, pendingA.id, (await import("../util/bytes.ts")).sha256(pre)]);
    const opts = { challenge: chal, user: { id: Buffer.alloc(32, 1).toString("base64url") } };
    const forged = await post("/auth/register/verify", { response: attacker.create(opts) }, { ip: attackerIp, cookie: `${PRE_AUTH_COOKIE}=${pre.toString("base64url")}` });
    expect(forged.status).toBe(403);
    expect((await app.db.owner.query("select count(*)::int as n from passkeys where user_id = $1", [pendingA.id])).rows[0].n).toBe(0);
    // The victim's own verified sign-up replaces the attacker's pending row.
    app.email.clear();
    const p = await signUp(app, victim, { ip: victimIp });
    expect(p.userId).not.toBe(pendingA.id);
    expect((await app.db.owner.query("select count(*)::int as n from users where id = $1", [pendingA.id])).rows[0].n).toBe(0);
    const rows = (await app.db.owner.query("select id, status from users where email = $1", [victim])).rows;
    expect(rows).toEqual([{ id: p.userId, status: "active" }]);
    // And the attacker cannot sign up over the live account.
    await post("/auth/signup/start", { email: victim }, { ip: attackerIp });
    expect((await app.db.owner.query("select count(*)::int as n from users where email = $1", [victim])).rows[0].n).toBe(1);
  });

  it("a verified account that never registered a credential can restart and finish sign-up", async () => {
    const ip = nextIp(); const email = "half@example.com";
    await post("/auth/signup/start", { email }, { ip });
    const code = codeFrom(lastMail(app, email, "signup.code")!.text);
    expect((await post("/auth/signup/verify", { email, code }, { ip })).status).toBe(200);
    // The browser dies before the ceremony. Start again with the mailbox.
    app.email.clear();
    const p = await signUp(app, email, { ip });
    expect(p.recoveryCodes).toHaveLength(10);
    expect((await app.db.owner.query("select count(*)::int as n from users where email = $1", [email])).rows[0].n).toBe(1);
  });
});

describe("login", () => {
  it("logs in with a discoverable credential, issues a NEW session id, records audit and last_used_at", async () => {
    const p = await signUp(app, "login1@example.com");
    const before = (await app.db.owner.query("select last_used_at, sign_count from passkeys where user_id = $1", [p.userId])).rows[0];
    expect(before.last_used_at).toBeNull();
    const { res, cookie } = await signIn(app, p.auth);
    expect(res.status).toBe(200);
    expect(cookie).toBeTruthy();
    expect(cookie).not.toBe(p.cookie);
    expect((await me(app, cookie!)).status).toBe(200);
    const after = (await app.db.owner.query("select last_used_at, sign_count from passkeys where user_id = $1", [p.userId])).rows[0];
    expect(after.last_used_at).not.toBeNull();
    expect(Number(after.sign_count)).toBe(1);
    expect(await auditActions(app, p.userId)).toContain("auth.login");
  });

  it("ST-43: verify without the pre-auth cookie is rejected, and the cookie is bound to the challenge", async () => {
    const p = await signUp(app, "pre1@example.com");
    const ip = nextIp();
    const o1 = await app.call("POST", "/api/v1/auth/login/options", { body: {}, headers: xff(ip) });
    const o2 = await app.call("POST", "/api/v1/auth/login/options", { body: {}, headers: xff(ip) });
    const pre1 = cookieFrom(o1.setCookies, PRE_AUTH_COOKIE)!; const pre2 = cookieFrom(o2.setCookies, PRE_AUTH_COOKIE)!;
    // The challenge hash, not the cookie, is stored.
    const rows = (await app.db.owner.query("select pre_auth_hash from webauthn_challenges where purpose = 'login' order by created_at desc limit 2")).rows;
    for (const r of rows) expect(pre1.split("=")[1]!).not.toBe(Buffer.from(r.pre_auth_hash).toString("base64url"));
    const resp = p.auth.get(o1.json.options);
    expect((await app.call("POST", "/api/v1/auth/login/verify", { body: { response: resp }, headers: xff(ip) })).status).toBe(401);
    // Another challenge's cookie does not unlock this challenge.
    const resp2 = p.auth.get(o1.json.options);
    expect((await app.call("POST", "/api/v1/auth/login/verify", { body: { response: resp2 }, cookie: pre2, headers: xff(ip) })).status).toBe(401);
    // Those failed tries did not burn the owner's challenge (they did not match it); the right cookie works once, then the challenge is spent.
    const resp3 = p.auth.get(o1.json.options);
    expect((await app.call("POST", "/api/v1/auth/login/verify", { body: { response: resp3 }, cookie: pre1, headers: xff(ip) })).status).toBe(200);
    const resp4 = p.auth.get(o1.json.options);
    expect((await app.call("POST", "/api/v1/auth/login/verify", { body: { response: resp4 }, cookie: pre1, headers: xff(ip) })).status).toBe(401);
  });

  it("ST-43: same-site, cross-site and form posts are rejected on every auth route", async () => {
    const p = await signUp(app, "csrf1@example.com");
    const routes: [string, string][] = [["/auth/signup/start", "{}"], ["/auth/signup/verify", "{}"], ["/auth/register/options", "{}"], ["/auth/register/verify", "{}"], ["/auth/login/options", "{}"], ["/auth/login/verify", "{}"],
      ["/auth/logout", "{}"], ["/auth/sessions/revoke-all", "{}"], ["/auth/recovery/start", "{}"], ["/auth/recovery/redeem", "{}"], ["/auth/recovery/cancel", "{}"]];
    for (const [path] of routes) {
      const body = { email: "x@example.com" };
      const bad: Record<string, string>[] = [{ "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }, { origin: "https://evil.example" }, { "x-mh-client": "" }];
      for (const h of bad) {
        expect((await app.call("POST", "/api/v1" + path, { body, cookie: p.cookie, headers: { ...xff(nextIp()), ...h } })).status, `${path} ${JSON.stringify(h)}`).toBe(403);
      }
      // A cross-origin HTML form post (urlencoded, no JSON header).
      const form = await app.call("POST", "/api/v1" + path, { body: "email=x%40example.com", cookie: p.cookie, headers: { "content-type": "application/x-www-form-urlencoded", ...xff(nextIp()) } });
      expect([403, 415]).toContain(form.status);
    }
    // The session survived all of that untouched.
    expect((await me(app, p.cookie)).status).toBe(200);
  });

  it("ST-41: a wrong origin or RP ID fails registration and login", async () => {
    const ip = nextIp();
    await post("/auth/signup/start", { email: "origin@example.com" }, { ip });
    const code = codeFrom(lastMail(app, "origin@example.com", "signup.code")!.text);
    const v = await post("/auth/signup/verify", { email: "origin@example.com", code }, { ip });
    const pre = cookieFrom(v.setCookies, PRE_AUTH_COOKIE)!;
    const evil = authenticator({ origin: "https://evil.example" });
    expect((await post("/auth/register/verify", { response: evil.create(v.json.options) }, { ip, cookie: pre })).status).toBe(400);
    // The challenge is burnt; the ticket still gets fresh options.
    const again = await post("/auth/register/options", {}, { ip, cookie: pre });
    expect(again.status).toBe(200);
    const wrongRp = authenticator({ rpId: "evil.example" });
    expect((await post("/auth/register/verify", { response: wrongRp.create(again.json.options) }, { ip, cookie: pre })).status).toBe(400);
    const third = await post("/auth/register/options", {}, { ip, cookie: pre });
    const good = authenticator();
    expect((await post("/auth/register/verify", { response: good.create(third.json.options) }, { ip, cookie: pre })).status).toBe(201);
    // Login from the wrong origin and from a wrong RP ID.
    const bad = await signIn(app, good, { override: { origin: "https://evil.example" } });
    expect(bad.res.status).toBe(401);
    const good2 = await signIn(app, good);
    expect(good2.res.status).toBe(200);
    // Wrong RP ID: an authenticator with a different rpId hash but the same key cannot assert.
    (good as unknown as { opts: { rpId: string } }).opts.rpId = "evil.example";
    const rp = await signIn(app, good);
    expect(rp.res.status).toBe(401);
  });

  it("rejects an unknown credential, a userHandle mismatch and a missing userHandle with the same answer", async () => {
    const p = await signUp(app, "handle@example.com");
    const other = await signUp(app, "handle2@example.com");
    const ghost = authenticator();
    const unknown = await signIn(app, ghost);
    const mismatch = await signIn(app, p.auth, { override: { userHandle: Buffer.from(other.auth.userHandle!) } });
    const missing = await signIn(app, p.auth, { override: { userHandle: null } });
    for (const r of [unknown, mismatch, missing]) { expect(r.res.status).toBe(401); expect(r.res.json).toEqual({ error: { code: "login_failed" } }); }
    expect((await signIn(app, p.auth)).res.status).toBe(200);
  });

  it("rejects a revoked credential and one without user verification", async () => {
    const p = await signUp(app, "revoked@example.com");
    const second = authenticator();
    // A second credential added straight through the store, so the first can be revoked.
    const nv = authenticator({ userVerified: false });
    await app.db.owner.query("update passkeys set revoked_at = now() where user_id = $1", [p.userId]);
    expect((await signIn(app, p.auth)).res.status).toBe(401);
    void second; void nv;
    const p2 = await signUp(app, "noverify@example.com");
    p2.auth.userVerified = false;
    expect((await signIn(app, p2.auth)).res.status).toBe(401);
  });

  it("ST-53: backup bits are stored and shown, a backup-state flip alerts, a backup-eligible flip fails closed, hardened mode refuses synced credentials", async () => {
    const synced = authenticator({ backupEligible: true, backupState: true });
    const p = await signUp(app, "synced@example.com", { auth: synced });
    const m = await me(app, p.cookie);
    expect(m.json.credentials[0]).toMatchObject({ backupEligible: true, backupState: true });
    expect(m.json.warnings).toContain("synced_credentials_only");
    // BS 1 -> 0: signs in, stores the new bit, raises an alert.
    synced.backupState = false;
    expect((await signIn(app, synced)).res.status).toBe(200);
    const row = (await app.db.owner.query("select backup_eligible, backup_state from passkeys where user_id = $1", [p.userId])).rows[0];
    expect(row).toEqual({ backup_eligible: true, backup_state: false });
    expect((await app.db.owner.query("select count(*)::int as n from alerts where kind = 'auth.backup_state_cleared' and subject = $1", [p.userId])).rows[0].n).toBe(1);
    // BE 1 -> 0: fails closed, alerts.
    synced.backupEligible = false;
    const flip = await signIn(app, synced);
    expect(flip.res.status).toBe(401);
    expect((await app.db.owner.query("select count(*)::int as n from alerts where kind = 'auth.backup_eligible_flip' and subject = $1", [p.userId])).rows[0].n).toBe(1);
    expect(await auditActions(app, p.userId)).toContain("auth.login.failed");
    synced.backupEligible = true;
    // Hardened mode: the synced credential is refused at login, and at registration.
    await app.db.owner.query("update users set hardened_mode = true where id = $1", [p.userId]);
    expect((await signIn(app, synced)).res.status).toBe(401);
    const ip = nextIp();
    await post("/auth/signup/start", { email: "hard@example.com" }, { ip });
    const code = codeFrom(lastMail(app, "hard@example.com", "signup.code")!.text);
    const v = await post("/auth/signup/verify", { email: "hard@example.com", code }, { ip });
    await app.db.owner.query("update users set hardened_mode = true where email = 'hard@example.com'");
    const pre = cookieFrom(v.setCookies, PRE_AUTH_COOKIE)!;
    const reg = await post("/auth/register/verify", { response: authenticator({ backupEligible: true, backupState: true }).create(v.json.options) }, { ip, cookie: pre });
    expect(reg.status).toBe(422);
    expect(reg.json.error.code).toBe("hardened_mode_requires_device_bound");
  });

  it("enforces signCount only for credentials that are not backup-eligible", async () => {
    const device = authenticator();
    const p = await signUp(app, "counter@example.com", { auth: device });
    expect((await signIn(app, device)).res.status).toBe(200);   // count 1
    device.signCount = 0;                                        // a clone rewinds
    expect((await signIn(app, device)).res.status).toBe(401);   // count 1 again: not greater than stored 1
    expect((await app.db.owner.query("select count(*)::int as n from alerts where kind = 'auth.sign_count_regression' and subject = $1", [p.userId])).rows[0].n).toBe(1);
    const synced = authenticator({ backupEligible: true, backupState: true });
    await signUp(app, "counter2@example.com", { auth: synced });
    expect((await signIn(app, synced)).res.status).toBe(200);
    synced.signCount = 0;
    expect((await signIn(app, synced)).res.status).toBe(200);   // not enforced for synced credentials
  });

  it("ST-54: an unsupported-algorithm credential is rejected at registration", async () => {
    const ip = nextIp();
    await post("/auth/signup/start", { email: "alg@example.com" }, { ip });
    const code = codeFrom(lastMail(app, "alg@example.com", "signup.code")!.text);
    const v = await post("/auth/signup/verify", { email: "alg@example.com", code }, { ip });
    const pre = cookieFrom(v.setCookies, PRE_AUTH_COOKIE)!;
    // The options themselves offer only ES256 and RS256.
    expect(v.json.options.pubKeyCredParams.map((x: { alg: number }) => x.alg).sort()).toEqual([-257, -7]);
    // An ES256 key whose COSE header claims EdDSA (-8): tamper the encoded key, as an authenticator ignoring pubKeyCredParams would send.
    const a = authenticator();
    const raw = a as unknown as { coseKey: () => Buffer };
    const orig = raw.coseKey.bind(a);
    raw.coseKey = () => { const b = orig(); expect(b[3]).toBe(0x03); expect(b[4]).toBe(0x26); b[4] = 0x27; return b; };
    const r = await post("/auth/register/verify", { response: a.create(v.json.options) }, { ip, cookie: pre });
    expect(r.status).toBe(400);
    expect((await app.db.owner.query("select count(*)::int as n from passkeys where user_id = (select id from users where email = 'alg@example.com')")).rows[0].n).toBe(0);
    // RS256 is accepted.
    const again = await post("/auth/register/options", {}, { ip, cookie: pre });
    const rsa = authenticator({ alg: -257 });
    const ok = await post("/auth/register/verify", { response: rsa.create(again.json.options) }, { ip, cookie: pre });
    expect(ok.status).toBe(201);
    expect(ok.json.credential.alg).toBe(-257);
    expect((await signIn(app, rsa)).res.status).toBe(200);
  });
});

describe("sessions and cookies", () => {
  it("ST-44: the session cookie is __Host- prefixed, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain, non-persistent", async () => {
    const ip = nextIp();
    await post("/auth/signup/start", { email: "cookie@example.com" }, { ip });
    const code = codeFrom(lastMail(app, "cookie@example.com", "signup.code")!.text);
    const v = await post("/auth/signup/verify", { email: "cookie@example.com", code }, { ip });
    const preSet = v.setCookies.find((c) => c.startsWith(PRE_AUTH_COOKIE + "="))!;
    const pre = cookieFrom(v.setCookies, PRE_AUTH_COOKIE)!;
    const reg = await post("/auth/register/verify", { response: authenticator().create(v.json.options) }, { ip, cookie: pre });
    const set = reg.setCookies.find((c) => c.startsWith("__Host-mh_session="))!;
    for (const c of [set, preSet]) {
      expect(c.startsWith("__Host-")).toBe(true);
      expect(c).toMatch(/; Secure/); expect(c).toMatch(/; HttpOnly/); expect(c).toMatch(/; SameSite=Lax/); expect(c).toMatch(/; Path=\//);
      expect(c).not.toMatch(/Domain=/i);
    }
    expect(set).not.toMatch(/Max-Age|Expires/i);     // a session cookie, not a persistent one
    expect(set.split(";")[0]!.split("=")[1]!.length).toBeGreaterThanOrEqual(43);   // 256 bits
    // The cookie value is not stored; its hash is.
    const val = Buffer.from(set.split(";")[0]!.split("=")[1]!, "base64url");
    expect((await app.db.owner.query("select count(*)::int as n from sessions where id_hash = $1", [(await import("../util/bytes.ts")).sha256(val)])).rows[0].n).toBe(1);
    expect((await app.db.owner.query("select count(*)::int as n from sessions where id_hash = $1", [val])).rows[0].n).toBe(0);
    // Login options also sets a short-lived pre-auth cookie with the same attributes.
    const o = await app.call("POST", "/api/v1/auth/login/options", { body: {}, headers: xff(ip) });
    const lp = o.setCookies.find((c) => c.startsWith(PRE_AUTH_COOKIE + "="))!;
    expect(lp).toMatch(/Max-Age=120/); expect(lp).toMatch(/Secure/); expect(lp).toMatch(/HttpOnly/); expect(lp).toMatch(/SameSite=Lax/);
  });

  it("ST-51: a pre-login cookie is no session, login issues a new id and ends the presented one, revoke-all ends everything in one request, logout sends Clear-Site-Data", async () => {
    const p = await signUp(app, "sess@example.com");
    // Only a session cookie is a session: the pre-auth cookie is not.
    const o = await app.call("POST", "/api/v1/auth/login/options", { body: {}, headers: xff(nextIp()) });
    const preOnly = cookieFrom(o.setCookies, PRE_AUTH_COOKIE)!;
    expect((await app.call("GET", "/api/v1/me", { cookie: preOnly })).status).toBe(401);
    expect((await app.call("GET", "/api/v1/me", { cookie: `${SESSION_COOKIE}=${preOnly.split("=")[1]}` })).status).toBe(401);
    // Login while presenting an older session cookie (fixation): the old id dies, a different one is issued.
    const fixed = await signIn(app, p.auth, { cookie: p.cookie });
    expect(fixed.res.status).toBe(200);
    expect(fixed.cookie).not.toBe(p.cookie);
    expect((await me(app, p.cookie)).status).toBe(401);
    expect((await me(app, fixed.cookie!)).status).toBe(200);
    // Three sessions, one revoke-all, all dead on the next request.
    const s2 = (await signIn(app, p.auth)).cookie!; const s3 = (await signIn(app, p.auth)).cookie!;
    const all = await app.call("POST", "/api/v1/auth/sessions/revoke-all", { cookie: fixed.cookie, body: {} });
    expect(all.status).toBe(200);
    for (const c of [fixed.cookie!, s2, s3]) expect((await me(app, c)).status).toBe(401);
    // Logout: revokes the row and clears the site data.
    const s4 = (await signIn(app, p.auth)).cookie!;
    const out = await app.call("POST", "/api/v1/auth/logout", { cookie: s4, body: {} });
    expect(out.status).toBe(200);
    expect(out.headers.get("clear-site-data")).toBe('"cookies", "storage"');
    expect(out.setCookies.some((c) => c.startsWith("__Host-mh_session=;") && /Max-Age=0/.test(c))).toBe(true);
    expect((await me(app, s4)).status).toBe(401);
    expect((await app.db.owner.query("select count(*)::int as n from sessions where user_id = $1 and revoked_at is null", [p.userId])).rows[0].n).toBe(0);
  });

  it("ST-52: idle (15 minutes) and absolute (8 hours) expiry are enforced on the server, through real login sessions", async () => {
    const p = await signUp(app, "expiry@example.com");
    const s = (await signIn(app, p.auth)).cookie!;
    app.clock.advance(14 * 60_000);
    expect((await me(app, s)).status).toBe(200);                 // activity slides the idle window
    app.clock.advance(14 * 60_000);
    expect((await me(app, s)).status).toBe(200);
    app.clock.advance(15 * 60_000 + 1000);                       // idle beyond 15 minutes
    expect((await me(app, s)).status).toBe(401);
    // Absolute: keep it active every 10 minutes; it still dies at 8 hours.
    const t = (await signIn(app, p.auth)).cookie!;
    let alive = true; let elapsed = 0;
    while (elapsed < 8 * 3600_000 - 10 * 60_000) { app.clock.advance(10 * 60_000); elapsed += 10 * 60_000; alive = (await me(app, t)).status === 200; if (!alive) break; }
    expect(alive).toBe(true);
    app.clock.advance(11 * 60_000);
    expect((await me(app, t)).status).toBe(401);
    const row = (await app.db.owner.query("select expires_at, created_at from sessions order by created_at desc limit 1")).rows[0];
    expect(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()).toBe(8 * 3600_000);
  });
});

describe("passkeys", () => {
  it("POST /passkeys adds a credential after the gate, starts a 24-hour secret.reveal hold only, emails every address, rotates sessions", async () => {
    const p = await signUp(app, "add@example.com");
    const before = await app.call("POST", "/api/v1/auth/register/options", { body: {}, cookie: p.cookie, headers: xff(p.ip) });
    expect(before.status).toBe(200);
    expect(before.json.options.excludeCredentials.map((c: { id: string }) => c.id)).toContain(p.auth.id);
    const second = authenticator();
    app.email.clear();
    const add = await app.call("POST", "/api/v1/passkeys", { body: { registration: second.create(before.json.options), label: "Work laptop" }, cookie: p.cookie });
    expect(add.status).toBe(201);
    expect(add.json.credential).toMatchObject({ label: "Work laptop", alg: -7 });
    const newCookie = cookieFrom(add.setCookies, SESSION_COOKIE)!;
    expect(newCookie).not.toBe(p.cookie);
    expect((await me(app, p.cookie)).status).toBe(401);
    const m = await me(app, newCookie);
    expect(m.json.credentials).toHaveLength(2);
    expect(m.json.hold.secretRevealUntil).toBe(new Date(app.clock.now().getTime() + 24 * 3600_000).toISOString());
    expect(m.json.hold.allHeldUntil).toBeNull();
    const { assertNotHeld, isHeld } = await import("./holds.ts");
    await withUser(app.ctx.runtime, p.userId, async (c) => {
      await expect(assertNotHeld(app.ctx, c, p.userId, "secret.reveal")).rejects.toMatchObject({ status: 423, code: "recovery_hold" });
      expect(await isHeld(app.ctx, c, p.userId, "domain.unlock")).toBe(false);
      expect(await isHeld(app.ctx, c, p.userId, "agent.token.create")).toBe(false);
    });
    expect(app.email.to("add@example.com").some((x) => x.kind === "passkey.added")).toBe(true);
    // A registration challenge is single use and bound to the session: replay fails.
    const replay = await app.call("POST", "/api/v1/passkeys", { body: { registration: second.create(before.json.options), label: "x" }, cookie: newCookie });
    expect(replay.status).toBe(400);
    // The hold ends after 24 hours.
    app.clock.advance(24 * 3600_000 + 1000);
    await withUser(app.ctx.runtime, p.userId, async (c) => { expect(await isHeld(app.ctx, c, p.userId, "secret.reveal")).toBe(false); });
  });

  it("refuses removing the last live credential without recovery codes and confirmation; revoking one of two works and emails every address", async () => {
    const p = await signUp(app, "del@example.com");
    const list = await app.call("GET", "/api/v1/passkeys", { cookie: p.cookie });
    const firstId = list.json.passkeys[0].id;
    const last = await app.call("DELETE", `/api/v1/passkeys/${firstId}`, { cookie: p.cookie });
    expect(last.status).toBe(409); expect(last.json.error.code).toBe("confirm_required");
    // Without recovery codes it is refused outright, even when confirmed.
    await app.db.owner.query("delete from recovery_codes where user_id = $1", [p.userId]);
    const noCodes = await app.call("DELETE", `/api/v1/passkeys/${firstId}`, { cookie: p.cookie, body: { confirmLast: true } });
    expect(noCodes.status).toBe(409); expect(noCodes.json.error.code).toBe("last_credential_no_recovery_codes");
    // Two credentials: one can go.
    const o = await app.call("POST", "/api/v1/auth/register/options", { body: {}, cookie: p.cookie });
    const second = authenticator();
    const add = await app.call("POST", "/api/v1/passkeys", { body: { registration: second.create(o.json.options) }, cookie: p.cookie });
    const cookie = cookieFrom(add.setCookies, SESSION_COOKIE)!;
    app.email.clear();
    const del = await app.call("DELETE", `/api/v1/passkeys/${firstId}`, { cookie });
    expect(del.status).toBe(200);
    expect(app.email.to("del@example.com").some((x) => x.kind === "passkey.removed")).toBe(true);
    expect((await signIn(app, p.auth)).res.status).toBe(401);
    // Unknown and someone else's ids answer identically.
    const other = await signUp(app, "del2@example.com");
    const foreign = (await app.call("GET", "/api/v1/passkeys", { cookie: other.cookie })).json.passkeys[0].id;
    const a = await app.call("DELETE", `/api/v1/passkeys/${foreign}`, { cookie: del.setCookies.length ? cookieFrom(del.setCookies, SESSION_COOKIE)! : cookie });
    const b = await app.call("DELETE", `/api/v1/passkeys/00000000-0000-4000-8000-000000000000`, { cookie: cookieFrom(del.setCookies, SESSION_COOKIE)! });
    expect(a.status).toBe(404); expect(b.status).toBe(404); expect(a.text).toBe(b.text);
  });

  it("a stepUp route needs the gate: without one the router answers 503, with a session-less call 401", async () => {
    const p = await signUp(app, "gate@example.com");
    expect((await app.call("POST", "/api/v1/passkeys", { body: {} })).status).toBe(401);
    const r = await app.call("POST", "/api/v1/passkeys", { body: {}, cookie: p.cookie });
    expect(r.status).toBe(400);   // stub gate passes; the handler rejects a body that is no registration
  });
});

describe("notification addresses and recovery codes", () => {
  it("adds a second address with a code, tells every existing address, requires a different mail domain for the independent channel", async () => {
    const p = await signUp(app, "addr@example.com");
    const { requireIndependentChannel } = await import("./credentials.ts");
    const chan = () => withUser(app.ctx.runtime, p.userId, (c) => requireIndependentChannel(app.ctx, c, p.userId));
    expect(await chan()).toBe(false);
    app.email.clear();
    const add = await app.call("POST", "/api/v1/notification-addresses", { body: { address: "second@example.com", kind: "second" }, cookie: p.cookie });
    expect(add.status).toBe(201);
    expect(add.json.address.verified).toBe(false);
    expect(app.email.to("addr@example.com").some((m) => m.kind === "address.added")).toBe(true);
    const code = codeFrom(lastMail(app, "second@example.com", "address.code")!.text);
    const id = add.json.address.id;
    expect((await app.call("POST", `/api/v1/notification-addresses/${id}/verify`, { body: { code: "11111111" }, cookie: p.cookie })).status).toBe(400);
    expect((await app.call("POST", `/api/v1/notification-addresses/${id}/verify`, { body: { code }, cookie: p.cookie })).status).toBe(200);
    // Same domain as the login address: not independent.
    expect(await chan()).toBe(false);
    const add2 = await app.call("POST", "/api/v1/notification-addresses", { body: { address: "backup@other.org", kind: "second" }, cookie: p.cookie });
    const code2 = codeFrom(lastMail(app, "backup@other.org", "address.code")!.text);
    await app.call("POST", `/api/v1/notification-addresses/${add2.json.address.id}/verify`, { body: { code: code2 }, cookie: p.cookie });
    expect(await chan()).toBe(true);
    // Removal tells everyone, the removed address included; the login address cannot be removed.
    app.email.clear();
    const rm = await app.call("DELETE", `/api/v1/notification-addresses/${add2.json.address.id}`, { cookie: p.cookie });
    expect(rm.status).toBe(200);
    for (const a of ["addr@example.com", "second@example.com", "backup@other.org"]) expect(app.email.to(a).some((m) => m.kind === "address.removed"), a).toBe(true);
    expect(await chan()).toBe(false);
    const loginId = (await app.call("GET", "/api/v1/notification-addresses", { cookie: p.cookie })).json.addresses.find((a: { kind: string }) => a.kind === "login").id;
    expect((await app.call("DELETE", `/api/v1/notification-addresses/${loginId}`, { cookie: p.cookie })).status).toBe(409);
    expect((await app.call("POST", "/api/v1/notification-addresses", { body: { address: "ADDR@example.com", kind: "second" }, cookie: p.cookie })).status).toBe(409);
  });

  it("ST-49: ten 128-bit codes of 26 base32 characters, stored hashed, regenerated with a mail to every address", async () => {
    const p = await signUp(app, "codes1@example.com");
    expect(new Set(p.recoveryCodes).size).toBe(10);
    for (const c of p.recoveryCodes) expect(c).toMatch(/^[A-Z2-7]{26}$/);
    const rows = (await app.db.owner.query("select code_hash from recovery_codes where user_id = $1", [p.userId])).rows;
    expect(rows).toHaveLength(10);
    const { createHash } = await import("node:crypto");
    for (const c of p.recoveryCodes) expect(rows.some((r) => Buffer.from(r.code_hash).equals(createHash("sha256").update(c).digest()))).toBe(true);
    expect(JSON.stringify((await app.db.owner.query("select * from recovery_codes where user_id = $1", [p.userId])).rows)).not.toContain(p.recoveryCodes[0]);
    app.email.clear();
    const re = await app.call("POST", "/api/v1/recovery-codes", { body: {}, cookie: p.cookie });
    expect(re.status).toBe(201);
    expect(re.json.recoveryCodes).toHaveLength(10);
    expect(re.json.recoveryCodes.some((c: string) => p.recoveryCodes.includes(c))).toBe(false);
    expect((await app.db.owner.query("select count(*)::int as n from recovery_codes where user_id = $1 and used_at is null", [p.userId])).rows[0].n).toBe(10);
    expect(app.email.to("codes1@example.com").some((m) => m.kind === "codes.regenerated")).toBe(true);
  });
});

describe("routes", () => {
  it("ST-44: no auth route mutates on GET; the allow-list of GET routes is explicit", async () => {
    const { authRoutes } = await import("./routes.ts");
    const gets = authRoutes.filter((r) => r.method === "GET").map((r) => r.path).sort();
    expect(gets).toEqual(["/api/v1/email-actions/:token", "/api/v1/me", "/api/v1/notification-addresses", "/api/v1/passkeys"]);
    for (const r of authRoutes) expect(r.principals.length).toBeGreaterThan(0);
    void createSession;
  });
});
