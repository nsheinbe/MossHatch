import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tx } from "@mosshatch/db";
import { mintToken } from "../util/token.ts";
import { verifyChain } from "../audit.ts";
import { signIn } from "../auth/testkit.ts";
import { newSession } from "../stepup/testkit.ts";
import { runReleaseSweep } from "../domains/release.ts";
import { erasureHash } from "../ops/erasure.ts";
import { closureSweep } from "./closure.ts";
import { COOLING_OFF_MS, DAY_MS } from "./common.ts";
import { addDomain, call, gated, makeClosureKit, makePerson, q, runJobs, stepUp, type ClosureKit, type Person } from "./testkit.ts";

/**
 * Account closure (design section 1 and test plan items 1 to 3; PLAN 4.3b; C-19, C-28, C-48, C-70). Security cases first: closing needs a
 * passkey, a stale signature does nothing, a bearer cannot close, and after the cooling-off a sign-in no longer reopens the account.
 */

let k: ClosureKit;
beforeAll(async () => { k = await makeClosureKit(); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await q(k, "delete from rate_counters"); });

const close = async (p: Person, input: Record<string, unknown> = {}) => {
  const s = await stepUp(k, p, "account.close", input);
  const r = await call(k, p, "POST", "/api/v1/account/close", {}, gated(s.actionId));
  return { ...r, summary: s.summary, actionId: s.actionId };
};
const status = async (p: Person) => (await q(k, "select status from users where id = $1", [p.user.userId]))[0].status as string;
const closure = async (p: Person) => (await q(k, "select * from account_closures where user_id = $1 order by requested_at desc limit 1", [p.user.userId]))[0];
const later = (ms: number) => k.h.app.clock.advance(ms);
async function order(p: Person, state: string, o: { fqdn?: string; domainId?: string } = {}): Promise<string> {
  return (await q(k, `insert into orders (user_id, kind, fqdn_ascii, domain_id, years, state, idempotency_key, request_hash, quote, subtotal_minor, tax_ceiling_minor, total_minor, livemode)
    values ($1,'register',$2,$3,1,$4,$5,'\\x00','{}',1000,0,1000,false) returning id`, [p.user.userId, o.fqdn ?? `o-${Math.random().toString(36).slice(2)}.com`, o.domainId ?? null, state, `k-${Math.random()}`]))[0].id;
}

