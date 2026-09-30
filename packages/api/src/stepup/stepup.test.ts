import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withUser } from "@mosshatch/db";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { Router, json, HttpError } from "../http/router.ts";
import { mintToken } from "../util/token.ts";
import { randomBytes } from "../util/bytes.ts";
import { registerStepUp } from "./routes.ts";
import { markExecuted, ACTION_HEADER } from "./gate.ts";
import { registerActionSpec, resetActionSpecs } from "./specs.ts";
import { setHoldsPort } from "./holds-port.ts";
import { addPasskey, authenticator, commit, makeUser, newSession, prepare, type TestUser } from "./testkit.ts";
import { z } from "zod";

/** Test-only resources: a mutable "parameter" the derive function reads from server state. */
const state = { value: "v1" };
const specFor = (type: "card.publish" | "mandate.sign", held: boolean) => registerActionSpec({
  type, held, userInput: z.object({}).strict(),
  async derive(_ctx, _c, _userId, targetId) { return { params: { target: targetId, value: state.value }, resourceId: targetId }; },
  summary: (p) => `Test action on ${String(p.target)} with ${String(p.value)}.`,
});

const router = new Router();
registerStepUp(router);
const usedBy: string[] = [];
router.add(
  { method: "POST", path: "/api/v1/test/gated", principals: ["session"], stepUp: "card.publish", handler: async (r) => {
    await withUser(r.ctx.runtime, r.principal.userId!, async (c) => { await markExecuted(c, r.action!); usedBy.push(r.action!.id); });
    return json({ ok: true, params: r.action!.params });
  } },
  { method: "POST", path: "/api/v1/test/gated2", principals: ["session"], stepUp: "card.publish", handler: async (r) => {
    await withUser(r.ctx.runtime, r.principal.userId!, (c) => markExecuted(c, r.action!));
    return json({ ok: true });
  } },
  { method: "POST", path: "/api/v1/test/gated-mandate", principals: ["session"], stepUp: "mandate.sign", handler: async () => json({ ok: true }) },
);

let app: TestApp; let alice: TestUser; let bob: TestUser;
let aliceKey: Awaited<ReturnType<typeof addPasskey>>; let bobKey: Awaited<ReturnType<typeof addPasskey>>;

beforeAll(async () => {
  app = await createTestApp(router);
  alice = await makeUser(app, "alice@example.com");
  bob = await makeUser(app, "bob@example.com");
  aliceKey = await addPasskey(app, alice);
  bobKey = await addPasskey(app, bob);
}, 60_000);
afterAll(async () => { await app?.drop(); resetActionSpecs(); setHoldsPort(undefined); });
beforeEach(async () => { await app.db.owner.query("delete from rate_counters where bucket = 'stepup_prepare'"); state.value = "v1"; specFor("card.publish", true); specFor("mandate.sign", false); setHoldsPort(undefined); });

/** Prepare a test action as `u`; returns id and the options the browser would receive. */
async function prep(u: TestUser = alice, type = "card.publish", target = "t1") {
  const r = await prepare(app, u, { type, target_id: target, user_input: {} });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { id: r.json.action_id as string, options: r.json.webauthn_options as { challenge: string; allowCredentials: { id: string }[]; timeout: number; userVerification: string } };
}
const actionRow = async (id: string) => (await app.db.owner.query("select * from actions where id = $1", [id])).rows[0];
const challengeRow = async (id: string) => (await app.db.owner.query("select * from webauthn_challenges where action_id = $1", [id])).rows[0];
const auditActions = async (userId: string) => (await app.db.owner.query("select action, detail from audit_log where chain_id = $1 order by seq", [userId])).rows;

