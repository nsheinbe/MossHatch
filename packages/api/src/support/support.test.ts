import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tx } from "@mosshatch/db";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { verifyChain, SYSTEM_CHAIN } from "../audit.ts";
import * as support from "./index.ts";
import type { RecoveryStarter } from "./types.ts";

let app: TestApp; let uid: string;
const EMAIL = "customer.private@example.org";
const SECOND = "second.private@example.net";
const FQDN = "very-private-name.com";
const CRED = "cred-id-PRIVATE-0123456789";
const actor = { staffId: "support-anna" };
const q = <T = any>(sql: string, p: unknown[] = []) => app.db.owner.query(sql, p).then((r) => r.rows as T[]);

beforeAll(async () => {
  app = await createTestApp();
  uid = (await q("insert into users (email, status, email_verified_at, billing_country) values ($1,'active',now(),'DE') returning id", [EMAIL]))[0].id;
  await q("insert into notification_addresses (user_id, address, kind, verified_at) values ($1,$2,'login',now()), ($1,$3,'second',now())", [uid, EMAIL, SECOND]);
  await q("insert into contacts (user_id, fields_enc) values ($1,$2)", [uid, JSON.stringify({ name: { ct: "SECRETCIPHERTEXT" } })]);
  await q("insert into passkeys (user_id, credential_id, public_key, alg, backup_eligible, backup_state) values ($1,$2,'\\xdeadbeef',-7,true,true)", [uid, CRED]);
  const dom = (await q("insert into domains (user_id, fqdn_ascii, tld, registrar, state, livemode, nameservers, expires_at) values ($1,$2,'com','mock','registered',false,'{ns1.private-ns.example}', now() + interval '1 year') returning id", [uid, FQDN]))[0].id;
  await q(`insert into orders (user_id, kind, fqdn_ascii, domain_id, years, state, idempotency_key, request_hash, quote, subtotal_minor, total_minor, livemode, reg_username)
           values ($1,'register',$2,$3,1,'captured','k1','\\x01','{}',1000,1099,false,'privateprofile123')`, [uid, FQDN, dom]);
  await q("insert into orders (user_id, kind, fqdn_ascii, years, state, idempotency_key, request_hash, quote, subtotal_minor, total_minor, livemode) values ($1,'register','other-private.com',1,'authorized','k2','\\x02','{}',1000,1099,false)", [uid]);
}, 60_000);
afterAll(async () => { await app?.drop(); });

const SRC = fs.readdirSync(import.meta.dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => [f, fs.readFileSync(path.join(import.meta.dirname, f), "utf8")] as const);