describe("C-28 closure: the request needs a passkey and the right state", () => {
  it("POST /account/close without a committed account.close action is 403 step_up_required and changes nothing; a bearer is refused", async () => {
    const p = await makePerson(k, "gate");
    const r = await call(k, p, "POST", "/api/v1/account/close", {});
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({ code: "step_up_required", type: "account.close" });
    const t = mintToken("live");
    await q(k, "insert into bindings (user_id, kind, name, token_prefix, token_hash, expires_at) values ($1,'agent','x',$2,$3, now() + interval '30 days')", [p.user.userId, t.prefix, t.hash]);
    const bearer = await k.h.app.call("POST", "/api/v1/account/close", { authorization: `Bearer ${t.token}`, body: {}, browser: false });
    expect([401, 403]).toContain(bearer.status);
    // An export action does not open the close route.
    const exp = await stepUp(k, p, "account.export");
    expect((await call(k, p, "POST", "/api/v1/account/close", {}, gated(exp.actionId))).status).toBe(403);
    expect(await status(p)).toBe("active");
    expect(await closure(p)).toBeUndefined();
  });

  it("refused while money or a registration is in flight: prepare is 409 closure_blocked and nothing is signed", async () => {
    const p = await makePerson(k, "busy");
    await order(p, "authorized");
    const r = await k.h.app.call("POST", "/api/v1/actions/prepare", { cookie: p.user.cookie, body: { type: "account.close", target_id: p.user.userId, user_input: {} } });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: "closure_blocked", blockers: ["open_order"] });
    expect((await q(k, "select count(*)::int as n from actions where user_id = $1 and type = 'account.close'", [p.user.userId]))[0].n).toBe(0);
  });

  it("C-28: names are offered transfer-out first; deleting them is a separate choice the passkey signs, and the summary names them", async () => {
    const p = await makePerson(k, "names");
    const d = await addDomain(k, p, `keepme-${Date.now().toString(36)}.dev`);
    const plainTry = await k.h.app.call("POST", "/api/v1/actions/prepare", { cookie: p.user.cookie, body: { type: "account.close", target_id: p.user.userId, user_input: {} } });
    expect(plainTry.status).toBe(409);
    expect(plainTry.json.error.code).toBe("domains_remain");
    expect(plainTry.json.error.domains).toEqual([{ id: d, fqdn: expect.stringMatching(/^keepme-/) }]);
    const view = await call(k, p, "GET", "/api/v1/account/closure");
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({ cooling_off_days: 14, blockers: [], domains: [{ id: d, transfer_out_in_progress: false }] });
    const s = await stepUp(k, p, "account.close", { delete_domains: true });
    expect(s.summary).toMatch(/keepme-.*\.dev/);
    expect(s.summary).toContain("14 days");
    expect(s.summary).toMatch(/transfer out any name you want to keep first/);
  });

  it("a name that arrives after the passkey signed makes the signature stale: 409 action_stale and nothing closes", async () => {
    const p = await makePerson(k, "stale");
    const s = await stepUp(k, p, "account.close", {});
    await addDomain(k, p, `late-${Date.now().toString(36)}.com`);
    const r = await call(k, p, "POST", "/api/v1/account/close", {}, gated(s.actionId));
    expect(r.status).toBe(409);
    expect(["action_stale", "domains_remain"]).toContain(r.json.error.code);
    expect(await status(p)).toBe("active");
    expect((await q(k, "select state from actions where id = $1", [s.actionId]))[0].state).toBe("committed");
  });
});

