import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withUser } from "@mosshatch/db";
import { appendAudit } from "../audit.ts";
import { hit } from "../ratelimit.ts";
import { prepare } from "../stepup/testkit.ts";
import { activateReveal, call, ciphertextColumns, everySink, makePerson, makeVaultKit, putSecret, reveal, type Person, type VaultKit } from "./testkit.ts";
import { pointerMac } from "./secrets.ts";
import { rewrapAll } from "./jobs.ts";
import { REVEAL_LIMITS } from "./reveal.ts";
import { KmsError } from "./kms/types.ts";

let k: VaultKit;
beforeAll(async () => { k = await makeVaultKit({ timeoutMs: 200 }); }, 120_000);
afterAll(async () => { await k?.drop(); });

const canary = () => `mh_test_CANARY_value_${Math.random().toString(36).slice(2)}`;
const tick = (ms = 61_000) => k.app.clock.advance(ms);
async function secretId(p: Person, env: string, name: string) {
  return (await k.app.db.owner.query("select id from secrets where domain_id = $1 and env = $2 and name = $3 and deleted_at is null", [p.domain.id, env, name])).rows[0]?.id as string;
}
async function resetLimits() { await k.app.db.owner.query("delete from rate_counters"); }

describe("secrets CRUD by domain and environment", () => {
  it("creates, versions, lists names only, and never returns a value from PUT or list", async () => {
    const p = await makePerson(k, "crud");
    const v1 = canary(), v2 = canary();
    const a = await putSecret(k, p, "dev", "api_key", v1);
    expect(a.status, a.text).toBe(201);
    expect(a.json).toMatchObject({ name: "API_KEY", env: "dev", version: 1 });
    const b = await putSecret(k, p, "dev", "API_KEY", v2);
    expect(b.status).toBe(200);
    expect(b.json.version).toBe(2);
    await putSecret(k, p, "prod", "DATABASE_URL", canary());
    const l = await call(k, p, "GET", `/api/v1/domains/${p.domain.fqdn}/secrets/dev`);
    expect(l.status).toBe(200);
    expect(l.json.secrets.map((s: { name: string; version: number }) => [s.name, s.version])).toEqual([["API_KEY", 2]]);
    const n = await call(k, p, "GET", `/api/v1/domains/${p.domain.fqdn}/nest`);
    expect(n.json.envs.dev.count).toBe(1); expect(n.json.envs.prod.count).toBe(1); expect(n.json.envs.preview.count).toBe(0);
    for (const r of [a, b, l, n]) { expect(r.text).not.toContain(v1); expect(r.text).not.toContain(v2); expect(r.headers.get("cache-control")).toBe("no-store, private"); }
    // Ciphertext is not plaintext, and the runtime role cannot read it at all.
    expect(await ciphertextColumns(k)).not.toContain(v1);
    await expect(withUser(k.app.ctx.runtime, p.user.userId, (c) => c.query("select ciphertext from secret_versions"))).rejects.toThrow();
  });

  it("an unknown env, a foreign domain and a released domain are the same 404", async () => {
    const p = await makePerson(k, "c404"), q = await makePerson(k, "c404b");
    const shape = (r: { status: number; json: unknown }) => JSON.stringify([r.status, r.json]);
    const env = await call(k, p, "GET", `/api/v1/domains/${p.domain.fqdn}/secrets/staging`);
    const foreign = await call(k, q, "GET", `/api/v1/domains/${p.domain.fqdn}/secrets/dev`);
    await k.app.db.owner.query("update domains set released_at = now() where id = $1", [p.domain.id]);
    const released = await call(k, p, "PUT", `/api/v1/domains/${p.domain.fqdn}/secrets/dev/X`, { value: "v" });
    expect(env.status).toBe(404);
    expect(shape(foreign)).toBe(shape(env));
    expect(shape(released)).toBe(shape(env));
  });

  it("ST-05: deleting nulls ciphertext and wrapped_dek of every version at once; re-wrap keeps the plaintext; over 16 KiB is 413", async () => {
    const p = await makePerson(k, "st05");
    await putSecret(k, p, "dev", "ONE", canary()); await putSecret(k, p, "dev", "ONE", canary());
    const id = await secretId(p, "dev", "ONE");
    const d = await call(k, p, "DELETE", `/api/v1/domains/${p.domain.fqdn}/secrets/dev/ONE`);
    expect(d.status).toBe(200);
    expect(d.json.versions_destroyed).toBe(2);
    const rows = (await k.app.db.owner.query("select ciphertext, wrapped_dek, destroyed_at from secret_versions where secret_id = $1", [id])).rows;
    expect(rows).toHaveLength(2);
    for (const r of rows) { expect(r.ciphertext).toBeNull(); expect(r.wrapped_dek).toBeNull(); expect(r.destroyed_at).not.toBeNull(); }
    expect((await call(k, p, "DELETE", `/api/v1/domains/${p.domain.fqdn}/secrets/dev/ONE`)).status).toBe(404);

    const value = canary();
    await putSecret(k, p, "prod", "KEEP", value);
    const keep = await secretId(p, "prod", "KEEP");
    const old = k.kms.currentKek("vault-prod");
    const fresh = await k.kms.createKey("vault-prod");
    await k.kms.setCurrentKek("vault-prod", fresh);
    const before = (await k.app.db.owner.query("select ciphertext, nonce, tag from secret_versions where secret_id = $1", [keep])).rows[0];
    await rewrapAll(k.app.ctx, old, fresh);
    const after = (await k.app.db.owner.query("select ciphertext, nonce, tag, kek_ref from secret_versions where secret_id = $1", [keep])).rows[0];
    expect(after.kek_ref).toBe(fresh);
    expect(Buffer.from(after.ciphertext).equals(Buffer.from(before.ciphertext))).toBe(true);
    await k.kms.disableKey(old);
    const act = await activateReveal(k, p, keep);
    const r = await reveal(k, p, keep, act);
    expect(r.status, r.text).toBe(200);
    expect(r.json.value).toBe(value);
    await k.kms.enableKey(old); await k.kms.setCurrentKek("vault-prod", old);

    const big = await putSecret(k, p, "dev", "BIG", "x".repeat(16 * 1024 + 1));
    expect(big.status).toBe(413);
    expect((await putSecret(k, p, "dev", "EXACT", "x".repeat(16 * 1024))).status).toBe(201);
    const multibyte = await putSecret(k, p, "dev", "WIDE", "é".repeat(8 * 1024 + 1));   // 16386 bytes
    expect(multibyte.status).toBe(413);
  });
});