describe("ST-144 support tooling shows metadata only and cannot do the forbidden things", () => {
  it("ST-144: the exported surface is exactly four reads and one recovery start", () => {
    const fns = Object.entries(support).filter(([, v]) => typeof v === "function" && !/^[A-Z]/.test(v.name || "")).map(([k]) => k).sort();
    expect(fns).toEqual([...support.SUPPORT_OPERATIONS].sort());
    expect(Object.keys(support).sort()).toEqual([...support.SUPPORT_OPERATIONS, "SUPPORT_OPERATIONS", "SupportError"].sort());
    for (const name of Object.keys(support)) {
      expect(name, name).not.toMatch(/unlock|transfer|nameserver|contact|addPasskey|registerPasskey|bypass|skip|override|cooling|hold|release|refund|delete|erase|export|reveal|decrypt|secret|approve|cancelRecovery|complete|freeze/i);
    }
    expect(support.startLostPasskeyRecovery.length).toBe(4);                              // (ctx, actor, userId, starter): no identity-claim or delay argument
  });
  it("ST-144: source scan: support code writes nothing but audit rows, reads no contact or credential data, and has no path into registrar, step-up, auth or Stripe code", () => {
    expect(SRC.length).toBeGreaterThan(3);
    for (const [file, src] of SRC) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|alter\s+table|drop\s+table)\b/i);
      expect(code, file).not.toMatch(/from\s+["'][^"']*(registrar|stepup|auth\/|orders\/|stripe|webauthn|vault|kms-vault)[^"']*["']/i);
      expect(code, file).not.toMatch(/\b(fetch|execFile|spawn)\s*\(/);
      expect(code, file).not.toMatch(/set_config|app\.user_id/);
      // Every select list stays inside the metadata allow-list.
      for (const m of code.matchAll(/select\s+([\s\S]*?)\s+from\s+(\w+)/gi)) {
        const [, cols, table] = m;
        expect(table, `${file}: ${m[0]}`).toMatch(/^(users|passkeys|notification_addresses|domains|orders|bindings|recovery_requests)$/);
        expect(cols, `${file}: ${m[0]}`).not.toMatch(/\b(address|fqdn_ascii|fields_enc|credential_id|public_key|nameservers|registry_statuses|reg_username|checkout_ip_enc|token_hash|token_prefix|scopes|billing_country|webauthn_user_handle|email)\b/i);
      }
    }
    // The single place that names an address is the lookup by the address the customer gave us.
    const withEmail = SRC.filter(([, s]) => /\bwhere email\b/i.test(s)).map(([f]) => f);
    expect(withEmail).toEqual(["read.ts"]);
  });
  it("ST-144: every read returns metadata only: no address, name, contact field, credential, key or domain name appears in any output", async () => {
    const all = {
      lookup: await support.lookupUserByEmail(app.ctx, actor, EMAIL),
      summary: await support.getAccountSummary(app.ctx, actor, uid),
      orders: await support.listAccountOrders(app.ctx, actor, uid),
      domains: await support.listAccountDomainStates(app.ctx, actor, uid),
    };
    expect(all.lookup).toEqual({ userId: uid, status: "active" });
    expect(all.summary).toMatchObject({ userId: uid, status: "active", emailVerified: true, frozen: false, counts: { passkeys: 1, notificationAddresses: 2, domains: 1, orders: 2, openOrders: 1, activeBindings: 0 }, recovery: null });
    expect(all.orders.map((o) => o.state).sort()).toEqual(["authorized", "captured"]);
    expect(all.orders.find((o) => o.state === "captured")!.totalMinor).toBe("1099");
    expect(all.domains).toHaveLength(1); expect(all.domains[0]).toMatchObject({ state: "registered" });
    const blob = JSON.stringify(all);
    for (const secret of [EMAIL, "customer.private", SECOND, FQDN, "other-private", "private-ns", CRED, "deadbeef", "SECRETCIPHERTEXT", "privateprofile123", "DE", "erased"]) {
      if (secret === "DE" || secret === "erased") continue;
      expect(blob, secret).not.toContain(secret);
    }
    const keys = new Set<string>();
    const walk = (v: unknown) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
    walk(Object.values(all));
    expect([...keys].sort()).toEqual([
      "activeBindings", "counts", "createdAt", "domains", "emailVerified", "expiresAt", "frozen", "hardenedMode", "id", "kind", "notificationAddresses", "openOrders", "orders",
      "passkeys", "recovery", "registeredAt", "riskState", "state", "status", "totalMinor", "updatedAt", "userId", "years",
    ].sort());
  });
  it("ST-144: an unknown user is answered with null, not an error that distinguishes anything", async () => {
    expect(await support.getAccountSummary(app.ctx, actor, "00000000-0000-4000-8000-00000000dead")).toBeNull();
    expect(await support.lookupUserByEmail(app.ctx, actor, "nobody@example.org")).toBeNull();
    expect(await support.listAccountOrders(app.ctx, actor, "00000000-0000-4000-8000-00000000dead")).toEqual([]);
  });
  it("a staff id must be an opaque handle (an email address is refused) and ids must be UUIDs, before any query", async () => {
    await expect(support.getAccountSummary(app.ctx, { staffId: "anna@mosshatch.com" }, uid)).rejects.toMatchObject({ code: "bad_actor" });
    await expect(support.getAccountSummary(app.ctx, actor, "1; drop table users")).rejects.toMatchObject({ code: "bad_id" });
  });
});