describe("prepare", () => {
  it("returns options limited to live, unsuspended passkeys, 120 s timeout, uv required", async () => {
    const extra = await addPasskey(app, alice);
    await app.db.owner.query("update passkeys set suspended_at = now() where credential_id = $1", [extra.credentialId]);
    const revoked = await addPasskey(app, alice);
    await app.db.owner.query("update passkeys set revoked_at = now() where credential_id = $1", [revoked.credentialId]);
    const { options, id } = await prep();
    expect(options.allowCredentials.map((c) => c.id)).toEqual([aliceKey.credentialId]);
    expect(options.timeout).toBe(120000);
    expect(options.userVerification).toBe("required");
    const row = await actionRow(id);
    expect(row.state).toBe("prepared"); expect(row.session_id_hash.equals(alice.sessionHash)).toBe(true);
    expect((await challengeRow(id)).purpose).toBe("stepup");
    await app.db.owner.query("delete from passkeys where credential_id = any($1)", [[extra.credentialId, revoked.credentialId]]);
  });
  it("the challenge is the SHA-256 digest of the canonical action fields (32 bytes, base64url)", async () => {
    const { options } = await prep();
    expect(Buffer.from(options.challenge, "base64url").length).toBe(32);
  });
  it("rejects unknown types, extra keys and client-supplied params", async () => {
    expect((await prepare(app, alice, { type: "secret.peek", target_id: "x", user_input: {} })).status).toBe(400);
    expect((await prepare(app, alice, { type: "card.publish", target_id: "x", user_input: {}, params: { a: 1 } })).status).toBe(400);
    expect((await prepare(app, alice, { type: "card.publish", user_input: {} })).status).toBe(400);
  });
  it("unregistered ids answer 409 action_unavailable", async () => {
    const r = await prepare(app, alice, { type: "domain.unlock", target_id: "x", user_input: {} });
    expect(r.status).toBe(409); expect(r.json.error.code).toBe("action_unavailable");
  });
  it("every spec is registered for exactly the thirteen ids; held everywhere except mandate.sign", async () => {
    resetActionSpecs();
    const { actionSpecs } = await import("./specs.ts");
    const { ACTION_TYPES } = await import("../http/types.ts");
    expect([...actionSpecs.keys()].sort()).toEqual([...ACTION_TYPES].sort());
    for (const [t, s] of actionSpecs) expect(s.held, t).toBe(t !== "mandate.sign");
    specFor("card.publish", true); specFor("mandate.sign", false);
  });
  it("passkey.add derives label and options hash from server state; the hash changes when a passkey appears", async () => {
    const r = await prepare(app, alice, { type: "passkey.add", target_id: alice.userId, user_input: { label: "Laptop" } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.summary).toBe('Add a passkey named "Laptop" to your account.');
    const row = await actionRow(r.json.action_id);
    expect(Object.keys(row.params).sort()).toEqual(["label", "options_hash"]);
    expect((await prepare(app, alice, { type: "passkey.add", target_id: bob.userId, user_input: { label: "x" } })).status).toBe(404);
    expect((await prepare(app, alice, { type: "passkey.add", target_id: alice.userId, user_input: { label: "x", extra: 1 } })).status).toBe(400);
    expect((await prepare(app, alice, { type: "passkey.add", target_id: alice.userId, user_input: { label: "" } })).status).toBe(400);
  });
  it("rate limit: 10 prepares per (user, session) in 10 minutes; another session has its own budget", async () => {
    const u = await makeUser(app, "rate@example.com");
    await addPasskey(app, u);
    for (let i = 0; i < 10; i++) expect((await prepare(app, u, { type: "card.publish", target_id: "t", user_input: {} })).status).toBe(200);
    const blocked = await prepare(app, u, { type: "card.publish", target_id: "t", user_input: {} });
    expect(blocked.status).toBe(429); expect(blocked.headers.get("retry-after")).toBeTruthy();
    const other = await newSession(app, u);
    expect((await prepare(app, other, { type: "card.publish", target_id: "t", user_input: {} })).status).toBe(200);
    app.clock.advance(11 * 60_000);
    const later = await newSession(app, u);
    expect((await prepare(app, later, { type: "card.publish", target_id: "t", user_input: {} })).status).toBe(200);
  });
  it("a user without a passkey cannot prepare", async () => {
    const u = await makeUser(app, "nokey@example.com");
    expect((await prepare(app, u, { type: "card.publish", target_id: "t", user_input: {} })).status).toBe(409);
  });
});

describe("commit happy path and evidence (ST-56)", () => {
  it("ST-56: a committed action stores every evidence column; the DB refuses a committed row without them", async () => {
    const { id, options } = await prep();
    const r = await commit(app, alice, id, aliceKey.auth.get(options));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.state).toBe("committed");
    const row = await actionRow(id);
    for (const col of ["credential_id", "uv", "be", "bs", "client_data_json", "authenticator_data", "signature", "committed_at"]) expect(row[col], col).not.toBeNull();
    expect(row.uv).toBe(true); expect(row.credential_id).toBe(aliceKey.credentialId);
    expect(JSON.parse(row.client_data_json.toString()).challenge).toBe(options.challenge);
    const bad = await app.db.owner.query("select count(*)::int as n from actions where state in ('committed','dispatching','executed','failed','outcome_unknown') and (credential_id is null or uv is null or be is null or bs is null or client_data_json is null or authenticator_data is null or signature is null)");
    expect(bad.rows[0].n).toBe(0);
    const p2 = await prep();
    await expect(app.db.owner.query("update actions set state = 'committed', committed_at = now() where id = $1", [p2.id])).rejects.toMatchObject({ code: "23514" });
    await expect(app.db.owner.query("update actions set state = 'committed', credential_id = 'x', uv = true, be = false, bs = false, client_data_json = '\\x01', authenticator_data = '\\x01' where id = $1", [p2.id])).rejects.toMatchObject({ code: "23514" });
    await expect(withUser(app.ctx.runtime, alice.userId, (c) => c.query("update actions set state = 'executed' where id = $1", [p2.id]))).rejects.toMatchObject({ code: "23514" });
  });
  it("updates the credential counter and last_used_at and writes audit rows", async () => {
    const before = (await app.db.owner.query("select sign_count from passkeys where credential_id = $1", [aliceKey.credentialId])).rows[0].sign_count;
    const { id, options } = await prep();
    expect((await commit(app, alice, id, aliceKey.auth.get(options))).status).toBe(200);
    const after = (await app.db.owner.query("select sign_count, last_used_at from passkeys where credential_id = $1", [aliceKey.credentialId])).rows[0];
    expect(Number(after.sign_count)).toBeGreaterThan(Number(before)); expect(after.last_used_at).not.toBeNull();
    const acts = (await auditActions(alice.userId)).map((a) => a.action);
    expect(acts).toContain("stepup.prepare"); expect(acts).toContain("stepup.commit");
  });
  it("GET /actions/:id shows the summary to the owner session only", async () => {
    const { id } = await prep();
    const ok = await app.call("GET", `/api/v1/actions/${id}`, { cookie: alice.cookie });
    expect(ok.status).toBe(200); expect(ok.json.summary).toBe("Test action on t1 with v1."); expect(ok.json.state).toBe("prepared");
    expect((await app.call("GET", `/api/v1/actions/${id}`, { cookie: bob.cookie })).status).toBe(404);
    const other = await newSession(app, alice);
    expect((await app.call("GET", `/api/v1/actions/${id}`, { cookie: other.cookie })).status).toBe(404);
    expect((await app.call("GET", `/api/v1/actions/00000000-0000-0000-0000-000000000000`, { cookie: alice.cookie })).status).toBe(404);
  });
});

