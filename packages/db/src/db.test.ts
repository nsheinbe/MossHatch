import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./testing.ts";
import { withUser, withNoUser } from "./client.ts";

let db: TestDb;
let a: string, b: string;
beforeAll(async () => {
  db = await createTestDb();
  const ins = async (email: string) => (await db.owner.query("insert into users (email, status, email_verified_at) values ($1,'active',now()) returning id", [email])).rows[0].id as string;
  a = await ins("a@example.com"); b = await ins("b@example.com");
  await db.owner.query("insert into domains (user_id, fqdn_ascii, tld, registrar, livemode) values ($1,'a-only.com','com','mock',false)", [a]);
  await db.owner.query("insert into passkeys (user_id, credential_id, public_key, alg, backup_eligible, backup_state) values ($1,'cred-a','\\x00',-7,false,false)", [a]);
}, 60_000);
afterAll(async () => { await db?.drop(); });

describe("schema and roles", () => {
  it("migrates and creates uuidv7 ids that sort by time", async () => {
    const r = await db.owner.query("select uuidv7() a, pg_sleep(0.01), uuidv7() b");
    expect(r.rows[0].a < r.rows[0].b).toBe(true);
    expect(String(r.rows[0].a)[14]).toBe("7");
  });
  it("ST-92: runtime role sees only its tenant, and nothing when unset", async () => {
    expect((await withUser(db.runtime, a, (c) => c.query("select fqdn_ascii from domains"))).rows).toHaveLength(1);
    expect((await withUser(db.runtime, b, (c) => c.query("select fqdn_ascii from domains"))).rows).toHaveLength(0);
    expect((await withNoUser(db.runtime, (c) => c.query("select id from domains"))).rows).toHaveLength(0);
    expect((await withNoUser(db.runtime, (c) => c.query("select id from users"))).rows).toHaveLength(0);
    expect((await withNoUser(db.runtime, (c) => c.query("select id from passkeys"))).rows).toHaveLength(0);
    await expect(withUser(db.runtime, b, (c) => c.query("insert into domains (user_id, fqdn_ascii, tld, registrar, livemode) values ($1,'x.com','com','mock',false)", [a]))).rejects.toThrow();
  });
  it("a plain connection with no transaction setting also fails closed", async () => {
    expect((await db.runtime.query("select id from domains")).rows).toHaveLength(0);
  });
  it("the runtime role cannot touch tables outside its grants", async () => {
    await expect(db.runtime.query("select * from schema_migrations")).rejects.toThrow(/permission denied/);
    await expect(db.runtime.query("update flags set value = 'true'")).rejects.toThrow(/permission denied/);
  });
  it("ST-142 (part): audit_log rejects update, delete and truncate for every role, even the owner", async () => {
    await db.owner.query("insert into audit_log (chain_id, seq, actor_kind, action, prev_mac, mac) values ($1,1,'system','x','\\x00','\\x01')", [a]);
    for (const pool of [db.owner, db.runtime, db.cron]) {
      await expect(pool.query("update audit_log set action = 'y'")).rejects.toThrow();
      await expect(pool.query("delete from audit_log")).rejects.toThrow();
      await expect(pool.query("truncate audit_log")).rejects.toThrow();
    }
  });
  it("pre-auth definer functions work without a tenant and leak nothing extra", async () => {
    const r = await withNoUser(db.runtime, (c) => c.query("select id from auth_user_by_email('A@EXAMPLE.COM')"));
    expect(r.rows).toHaveLength(1);
    const p = await withNoUser(db.runtime, (c) => c.query("select user_id from auth_passkey_lookup('cred-a')"));
    expect(p.rows[0].user_id).toBe(a);
    expect((await withNoUser(db.runtime, (c) => c.query("select * from auth_passkey_lookup('nope')"))).rows).toHaveLength(0);
  });
  it("sign-up replaces an attacker's pending row and never touches a live account (ST-42 core)", async () => {
    const first = (await withNoUser(db.runtime, (c) => c.query("select auth_signup_pending('victim@example.com') id"))).rows[0].id;
    const second = (await withNoUser(db.runtime, (c) => c.query("select auth_signup_pending('victim@example.com') id"))).rows[0].id;
    expect(first).not.toBe(second);
    expect((await db.owner.query("select count(*)::int n from users where email = 'victim@example.com'")).rows[0].n).toBe(1);
    const live = (await withNoUser(db.runtime, (c) => c.query("select auth_signup_pending('a@example.com') id"))).rows[0].id;
    expect(live).toBeNull();
  });
  it("jobs reject payloads that carry secret-shaped keys, and accept domain names containing 'token'", async () => {
    await expect(db.owner.query(`insert into jobs (kind, payload) values ('x', '{"auth_code":"abc"}')`)).rejects.toThrow();
    await db.owner.query(`insert into jobs (kind, payload) values ('x', '{"fqdn":"tokenlab.com"}')`);
  });
});
