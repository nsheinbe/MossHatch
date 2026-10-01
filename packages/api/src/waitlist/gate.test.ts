import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestApp } from "../testing/app.ts";
import { authenticator, codeFrom, lastMail, newApp, nextIp, signUp, xff } from "../auth/testkit.ts";
import { waitlistFetch } from "./http.ts";
import { createInvites, waitlistStats } from "./owner.ts";
import { inviteOnlyFromEnv, parseInvite, INVITE_TTL_MS } from "./gate.ts";
import type { WaitlistDeps } from "./service.ts";
import { FakeEmail } from "../email.ts";
import { PRE_AUTH_COOKIE } from "../http/session.ts";
import { cookieFrom } from "../testing/app.ts";

/**
 * Invite-only rollout: invites for the next people in line, single use, 14-day expiry, bound to the invited address, and the
 * sign-up guard on and off. WL-10 invite creation, WL-11 single use, WL-12 expiry, WL-13 email binding, WL-14 gate on/off.
 */
const ORIGIN = "https://mosshatch.test";
let app: TestApp;
let d: WaitlistDeps;
const mail = new FakeEmail();

beforeAll(async () => {
  app = await newApp();
  d = { pool: app.db.runtime, clock: app.clock, email: mail, secret: Buffer.alloc(32, 3), origin: ORIGIN };
}, 120_000);
afterAll(async () => { await app?.drop(); });
beforeEach(async () => {
  (app.ctx.services as { inviteOnly?: boolean }).inviteOnly = true;
  await app.db.owner.query("delete from rate_counters where bucket like 'waitlist.%'");
  mail.clear();
});

let ipN = 0;
async function confirmed(email: string) {
  const h = { "content-type": "application/json", "x-forwarded-for": `192.0.2.${++ipN}` };
  await waitlistFetch(d, new Request(ORIGIN + "/api/waitlist", { method: "POST", headers: h, body: JSON.stringify({ email, consent: true }) }));
  const t = /confirm\?t=([A-Za-z0-9_-]{43})/.exec(mail.to(email).at(-1)!.text)![1]!;
  await waitlistFetch(d, new Request(ORIGIN + "/api/waitlist/confirm", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `192.0.2.${++ipN}` }, body: `t=${t}` }));
  app.clock.advance(1000);
}
const inviteFor = (email: string) => /\/invite\?t=(\S+)/.exec(mail.to(email).at(-1)!.text)![1]!;

async function signUpWith(email: string, invite?: string, verifyInvite: string | null | undefined = invite) {
  const ip = nextIp();
  const s = await app.call("POST", "/api/v1/auth/signup/start", { body: { email, invite }, headers: xff(ip) });
  if (s.status !== 202) return { stage: "start", status: s.status, code: s.json?.error?.code };
  const code = codeFrom(lastMail(app, email, "signup.code")!.text);
  const v = await app.call("POST", "/api/v1/auth/signup/verify", { body: { email, code, invite: verifyInvite }, headers: xff(ip) });
  if (v.status !== 200) return { stage: "verify", status: v.status, code: v.json?.error?.code };
  const reg = await app.call("POST", "/api/v1/auth/register/verify", { body: { response: authenticator().create(v.json.options) }, cookie: cookieFrom(v.setCookies, PRE_AUTH_COOKIE)!, headers: xff(ip) });
  return { stage: "done", status: reg.status, code: undefined };
}