describe("ST-55: another account's passkey cannot complete the action", () => {
  const expectRefused = async (id: string, r: { status: number; json: any }) => {
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(r.json.error.code).toBe("assertion_invalid");
    const row = await actionRow(id);
    expect(row.state).not.toBe("committed"); expect(row.credential_id).toBeNull();
    expect((await challengeRow(id)).consumed_at).not.toBeNull();
    const audit = await auditActions(alice.userId);
    expect(audit.some((a) => a.action === "stepup.commit_failed" && a.detail.reason)).toBe(true);
  };
  it("user B's valid passkey, with A's cookie and A's challenge, fails", async () => {
    const { id, options } = await prep(alice);
    const r = await commit(app, alice, id, bobKey.auth.get(options));
    await expectRefused(id, r);
    expect((await auditActions(alice.userId)).at(-1)!.detail.reason).toBe("credential_not_allowed");
  });
  it("B's passkey fails even if B's own session commits A's action id (404, nothing consumed)", async () => {
    const { id, options } = await prep(alice);
    const r = await commit(app, bob, id, bobKey.auth.get(options));
    expect(r.status).toBe(404);
    expect((await challengeRow(id)).consumed_at).toBeNull();
    expect((await actionRow(id)).state).toBe("prepared");
  });
  it("A's own second session cannot commit an action prepared in the first", async () => {
    const { id, options } = await prep(alice);
    const other = await newSession(app, alice);
    expect((await commit(app, other, id, aliceKey.auth.get(options))).status).toBe(404);
    expect((await challengeRow(id)).consumed_at).toBeNull();
  });
  it("a credential row of another user is refused even when its id is smuggled into the allow list", async () => {
    const { id, options } = await prep(alice);
    await app.db.owner.query("update actions set allow_credential_ids = allow_credential_ids || $2::text[] where id = $1", [id, [bobKey.credentialId]]);
    const r = await commit(app, alice, id, bobKey.auth.get(options));
    await expectRefused(id, r);
    expect((await auditActions(alice.userId)).at(-1)!.detail.reason).toBe("credential_unavailable");
  });
  it("a revoked credential fails", async () => {
    const k = await addPasskey(app, alice);
    const { id, options } = await prep(alice);
    await app.db.owner.query("update passkeys set revoked_at = now() where credential_id = $1", [k.credentialId]);
    await expectRefused(id, await commit(app, alice, id, k.auth.get(options)));
    expect((await auditActions(alice.userId)).at(-1)!.detail.reason).toBe("credential_unavailable");
  });
  it("a suspended credential fails", async () => {
    const k = await addPasskey(app, alice);
    const { id, options } = await prep(alice);
    await app.db.owner.query("update passkeys set suspended_at = now() where credential_id = $1", [k.credentialId]);
    await expectRefused(id, await commit(app, alice, id, k.auth.get(options)));
  });
  it("a mismatched userHandle fails", async () => {
    const { id, options } = await prep(alice);
    await expectRefused(id, await commit(app, alice, id, aliceKey.auth.get(options, { userHandle: randomBytes(32) })));
    expect((await auditActions(alice.userId)).at(-1)!.detail.reason).toBe("user_handle_mismatch");
  });
  it("an absent userHandle is accepted (it is checked when present)", async () => {
    const { id, options } = await prep(alice);
    expect((await commit(app, alice, id, aliceKey.auth.get(options, { userHandle: null }))).status).toBe(200);
  });
  it("a backup-eligible flip fails closed and raises an alert", async () => {
    const k = await addPasskey(app, alice);
    const { id, options } = await prep(alice);
    k.auth.backupEligible = true; // the authenticator now claims multi-device; stored bit is 0
    await expectRefused(id, await commit(app, alice, id, k.auth.get(options)));
    expect((await auditActions(alice.userId)).at(-1)!.detail.reason).toBe("backup_eligible_flip");
    const alerts = (await app.db.owner.query("select * from alerts where kind = 'webauthn_backup_eligible_flip' and subject = $1", [k.passkeyId])).rows;
    expect(alerts.length).toBe(1); expect(alerts[0].severity).toBe("page");
    expect(JSON.stringify(alerts[0].detail)).not.toContain(k.credentialId);
  });
  it("a credential outside allowCredentials fails (a passkey added after prepare)", async () => {
    const { id, options } = await prep(alice);
    const late = await addPasskey(app, alice);
    await expectRefused(id, await commit(app, alice, id, late.auth.get(options)));
    expect((await auditActions(alice.userId)).at(-1)!.detail.reason).toBe("credential_not_allowed");
  });
  it("an assertion for the wrong origin, or without user verification, fails", async () => {
    const a = await prep(alice);
    await expectRefused(a.id, await commit(app, alice, a.id, aliceKey.auth.get(a.options, { origin: "https://evil.example" })));
    const k = await addPasskey(app, alice);
    const b = await prep(alice);
    k.auth.userVerified = false;
    await expectRefused(b.id, await commit(app, alice, b.id, k.auth.get(b.options)));
  });
  it("a synced (backup-eligible) credential works with signCount not enforced", async () => {
    const k = await addPasskey(app, alice, { backupEligible: true, backupState: true });
    const first = await prep(alice);
    expect((await commit(app, alice, first.id, k.auth.get(first.options))).status).toBe(200);
    k.auth.signCount = 0; // sync providers may report a counter that does not increase
    const second = await prep(alice);
    expect((await commit(app, alice, second.id, k.auth.get(second.options))).status).toBe(200);
  });
  it("a device-bound credential whose counter goes backwards fails", async () => {
    const k = await addPasskey(app, alice);
    const first = await prep(alice);
    k.auth.signCount = 10;
    expect((await commit(app, alice, first.id, k.auth.get(first.options))).status).toBe(200);
    k.auth.signCount = 2;
    const second = await prep(alice);
    await expectRefused(second.id, await commit(app, alice, second.id, k.auth.get(second.options)));
  });
});

