import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCloudTrail, kmsReconcile } from "../ops/kms-reconcile.ts";
import { activateReveal, call, ciphertextColumns, everySink, makePerson, makeVaultKit, putSecret, reveal, type Person, type VaultKit } from "./testkit.ts";
import { affectedFromTrail, autoDenyOnUnauditedDecrypt, customersUnderKek, runCompromiseDrill } from "./drill.ts";
import { trailAlarms } from "./alarms.ts";
import { newSession } from "../stepup/testkit.ts";
import { withConnectionCredential } from "./connections.ts";
import { kmsContext } from "./envelope.ts";
import { KmsError, type KmsTrailEvent, type SecretEnv } from "./kms/types.ts";

let k: VaultKit;
beforeAll(async () => { k = await makeVaultKit(); }, 120_000);
afterAll(async () => { await k?.drop(); });

const canary = () => `mh_test_CANARY_value_${Math.random().toString(36).slice(2)}`;
async function rowsOf(p: Person) {
  return (await k.app.db.owner.query("select s.id, s.env, s.user_id, v.wrapped_dek, v.kek_ref from secrets s join secret_versions v on v.id = s.current_version_id where s.user_id = $1 and s.deleted_at is null order by s.name", [p.user.userId])).rows;
}

describe("stored provider credentials (connections)", () => {
  it("stores through the same envelope, never returns the credential, decrypts only for jobs, and disconnect destroys it", async () => {
    const p = await makePerson(k, "conn");
    const cred = `vercel_${canary()}`;
    const put = await call(k, p, "PUT", `/api/v1/domains/${p.domain.fqdn}/connections/vercel`, { kind: "pasted_token", credential: cred, scope_summary: "project" });
    expect(put.status, put.text).toBe(201);
    expect(put.text).not.toContain(cred);
    const nest = await call(k, p, "GET", `/api/v1/domains/${p.domain.fqdn}/nest`);
    expect(nest.json.connections).toEqual([expect.objectContaining({ service: "vercel", status: "active" })]);
    expect(nest.text).not.toContain(cred);
    expect(await ciphertextColumns(k)).not.toContain(cred);
    const credId = (await k.app.db.owner.query("select id from connection_credentials where connection_id = $1 and revoked_at is null", [put.json.connection_id])).rows[0].id;
    expect(await withConnectionCredential(k.app.ctx, credId, "connection.check", async (v) => v === cred)).toBe(true);
    // The AAD binds the service and connection: a row relabelled to another service does not decrypt.
    await k.app.db.owner.query("update connections set service = 'neon' where id = $1", [put.json.connection_id]);
    await expect(withConnectionCredential(k.app.ctx, credId, "connection.check", async () => true)).rejects.toMatchObject({ code: "vault_integrity" });
    await k.app.db.owner.query("update connections set service = 'vercel' where id = $1", [put.json.connection_id]);
    const del = await call(k, p, "DELETE", `/api/v1/domains/${p.domain.fqdn}/connections/vercel`);
    expect(del.status).toBe(200);
    const row = (await k.app.db.owner.query("select ciphertext, wrapped_dek, revoked_at from connection_credentials where id = $1", [credId])).rows[0];
    expect(row.ciphertext).toBeNull(); expect(row.wrapped_dek).toBeNull(); expect(row.revoked_at).not.toBeNull();
    await expect(withConnectionCredential(k.app.ctx, credId, "recipe.apply", async () => true)).rejects.toMatchObject({ status: 404 });
    expect(await everySink(k)).not.toContain(cred);
    expect((await call(k, p, "PUT", `/api/v1/domains/${p.domain.fqdn}/connections/github`, { kind: "pasted_token", credential: "x" })).status).toBe(404);
  });
});

describe("ST-10: Decrypt-volume and secret-diversity alarms fire, and an unmatched Decrypt raises an alert", () => {
  it("the trail alarms fire per principal above their thresholds", async () => {
    const now = k.app.clock.now();
    const ev = (i: number, principal: string, secret: string): KmsTrailEvent => ({ eventId: `e${i}`, at: new Date(now.getTime() - 1000), eventName: "Decrypt", principal, keyId: "k", encryptionContext: { app: "mosshatch-nest", env: "prod", owner_id: "o", secret_id: secret }, errorCode: null });
    const events = [...Array.from({ length: 201 }, (_, i) => ev(i, "role/vault-prod", "same")), ...Array.from({ length: 10 }, (_, i) => ev(1000 + i, "role/vault-nonprod", `s${i}`))];
    const r = await trailAlarms(k.app.ctx, events);
    expect(r.volume).toEqual(["role/vault-prod"]);
    expect(r.diversity).toEqual(["role/vault-nonprod"]);
    const kinds = (await k.app.db.owner.query("select kind from alerts where kind like 'kms.%' order by kind")).rows.map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(["kms.decrypt_volume", "kms.secret_diversity"]));
  });
});