describe("C-28 closure: what closing does at once", () => {
  let p: Person; let other: Awaited<ReturnType<typeof newSession>>; let token = ""; let oauthToken = ""; let domainId = "";
  beforeAll(async () => {
    p = await makePerson(k, "closer");
    other = await newSession(k.h.app, p.user);
    domainId = await addDomain(k, p, `closer-${Date.now().toString(36)}.com`);
    const t = mintToken("live"); token = t.token;
    await q(k, "insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, expires_at) values ($1,'agent','bot',$2,$3,'[]', now() + interval '30 days')", [p.user.userId, t.prefix, t.hash]);
    // An OAuth grant (a binding bound to a client and an audience), its refresh token, and a consent still open.
    const client = (await q(k, "insert into oauth_clients (client_id, registration, redirect_uris) values ($1,'dcr','{https://c.example/cb}') returning id", [`mhc_${Math.random().toString(36).slice(2).padEnd(20, "x")}`]))[0].id;
    const o = mintToken("live"); oauthToken = o.token;
    const grant = (await q(k, "insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, expires_at, oauth_client_id) values ($1,'agent','claude',$2,$3,'[]', now() + interval '30 days',$4) returning id", [p.user.userId, o.prefix, o.hash, client]))[0].id;
    const rt = mintToken("live");
    await q(k, "insert into oauth_refresh_tokens (binding_id, user_id, client_ref, token_prefix, token_hash, created_at, idle_expires_at, expires_at) values ($1,$2,$3,$4,$5, now(), now() + interval '30 days', now() + interval '90 days')", [grant, p.user.userId, client, rt.prefix, rt.hash]);
    await q(k, "insert into oauth_authorizations (client_ref, redirect_uri, code_challenge, user_id, status, created_at, expires_at) values ($1,'https://c.example/cb',$2,$3,'pending', now(), now() + interval '1 hour')", [client, "b".repeat(43), p.user.userId]);
    await q(k, "insert into renewal_mandates (domain_id, user_id, price_ceiling_minor, text_hash, retain_until) values ($1,$2,2000,'h', now() + interval '3 years')", [domainId, p.user.userId]);
    await q(k, "update domains set auto_renew = true where id = $1", [domainId]);
    await q(k, `insert into cards (user_id, domain_id, slug, species, family, rarity, traits, hatched_on, snapshot_ref, snapshot_url, image_sha256, image_width, image_height, image_bytes, published_at)
                values ($1,$2,(select fqdn_ascii from domains where id = $2),'moss fox','fox','common','["quiet"]'::jsonb, now()::date,'snap','https://example.test/s.png',$3,512,512,1000, now())`, [p.user.userId, domainId, "a".repeat(64)]);
    k.h.app.email.clear();
  });

  it("revokes every session, token, OAuth grant and refresh token, turns off auto-renew, takes down cards and tells every address", async () => {
    // The fixtures are live before: each refusal below is the closure's doing.
    for (const t of [token, oauthToken]) expect((await k.h.app.call("GET", "/api/v1/whoami", { authorization: `Bearer ${t}`, browser: false })).status).toBe(200);
    for (const cookie of [p.user.cookie, other.cookie]) expect((await k.h.app.call("GET", "/api/v1/me", { cookie })).status).toBe(200);
    const r = await close(p, { delete_domains: true });
    expect(r.status, r.text).toBe(202);
    expect(r.json.closure).toMatchObject({ state: "cooling_off" });
    expect(new Date(r.json.closure.cooling_off_until).getTime() - k.h.app.clock.now().getTime()).toBe(COOLING_OFF_MS);
    expect(r.setCookies.some((c) => c.startsWith("__Host-mh_session=;"))).toBe(true);
    expect(await status(p)).toBe("closing");
    // Every session, including one the request did not come from.
    for (const cookie of [p.user.cookie, other.cookie]) expect((await k.h.app.call("GET", "/api/v1/me", { cookie })).status).toBe(401);
    for (const t of [token, oauthToken]) expect((await k.h.app.call("GET", "/api/v1/whoami", { authorization: `Bearer ${t}`, browser: false })).status).toBe(401);
    expect((await q(k, "select count(*)::int as n from oauth_refresh_tokens where user_id = $1 and revoked_at is null", [p.user.userId]))[0].n).toBe(0);
    expect((await q(k, "select status from oauth_authorizations where user_id = $1", [p.user.userId]))[0].status).toBe("denied");
    expect((await q(k, "select revoked_at, revoked_by from renewal_mandates where user_id = $1", [p.user.userId]))[0]).toMatchObject({ revoked_by: "system" });
    expect((await q(k, "select auto_renew from domains where id = $1", [domainId]))[0].auto_renew).toBe(false);
    expect((await q(k, "select unpublish_reason from cards where user_id = $1", [p.user.userId]))[0].unpublish_reason).toBe("account_closed");
    expect((await q(k, "select count(*)::int as n from jobs where kind in ('card.purge','cards.rebuild') and state = 'queued'"))[0].n).toBeGreaterThanOrEqual(2);
    const mails = k.h.app.email.sent.filter((m) => m.kind === "account_closing");
    expect(mails.map((m) => m.to[0]).sort()).toEqual([p.email, p.second].sort());
    expect(mails[0]!.text).toContain("Signing in cancels the closure");
    expect(mails[0]!.text).toContain("One name is still in your account");
    // Rule 2: the audit row holds ids and counts only.
    const a = (await q(k, "select detail from audit_log where chain_id = $1 and action = 'account.closing'", [p.user.userId]))[0].detail;
    expect(JSON.stringify(a)).not.toMatch(/@|closer-|\.com/);
    expect(a).toMatchObject({ domains: 1, sessions: 2 });
  });

  it("a second request while one is open is refused, and new orders are impossible (no session resolves)", async () => {
    const s2 = await newSession(k.h.app, p.user);
    expect((await k.h.app.call("GET", "/api/v1/me", { cookie: s2.cookie })).status).toBe(401);
    expect((await k.h.app.call("POST", "/api/v1/orders", { cookie: s2.cookie, body: { fqdn: "x.com", years: 1 }, headers: { "idempotency-key": "k" } })).status).toBe(401);
  });

  it("a passkey sign-in inside the cooling-off cancels the closure and reopens the account; what closing revoked stays revoked", async () => {
    later(3 * DAY_MS);
    k.h.app.email.clear();
    const s = await signIn(k.h.app, p.key.auth);
    expect(s.res.status, s.res.text).toBe(200);
    expect(await status(p)).toBe("active");
    expect(await closure(p)).toMatchObject({ state: "cancelled", cancelled_by: "sign_in" });
    expect((await k.h.app.call("GET", "/api/v1/me", { cookie: s.cookie })).status).toBe(200);
    expect((await k.h.app.call("GET", "/api/v1/whoami", { authorization: `Bearer ${token}`, browser: false })).status).toBe(401);
    expect(k.h.app.email.sent.filter((m) => m.kind === "account_closure_cancelled").map((m) => m.to[0]).sort()).toEqual([p.email, p.second].sort());
    // Nothing more happens to the cancelled closure.
    later(COOLING_OFF_MS);
    await closureSweep(k.h.app.ctx);
    expect(await status(p)).toBe("active");
    expect((await q(k, "select released_at from domains where id = $1", [domainId]))[0].released_at).toBeNull();
  });
});