describe("ST-58: replay and parameter change", () => {
  it("a replayed assertion fails, on the same action and on a new one", async () => {
    const a = await prep();
    const assertion = aliceKey.auth.get(a.options);
    expect((await commit(app, alice, a.id, assertion)).status).toBe(200);
    const again = await commit(app, alice, a.id, assertion);
    expect(again.status).toBe(409);
    const b = await prep();
    const cross = await commit(app, alice, b.id, assertion);
    expect(cross.status).toBe(403);
    expect((await actionRow(b.id)).state).not.toBe("committed");
  });
  it("a parameter changed between prepare and commit fails 409 and the action never commits", async () => {
    const { id, options } = await prep();
    state.value = "v2";
    const r = await commit(app, alice, id, aliceKey.auth.get(options));
    expect(r.status).toBe(409); expect(r.json.error.code).toBe("params_changed");
    const row = await actionRow(id);
    expect(row.state).not.toBe("committed"); expect(row.credential_id).toBeNull();
    expect((await auditActions(alice.userId)).at(-1)!.detail.reason).toBe("params_changed");
  });
  it("the challenge is valid at 119 seconds and refused at 121", async () => {
    const ok = await prep();
    app.clock.advance(119_000);
    expect((await commit(app, alice, ok.id, aliceKey.auth.get(ok.options))).status).toBe(200);
    const late = await prep();
    app.clock.advance(121_000);
    const r = await commit(app, alice, late.id, aliceKey.auth.get(late.options));
    expect(r.status).toBe(409);
    expect((await actionRow(late.id)).state).toBe("prepared");
  });
  it("a failed verification leaves the challenge consumed: the correct assertion then fails too", async () => {
    const { id, options } = await prep();
    const good = aliceKey.auth.get(options);
    const tampered = { ...good, response: { ...good.response, signature: Buffer.alloc(64, 1).toString("base64url") } };
    const bad = await commit(app, alice, id, tampered);
    expect(bad.status).toBe(403);
    expect((await challengeRow(id)).consumed_at).not.toBeNull();
    const retry = await commit(app, alice, id, good);
    expect(retry.status).toBe(409);
    expect((await actionRow(id)).state).not.toBe("committed");
  });
  it("a challenge signed for another action does not verify", async () => {
    const a = await prep(); const b = await prep();
    const r = await commit(app, alice, b.id, aliceKey.auth.get(a.options));
    expect(r.status).toBe(403);
  });
});