describe("the KMS compromise drill (fake KMS, timed)", () => {
  it("auto-deny, scope from the trail, per-customer affected list, notices, and migration to new KEKs with ReEncrypt", async () => {
    k.app.clock.advance(60_000);   // a window that excludes the earlier tests' KMS calls
    const start = k.app.clock.now();
    const a = await makePerson(k, "drilla"), b = await makePerson(k, "drillb"), c = await makePerson(k, "drillc");
    const values = new Map<string, string>();
    for (const [p, env, n] of [[a, "prod", "A_PROD"], [a, "dev", "A_DEV"], [c, "prod", "C_PROD"]] as const) { const v = canary(); values.set(`${p.user.userId}:${n}`, v); await putSecret(k, p, env, n, v); }
    for (let i = 0; i < 10; i++) { const v = canary(); values.set(`${b.user.userId}:B${i}`, v); await putSecret(k, b, "prod", `B${i}`, v); }
    const conn = await call(k, c, "PUT", `/api/v1/domains/${c.domain.fqdn}/connections/neon`, { kind: "pasted_token", credential: `npg_${canary()}` });
    expect(conn.status).toBe(201);

    // A legitimate, audited reveal by A.
    const aProd = (await rowsOf(a))[1]!;   // A_DEV, A_PROD by name
    expect((await reveal(k, a, aProd.id, await activateReveal(k, a, aProd.id))).status).toBe(200);

    // The compromise: code with the vault role decrypts B's and C's wrapped keys straight from the database (no audit rows).
    const stolen: { id: string; env: string; user_id: string; wrapped_dek: Buffer; kek_ref: string }[] = [...(await rowsOf(b)), ...(await rowsOf(c))];
    for (const r of stolen) await k.kms.decrypt(r.env === "prod" ? "vault-prod" : "vault-nonprod", r.kek_ref, Buffer.from(r.wrapped_dek), kmsContext(r.env as SecretEnv, r.user_id, r.id));
    const windowEnd = new Date(k.app.clock.now().getTime() + 1000);

    // Detection: CloudTrail (the fake's trail) joined to the audit log raises the unaudited-Decrypt page ...
    const ct = new FakeCloudTrail();
    ct.events = (await k.kms.trail()).filter((e) => e.eventName === "Decrypt" && !e.errorCode).map((e) => ({ eventId: e.eventId, at: e.at, keyId: e.keyId!, nonce: e.encryptionContext?.secret_id ?? null }));
    await k.app.db.owner.query("delete from flags where name = 'audit.kms_reconcile.cursor'");
    k.app.clock.advance(16 * 60_000);
    const rec = await kmsReconcile(k.app.ctx, ct);
    for (const p of [a, b, c]) p.user = await newSession(k.app, p.user);   // 16 minutes passed: sign in again
    expect(rec.unaudited.length).toBe(stolen.length);
    // ... and ST-11: the auto-deny attaches, blocks Decrypt for existing sessions, and is removable.
    expect(await autoDenyOnUnauditedDecrypt(k.app.ctx, k.kms)).toBe(true);
    await expect(k.kms.decrypt("vault-prod", stolen[0]!.kek_ref, Buffer.from(stolen[0]!.wrapped_dek), kmsContext("prod", stolen[0]!.user_id, stolen[0]!.id))).rejects.toMatchObject({ code: "AccessDeniedException" });
    const blocked = await reveal(k, a, aProd.id, await activateReveal(k, a, aProd.id));
    expect(blocked.status).toBe(503);
    await k.kms.removeRoleDeny("vault-prod"); await k.kms.removeRoleDeny("vault-nonprod");

    // The affected list alone (what the drill computes): B and C exposed and unaudited; A's decrypt was her own reveal.
    const affected = await affectedFromTrail(k.app.ctx, await k.kms.trail(), { from: start, to: windowEnd });
    const byUser = new Map(affected.map((x) => [x.user_id, x]));
    expect(byUser.get(b.user.userId)!.unaudited).toBe(10);
    expect(byUser.get(c.user.userId)!.unaudited).toBe(1);
    expect(byUser.get(a.user.userId)!.unaudited).toBe(0);
    expect((await customersUnderKek(k.app.ctx, k.kms.currentKek("vault-prod"))).map((x) => x.user_id).sort()).toEqual([a.user.userId, b.user.userId, c.user.userId].sort());

    // The timed drill.
    k.app.email.clear();
    const t0 = performance.now();
    const d = await runCompromiseDrill(k.app.ctx, { incidentId: "01900000-0000-7000-8000-00000000d7d1", window: { from: start, to: windowEnd } });
    const elapsed = performance.now() - t0;
    expect(d.steps.map((s) => s.step)).toEqual(["revoke_and_deny", "disable_keys", "scope_from_trail", "affected_list", "notices", "new_keys", "reencrypt", "retire_old_keys", "lift_role_deny"]);
    expect(d.affected.map((x) => x.user_id).sort()).toEqual([a.user.userId, b.user.userId, c.user.userId].sort());
    expect(d.noticesSent).toBe(3);
    expect(d.rewrapped).toBe(14);   // 13 secrets + 1 connection credential
    expect(elapsed).toBeLessThan(15_000);   // own target for the fake; the staging rehearsal is timed separately (runbook)
    console.info(`kms-compromise drill (fake KMS): ${JSON.stringify(d.steps)} total ${d.totalMs} ms`);

    // Every customer was told, with counts and no names or values.
    const bMail = k.app.email.to(b.login)[0]!;
    expect(bMail.text).toContain("It may have exposed 10 of your stored secrets; 10 of those reads have no matching reveal");
    for (const v of values.values()) expect(JSON.stringify(k.app.email.sent)).not.toContain(v);

    // After: nothing left on the old keys, old keys disabled, every value still reveals under the new keys, stolen wrapped keys are dead.
    for (const old of Object.values(d.oldKeks)) {
      expect(k.kms.keyState(old)).toBe("Disabled");
      expect((await k.app.db.owner.query("select count(*)::int n from secret_versions where kek_ref = $1 and destroyed_at is null", [old])).rows[0].n).toBe(0);
    }
    for (const [p, name] of [[a, "A_PROD"], [a, "A_DEV"], [b, "B7"], [c, "C_PROD"]] as const) {
      const id = (await k.app.db.owner.query("select id from secrets where user_id = $1 and name = $2", [p.user.userId, name])).rows[0].id;
      await k.app.db.owner.query("delete from rate_counters");
      const r = await reveal(k, p, id, await activateReveal(k, p, id));
      expect(r.status, `${name}: ${r.text}`).toBe(200);
      expect(r.json.value).toBe(values.get(`${p.user.userId}:${name}`));
    }
    const credId = (await k.app.db.owner.query("select id from connection_credentials where user_id = $1 and revoked_at is null", [c.user.userId])).rows[0].id;
    expect(await withConnectionCredential(k.app.ctx, credId, "connection.check", async (v) => v.startsWith("npg_"))).toBe(true);
    await expect(k.kms.decrypt("vault-prod", stolen[0]!.kek_ref, Buffer.from(stolen[0]!.wrapped_dek), kmsContext("prod", stolen[0]!.user_id, stolen[0]!.id))).rejects.toBeInstanceOf(KmsError);
    const audit = (await k.app.db.owner.query("select detail from audit_log where action = 'vault.compromise_drill'")).rows[0].detail;
    expect(audit).toMatchObject({ customers: 3, rewrapped: 14, notices: 3 });
  });
});

