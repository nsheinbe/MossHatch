import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUser } from "@mosshatch/db";
import { cookieFrom, type TestApp } from "../testing/app.ts";
import { ACTION_TYPES, type ActionType } from "../http/types.ts";
import { PRE_AUTH_COOKIE, SESSION_COOKIE } from "../http/session.ts";
import { hit } from "../ratelimit.ts";
import { mintToken } from "../util/token.ts";
import { HELD_ACTIONS, assertNotHeld, isHeld } from "./holds.ts";
import { CLASS_B, flushSecurityDigests } from "./mail.ts";
import { RECOVERY_CODE_ATTEMPTS, RECOVERY_START_SOURCE } from "./recovery.ts";
import { auditActions, authenticator, clearClassA, codeFrom, fillClassA, lastMail, linkFrom, me, newApp, nextIp, signIn, signUp, xff, type Person } from "./testkit.ts";

let app: TestApp;
beforeAll(async () => { app = await newApp(); }, 60_000);
afterAll(async () => { await app?.drop(); });

const post = (p: string, body: unknown, o: { cookie?: string; ip?: string } = {}) => app.call("POST", "/api/v1" + p, { body, cookie: o.cookie, headers: xff(o.ip ?? nextIp()) });
const start = (email: string, recPath: "codes_email" | "email_only", ip?: string) => post("/auth/recovery/start", { email, path: recPath }, { ip });

/** A second verified address on another mail domain (the independent channel). */
async function addSecond(p: Person, address: string, kind: "second" | "registrant" = "second") {
  const add = await app.call("POST", "/api/v1/notification-addresses", { body: { address, kind }, cookie: p.cookie });
  expect(add.status).toBe(201);
  const code = codeFrom(lastMail(app, address, "address.code")!.text);
  expect((await app.call("POST", `/api/v1/notification-addresses/${add.json.address.id}/verify`, { body: { code }, cookie: p.cookie })).status).toBe(200);
}

/** Redeem the emailed code (plus a recovery code where the path needs one) and register a new authenticator: the whole completion. */
async function redeemAndRegister(p: Person, o: { recoveryCode?: string; newAuth?: ReturnType<typeof authenticator>; ip?: string } = {}) {
  const ip = o.ip ?? nextIp();
  const code = codeFrom(lastMail(app, p.email, "recovery.code")!.text);
  const red = await post("/auth/recovery/redeem", { email: p.email, code, recoveryCode: o.recoveryCode }, { ip });
  if (red.status !== 200) return { red };
  const pre = cookieFrom(red.setCookies, PRE_AUTH_COOKIE)!;
  const newAuth = o.newAuth ?? authenticator();
  const reg = await post("/auth/register/verify", { response: newAuth.create(red.json.options) }, { ip, cookie: pre });
  return { red, reg, newAuth, cookie: reg.status === 201 ? cookieFrom(reg.setCookies, SESSION_COOKIE)! : undefined, ip };
}

const heldIds = async (userId: string) => withUser(app.ctx.runtime, userId, async (c) => {
  const out: ActionType[] = [];
  for (const t of ACTION_TYPES) if (await isHeld(app.ctx, c, userId, t)) out.push(t);
  return out;
});

describe("holds table (4.5)", () => {
  it("ST-45: the Held ids are exactly the rows marked H in the plan's step-up table, and mandate.sign is not held", () => {
    const md = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../docs/PLAN.md"), "utf8");
    const rows = [...md.matchAll(/^\| `([a-z._]+)` \|.*\| ([^|]+) \|$/gm)].filter((m) => (ACTION_TYPES as readonly string[]).includes(m[1]!));
    expect(rows.map((r) => r[1]).sort()).toEqual([...ACTION_TYPES].sort());
    const held = rows.filter((r) => r[2]!.trim() === "H").map((r) => r[1]!).sort();
    expect(held).toEqual([...HELD_ACTIONS].sort());
    expect(HELD_ACTIONS).not.toContain("mandate.sign");
    expect(HELD_ACTIONS).toHaveLength(14);                              // the H rows of PLAN 4.5: twelve, plus account.close and account.export (closure module)
  });
});