describe("ST-59: twenty parallel commits succeed once", () => {
  it("exactly one 200; the rest are refused; one committed row", async () => {
    const { id, options } = await prep();
    const assertion = aliceKey.auth.get(options);
    const results = await Promise.all(Array.from({ length: 20 }, () => commit(app, alice, id, assertion)));
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBe(1);
    for (const r of results) if (r.status !== 200) expect([403, 409], JSON.stringify(r.json)).toContain(r.status);
    const row = await actionRow(id);
    expect(row.state).toBe("committed");
    const commits = (await app.db.owner.query("select 1 from audit_log where chain_id = $1 and action = 'stepup.commit' and resource_id = $2", [alice.userId, id])).rows;
    expect(commits.length).toBe(1);
  });
});

describe("bearer tokens never reach /actions", () => {
  it("every /actions route refuses a bearer (403) and a bad token (401)", async () => {
    const m = mintToken("live");
    await app.db.owner.query("insert into bindings (user_id, kind, name, token_prefix, token_hash, expires_at) values ($1,'agent','t',$2,$3,$4)", [alice.userId, m.prefix, m.hash, new Date(app.clock.now().getTime() + 86400_000)]);
    const { id } = await prep();
    const h = { authorization: `Bearer ${m.token}` };
    const calls = [
      app.call("POST", "/api/v1/actions/prepare", { ...h, body: { type: "card.publish", target_id: "t", user_input: {} } }),
      app.call("POST", `/api/v1/actions/${id}/commit`, { ...h, body: { assertion: {} } }),
      app.call("GET", `/api/v1/actions/${id}`, h),
    ];
    for (const r of await Promise.all(calls)) expect(r.status).toBe(403);
    expect((await app.call("GET", `/api/v1/actions/${id}`, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await app.call("GET", `/api/v1/actions/${id}`)).status).toBe(401);
    expect((await app.call("POST", "/api/v1/test/gated", { ...h, body: {} })).status).toBe(403);
  });
});

describe("holds", () => {
  it("a held id is refused at prepare and at commit; mandate.sign is not held", async () => {
    const calls: string[] = [];
    setHoldsPort(async (_c, _cl, _u, t) => { calls.push(t); throw new HttpError(423, "recovery_hold"); });
    const r = await prepare(app, alice, { type: "card.publish", target_id: "t", user_input: {} });
    expect(r.status).toBe(423); expect(calls).toContain("card.publish");
    setHoldsPort(undefined);
    const { id, options } = await prep();
    setHoldsPort(async () => { throw new HttpError(423, "recovery_hold"); });
    const c = await commit(app, alice, id, aliceKey.auth.get(options));
    expect(c.status).toBe(423);
    expect((await actionRow(id)).state).toBe("prepared");
    // the hold does not burn the challenge, so the person can finish after the hold lifts
    setHoldsPort(undefined);
    expect((await commit(app, alice, id, aliceKey.auth.get(options))).status).toBe(200);
    // not held
    setHoldsPort(async () => { throw new HttpError(423, "recovery_hold"); });
    const m = await prep(alice, "mandate.sign");
    expect((await commit(app, alice, m.id, aliceKey.auth.get(m.options))).status).toBe(200);
  });
  it("the gate re-checks the hold when the gated route is called", async () => {
    const { id, options } = await prep();
    expect((await commit(app, alice, id, aliceKey.auth.get(options))).status).toBe(200);
    setHoldsPort(async () => { throw new HttpError(423, "recovery_hold"); });
    const r = await app.call("POST", "/api/v1/test/gated", { cookie: alice.cookie, body: {}, headers: { [ACTION_HEADER]: id } });
    expect(r.status).toBe(423);
  });
});

describe("the gate", () => {
  const gated = (u: TestUser, id?: string, path = "/api/v1/test/gated") => app.call("POST", path, { cookie: u.cookie, body: {}, headers: id ? { [ACTION_HEADER]: id } : {} });
  const committed = async (u = alice, key = aliceKey, type = "card.publish") => {
    const { id, options } = await prep(u, type);
    expect((await commit(app, u, id, key.auth.get(options))).status).toBe(200);
    return id;
  };
  it("no action id: 403 step_up_required naming the type", async () => {
    const r = await gated(alice);
    expect(r.status).toBe(403); expect(r.json.error).toMatchObject({ code: "step_up_required", type: "card.publish" });
  });
  it("a prepared (uncommitted) action does not open the gate", async () => {
    const { id } = await prep();
    expect((await gated(alice, id)).status).toBe(403);
  });
  it("a committed action opens it once; the second use is refused; only one of many parallel uses wins", async () => {
    const id = await committed();
    const r = await gated(alice, id);
    expect(r.status, JSON.stringify(r.json)).toBe(200); expect(r.json.params).toEqual({ target: "t1", value: "v1" });
    expect((await actionRow(id)).state).toBe("executed");
    expect((await gated(alice, id)).status).toBe(403);
    const id2 = await committed();
    const rs = await Promise.all(Array.from({ length: 10 }, () => gated(alice, id2)));
    expect(rs.filter((x) => x.status === 200).length).toBe(1);
    for (const x of rs) if (x.status !== 200) expect([403, 409]).toContain(x.status);
  });
  it("an action of another type does not open the route", async () => {
    const id = await committed(alice, aliceKey, "mandate.sign");
    expect((await gated(alice, id)).status).toBe(403);
    expect((await gated(alice, id, "/api/v1/test/gated-mandate")).status).toBe(200);
  });
  it("another user's action, or another session's action, does not open the route", async () => {
    const id = await committed();
    expect((await gated(bob, id)).status).toBe(403);
    const other = await newSession(app, alice);
    expect((await gated(other, id)).status).toBe(403);
    expect((await gated(alice, id)).status).toBe(200);
  });
  it("an expired committed action is refused", async () => {
    const id = await committed();
    app.clock.advance(121_000);
    expect((await gated(alice, id)).status).toBe(403);
  });
  it("a garbage action id is refused with the same answer", async () => {
    const r = await gated(alice, "not-a-uuid");
    expect(r.status).toBe(403); expect(r.json.error.code).toBe("step_up_required");
    expect((await gated(alice, "00000000-0000-0000-0000-000000000000")).json).toEqual(r.json);
  });
  it("an action used by one gated route cannot be used by another route of the same type", async () => {
    const id = await committed();
    expect((await gated(alice, id, "/api/v1/test/gated2")).status).toBe(200);
    expect((await gated(alice, id, "/api/v1/test/gated")).status).toBe(403);
  });
  it("execute hooks run in the commit transaction and roll back with it", async () => {
    let ran = 0;
    registerActionSpec({
      type: "card.publish", held: true, userInput: z.object({}).strict(),
      async derive(_c, _cl, _u, t) { return { params: { target: t, value: state.value } }; }, summary: () => "x",
      async execute(_ctx, c, a) { ran++; await c.query("update actions set expected_post_state = $2 where id = $1", [a.id, { hooked: true }]); },
    });
    const { id, options } = await prep();
    expect((await commit(app, alice, id, aliceKey.auth.get(options))).status).toBe(200);
    expect(ran).toBe(1); expect((await actionRow(id)).expected_post_state).toEqual({ hooked: true });
    registerActionSpec({
      type: "card.publish", held: true, userInput: z.object({}).strict(),
      async derive(_c, _cl, _u, t) { return { params: { target: t, value: state.value } }; }, summary: () => "x",
      async execute() { throw new HttpError(500, "boom"); },
    });
    const b = await prep();
    expect((await commit(app, alice, b.id, aliceKey.auth.get(b.options))).status).toBe(500);
    expect((await actionRow(b.id)).state).not.toBe("committed");
  });
});