describe("review: exposure scoping and the drill under hostile input", () => {
  it("review: an attacker's extra Decrypt of a record that was also read legitimately is counted as unaudited", async () => {
    await k.app.db.owner.query("delete from rate_counters");
    const p = await makePerson(k, "extra");
    await putSecret(k, p, "dev", "SHARED", canary());
    await putSecret(k, p, "dev", "ONLY_AUDITED", canary());
    k.app.clock.advance(1000);
    const from = k.app.clock.now();
    const [only, shared] = await rowsOf(p);   // ONLY_AUDITED, SHARED by name
    // One legitimate reveal of each (one audit row and one Decrypt each) ...
    for (const r of [only!, shared!]) expect((await reveal(k, p, r.id, await activateReveal(k, p, r.id))).status).toBe(200);
    // ... then the attacker decrypts SHARED's wrapped key again with the role, with no audit row.
    await k.kms.decrypt("vault-nonprod", shared!.kek_ref, Buffer.from(shared!.wrapped_dek), kmsContext("dev", p.user.userId, shared!.id));
    const to = new Date(k.app.clock.now().getTime() + 1000);
    const mine = (await affectedFromTrail(k.app.ctx, await k.kms.trail(), { from, to })).find((a) => a.user_id === p.user.userId)!;
    const byId = new Map(mine.records.map((r) => [r.record_id, r]));
    expect(byId.get(shared!.id)).toMatchObject({ decrypts: 2, audited: false });
    expect(byId.get(only!.id)).toMatchObject({ decrypts: 1, audited: true });
    expect(mine.unaudited).toBe(1);
  });

  it("review: a non-UUID owner_id or secret_id in the trail is reported as unattributable and never aborts the drill after the keys are disabled", async () => {
    await k.app.db.owner.query("delete from rate_counters");
    const p = await makePerson(k, "junkctx");
    await putSecret(k, p, "dev", "JUNK_CTX", canary());
    const row = (await rowsOf(p))[0]!;
    k.app.clock.advance(1000);
    const from = k.app.clock.now();
    // The attacker holds vault-nonprod and picks a context the key policy accepts (app, env and the key set only).
    const kek = k.kms.currentKek("vault-nonprod");
    for (const ctx of [{ owner_id: "x", secret_id: "y" }, { owner_id: p.user.userId, secret_id: "-".repeat(36) }, { owner_id: "x", secret_id: row.id }]) {
      const c = { app: "mosshatch-nest", env: "dev", ...ctx } as unknown as ReturnType<typeof kmsContext>;
      const dk = await k.kms.generateDataKey("vault-nonprod", kek, c);
      await k.kms.decrypt("vault-nonprod", kek, dk.ciphertextBlob, c);
    }
    // And a real, unaudited Decrypt of the person's record.
    await k.kms.decrypt("vault-nonprod", row.kek_ref, Buffer.from(row.wrapped_dek), kmsContext("dev", p.user.userId, row.id));
    const to = new Date(k.app.clock.now().getTime() + 1000);

    const affected = await affectedFromTrail(k.app.ctx, await k.kms.trail(), { from, to });
    expect(affected.map((a) => a.user_id)).toEqual([p.user.userId]);
    expect(affected[0]!.records).toEqual([expect.objectContaining({ record_id: row.id, decrypts: 1, audited: false })]);

    const incidentId = "01900000-0000-7000-8000-00000000d7d2";
    const d = await runCompromiseDrill(k.app.ctx, { incidentId, window: { from, to } });
    expect(d.steps.map((s) => s.step)).toContain("lift_role_deny");
    expect(d.unattributable).toBe(3);
    expect(d.affected.map((x) => x.user_id)).toEqual([p.user.userId]);
    for (const cls of ["vault-prod", "vault-nonprod"] as const) expect(k.kms.keyState(k.kms.currentKek(cls))).toBe("Enabled");
    const audit = (await k.app.db.owner.query("select detail from audit_log where action = 'vault.compromise_drill' and resource_id = $1", [incidentId])).rows[0].detail;
    expect(audit).toMatchObject({ customers: 1, unattributable: 3 });
  });
});