describe("C-28 closure: after the cooling-off (design test 1: every state, and closed waits for what is open)", () => {
  let p: Person; let names: string[] = []; let disputed = ""; let refunding = "";
  beforeAll(async () => {
    p = await makePerson(k, "leaver");
    names = [`leaver-a-${Date.now().toString(36)}.com`, `leaver-b-${Date.now().toString(36)}.app`];
    for (const n of names) await addDomain(k, p, n);
    // Money that settles on its own: a disputed payment and a refund in flight do not stop the request, but they stop `closed`.
    disputed = await order(p, "captured");
    await q(k, "insert into payments (order_id, user_id, stripe_payment_intent_id, amount_minor, currency, status, livemode, dispute_state) values ($1,$2,$3,1000,'usd','succeeded',false,'open')", [disputed, p.user.userId, `pi_${Math.random().toString(36).slice(2)}`]);
    refunding = await order(p, "refund_pending");
    await q(k, "insert into stripe_customers (user_id, stripe_customer_id, livemode) values ($1,$2,false)", [p.user.userId, `cus_leaver_${Math.random().toString(36).slice(2)}`]);
    const r = await close(p, { delete_domains: true });
    expect(r.status, r.text).toBe(202);
  });

  it("before the cooling-off ends, the sweep does nothing", async () => {
    later(COOLING_OFF_MS - 60_000);
    const s = await closureSweep(k.h.app.ctx);
    expect(s.windingDown).toBe(0);
    expect((await closure(p)).state).toBe("cooling_off");
  });

  it("at its end a sign-in no longer reopens the account, and the names still here are deleted at the registry and released", async () => {
    later(60_000);
    const s = await signIn(k.h.app, p.key.auth);
    expect(s.res.status).toBe(401);
    expect(await status(p)).toBe("closing");
    k.deleted.length = 0;
    await closureSweep(k.h.app.ctx);
    expect((await closure(p)).state).toBe("winding_down");
    expect(k.deleted.sort()).toEqual([...names].sort());
    const rel = await q(k, "select release_reason, released_at from domains where user_id = $1", [p.user.userId]);
    expect(rel.every((d) => d.release_reason === "account_closed" && d.released_at !== null)).toBe(true);
    expect((await q(k, "select count(*)::int as n from domain_releases where user_id = $1 and cause = 'account_closed'", [p.user.userId]))[0].n).toBe(2);
  });

  it("closed waits while a dispute and a refund are open, and says why with codes", async () => {
    await closureSweep(k.h.app.ctx);
    const c = await closure(p);
    expect(c.state).toBe("winding_down");
    expect([...c.blocked_by].sort()).toEqual(["open_dispute", "open_refund"]);
    await q(k, "update payments set dispute_state = 'won' where order_id = $1", [disputed]);
    await closureSweep(k.h.app.ctx);
    expect((await closure(p)).blocked_by).toEqual(["open_refund"]);
    await q(k, "update orders set state = 'refunded' where id = $1", [refunding]);
  });

  it("closed: the last email goes out, users.status is closed and the Stripe customer is deleted; then the purge runs (ledger first)", async () => {
    k.h.app.email.clear();
    const s = await closureSweep(k.h.app.ctx);
    expect(s.closed).toBe(1);
    expect(s.purged).toBe(1);
    expect(k.h.app.email.sent.filter((m) => m.kind === "account_closed").map((m) => m.to[0]).sort()).toEqual([p.email, p.second].sort());
    const cust = (await q(k, "select stripe_customer_id, deleted_at from stripe_customers where user_id = $1", [p.user.userId]))[0];
    expect(cust.deleted_at).not.toBeNull();
    expect(k.stripeCustomers.deleted.has(cust.stripe_customer_id)).toBe(true);
    expect((await closure(p)).state).toBe("purged");
    expect(await status(p)).toBe("purged");
    expect(k.ledger.items.map((e) => e.userHash)).toContain(erasureHash(p.user.userId));
    // Money records stay (C-19), under ids.
    expect((await q(k, "select count(*)::int as n from orders where user_id = $1", [p.user.userId]))[0].n).toBe(2);
    expect((await q(k, "select count(*)::int as n from payments where user_id = $1", [p.user.userId]))[0].n).toBe(1);
  });

  it("sealed only after every released name's vault ciphertext is destroyed at the end of its 30-day hold (ST-95); chain.closed is the last row and the chain verifies", async () => {
    const d = (await q(k, "select id from domains where user_id = $1 order by created_at limit 1", [p.user.userId]))[0].id;
    const sec = (await q(k, "insert into secrets (user_id, domain_id, env, name) values ($1,$2,'prod','DB_URL') returning id", [p.user.userId, d]))[0].id;
    await q(k, "insert into secret_versions (secret_id, user_id, version, ciphertext, nonce, tag, wrapped_dek, kek_ref, kek_class, created_by_kind) values ($1,$2,1,'\\xdeadbeef',$3,$4,'\\xcafebabe','local:test','vault-nonprod','user')",
      [sec, p.user.userId, Buffer.alloc(12, 1), Buffer.alloc(16, 2)]);
    await closureSweep(k.h.app.ctx);
    expect((await closure(p)).state).toBe("purged");
    later(30 * DAY_MS);
    await runReleaseSweep(k.h.app.ctx);
    expect((await q(k, "select count(*)::int as n from secret_versions where user_id = $1 and ciphertext is not null", [p.user.userId]))[0].n).toBe(0);
    const s = await closureSweep(k.h.app.ctx);
    expect(s.sealed).toBe(1);
    expect((await closure(p)).state).toBe("sealed");
    const last = (await q(k, "select action from audit_log where chain_id = $1 order by seq desc limit 1", [p.user.userId]))[0];
    expect(last.action).toBe("chain.closed");
    expect(await tx(k.h.app.ctx.cron, (c) => verifyChain(k.h.app.ctx, c, p.user.userId))).toMatchObject({ ok: true });
    const actions = (await q(k, "select action from audit_log where chain_id = $1 order by seq", [p.user.userId])).map((r) => r.action);
    for (const a of ["account.closing", "account.winding_down", "domain.released", "account.closed", "stripe.customer_deleted", "account.erased", "domain.destroyed", "chain.closed"]) expect(actions, a).toContain(a);
    expect(actions.indexOf("account.erased")).toBeLessThan(actions.indexOf("chain.closed"));
  });
});