describe("reveal", () => {
  it("ST-23: no committed step-up is 403; one assertion reveals one secret, once", async () => {
    await resetLimits();
    const p = await makePerson(k, "st23");
    const value = canary();
    await putSecret(k, p, "prod", "TOKEN_A", value); await putSecret(k, p, "prod", "TOKEN_B", canary());
    const a = await secretId(p, "prod", "TOKEN_A"), b = await secretId(p, "prod", "TOKEN_B");
    const none = await reveal(k, p, a);
    expect(none.status).toBe(403);
    expect(none.json.error).toMatchObject({ code: "step_up_required", type: "secret.reveal" });
    const act = await activateReveal(k, p, a);
    const wrong = await reveal(k, p, b, act);
    expect(wrong.status).toBe(403);
    const ok = await reveal(k, p, a, act);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toMatchObject({ secret_id: a, name: "TOKEN_A", env: "prod", version: 1, value });
    const again = await reveal(k, p, a, act);
    expect(again.status).toBe(403);
    expect(again.text).not.toContain(value);
    // The action is spent: executed, never back to committed.
    expect((await k.app.db.owner.query("select state from actions where id = $1", [act])).rows[0].state).toBe("executed");
    // A stale commit needs a new activation.
    const late = await activateReveal(k, p, a);
    tick(61_000);
    expect((await reveal(k, p, a, late)).status).toBe(403);
  });

  it("ST-15: reveal and every vault route answer no-store, private with Pragma no-cache, and the value never rides in a URL", async () => {
    await resetLimits();
    const p = await makePerson(k, "st15");
    const value = canary();
    const put = await putSecret(k, p, "dev", "HDR", value);
    const id = put.json.id;
    const r = await reveal(k, p, id, await activateReveal(k, p, id));
    expect(r.headers.get("cache-control")).toBe("no-store, private");
    expect(r.headers.get("pragma")).toBe("no-cache");
    for (const res of [put, await call(k, p, "GET", `/api/v1/domains/${p.domain.fqdn}/nest`), await call(k, p, "DELETE", `/api/v1/domains/${p.domain.fqdn}/secrets/dev/HDR`)]) {
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.get("pragma")).toBe("no-cache");
    }
    const { vaultRoutes } = await import("./routes.ts");
    for (const route of vaultRoutes) { expect(route.path).not.toMatch(/value|token|credential/); if (/reveal|read$/.test(route.path)) expect(route.method).toBe("POST"); }
  });

  it("ST-24: secret.reveal is refused during the passkey hold and the recovery hold, with the hold end in the response", async () => {
    await resetLimits();
    const p = await makePerson(k, "st24");
    await putSecret(k, p, "dev", "HELD", canary());
    const id = await secretId(p, "dev", "HELD");
    const until = new Date(k.app.clock.now().getTime() + 24 * 3_600_000);
    await k.app.db.owner.query("insert into action_holds (user_id, scope, until) values ($1,'secret.reveal',$2)", [p.user.userId, until]);
    const r = await prepare(k.app, p.user, { type: "secret.reveal", target_id: id, user_input: {} });
    expect(r.status).toBe(423);
    expect(r.json.error).toMatchObject({ code: "recovery_hold", hold_until: until.toISOString() });
    await k.app.db.owner.query("delete from action_holds where user_id = $1", [p.user.userId]);
    // A hold that starts after the commit still blocks the reveal.
    const act = await activateReveal(k, p, id);
    const later = new Date(k.app.clock.now().getTime() + 72 * 3_600_000);
    await k.app.db.owner.query("insert into action_holds (user_id, scope, until) values ($1,'all_held',$2)", [p.user.userId, later]);
    const g = await reveal(k, p, id, act);
    expect(g.status).toBe(423);
    expect(g.json.error.hold_until).toBe(later.toISOString());
    expect(g.text).not.toContain("mh_test_CANARY_value_");
  });

  it("ST-25: 3 a minute per secret, 5 a minute and 30 an hour per user", async () => {
    await resetLimits();
    const p = await makePerson(k, "st25");
    await putSecret(k, p, "dev", "S0", canary());
    const s0 = await secretId(p, "dev", "S0");
    for (let i = 0; i < 3; i++) expect((await reveal(k, p, s0, await activateReveal(k, p, s0))).status).toBe(200);
    const fourth = await reveal(k, p, s0, await activateReveal(k, p, s0));
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get("retry-after")).toMatch(/^\d+$/);

    await resetLimits(); tick();
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) { await putSecret(k, p, "dev", `S${i}`, canary()); ids.push(await secretId(p, "dev", `S${i}`)); }
    for (let i = 0; i < 5; i++) expect((await reveal(k, p, ids[i]!, await activateReveal(k, p, ids[i]!))).status).toBe(200);
    expect((await reveal(k, p, ids[5]!, await activateReveal(k, p, ids[5]!))).status).toBe(429);

    await resetLimits(); tick();
    await withUser(k.app.ctx.runtime, p.user.userId, async (c) => { for (let i = 0; i < 30; i++) await hit(k.app.ctx, c, p.user.userId, REVEAL_LIMITS.userHour); });
    expect((await reveal(k, p, ids[0]!, await activateReveal(k, p, ids[0]!))).status).toBe(429);
  });

  it("ST-26: the audit row commits before KMS; a failed insert stops the reveal; a KMS failure does not reopen the action", async () => {
    await resetLimits();
    const p = await makePerson(k, "st26");
    await putSecret(k, p, "prod", "ORDER", canary());
    const id = await secretId(p, "prod", "ORDER");

    // (1) At the moment KMS Decrypt runs, the authorized row is already committed (visible to another connection).
    const orig = k.kms.decrypt.bind(k.kms);
    let seenAtDecrypt = -1;
    k.kms.decrypt = async (...a) => { seenAtDecrypt = (await k.app.db.owner.query("select count(*)::int n from audit_log where chain_id = $1 and action = 'secret.reveal.authorized'", [p.user.userId])).rows[0].n; return orig(...a); };
    expect((await reveal(k, p, id, await activateReveal(k, p, id))).status).toBe(200);
    k.kms.decrypt = orig;
    expect(seenAtDecrypt).toBe(1);

    // (2) The audit insert fails: nothing is decrypted and the action stays unused.
    const decrypts = k.kms.calls.Decrypt;
    const act = await activateReveal(k, p, id);
    await k.app.db.owner.query("revoke insert on audit_log from mh_vault");
    try {
      const r = await reveal(k, p, id, act);
      expect(r.status).toBe(503);
      expect(k.kms.calls.Decrypt).toBe(decrypts);
      expect((await k.app.db.owner.query("select state from actions where id = $1", [act])).rows[0].state).toBe("committed");
    } finally { await k.app.db.owner.query("grant insert on audit_log to mh_vault"); }

    // (3) KMS fails after T1 committed: 503, the action is spent, the same action cannot try again, and `failed` is recorded.
    const act2 = await activateReveal(k, p, id);
    k.kms.failNext = ["ThrottlingException"];
    const f = await reveal(k, p, id, act2);
    expect(f.status).toBe(503);
    expect(f.json.error.code).toBe("vault_unavailable");
    expect((await reveal(k, p, id, act2)).status).toBe(403);
    const acts = (await k.app.db.owner.query("select action from audit_log where chain_id = $1 and resource_id = $2 order by seq", [p.user.userId, id])).rows.map((r) => r.action);
    expect(acts.slice(-2)).toEqual(["secret.reveal.authorized", "secret.reveal.failed"]);
  });

  it("ST-27: a reveal sends the notification; more than 5 reveals in an hour raises the alert", async () => {
    await resetLimits();
    const p = await makePerson(k, "st27");
    await putSecret(k, p, "prod", "DATABASE_URL", canary());
    const id = await secretId(p, "prod", "DATABASE_URL");
    k.app.email.clear();
    const r = await k.app.call("POST", `/api/v1/secrets/${id}/reveal`, { cookie: p.user.cookie, body: {}, headers: { "x-mh-action-id": await activateReveal(k, p, id), "user-agent": "Mozilla/5.0 Chrome/140.0" } });
    expect(r.status).toBe(200);
    const mails = k.app.email.to(p.login);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toMatch(/^Secret DATABASE_URL \(prod\) on st27-\d+-nest\.com was revealed from Chrome at \d{4}-\d\d-\d\d \d\d:\d\d UTC\./);
    expect(k.app.email.to("st27-second@example.net")).toHaveLength(1);
    expect(mails[0]!.text).not.toContain("mh_test_CANARY_value_");
    for (let i = 0; i < 5; i++) { tick(); await k.app.db.owner.query("delete from rate_counters where bucket like 'vault.reveal%'"); expect((await reveal(k, p, id, await activateReveal(k, p, id))).status).toBe(200); }
    const alerts = (await k.app.db.owner.query("select kind, severity from alerts where subject = $1", [p.user.userId])).rows;
    expect(alerts).toContainEqual({ kind: "vault.reveal_rate", severity: "warn" });
  });
});