describe("invite-only rollout", () => {
  it("WL-10 invites go to the next confirmed people in line, once each, with only the token hash stored", async () => {
    await confirmed("first@example.com");
    await confirmed("second@example.com");
    await confirmed("third@example.com");
    expect(await createInvites(app.db.cron, mail, ORIGIN, { next: 2 }, app.clock.now())).toEqual({ invited: 2, failed: 0, skipped: 0 });
    const m = mail.to("first@example.com").at(-1)!;
    expect(m.subject).toBe("Your egg is ready to hatch");
    expect(m.text).toContain(`${ORIGIN}/invite?t=`);
    expect(mail.to("second@example.com").at(-1)!.subject).toBe("Your egg is ready to hatch");
    expect(mail.to("third@example.com").at(-1)!.subject).not.toBe("Your egg is ready to hatch");
    const tok = parseInvite(inviteFor("first@example.com"))!;
    expect(JSON.stringify((await app.db.owner.query("select * from waitlist_invites")).rows)).not.toContain(tok.secret);
    // The next run picks up where the last one stopped.
    expect((await createInvites(app.db.cron, mail, ORIGIN, { next: 5 }, app.clock.now())).invited).toBe(1);
    expect(mail.to("third@example.com").at(-1)!.subject).toBe("Your egg is ready to hatch");
    // A failed send leaves the person uninvited.
    await confirmed("fourth@example.com");
    const broken = { send: async () => { throw new Error("down"); } };
    expect(await createInvites(app.db.cron, broken, ORIGIN, { next: 5 }, app.clock.now())).toEqual({ invited: 0, failed: 1, skipped: 0 });
    expect((await app.db.owner.query("select invited_at from waitlist where email = 'fourth@example.com'")).rows[0].invited_at).toBeNull();
    // --email for one address; an unconfirmed address is skipped.
    expect((await createInvites(app.db.cron, mail, ORIGIN, { email: "nobody@example.com" }, app.clock.now())).skipped).toBe(1);
  });

  it("WL-14 gate on: sign-up without an invite is refused at start and at verify, and never creates an account", async () => {
    const r = await signUpWith("uninvited@example.com");
    expect(r).toEqual({ stage: "start", status: 403, code: "invite_required" });
    expect(lastMail(app, "uninvited@example.com", "signup.code")).toBeUndefined();
    expect((await app.db.owner.query("select count(*)::int as n from users where email = 'uninvited@example.com'")).rows[0].n).toBe(0);
    expect((await signUpWith("uninvited@example.com", "garbage")).code).toBe("invite_required");
  });

  it("WL-11 WL-13 an invite works once, only for its own address, and is used in the activation transaction", async () => {
    await confirmed("inv-a@example.com");
    await confirmed("inv-b@example.com");
    await createInvites(app.db.cron, mail, ORIGIN, { next: 5 }, app.clock.now());
    const a = inviteFor("inv-a@example.com");
    // Bound to its address: B cannot use A's invite (start and verify both check).
    expect(await signUpWith("inv-b@example.com", a)).toEqual({ stage: "start", status: 403, code: "invite_required" });
    // A wrong secret with the right id fails.
    const tok = parseInvite(a)!;
    const wrong = `${tok.id}.${tok.secret.slice(0, -1)}${tok.secret.endsWith("A") ? "B" : "A"}`;
    expect((await signUpWith("inv-a@example.com", wrong)).code).toBe("invite_required");
    // Start with the invite but verify without it: refused, and the account stays pending (activation rolled back), invite unused.
    expect(await signUpWith("inv-a@example.com", a, null)).toEqual({ stage: "verify", status: 403, code: "invite_required" });
    expect((await app.db.owner.query("select status from users where email = 'inv-a@example.com'")).rows[0].status).toBe("pending");
    expect((await app.db.owner.query("select used_at from waitlist_invites i join waitlist w on w.id = i.waitlist_id where w.email = 'inv-a@example.com'")).rows[0].used_at).toBeNull();
    expect(await signUpWith("inv-a@example.com", a)).toEqual({ stage: "done", status: 201, code: undefined });
    const used = (await app.db.owner.query("select i.used_at, i.used_by, u.id from waitlist_invites i join waitlist w on w.id = i.waitlist_id join users u on u.email = w.email where w.email = 'inv-a@example.com'")).rows[0];
    expect(used.used_at).not.toBeNull();
    expect(used.used_by).toBe(used.id);
    // Used once: a second sign-up with it (say after closing the account) is refused. (An hour on, so the per-address mail limit is not what refuses it.)
    app.clock.advance(3600_000);
    expect((await signUpWith("inv-a@example.com", a)).code).toBe("invite_required");
    const s = await waitlistStats(app.db.cron, app.clock.now());
    expect(s.totals.accepted).toBe(1);
  });

  it("WL-12 an invite expires after 14 days", async () => {
    await confirmed("late-inv@example.com");
    await createInvites(app.db.cron, mail, ORIGIN, { email: "late-inv@example.com" }, app.clock.now());
    const t = inviteFor("late-inv@example.com");
    app.clock.advance(INVITE_TTL_MS + 1000);
    expect((await signUpWith("late-inv@example.com", t)).code).toBe("invite_required");
    // The owner can send a fresh one.
    expect((await createInvites(app.db.cron, mail, ORIGIN, { email: "late-inv@example.com" }, app.clock.now())).invited).toBe(1);
    expect((await signUpWith("late-inv@example.com", inviteFor("late-inv@example.com"))).stage).toBe("done");
  });

  it("WL-14 gate off: sign-up works without an invite (local and preview default), and the switch reads MH_INVITE_ONLY", async () => {
    (app.ctx.services as { inviteOnly?: boolean }).inviteOnly = false;
    const p = await signUp(app, "open@example.com");
    expect(p.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(inviteOnlyFromEnv({}, "production")).toBe(true);
    expect(inviteOnlyFromEnv({}, "staging")).toBe(true);
    expect(inviteOnlyFromEnv({}, "preview")).toBe(false);
    expect(inviteOnlyFromEnv({}, "local")).toBe(false);
    expect(inviteOnlyFromEnv({ MH_INVITE_ONLY: "0" }, "production")).toBe(false);
    expect(inviteOnlyFromEnv({ MH_INVITE_ONLY: "1" }, "local")).toBe(true);
  });

  it("WL-13 unsubscribing cancels an unused invite", async () => {
    await confirmed("leaver@example.com");
    await createInvites(app.db.cron, mail, ORIGIN, { email: "leaver@example.com" }, app.clock.now());
    const invite = inviteFor("leaver@example.com");
    const u = /unsubscribe\?t=([A-Za-z0-9_-]{43})/.exec(mail.to("leaver@example.com").at(-1)!.text)![1]!;
    await waitlistFetch(d, new Request(ORIGIN + "/api/waitlist/unsubscribe", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "192.0.2.250" }, body: `t=${u}` }));
    expect((await signUpWith("leaver@example.com", invite)).code).toBe("invite_required");
  });
});