describe("review: connection writes race a disconnect", () => {
  it("review: a disconnect that lands while a connection PUT is inside KMS leaves no live credential; concurrent PUTs never 500", async () => {
    const p = await makePerson(k, "connrace");
    const put = (cred: string) => call(k, p, "PUT", `/api/v1/domains/${p.domain.fqdn}/connections/vercel`, { kind: "pasted_token", credential: cred });
    expect((await put(`vercel_${canary()}`)).status).toBe(201);
    const liveCreds = async () => (await k.app.db.owner.query(
      "select k.id from connection_credentials k join connections n on n.id = k.connection_id where n.domain_id = $1 and (k.revoked_at is null or k.ciphertext is not null)", [p.domain.id])).rows;

    const orig = k.kms.generateDataKey;
    let entered = 0, release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let inside!: () => void;
    const reached = new Promise<void>((r) => { inside = r; });
    k.kms.generateDataKey = async function (this: typeof k.kms, ...a: Parameters<typeof orig>) { entered++; inside(); await gate; return orig.apply(this, a); };
    try {
      const second = put(`vercel_${canary()}`);
      await reached;
      const del = await call(k, p, "DELETE", `/api/v1/domains/${p.domain.fqdn}/connections/vercel`);
      expect(del.status).toBe(200);
      release();
      const r2 = await second;
      expect(r2.status, r2.text).toBe(409);
      expect(r2.json.error.code).toBe("write_conflict");
    } finally { k.kms.generateDataKey = orig; }
    expect(entered).toBe(1);
    expect(await liveCreds()).toEqual([]);
    const conns = (await k.app.db.owner.query("select status, ended_at from connections where domain_id = $1", [p.domain.id])).rows;
    for (const c of conns) { expect(c.status).toBe("ended"); expect(c.ended_at).not.toBeNull(); }
    expect((await call(k, p, "GET", `/api/v1/domains/${p.domain.fqdn}/nest`)).json.connections).toEqual([]);

    // Two PUTs released from KMS together: each is 201 or 409 (never a raw unique violation), and one credential stays live.
    let both!: () => void, n = 0;
    const together = new Promise<void>((r) => { both = r; });
    k.kms.generateDataKey = async function (this: typeof k.kms, ...a: Parameters<typeof orig>) { if (++n === 2) both(); await together; return orig.apply(this, a); };
    try {
      const rs = await Promise.all([put(`vercel_${canary()}`), put(`vercel_${canary()}`)]);
      for (const r of rs) expect([201, 409], r.text).toContain(r.status);
    } finally { k.kms.generateDataKey = orig; }
    expect(await liveCreds()).toHaveLength(1);
  });
});
