import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getJobDef } from "../jobs/registry.ts";
import { activateReveal, bearerRead, call, everySink, makeBinding, makePerson, makeVaultKit, putSecret, reveal, type Person, type VaultKit } from "./testkit.ts";
import { readSecretsForBinding } from "./read.ts";

let k: VaultKit;
beforeAll(async () => { k = await makeVaultKit({ timeoutMs: 200 }); }, 120_000);
afterAll(async () => { await k?.drop(); });

const canary = () => `mh_test_CANARY_value_${Math.random().toString(36).slice(2)}`;
const scope = (p: Person, env: string, capability = "secrets.read") => ({ capability, domain_id: p.domain.id, env });
async function resetLimits() { await k.app.db.owner.query("delete from rate_counters"); }

describe("bearer reads (the second read path)", () => {
  it("reads a domain and env with the matching scope; values only in this response; no-store", async () => {
    const p = await makePerson(k, "br");
    const a = canary(), b = canary();
    await putSecret(k, p, "dev", "A_ONE", a); await putSecret(k, p, "dev", "B_TWO", b); await putSecret(k, p, "prod", "P", canary());
    const t = await makeBinding(k, p, [scope(p, "dev")], "cli");
    const r = await bearerRead(k, p.domain.fqdn, "dev", t.token);
    expect(r.status, r.text).toBe(200);
    expect(r.json.secrets).toEqual([{ name: "A_ONE", version: 1, value: a }, { name: "B_TWO", version: 1, value: b }]);
    expect(r.headers.get("cache-control")).toBe("no-store, private");
    const one = await bearerRead(k, p.domain.fqdn, "dev", t.token, { names: ["b_two"] });
    expect(one.json.secrets.map((s: { name: string }) => s.name)).toEqual(["B_TWO"]);
  });

  it("ST-28: a cookie session is refused, a missing scope is 403 (never an empty list), and prod needs an explicit :prod", async () => {
    await resetLimits();
    const p = await makePerson(k, "st28");
    await putSecret(k, p, "prod", "PROD_ONLY", canary()); await putSecret(k, p, "dev", "DEV_ONLY", canary());
    const cookie = await call(k, p, "POST", `/api/v1/domains/${p.domain.fqdn}/secrets/dev/read`, {});
    expect(cookie.status).toBe(403);
    expect(cookie.json.error.code).toBe("forbidden_principal");
    const none = await makeBinding(k, p, []);
    const r1 = await bearerRead(k, p.domain.fqdn, "dev", none.token);
    expect(r1.status).toBe(403); expect(r1.json).toEqual({ error: { code: "scope_missing" } });
    const star = await makeBinding(k, p, [{ capability: "secrets.read", domain_id: "*", env: "*" }]);
    expect((await bearerRead(k, p.domain.fqdn, "dev", star.token)).status).toBe(200);
    const pr = await bearerRead(k, p.domain.fqdn, "prod", star.token);
    expect(pr.status).toBe(403); expect(pr.json.error.code).toBe("scope_missing");
    const other = await makeBinding(k, p, [{ capability: "secrets.read", domain_id: "018f0000-0000-7000-8000-000000000000", env: "dev" }]);
    expect((await bearerRead(k, p.domain.fqdn, "dev", other.token)).status).toBe(403);
    const explicit = await makeBinding(k, p, [`secrets.read:${p.domain.id}:prod`]);
    const ok = await bearerRead(k, p.domain.fqdn, "prod", explicit.token);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.secrets.map((s: { name: string }) => s.name)).toEqual(["PROD_ONLY"]);
    // A different capability on the right domain and env is still no scope.
    const wrongCap = await makeBinding(k, p, [scope(p, "dev", "secrets.write")]);
    expect((await bearerRead(k, p.domain.fqdn, "dev", wrongCap.token)).status).toBe(403);
  });

  it("ST-09 and ST-31: a dev- or preview-scoped CLI or agent token cannot obtain a prod read", async () => {
    await resetLimits();
    const p = await makePerson(k, "st31");
    await putSecret(k, p, "prod", "X", canary());
    const cli = await makeBinding(k, p, [scope(p, "dev"), scope(p, "preview"), { capability: "secrets.read", domain_id: p.domain.id, env: "*" }], "cli");
    const r = await bearerRead(k, p.domain.fqdn, "prod", cli.token);
    expect(r.status).toBe(403);
    const decrypts = k.kms.calls.Decrypt;
    await expect(readSecretsForBinding(k.app.ctx, { userId: p.user.userId, bindingId: cli.id, bindingKind: "cli", scopes: [scope(p, "dev")] }, { domainId: p.domain.id, env: "prod" })).rejects.toMatchObject({ status: 403 });
    expect(k.kms.calls.Decrypt).toBe(decrypts);
  });

  it("ST-32: a binding holding secrets.read with dns.write (on any domain) is refused; secrets.read with recipes.apply is allowed", async () => {
    await resetLimits();
    const p = await makePerson(k, "st32");
    await putSecret(k, p, "dev", "X", canary());
    const bad = await makeBinding(k, p, [scope(p, "dev"), { capability: "dns.write", domain_id: "018f0000-0000-7000-8000-000000000000", env: null }]);
    const r = await bearerRead(k, p.domain.fqdn, "dev", bad.token);
    expect(r.status).toBe(403); expect(r.json.error.code).toBe("scope_conflict");
    const good = await makeBinding(k, p, [scope(p, "dev"), { capability: "recipes.apply", domain_id: p.domain.id, env: null }]);
    expect((await bearerRead(k, p.domain.fqdn, "dev", good.token)).status).toBe(200);
  });

  it("ST-29: one audit row per secret commits before decrypt; if that write fails the read fails and nothing is decrypted", async () => {
    await resetLimits();
    const p = await makePerson(k, "st29");
    for (const n of ["A", "B", "C"]) await putSecret(k, p, "preview", n, canary());
    const t = await makeBinding(k, p, [scope(p, "preview")]);
    const orig = k.kms.decrypt.bind(k.kms);
    const seen: number[] = [];
    k.kms.decrypt = async (...a) => { seen.push((await k.app.db.owner.query("select count(*)::int n from audit_log where chain_id = $1 and action = 'secret.read'", [p.user.userId])).rows[0].n); return orig(...a); };
    try { expect((await bearerRead(k, p.domain.fqdn, "preview", t.token)).status).toBe(200); } finally { k.kms.decrypt = orig; }
    expect(seen).toEqual([3, 3, 3]);
    const rows = (await k.app.db.owner.query("select actor_kind, actor_id, resource_id, detail from audit_log where chain_id = $1 and action = 'secret.read'", [p.user.userId])).rows;
    expect(new Set(rows.map((r) => r.resource_id)).size).toBe(3);
    for (const r of rows) { expect(r.actor_kind).toBe("agent"); expect(r.actor_id).toBe(t.id); expect(Object.keys(r.detail).sort()).toEqual(["binding_id", "decrypt_nonce", "domain_id", "env", "version"]); }

    const before = k.kms.calls.Decrypt;
    await k.app.db.owner.query("revoke insert on audit_log from mh_vault");
    try {
      const r = await bearerRead(k, p.domain.fqdn, "preview", t.token);
      expect(r.status).toBe(503);
      expect(r.text).not.toMatch(/mh_test_CANARY_value_/);
    } finally { await k.app.db.owner.query("grant insert on audit_log to mh_vault"); }
    expect(k.kms.calls.Decrypt).toBe(before);
  });

  it("ST-30: token read limits return 429 (20 a minute, 6 an hour on prod) and the hourly digest email is sent", async () => {
    await resetLimits();
    const p = await makePerson(k, "st30");
    await putSecret(k, p, "dev", "D", canary()); await putSecret(k, p, "prod", "P", canary());
    const t = await makeBinding(k, p, [scope(p, "dev"), scope(p, "prod")]);
    for (let i = 0; i < 20; i++) expect((await bearerRead(k, p.domain.fqdn, "dev", t.token)).status).toBe(200);
    const over = await bearerRead(k, p.domain.fqdn, "dev", t.token);
    expect(over.status).toBe(429); expect(over.headers.get("retry-after")).toMatch(/^\d+$/);

    // ST-25: agent traffic never counts against the person's reveal buckets.
    const id = (await k.app.db.owner.query("select id from secrets where domain_id = $1 and name = 'D'", [p.domain.id])).rows[0].id;
    expect((await reveal(k, p, id, await activateReveal(k, p, id))).status).toBe(200);

    await k.app.db.owner.query("delete from rate_counters where bucket = 'vault.read.token.m'");
    for (let i = 0; i < 6; i++) expect((await bearerRead(k, p.domain.fqdn, "prod", t.token)).status).toBe(200);
    expect((await bearerRead(k, p.domain.fqdn, "prod", t.token)).status).toBe(429);

    const jobs = (await k.app.db.owner.query("select * from jobs where kind = 'vault.read_digest' and payload->>'binding_id' = $1", [t.id])).rows;
    expect(jobs).toHaveLength(1);
    expect(Object.keys(jobs[0].payload).sort()).toEqual(["binding_id", "hour", "user_id"]);
    k.app.email.clear();
    await getJobDef("vault.read_digest")!.handler(k.app.ctx, jobs[0]);
    const mail = k.app.email.to(p.login);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toMatch(/read 26 secrets in the hour from .*, 6 of them from prod/);
  });

  it("cross-tenant: another person's token never reaches this domain, whatever its scopes say", async () => {
    await resetLimits();
    const a = await makePerson(k, "xa"), b = await makePerson(k, "xb");
    const value = canary();
    await putSecret(k, a, "dev", "A", value);
    const tb = await makeBinding(k, b, [{ capability: "secrets.read", domain_id: a.domain.id, env: "dev" }, { capability: "secrets.read", domain_id: "*", env: "*" }]);
    const r = await bearerRead(k, a.domain.fqdn, "dev", tb.token);
    const missing = await bearerRead(k, "nothing-here-at-all.com", "dev", tb.token);
    expect(r.status).toBe(404);
    expect(JSON.stringify([r.status, r.json])).toBe(JSON.stringify([missing.status, missing.json]));
    expect(r.text).not.toContain(value);
    await expect(readSecretsForBinding(k.app.ctx, { userId: b.user.userId, bindingId: tb.id, bindingKind: "agent", scopes: [{ capability: "secrets.read", domain_id: a.domain.id, env: "dev" }] }, { domainId: a.domain.id, env: "dev" }))
      .resolves.toEqual([]);   // RLS: B's tenant context sees none of A's rows even when handed A's domain id
  });

  it("at most 100 secrets per read; KMS down is 503 vault_unavailable; nothing leaks", async () => {
    await resetLimits();
    const p = await makePerson(k, "cap");
    const t = await makeBinding(k, p, [scope(p, "dev")]);
    const value = canary();
    await putSecret(k, p, "dev", "FIRST", value);
    k.kms.down = true;
    const down = await bearerRead(k, p.domain.fqdn, "dev", t.token);
    k.kms.down = false;
    expect(down.status).toBe(503); expect(down.json).toEqual({ error: { code: "vault_unavailable" } });
    for (let i = 0; i < 100; i++) await k.app.db.owner.query("delete from rate_counters where bucket = 'vault.write.user.m'").then(() => putSecret(k, p, "dev", `N${i}`, "v"));
    const many = await bearerRead(k, p.domain.fqdn, "dev", t.token);
    expect(many.status).toBe(422); expect(many.json.error.code).toBe("too_many_secrets");
    expect((await bearerRead(k, p.domain.fqdn, "dev", t.token, { names: Array.from({ length: 101 }, (_, i) => `N${i}`) })).status).toBe(400);
    expect((await everySink(k)) + down.text + many.text).not.toContain(value);
  });
});