describe("integrity of stored rows", () => {
  it("ST-03: swapping the names of two secrets in one domain and env fails to decrypt, even with a valid pointer MAC", async () => {
    await resetLimits();
    const p = await makePerson(k, "st03");
    const va = canary(), vb = canary();
    await putSecret(k, p, "prod", "ALPHA", va); await putSecret(k, p, "prod", "BRAVO", vb);
    const a = await secretId(p, "prod", "ALPHA"), b = await secretId(p, "prod", "BRAVO");
    await k.app.db.owner.query("update secrets set name = 'TMP_SWAP' where id = $1", [a]);
    await k.app.db.owner.query("update secrets set name = 'ALPHA' where id = $1", [b]);
    await k.app.db.owner.query("update secrets set name = 'BRAVO' where id = $1", [a]);
    // Worst case: the attacker could also forge the pointer MAC. The AAD still refuses.
    for (const id of [a, b]) {
      const s = (await k.app.db.owner.query("select * from secrets where id = $1", [id])).rows[0];
      const mac = await pointerMac(k.app.ctx, { id, domain_id: s.domain_id, name: s.name, env: s.env, current_version: s.current_version, current_version_id: s.current_version_id });
      await k.app.db.owner.query("update secrets set pointer_mac = $2 where id = $1", [id, mac]);
    }
    const act = await activateReveal(k, p, a);
    const r = await reveal(k, p, a, act);
    expect(r.status).toBe(500);
    expect(r.json.error.code).toBe("vault_integrity");
    expect(r.text).not.toContain(va); expect(r.text).not.toContain(vb);
    expect((await k.app.db.owner.query("select 1 from alerts where kind = 'vault.integrity' and subject = $1", [a])).rowCount).toBe(1);
  });

  it("ST-04: pointing current_version_id at an older version fails the pointer MAC", async () => {
    await resetLimits();
    const p = await makePerson(k, "st04");
    const old = canary();
    await putSecret(k, p, "prod", "ROLLED", old); await putSecret(k, p, "prod", "ROLLED", canary());
    const id = await secretId(p, "prod", "ROLLED");
    const act = await activateReveal(k, p, id);
    const v1 = (await k.app.db.owner.query("select id from secret_versions where secret_id = $1 and version = 1", [id])).rows[0].id;
    await k.app.db.owner.query("update secrets set current_version_id = $2, current_version = 1 where id = $1", [id, v1]);
    const r = await reveal(k, p, id, act);
    expect(r.status).toBe(500);
    expect(r.text).not.toContain(old);
    // Only the id moved (version left at 2): also refused.
    await k.app.db.owner.query("update secrets set current_version = 2 where id = $1", [id]);
    expect((await reveal(k, p, id, await activateReveal(k, p, id).catch(() => "00000000-0000-0000-0000-000000000000"))).status).toBeGreaterThanOrEqual(400);
  });

  it("ST-12: the runtime database role cannot insert reveal or read audit rows; the vault role can", async () => {
    const p = await makePerson(k, "st12");
    for (const action of ["secret.reveal.authorized", "secret.reveal.released", "secret.read", "secret.reveal"]) {
      await expect(withUser(k.app.ctx.runtime, p.user.userId, (c) => appendAudit(k.app.ctx, c, { chainId: p.user.userId, actorKind: "user", action })), action).rejects.toThrow(/vault role/);
    }
    await expect(withUser(k.app.ctx.cron, p.user.userId, (c) => appendAudit(k.app.ctx, c, { chainId: p.user.userId, actorKind: "system", action: "secret.read" }))).rejects.toThrow(/vault role/);
    await withUser(k.vaultPool, p.user.userId, (c) => appendAudit(k.app.ctx, c, { chainId: p.user.userId, actorKind: "user", action: "secret.reveal.authorized" }));
    // Other audit rows are unaffected.
    await withUser(k.app.ctx.runtime, p.user.userId, (c) => appendAudit(k.app.ctx, c, { chainId: p.user.userId, actorKind: "user", action: "secret.write" }));
  });
});