describe("ST-155 support actions are audited and cannot bypass recovery", () => {
  it("ST-155: every support read and action writes an audit row with actor_kind 'support' in the customer's chain, and the chain still verifies", async () => {
    const before = Number((await q("select seq from audit_heads where chain_id = $1", [uid]))[0]?.seq ?? 0);
    await support.getAccountSummary(app.ctx, actor, uid);
    await support.listAccountOrders(app.ctx, actor, uid);
    await support.listAccountDomainStates(app.ctx, actor, uid);
    await support.lookupUserByEmail(app.ctx, actor, EMAIL);
    const rows = await q("select actor_kind, actor_id, action, resource_id, detail, pii from audit_log where chain_id = $1 and seq > $2 order by seq", [uid, before]);
    expect(rows.map((r) => r.action)).toEqual(["support.view_account", "support.view_orders", "support.view_domains", "support.lookup"]);
    for (const r of rows) { expect(r.actor_kind).toBe("support"); expect(r.actor_id).toBe("support-anna"); expect(r.pii).toBeNull(); }
    expect(JSON.stringify(rows)).not.toContain("example.org");
    expect(await tx(app.ctx.cron, (c) => verifyChain(app.ctx, c, uid))).toMatchObject({ ok: true });
  });
  it("ST-155: a lookup that finds nothing is still audited (system chain), without the address", async () => {
    await support.lookupUserByEmail(app.ctx, actor, "ghost.person@example.org");
    const r = (await q("select actor_kind, detail from audit_log where chain_id = $1 and action = 'support.lookup' order by seq desc limit 1", [SYSTEM_CHAIN]))[0];
    expect(r).toEqual({ actor_kind: "support", detail: { found: false } });
    expect(JSON.stringify(await q("select * from audit_log where chain_id = $1", [SYSTEM_CHAIN]))).not.toContain("ghost.person");
  });
  it("ST-155: a lost-passkey request only calls the normal recovery start, with no option to shorten anything, and changes nothing itself", async () => {
    const calls: unknown[] = [];
    // Stub of the auth module's recovery start: it makes the normal request and its cooling-off period.
    const stub: RecoveryStarter = async (args) => {
      calls.push(args);
      const id = (await q("insert into recovery_requests (user_id, path, status, cooling_off_until) values ($1,'email_only','cooling_off', now() + interval '72 hours') returning id", [args.userId]))[0].id;
      return { status: "started", requestId: id };
    };
    const passkeysBefore = (await q("select count(*)::int as n from passkeys where user_id = $1", [uid]))[0].n;
    const res = await support.startLostPasskeyRecovery(app.ctx, actor, uid, stub);
    expect(calls).toEqual([{ userId: uid, initiatedBy: "support" }]);                     // exactly this, nothing else
    expect(res.status).toBe("started"); expect(Object.keys(res).sort()).toEqual(["requestId", "status"]);
    const rec = (await q("select status, path, completed_at, cooling_off_until, hold_until from recovery_requests where user_id = $1", [uid]))[0];
    expect(rec.status).toBe("cooling_off"); expect(rec.completed_at).toBeNull(); expect(rec.hold_until).toBeNull();   // support did not complete or shorten it
    expect((await q("select count(*)::int as n from passkeys where user_id = $1", [uid]))[0].n).toBe(passkeysBefore);   // no passkey added
    expect((await q("select count(*)::int as n from action_holds where user_id = $1", [uid]))[0].n).toBe(0);
    const audit = (await q("select actor_kind, actor_id, action, resource_id, detail from audit_log where chain_id = $1 and action = 'support.recovery_start'", [uid]))[0];
    expect(audit).toEqual({ actor_kind: "support", actor_id: "support-anna", action: "support.recovery_start", resource_id: rec ? res.requestId : null, detail: { outcome: "started" } });
    // A second request while one is open is the auth module's decision, passed through as such.
    const again = await support.startLostPasskeyRecovery(app.ctx, actor, uid, async () => ({ status: "already_open" }));
    expect(again).toEqual({ status: "already_open" });
  });
  it("ST-155: a failing recovery start is audited as an error and rethrown; a malformed user id never reaches it", async () => {
    let called = 0;
    await expect(support.startLostPasskeyRecovery(app.ctx, actor, uid, async () => { called++; throw new Error("boom"); })).rejects.toThrow("boom");
    expect((await q("select detail from audit_log where chain_id = $1 and action = 'support.recovery_start' order by seq desc limit 1", [uid]))[0].detail).toEqual({ outcome: "error" });
    await expect(support.startLostPasskeyRecovery(app.ctx, actor, "not-a-uuid", async () => { called++; return { status: "started" }; })).rejects.toMatchObject({ code: "bad_id" });
    expect(called).toBe(1);
  });
  it("ST-155: the support module never reads or writes what a recovery is made of: no query names recovery_codes, action_holds, sessions or passkey inserts", () => {
    for (const [file, src] of SRC) expect(src, file).not.toMatch(/recovery_codes|action_holds|insert into passkeys|from sessions|email_action_tokens/i);
  });
});