describe("recovery", () => {
  it("ST-45: codes plus emailed code completes with no cooling-off and holds every Held id for 24 hours; the request settles afterwards", async () => {
    const p = await signUp(app, "r1@example.com");
    const st = await start(p.email, "codes_email");
    expect(st.status).toBe(202);
    const row = (await app.db.owner.query("select * from recovery_requests where user_id = $1", [p.userId])).rows[0];
    expect(row).toMatchObject({ path: "codes_email", status: "pending", cooling_off_until: null });
    // A wrong recovery code fails; the right one plus the emailed code completes.
    const bad = await post("/auth/recovery/redeem", { email: p.email, code: codeFrom(lastMail(app, p.email, "recovery.code")!.text), recoveryCode: "A".repeat(26) });
    expect(bad.status).toBe(401);
    const done = await redeemAndRegister(p, { recoveryCode: p.recoveryCodes[3] });
    expect(done.reg!.status).toBe(201);
    expect(done.reg!.json.recoveryCodes).toBeUndefined();
    const hold = (await app.db.owner.query("select scope, until from action_holds where user_id = $1", [p.userId])).rows;
    expect(hold).toHaveLength(1);
    expect(new Date(hold[0].until).getTime() - app.clock.now().getTime()).toBe(24 * 3600_000);
    // Every id marked H is refused; mandate.sign is not.
    await withUser(app.ctx.runtime, p.userId, async (c) => {
      for (const t of HELD_ACTIONS) await expect(assertNotHeld(app.ctx, c, p.userId, t), t).rejects.toMatchObject({ status: 423, code: "recovery_hold" });
      await expect(assertNotHeld(app.ctx, c, p.userId, "mandate.sign")).resolves.toBeUndefined();
    });
    expect(await heldIds(p.userId)).toHaveLength(14);
    const m = await me(app, done.cookie!);
    expect(m.json.hold).toMatchObject({ active: true });
    expect(m.json.recovery).toMatchObject({ status: "holding", path: "codes_email" });
    // The used code is spent; the rest are untouched.
    expect((await app.db.owner.query("select count(*)::int as n from recovery_codes where user_id = $1 and used_at is null", [p.userId])).rows[0].n).toBe(9);
    // After 24 hours the hold is over.
    app.clock.advance(24 * 3600_000 + 1000);
    expect(await heldIds(p.userId)).toEqual([]);
    const later = await signIn(app, done.newAuth!);
    expect((await me(app, later.cookie!)).json.recovery).toBeNull();
    expect(await auditActions(app, p.userId)).toEqual(expect.arrayContaining(["auth.recovery.started", "auth.recovery.redeemed", "auth.recovery.completed"]));
  });

  it("ST-45: email-only waits 72 hours, then holds 72 hours; nothing can be redeemed during the wait", async () => {
    const p = await signUp(app, "r2@example.com");
    await addSecond(p, "r2-second@backup.org");
    const st = await start(p.email, "email_only");
    expect(st.status).toBe(202);
    const row = (await app.db.owner.query("select * from recovery_requests where user_id = $1", [p.userId])).rows[0];
    expect(row.status).toBe("cooling_off");
    expect(new Date(row.cooling_off_until).getTime() - app.clock.now().getTime()).toBe(72 * 3600_000);
    // No emailed code exists during the cooling-off, and asking again does not create one.
    expect(lastMail(app, p.email, "recovery.code")).toBeUndefined();
    app.clock.advance(3600_000);
    await start(p.email, "email_only");
    expect(lastMail(app, p.email, "recovery.code")).toBeUndefined();
    expect((await post("/auth/recovery/redeem", { email: p.email, code: "12345678" })).status).toBe(401);
    // After the wait the emailed code goes out.
    app.clock.advance(72 * 3600_000);
    await start(p.email, "email_only");
    const done = await redeemAndRegister(p);
    expect(done.reg!.status).toBe(201);
    const hold = (await app.db.owner.query("select until from action_holds where user_id = $1", [p.userId])).rows[0];
    expect(new Date(hold.until).getTime() - app.clock.now().getTime()).toBe(72 * 3600_000);
    expect(await heldIds(p.userId)).toHaveLength(14);
    app.clock.advance(72 * 3600_000 - 1000);
    expect(await heldIds(p.userId)).toHaveLength(14);
    app.clock.advance(2000);
    expect(await heldIds(p.userId)).toEqual([]);
  });

  it("completion revokes every session and binding, suspends (does not delete) the old credentials, and blocks address and passkey changes during the hold", async () => {
    const p = await signUp(app, "r3@example.com");
    const other = (await signIn(app, p.auth)).cookie!;
    const m = mintToken("live");
    const b = (await app.db.owner.query("insert into bindings (user_id, kind, name, token_prefix, token_hash, expires_at) values ($1,'agent','a',$2,$3,$4) returning id", [p.userId, m.prefix, m.hash, new Date(app.clock.now().getTime() + 86400_000)])).rows[0];
    await start(p.email, "codes_email");
    const done = await redeemAndRegister(p, { recoveryCode: p.recoveryCodes[0] });
    expect(done.reg!.status).toBe(201);
    for (const c of [p.cookie, other]) expect((await me(app, c)).status).toBe(401);
    expect((await app.db.owner.query("select revoked_at from bindings where id = $1", [b.id])).rows[0].revoked_at).not.toBeNull();
    const pk = (await app.db.owner.query("select credential_id, suspended_at, revoked_at, suspended_by_recovery_id, created_by_recovery_id from passkeys where user_id = $1 order by created_at", [p.userId])).rows;
    expect(pk).toHaveLength(2);
    expect(pk[0]).toMatchObject({ credential_id: p.auth.id, revoked_at: null });
    expect(pk[0].suspended_at).not.toBeNull();
    expect(pk[1].suspended_at).toBeNull();
    expect(pk[1].created_by_recovery_id).toBe(pk[0].suspended_by_recovery_id);
    // During the hold: no address change, no code regeneration, no passkey removal, no passkey add.
    const nc = done.cookie!;
    expect((await app.call("POST", "/api/v1/notification-addresses", { body: { address: "evil@evil.org", kind: "second" }, cookie: nc })).status).toBe(423);
    expect((await app.call("POST", "/api/v1/recovery-codes", { body: {}, cookie: nc })).status).toBe(423);
    const list = (await app.call("GET", "/api/v1/passkeys", { cookie: nc })).json.passkeys;
    for (const k of list) expect((await app.call("DELETE", `/api/v1/passkeys/${k.id}`, { cookie: nc, body: { confirmLast: true } })).status).toBe(423);
    const loginAddr = (await app.call("GET", "/api/v1/notification-addresses", { cookie: nc })).json.addresses[0].id;
    expect((await app.call("DELETE", `/api/v1/notification-addresses/${loginAddr}`, { cookie: nc })).status).toBe(423);
    const opts = await app.call("POST", "/api/v1/auth/register/options", { body: {}, cookie: nc });
    expect((await app.call("POST", "/api/v1/passkeys", { body: { registration: authenticator().create(opts.json.options) }, cookie: nc })).status).toBe(423);
  });

  it("ST-46: email-only is refused without a second verified channel on another domain, with the same response as an unknown address; a sign-in cancels a pending request", async () => {
    const p = await signUp(app, "r4@example.com");
    app.email.clear();
    const known = await start(p.email, "email_only");
    const unknown = await start("nobody-r4@example.com", "email_only");
    expect(known.status).toBe(202); expect(known.text).toBe(unknown.text);
    expect((await app.db.owner.query("select count(*)::int as n from recovery_requests where user_id = $1", [p.userId])).rows[0].n).toBe(0);
    expect(app.email.to(p.email).some((m) => m.kind === "recovery.unavailable")).toBe(true);
    expect(lastMail(app, p.email, "recovery.code")).toBeUndefined();
    // A second address on the same domain does not count; an unverified one on another domain does not either.
    await addSecond(p, "r4-second@example.com");
    await start(p.email, "email_only");
    expect((await app.db.owner.query("select count(*)::int as n from recovery_requests where user_id = $1", [p.userId])).rows[0].n).toBe(0);
    await app.call("POST", "/api/v1/notification-addresses", { body: { address: "r4@unverified.org", kind: "second" }, cookie: p.cookie });
    await start(p.email, "email_only");
    expect((await app.db.owner.query("select count(*)::int as n from recovery_requests where user_id = $1", [p.userId])).rows[0].n).toBe(0);
    // With a verified independent channel it opens; any legitimate sign-in cancels it.
    await addSecond(p, "r4-real@backup.org");
    await start(p.email, "email_only");
    const open = (await app.db.owner.query("select id, status from recovery_requests where user_id = $1", [p.userId])).rows[0];
    expect(open.status).toBe("cooling_off");
    expect((await me(app, p.cookie)).json.recovery).toMatchObject({ status: "cooling_off", path: "email_only" });
    app.email.clear();
    expect((await signIn(app, p.auth)).res.status).toBe(200);
    expect((await app.db.owner.query("select status, cancelled_by from recovery_requests where id = $1", [open.id])).rows[0]).toEqual({ status: "cancelled", cancelled_by: "sign_in" });
    for (const a of [p.email, "r4-real@backup.org"]) expect(app.email.to(a).some((m) => m.kind === "recovery.cancelled"), a).toBe(true);
    expect(await auditActions(app, p.userId)).toContain("auth.recovery.cancelled");
    // The same for a codes_email request that is still pending.
    await start(p.email, "codes_email");
    expect((await app.db.owner.query("select status from recovery_requests where user_id = $1 and status = 'pending'", [p.userId])).rowCount).toBe(1);
    await signIn(app, p.auth);
    expect((await app.db.owner.query("select count(*)::int as n from recovery_requests where user_id = $1 and status in ('pending','cooling_off')", [p.userId])).rows[0].n).toBe(0);
  });

  it("allows at most one open request per account", async () => {
    const p = await signUp(app, "r5@example.com");
    const ip = nextIp();
    for (let i = 0; i < 4; i++) await start(p.email, "codes_email", ip);
    expect((await app.db.owner.query("select count(*)::int as n from recovery_requests where user_id = $1", [p.userId])).rows[0].n).toBe(1);
    // Concurrent starts also end with one row.
    const q = await signUp(app, "r5b@example.com");
    await Promise.all(Array.from({ length: 5 }, () => start(q.email, "codes_email", nextIp())));
    expect((await app.db.owner.query("select count(*)::int as n from recovery_requests where user_id = $1", [q.userId])).rows[0].n).toBe(1);
    expect(app.email.to(q.email).filter((m) => m.kind === "recovery.started")).toHaveLength(1);
  });

  it("ST-47: notices reach every notification address including the registrant, and a flood of starts stops neither redeeming nor cancelling from a new device", async () => {
    const p = await signUp(app, "r6@example.com");
    await addSecond(p, "r6-second@backup.org");
    await addSecond(p, "r6-registrant@registrant.net", "registrant");
    app.email.clear();
    const attackerIp = nextIp();
    const first = await start(p.email, "codes_email", attackerIp);
    expect(first.status).toBe(202);
    for (const a of [p.email, "r6-second@backup.org", "r6-registrant@registrant.net"]) expect(app.email.to(a).filter((m) => m.kind === "recovery.started"), a).toHaveLength(1);
    expect(lastMail(app, "r6-second@backup.org", "recovery.started")!.text).toMatch(/email-actions\//);
    // The attacker floods from one source: the source budget blocks the starts, and only starts.
    const codeMail = codeFrom(lastMail(app, p.email, "recovery.code")!.text);
    let blocked = 0;
    for (let i = 0; i < 25; i++) if ((await start(p.email, "codes_email", attackerIp)).status === 429) blocked++;
    expect(blocked).toBeGreaterThan(0);
    expect(RECOVERY_START_SOURCE.max).toBe(10);
    // The emailed code the owner already holds was not rotated, and only one code mail and one started notice exist.
    expect(app.email.to(p.email).filter((m) => m.kind === "recovery.code")).toHaveLength(1);
    expect(app.email.to(p.email).filter((m) => m.kind === "recovery.started")).toHaveLength(1);
    // The owner, on a new device that shares the attacker's exhausted source prefix, redeems the emailed code.
    const done = await redeemAndRegister(p, { recoveryCode: p.recoveryCodes[1], ip: attackerIp });
    expect(done.red.status).toBe(200);
    expect(done.reg!.status).toBe(201);
    expect(codeMail).toMatch(/^\d{8}$/);
    for (const a of [p.email, "r6-second@backup.org", "r6-registrant@registrant.net"]) expect(app.email.to(a).filter((m) => m.kind === "recovery.completed"), a).toHaveLength(1);
  });

  it("ST-47: cancelling from a new device works through the emailed link and the endpoint while the source and account budgets are exhausted", async () => {
    const p = await signUp(app, "r7@example.com");
    await addSecond(p, "r7-second@backup.org");
    const ip = nextIp();
    await start(p.email, "codes_email", ip);
    for (let i = 0; i < 15; i++) await start(p.email, "codes_email", ip);      // source budget gone
    await fillClassA(app, p.email);                                            // class A mail gone

    await withUser(app.ctx.runtime, p.userId, async (c) => { for (let i = 0; i < 30; i++) await hit(app.ctx, c, p.userId, CLASS_B); });   // class B bucket gone
    expect((await start(p.email, "codes_email", ip)).status).toBe(429);
    const token = linkFrom(lastMail(app, "r7-second@backup.org", "recovery.started")!.text);
    // The link page changes nothing.
    const page = await app.call("GET", `/api/v1/email-actions/${token}`);
    expect(page.status).toBe(200);
    expect((await app.db.owner.query("select status from recovery_requests where user_id = $1", [p.userId])).rows[0].status).toBe("pending");
    // POST the token to the cancel endpoint from a device with no session, on the exhausted source.
    const cancel = await post("/auth/recovery/cancel", { token }, { ip });
    expect(cancel.status).toBe(200);
    expect(cancel.json).toEqual({ ok: true, cancelled: true });
    expect((await app.db.owner.query("select status, cancelled_by from recovery_requests where user_id = $1", [p.userId])).rows[0]).toEqual({ status: "cancelled", cancelled_by: "email_link" });
    // Once spent, the token does nothing more, and the cancelled request's code is dead.
    expect((await post("/auth/recovery/cancel", { token }, { ip })).status).toBe(404);
    expect((await post("/auth/recovery/redeem", { email: p.email, code: codeFrom(lastMail(app, p.email, "recovery.code")!.text), recoveryCode: p.recoveryCodes[0] }, { ip })).status).toBe(401);
    await clearClassA(app);
    // A signed-in cancel also works.
    app.clock.advance(3600_000 * 2);
    await start(p.email, "codes_email", nextIp());
    const viaSession = await app.call("POST", "/api/v1/auth/recovery/cancel", { body: {}, cookie: (await signIn(app, p.auth)).cookie });
    expect(viaSession.status).toBe(200);
  });

  it("ST-48: a suspended credential restores on a user-verified assertion: the recovery's credentials and sessions are revoked and the hold is applied again", async () => {
    const p = await signUp(app, "r8@example.com");
    await start(p.email, "codes_email");
    const done = await redeemAndRegister(p, { recoveryCode: p.recoveryCodes[0] });
    expect(done.reg!.status).toBe(201);
    const recSession = done.cookie!;
    // Two days on: the original 24-hour hold is over, but the old credentials are still suspended (30 days).
    app.clock.advance(2 * 24 * 3600_000);
    expect(await heldIds(p.userId)).toEqual([]);
    const s = (await app.db.owner.query("select suspended_at from passkeys where user_id = $1 and credential_id = $2", [p.userId, p.auth.id])).rows[0];
    expect(s.suspended_at).not.toBeNull();
    // The attacker's fresh session would be idle by now; make one with the attacker's credential.
    const atk = await signIn(app, done.newAuth!);
    expect(atk.res.status).toBe(200);
    app.email.clear();
    const undo = await signIn(app, p.auth);
    expect(undo.res.status).toBe(200);
    expect(undo.res.json.restored).toBe(true);
    const rows = (await app.db.owner.query("select credential_id, suspended_at, revoked_at from passkeys where user_id = $1 order by created_at", [p.userId])).rows;
    expect(rows[0]).toMatchObject({ credential_id: p.auth.id, suspended_at: null, revoked_at: null });
    expect(rows[1].revoked_at).not.toBeNull();
    for (const c of [recSession, atk.cookie!]) expect((await me(app, c)).status).toBe(401);
    expect((await me(app, undo.cookie!)).status).toBe(200);
    expect((await signIn(app, done.newAuth!)).res.status).toBe(401);       // the recovery's credential is dead
    expect(await heldIds(p.userId)).toHaveLength(14);                       // held again
    const hold = (await app.db.owner.query("select until from action_holds where user_id = $1 order by created_at desc", [p.userId])).rows[0];
    expect(new Date(hold.until).getTime() - app.clock.now().getTime()).toBe(24 * 3600_000);
    expect(app.email.to(p.email).some((m) => m.kind === "recovery.undone")).toBe(true);
    expect(await auditActions(app, p.userId)).toContain("auth.recovery.undone");
    expect((await app.db.owner.query("select status from recovery_requests where user_id = $1", [p.userId])).rows[0].status).toBe("cancelled");
    // Another recovery can be started afterwards (the old request is closed).
    expect((await start(p.email, "codes_email")).status).toBe(202);
    expect((await app.db.owner.query("select count(*)::int as n from recovery_requests where user_id = $1", [p.userId])).rows[0].n).toBe(2);
  });

  it("ST-48: suspended credentials stay restorable for 30 days and no longer after", async () => {
    const a = await signUp(app, "r9@example.com");
    await start(a.email, "codes_email");
    const doneA = await redeemAndRegister(a, { recoveryCode: a.recoveryCodes[0] });
    app.clock.advance(29 * 24 * 3600_000);
    // Day 29: still restorable; use a second person for day 31.
    const b = await signUp(app, "r10@example.com");
    await start(b.email, "codes_email");
    await redeemAndRegister(b, { recoveryCode: b.recoveryCodes[0] });
    expect((await signIn(app, a.auth)).res.status).toBe(200);
    app.clock.advance(31 * 24 * 3600_000);
    expect((await signIn(app, b.auth)).res.status).toBe(401);
    const { sweepAuth } = await import("./sweep.ts");
    const swept = await sweepAuth(app.ctx);
    expect(swept.expiredSuspensions).toBeGreaterThanOrEqual(1);
    expect((await app.db.owner.query("select revoked_at from passkeys where user_id = $1 and credential_id = $2", [b.userId, b.auth.id])).rows[0].revoked_at).not.toBeNull();
    void doneA;
  });

  it("ST-48 review: undoing a recovery also revokes what later recoveries and the recovery's own sessions added, and cancels them", async () => {
    const p = await signUp(app, "r-chain@example.com");
    await start(p.email, "codes_email");
    const r1 = await redeemAndRegister(p, { recoveryCode: p.recoveryCodes[0] });   // A1; the victim's passkey V is suspended by R1
    expect(r1.reg!.status).toBe(201);
    // R1's hold ends. The recovery's credential adds a passkey (A3) with a step-up, then a second recovery (R2) adds A2.
    app.clock.advance(25 * 3600_000);
    const atk = (await signIn(app, r1.newAuth!)).cookie!;
    const opts = await app.call("POST", "/api/v1/auth/register/options", { body: {}, cookie: atk });
    const a3 = authenticator();
    const added = await app.call("POST", "/api/v1/passkeys", { body: { registration: a3.create(opts.json.options), label: "A3" }, cookie: atk });
    expect(added.status, added.text).toBe(201);
    await start(p.email, "codes_email");
    const r2 = await redeemAndRegister(p, { recoveryCode: p.recoveryCodes[1] });   // suspends A1 and A3 (V is already suspended by R1)
    expect(r2.reg!.status).toBe(201);
    // The victim signs in with V: the undo covers R1 and everything that hangs off it.
    const undo = await signIn(app, p.auth);
    expect(undo.res.status).toBe(200);
    expect(undo.res.json.restored).toBe(true);
    const rows = (await app.db.owner.query("select credential_id, suspended_at, revoked_at from passkeys where user_id = $1", [p.userId])).rows;
    const byId = (id: string) => rows.find((r) => r.credential_id === id)!;
    expect(byId(p.auth.id)).toMatchObject({ suspended_at: null, revoked_at: null });
    for (const a of [r1.newAuth!, r2.newAuth!, a3]) expect(byId(a.id).revoked_at, a.id).not.toBeNull();
    for (const a of [r2.newAuth!, a3, r1.newAuth!]) expect((await signIn(app, a)).res.status).toBe(401);
    expect((await app.db.owner.query("select status from recovery_requests where user_id = $1 order by created_at", [p.userId])).rows.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    expect(await heldIds(p.userId)).toHaveLength(14);
  });

  it("ST-46 review: a sign-in that undoes a recovery also cancels a later request that is still open", async () => {
    const p = await signUp(app, "r-open@example.com");
    await start(p.email, "codes_email");
    const r1 = await redeemAndRegister(p, { recoveryCode: p.recoveryCodes[0] });
    expect(r1.reg!.status).toBe(201);
    app.clock.advance(25 * 3600_000);
    await start(p.email, "codes_email");                                              // R2, pending
    const r2 = (await app.db.owner.query("select id, status from recovery_requests where user_id = $1 order by created_at desc limit 1", [p.userId])).rows[0];
    expect(r2.status).toBe("pending");
    const code = codeFrom(lastMail(app, p.email, "recovery.code")!.text);
    const undo = await signIn(app, p.auth);
    expect(undo.res.json.restored).toBe(true);
    expect((await app.db.owner.query("select status, cancelled_by from recovery_requests where id = $1", [r2.id])).rows[0]).toEqual({ status: "cancelled", cancelled_by: "sign_in" });
    // R2 can no longer be redeemed.
    expect((await post("/auth/recovery/redeem", { email: p.email, code, recoveryCode: p.recoveryCodes[1] })).status).toBe(401);
  });

  it("ST-49: recovery codes are limited to 10 attempts an hour per account, the limit never touches passkey sign-in, and it resets", async () => {
    const p = await signUp(app, "r11@example.com");
    expect(RECOVERY_CODE_ATTEMPTS.max).toBe(10);
    const wrong = (i: number) => "B".repeat(25) + "ABCDEFGH"[i % 8];
    let attempt = 0;
    app.clock.set(new Date(Math.ceil(app.clock.now().getTime() / 3600_000) * 3600_000 + 1000));   // start of a rate window
    // The emailed code dies after 5 tries, so 10 guesses need two codes (the account mail limit is 1 per 15 minutes).
    for (let round = 0; round < 3; round++) {
      await start(p.email, "codes_email", nextIp());
      const code = codeFrom(lastMail(app, p.email, "recovery.code")!.text);
      for (let i = 0; i < 5; i++) {
        const r = await post("/auth/recovery/redeem", { email: p.email, code, recoveryCode: wrong(attempt++) });
        if (attempt <= 10) expect(r.status).toBe(401);
        else { expect(r.status).toBe(429); break; }
      }
      // Passkey sign-in is untouched by the exhausted recovery bucket.
      expect((await signIn(app, p.auth)).res.status).toBe(200);
      if (round < 2) {
        // The sign-in cancelled the request; open a new one after the mail window.
        app.clock.advance(15 * 60_000);
      }
    }
    expect(attempt).toBeGreaterThanOrEqual(11);
    // Next hour: the bucket is fresh and the right code works.
    app.clock.set(new Date(Math.ceil(app.clock.now().getTime() / 3600_000) * 3600_000 + 1000));
    await start(p.email, "codes_email", nextIp());
    const ok = await redeemAndRegister(p, { recoveryCode: p.recoveryCodes[5] });
    expect(ok.reg!.status).toBe(201);
  });

  it("a recovery code works once and is compared normalised; a wrong emailed code dies after five tries", async () => {
    const p = await signUp(app, "r12@example.com");
    await start(p.email, "codes_email");
    const code = codeFrom(lastMail(app, p.email, "recovery.code")!.text);
    for (let i = 0; i < 5; i++) expect((await post("/auth/recovery/redeem", { email: p.email, code: "00000000", recoveryCode: p.recoveryCodes[0] })).status).toBe(401);
    expect((await post("/auth/recovery/redeem", { email: p.email, code, recoveryCode: p.recoveryCodes[0] })).status).toBe(401);     // dead now
    expect((await app.db.owner.query("select count(*)::int as n from recovery_codes where user_id = $1 and used_at is null", [p.userId])).rows[0].n).toBe(10);
    // A new code after the mail window; the spaced, lower-case form of a recovery code is accepted, once.
    app.clock.advance(15 * 60_000);
    await start(p.email, "codes_email");
    const spaced = p.recoveryCodes[2]!.toLowerCase().replace(/(.{4})/g, "$1 ").trim();
    const done = await redeemAndRegister(p, { recoveryCode: spaced });
    expect(done.reg!.status).toBe(201);
    expect((await app.db.owner.query("select count(*)::int as n from recovery_codes where user_id = $1 and used_at is not null", [p.userId])).rows[0].n).toBe(1);
  });

  it("recovery mail to the login address is limited to one per 15 minutes and the outcome is the same for known and unknown addresses", async () => {
    const p = await signUp(app, "r13@example.com");
    const a = await start(p.email, "codes_email");
    const b = await start("ghost-r13@example.com", "codes_email");
    expect(a.status).toBe(b.status); expect(a.text).toBe(b.text);
    expect(app.email.to("ghost-r13@example.com")).toHaveLength(0);
    const code1 = codeFrom(lastMail(app, p.email, "recovery.code")!.text);
    // The code dies; a new one within 15 minutes is not sent.
    for (let i = 0; i < 5; i++) await post("/auth/recovery/redeem", { email: p.email, code: "00000000", recoveryCode: p.recoveryCodes[0] });
    await start(p.email, "codes_email");
    expect(app.email.to(p.email).filter((m) => m.kind === "recovery.code")).toHaveLength(1);
    app.clock.advance(15 * 60_000);
    await start(p.email, "codes_email");
    const codes = app.email.to(p.email).filter((m) => m.kind === "recovery.code");
    expect(codes).toHaveLength(2);
    expect(codeFrom(codes[1]!.text)).not.toBe(code1);
  });

  it("ST-50: filling the class A mail bucket (and class B) does not suppress the recovery-started notice; class B coalesces into a digest and is never dropped", async () => {
    const p = await signUp(app, "r14@example.com");
    await addSecond(p, "r14-second@backup.org");
    await fillClassA(app, p.email);
    await withUser(app.ctx.runtime, p.userId, async (c) => { for (let i = 0; i < 30; i++) await hit(app.ctx, c, p.userId, CLASS_B); });
    app.email.clear();
    const st = await start(p.email, "codes_email");
    expect(st.status).toBe(202);
    for (const a of [p.email, "r14-second@backup.org"]) expect(app.email.to(a).filter((m) => m.kind === "recovery.started"), a).toHaveLength(1);
    // Class A is exhausted, so the emailed code was held back; the request exists.
    expect(lastMail(app, p.email, "recovery.code")).toBeUndefined();
    expect((await app.db.owner.query("select status from recovery_requests where user_id = $1", [p.userId])).rows[0].status).toBe("pending");
    // Ordinary class B notices over the bucket are queued, not dropped, and leave as one digest.
    app.email.clear();
    const s = (await signIn(app, p.auth)).cookie!;     // cancels the request (immediate notice) and is a fresh session
    for (let i = 0; i < 3; i++) expect((await app.call("POST", "/api/v1/recovery-codes", { body: {}, cookie: s })).status).toBe(201);
    expect(app.email.to(p.email).filter((m) => m.kind === "codes.regenerated")).toHaveLength(0);
    expect((await app.db.owner.query("select count(*)::int as n from security_notice_queue where user_id = $1 and sent_at is null", [p.userId])).rows[0].n).toBeGreaterThanOrEqual(3);
    const sent = await flushSecurityDigests(app.ctx);
    expect(sent).toBeGreaterThanOrEqual(2);
    for (const a of [p.email, "r14-second@backup.org"]) {
      const d = app.email.to(a).filter((m) => m.kind === "security.digest");
      expect(d).toHaveLength(1);
      expect(d[0]!.text).toMatch(/recovery codes were replaced \(3 times\)/i);
    }
    expect(await flushSecurityDigests(app.ctx)).toBe(0);
    await clearClassA(app);
  });

  it("a flood of sign-up starts for an address cannot use up the budget for the owner's recovery code", async () => {
    const p = await signUp(app, "r15@example.com");
    const ip = nextIp();
    for (let i = 0; i < 12; i++) await post("/auth/signup/start", { email: p.email }, { ip });
    expect((await post("/auth/signup/start", { email: p.email }, { ip })).status).toBe(429);
    await start(p.email, "codes_email");
    expect(lastMail(app, p.email, "recovery.code")).toBeDefined();
  });

  it("recovery start without JSON, with a bad address or bad path is a 422 that does not depend on the account", async () => {
    const a = await post("/auth/recovery/start", { email: "not-an-address", path: "codes_email" });
    const b = await post("/auth/recovery/start", { email: "x@example.com", path: "nope" });
    expect(a.status).toBe(422); expect(b.status).toBe(422); expect(a.text).toBe(b.text);
  });
});

describe("ST-48 review: what a recovery's session enabled beyond passkeys", () => {
  it("ST-48 review: undoing a recovery also revokes agent and CLI tokens it enabled", async () => {
    const p = await signUp(app, "r-tokens@example.com");
    await start(p.email, "codes_email");
    const r1 = await redeemAndRegister(p, { recoveryCode: p.recoveryCodes[0] });
    expect(r1.reg!.status).toBe(201);
    // The hold ends. The recovery's credential then creates what a signed-in person can: an agent token with a pending purchase
    // request holding a reservation, a CLI sign-in with its refresh token, a connected app with its refresh token, a device
    // grant approved but not yet claimed, and a consent whose code is not yet exchanged.
    app.clock.advance(25 * 3600_000);
    const now = app.clock.now();
    const o = app.db.owner;
    const far = new Date(now.getTime() + 30 * 86_400_000);
    const bytes = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    const client = (await o.query("insert into oauth_clients (client_id, registration, redirect_uris) values ($1, 'dcr', array['https://app.example.net/cb']) returning id", [`review-client-${Date.now()}`])).rows[0].id as string;
    const binding = async (kind: "agent" | "cli", name: string, extra: { cap?: number; reserved?: number; oauth?: boolean } = {}) => {
      const t = mintToken(kind === "cli" ? "cli" : "live");
      const id = (await o.query(
        `insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, spend_cap_minor, reserved_minor, expires_at, family_expires_at, oauth_client_id, created_at, updated_at)
         values ($1,$2,$3,$4,$5,'[]',$6,$7,$8,$8,$9,$10,$10) returning id`,
        [p.userId, kind, name, t.prefix, t.hash, extra.cap ?? 0, extra.reserved ?? 0, far, extra.oauth ? client : null, now])).rows[0].id as string;
      return id;
    };
    const agent = await binding("agent", "Attacker bot", { cap: 100_000, reserved: 5000 });
    const cli = await binding("cli", "CLI login");
    const app1 = await binding("agent", "Connected app", { oauth: true });
    const clr = mintToken("clr"), oref = mintToken("clr");
    await o.query("insert into binding_refresh_tokens (binding_id, user_id, token_prefix, token_hash, created_at, idle_expires_at, expires_at) values ($1,$2,$3,$4,$5,$6,$6)", [cli, p.userId, clr.prefix, clr.hash, now, far]);
    await o.query("insert into oauth_refresh_tokens (binding_id, user_id, client_ref, token_prefix, token_hash, created_at, idle_expires_at, expires_at) values ($1,$2,$3,$4,$5,$6,$7,$7)", [app1, p.userId, client, oref.prefix, oref.hash, now, far]);
    const req = (await o.query(
      `insert into agent_requests (user_id, binding_id, kind, state, request_hash, params, fqdn_ascii, years, quoted_minor, reservation, created_at, expires_at)
       values ($1,$2,'register','pending',$3,'{}','review-undo.com',1,5000,'held',$4,$5) returning id`, [p.userId, agent, bytes(), now, new Date(now.getTime() + 3600_000)])).rows[0].id as string;
    const device = (await o.query("insert into device_requests (device_code_hash, user_code_hash, state, user_id, approved_scopes, created_at, expires_at) values ($1,$2,'approved',$3,'[]',$4,$5) returning id",
      [bytes(), bytes(), p.userId, now, new Date(now.getTime() + 600_000)])).rows[0].id as string;
    const consent = (await o.query(
      `insert into oauth_authorizations (client_ref, redirect_uri, code_challenge, user_id, status, binding_id, code_hash, code_expires_at, created_at, expires_at)
       values ($1,'https://app.example.net/cb',$2,$3,'approved',$4,$5,$6,$7,$6) returning id`, [client, "A".repeat(43), p.userId, app1, bytes(), new Date(now.getTime() + 60_000), now])).rows[0].id as string;

    // The owner signs in with the passkey the recovery suspended: the undo.
    const undo = await signIn(app, p.auth);
    expect(undo.res.status).toBe(200);
    expect(undo.res.json.restored).toBe(true);
    const b = (await o.query("select id, revoked_at, reserved_minor from bindings where id = any($1::uuid[])", [[agent, cli, app1]])).rows;
    expect(b).toHaveLength(3);
    for (const x of b) expect(x.revoked_at, x.id).not.toBeNull();
    expect((await o.query("select revoked_at from binding_refresh_tokens where binding_id = $1", [cli])).rows[0].revoked_at).not.toBeNull();
    expect((await o.query("select revoked_at from oauth_refresh_tokens where binding_id = $1", [app1])).rows[0].revoked_at).not.toBeNull();
    const r = (await o.query("select state, reservation from agent_requests where id = $1", [req])).rows[0];
    expect(["declined", "void"]).toContain(r.state);
    expect(r.reservation).toBe("released");
    expect(String(b.find((x) => x.id === agent)!.reserved_minor)).toBe("0");
    expect((await o.query("select state from device_requests where id = $1", [device])).rows[0].state).toBe("denied");
    expect((await o.query("select status from oauth_authorizations where id = $1", [consent])).rows[0].status).toBe("denied");
    expect(await auditActions(app, p.userId)).toEqual(expect.arrayContaining(["auth.recovery.undone", "binding.revoke_all"]));
    // The owner's fresh session is untouched and the undo notice says the tokens went too.
    expect((await me(app, undo.cookie!)).status).toBe(200);
    expect(app.email.to(p.email).filter((m) => m.kind === "recovery.undone").at(-1)!.text).toMatch(/token/i);
  });
});

describe("ST-48 review: a completed recovery invalidates grants approved but not yet claimed", () => {
  it("ST-48 review: completing a recovery denies approved device grants and open OAuth consents, so a later device poll gets no token", async () => {
    const { tokenHandler } = await import("../bindings/device.ts");
    const { sha256 } = await import("../util/bytes.ts");
    const p = await signUp(app, "r-grants@example.com");
    const o = app.db.owner;
    const now = app.clock.now();
    const bytes = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    await o.query("update users set device_login_enabled = true where id = $1", [p.userId]);
    // Before the recovery (for example by whoever holds the account now): a device grant approved and not yet polled for, a consent
    // claimed on the consent screen, and a consent approved whose code is not yet exchanged.
    const deviceCode = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const device = (await o.query("insert into device_requests (device_code_hash, user_code_hash, state, user_id, approved_scopes, created_at, expires_at) values ($1,$2,'approved',$3,'[]',$4,$5) returning id",
      [sha256(deviceCode), bytes(), p.userId, now, new Date(now.getTime() + 600_000)])).rows[0].id as string;
    const client = (await o.query("insert into oauth_clients (client_id, registration, redirect_uris) values ($1, 'dcr', array['https://app.example.net/cb']) returning id", [`recovery-grants-${Date.now()}`])).rows[0].id as string;
    const t = mintToken("cli");
    const grant = (await o.query(
      `insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, expires_at, family_expires_at, oauth_client_id, audience, created_at, updated_at)
       values ($1,'agent','Connected app',$2,$3,'[]',$4,$5,$6,$7,$4,$4) returning id`,
      [p.userId, t.prefix, t.hash, now, new Date(now.getTime() + 30 * 86_400_000), client, `${app.ctx.config.origin}/mcp`])).rows[0].id as string;
    const consent = async (status: "pending" | "approved") => (await o.query(
      `insert into oauth_authorizations (client_ref, redirect_uri, code_challenge, user_id, status, binding_id, code_hash, code_expires_at, created_at, expires_at)
       values ($1,'https://app.example.net/cb',$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [client, "A".repeat(43), p.userId, status, status === "approved" ? grant : null, status === "approved" ? bytes() : null, status === "approved" ? new Date(now.getTime() + 60_000) : null, now, new Date(now.getTime() + 600_000)])).rows[0].id as string;
    const claimed = await consent("pending"), approved = await consent("approved");

    await start(p.email, "codes_email");
    const r = await redeemAndRegister(p, { recoveryCode: p.recoveryCodes[0] });
    expect(r.reg!.status).toBe(201);

    expect((await o.query("select state from device_requests where id = $1", [device])).rows[0].state).toBe("denied");
    const st = (await o.query("select id, status from oauth_authorizations where id = any($1::uuid[])", [[claimed, approved]])).rows;
    expect(Object.fromEntries(st.map((x) => [x.id, x.status]))).toEqual({ [claimed]: "denied", [approved]: "denied" });
    // The device that asked before the recovery polls afterwards: no token, no binding.
    const before = (await o.query("select count(*)::int n from bindings where user_id = $1", [p.userId])).rows[0].n as number;
    const poll = tokenHandler({ ctx: app.ctx, body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: "mosshatch-cli" } } as never);
    await expect(poll).rejects.toMatchObject({ status: 400, code: "access_denied" });
    expect((await o.query("select count(*)::int n from bindings where user_id = $1", [p.userId])).rows[0].n).toBe(before);
    expect((await o.query("select count(*)::int n from bindings where user_id = $1 and revoked_at is null", [p.userId])).rows[0].n).toBe(0);
  });
});