describe("C-19 closure: legal hold, a name mid transfer-out, and a registrar that cannot delete", () => {
  it("a legal hold keeps the identifying rows after closure until it is lifted", async () => {
    const p = await makePerson(k, "held");
    await q(k, "insert into consents (user_id, kind, document_hash, version, retain_until, legal_hold) values ($1,'terms','h','v', now() + interval '3 years', true)", [p.user.userId]);
    expect((await close(p)).status).toBe(202);
    later(COOLING_OFF_MS + 1000);
    await closureSweep(k.h.app.ctx);
    const c = await closure(p);
    expect(c.state).toBe("closed");
    expect(c.blocked_by).toEqual(["legal_hold"]);
    expect(await status(p)).toBe("closed");
    expect((await q(k, "select count(*)::int as n from contacts where user_id = $1", [p.user.userId]))[0].n).toBe(1);
    await q(k, "update consents set legal_hold = false where user_id = $1", [p.user.userId]);
    await closureSweep(k.h.app.ctx);
    expect(await status(p)).toBe("purged");
    expect((await q(k, "select count(*)::int as n from contacts where user_id = $1", [p.user.userId]))[0].n).toBe(0);
  });

  it("a name mid transfer-out is left to finish; closed waits for it; a registrar that cannot delete pages a person", async () => {
    const p = await makePerson(k, "moving");
    const away = await addDomain(k, p, `moving-${Date.now().toString(36)}.com`);
    const stay = await addDomain(k, p, `stuck-${Date.now().toString(36)}.com`);
    await q(k, "update domains set transfer_away = true where id = $1", [away]);
    expect((await close(p, { delete_domains: true })).status).toBe(202);
    const saved = k.h.svc.deleteDomain; k.h.svc.deleteDomain = undefined;
    try {
      later(COOLING_OFF_MS + 1000);
      await closureSweep(k.h.app.ctx);
    } finally { k.h.svc.deleteDomain = saved; }
    expect((await q(k, "select released_at from domains where id = $1", [away]))[0].released_at).toBeNull();
    expect((await q(k, "select release_reason from domains where id = $1", [stay]))[0].release_reason).toBe("account_closed");
    expect((await q(k, "select severity from alerts where kind = 'manual_domain_delete_required' and subject = $1", [stay]))[0].severity).toBe("page");
    const c = await closure(p);
    expect(c.state).toBe("winding_down");
    expect(c.blocked_by).toEqual(expect.arrayContaining(["live_domain", "transfer_out"]));
    // The transfer completes (the sync releases the name): now the account closes.
    await q(k, "update domains set released_at = now(), release_reason = 'transferred_out', transfer_away = false where id = $1", [away]);
    await closureSweep(k.h.app.ctx);
    expect(["closed", "purged"]).toContain((await closure(p)).state);
  });
});

describe("C-70 and C-28: a closing account's export and cards", () => {
  it("an export file is deleted when the account closes, and a pending export is cancelled rather than built", async () => {
    const p = await makePerson(k, "exp-close");
    const e = await stepUp(k, p, "account.export");
    expect((await call(k, p, "POST", "/api/v1/account/export", {}, gated(e.actionId))).status).toBe(202);
    await runJobs(k, ["account.export"]);
    const e2id = (await q(k, "select id from account_exports where user_id = $1", [p.user.userId]))[0].id;
    expect((await q(k, "select count(*)::int as n from account_export_files where export_id = $1", [e2id]))[0].n).toBe(1);
    expect((await close(p)).status).toBe(202);
    later(COOLING_OFF_MS + 1000);
    await closureSweep(k.h.app.ctx);
    expect((await q(k, "select count(*)::int as n from account_export_files where user_id = $1", [p.user.userId]))[0].n).toBe(0);
    expect((await q(k, "select storage_ref from account_exports where id = $1", [e2id]))[0].storage_ref).toBeNull();
  });
});