describe("failing closed", () => {
  it("ST-13: with KMS down, reveal, write and re-wrap fail closed with 503 vault_unavailable and log no context", async () => {
    await resetLimits();
    const p = await makePerson(k, "st13");
    const value = canary();
    await putSecret(k, p, "prod", "DOWN", value);
    const id = await secretId(p, "prod", "DOWN");
    const act = await activateReveal(k, p, id);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      k.kms.down = true;
      const r = await reveal(k, p, id, act);
      expect(r.status).toBe(503); expect(r.json).toEqual({ error: { code: "vault_unavailable" } });
      const w = await putSecret(k, p, "prod", "DOWN", canary());
      expect(w.status).toBe(503); expect(w.json).toEqual({ error: { code: "vault_unavailable" } });
      await expect(rewrapAll(k.app.ctx, k.kms.currentKek("vault-prod"), await k.kms.createKey("vault-prod"))).rejects.toBeInstanceOf(KmsError);
      k.kms.down = false; k.kms.hang = true;
      const act2 = await activateReveal(k, p, id);
      const t = await reveal(k, p, id, act2);
      expect(t.status).toBe(503);
    } finally {
      k.kms.down = false; k.kms.hang = false;
      const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
      spies.forEach((s) => s.mockRestore());
      for (const needle of [id, p.user.userId, p.domain.id, "owner_id", "secret_id", value, "DOWN"]) expect(logged).not.toContain(needle);
    }
  });

  it("ST-18: malformed, truncated, oversized and non-UTF-8 bodies, KMS AccessDenied, throttling and timeout, and a name race leak nothing", async () => {
    await resetLimits();
    const p = await makePerson(k, "st18");
    const value = canary();
    const path = `/api/v1/domains/${p.domain.fqdn}/secrets/dev/RACE`;
    const raw = async (body: BodyInit) => {
      const req = k.app.req("PUT", path, { cookie: p.user.cookie });
      return k.app.router!.dispatch(k.app.ctx, new Request(req.url, { method: "PUT", headers: req.headers, body }));
    };
    const bodies: string[] = [];
    for (const b of [`{"value":"${value}"`, `{"value":"${value}", "x": }`, `{"value":${JSON.stringify(value)},"extra":1}`, `{"value":"${value}\\ud800"}`, `{"value":"${"y".repeat(300_000)}${value}"}`]) {
      const r = await raw(b); const t = await r.text(); bodies.push(t);
      expect(r.status, t).toBeGreaterThanOrEqual(400);
    }
    const nonUtf8 = await raw(Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from(`${value}"}`)]));
    expect(nonUtf8.status).toBe(422); bodies.push(await nonUtf8.text());
    for (const e of ["AccessDeniedException", "ThrottlingException", "Timeout"] as const) {
      k.kms.failNext = [e];
      const r = await putSecret(k, p, "dev", "KMSFAIL", value);
      expect(r.status, e).toBe(503); bodies.push(r.text);
    }
    // Two writers race for a new name: one creates, the other either versions it or loses with 409; never a 500 or a leak.
    const [x, y] = await Promise.all([putSecret(k, p, "dev", "RACE", value), putSecret(k, p, "dev", "RACE", canary())]);
    expect([x.status, y.status].sort()).toEqual(expect.arrayContaining([201]));
    for (const r of [x, y]) { expect([200, 201, 409]).toContain(r.status); bodies.push(r.text); }
    const hay = bodies.join("\n") + (await everySink(k));
    expect(hay).not.toContain(value);
  });

  it("ST-20: a name that is a canary, an sk_live_ string or 200 characters is refused with 422 and appears nowhere", async () => {
    await resetLimits();
    const p = await makePerson(k, "st20");
    const names = ["mh_test_CANARY_name_q7", "sk_live_4eC39HqLyjWDarjtT1zdp7dc", "N".repeat(200), "NODE_OPTIONS"];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const bodies: string[] = [];
    try {
      for (const n of names) {
        const r = await putSecret(k, p, "dev", encodeURIComponent(n), "value");
        expect(r.status, n.slice(0, 12)).toBe(422);
        expect(r.json).toEqual({ error: { code: "invalid_name" } });
        bodies.push(r.text);
      }
    } finally {
      const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
      spies.forEach((s) => s.mockRestore());
      bodies.push(logged);
    }
    const rejected = (await k.app.db.owner.query("select detail from audit_log where chain_id = $1 and action = 'secret.name_rejected'", [p.user.userId])).rows.map((r) => r.detail.reason);
    expect(rejected.sort()).toEqual(["length", "reserved", "scanner", "scanner"]);
    const hay = bodies.join("\n") + (await everySink(k));
    for (const n of names.slice(0, 3)) expect(hay).not.toContain(n);
  });
});
