import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activateReveal, bearerRead, call, ciphertextColumns, everySink, makeBinding, makePerson, makeVaultKit, putSecret, reveal, type VaultKit } from "../vault/testkit.ts";
import { rewrapAll } from "../vault/jobs.ts";
import { getJobDef } from "../jobs/registry.ts";
import { vaultRoutes } from "../vault/routes.ts";

/**
 * ST-17 (server side): the value canary appears only in the reveal and bearer-read response bodies. Every vault route is
 * driven through success and forced failure with the canary in play, and every sink is searched: console output, every
 * table that holds payloads or logs, the mail transport, the KMS trail (CloudTrail stand-in), the ciphertext columns
 * (as text), jobs, alerts and every other response body and header. The browser half (console, HAR, storage, heap) is
 * the end-to-end suite's.
 */

let k: VaultKit;
beforeAll(async () => { k = await makeVaultKit({ timeoutMs: 200 }); }, 120_000);
afterAll(async () => { await k?.drop(); });

describe("ST-17: the value canary appears only in reveal and read response bodies", () => {
  it("across CRUD, reveal, bearer read, forced failures, digest, re-wrap and delete", async () => {
    const value = `mh_test_CANARY_value_${Math.random().toString(36).slice(2)}_end`;
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const allowed: string[] = [];     // the one reveal and the read bodies
    const other: string[] = [];       // everything else the server said
    const keep = <R extends { text: string; headers: Headers }>(r: R, into: string[]): R => { into.push(r.text, JSON.stringify([...r.headers.entries()])); return r; };
    try {
      const a = await makePerson(k, "cna"), b = await makePerson(k, "cnb");
      const put = keep(await putSecret(k, a, "prod", "CANARY_HOLDER", value), other);
      expect(put.status).toBe(201);
      keep(await putSecret(k, a, "dev", "CANARY_HOLDER", value), other);
      const id = put.json.id as string;
      // Another tenant tries everything with the canary.
      keep(await putSecret(k, b, "prod", "X", value), other);
      keep(await call(k, b, "PUT", `/api/v1/domains/${a.domain.fqdn}/secrets/prod/CANARY_HOLDER`, { value }), other);
      keep(await reveal(k, b, id), other);
      // Listing, nest and bad input with the canary in the body.
      keep(await call(k, a, "GET", `/api/v1/domains/${a.domain.fqdn}/nest`), other);
      keep(await call(k, a, "GET", `/api/v1/domains/${a.domain.fqdn}/secrets/prod`), other);
      keep(await call(k, a, "PUT", `/api/v1/domains/${a.domain.fqdn}/secrets/prod/CANARY_HOLDER`, { value, extra: value }), other);
      keep(await call(k, a, "PUT", `/api/v1/domains/${a.domain.fqdn}/secrets/prod/CANARY_HOLDER`, { value: value + "\ud800" }), other);
      keep(await call(k, a, "PUT", `/api/v1/domains/${a.domain.fqdn}/secrets/prod/NODE_OPTIONS`, { value }), other);
      keep(await call(k, a, "PUT", `/api/v1/domains/${a.domain.fqdn}/connections/resend`, { kind: "pasted_token", credential: value }), other);
      // KMS failures during write and reveal.
      k.kms.failNext = ["AccessDeniedException"];
      keep(await putSecret(k, a, "prod", "CANARY_HOLDER", value), other);
      const act1 = await activateReveal(k, a, id);
      k.kms.failNext = ["ThrottlingException"];
      keep(await reveal(k, a, id, act1), other);
      // The one reveal.
      const act2 = await activateReveal(k, a, id);
      const r = keep(await reveal(k, a, id, act2), allowed);
      expect(r.status).toBe(200);
      expect(r.json.value).toBe(value);
      keep(await reveal(k, a, id, act2), other);   // re-serve refused
      // Bearer reads: success, scope miss, KMS down.
      const t = await makeBinding(k, a, [{ capability: "secrets.read", domain_id: a.domain.id, env: "prod" }]);
      const rd = keep(await bearerRead(k, a.domain.fqdn, "prod", t.token), allowed);
      expect(rd.json.secrets[0].value).toBe(value);
      keep(await bearerRead(k, a.domain.fqdn, "dev", t.token), other);
      k.kms.down = true;
      keep(await bearerRead(k, a.domain.fqdn, "prod", t.token), other);
      k.kms.down = false;
      // Digest, re-wrap, delete.
      const job = (await k.app.db.owner.query("select * from jobs where kind = 'vault.read_digest'")).rows[0];
      await getJobDef("vault.read_digest")!.handler(k.app.ctx, job);
      const fresh = await k.kms.createKey("vault-prod");
      await rewrapAll(k.app.ctx, k.kms.currentKek("vault-prod"), fresh);
      keep(await call(k, a, "DELETE", `/api/v1/domains/${a.domain.fqdn}/secrets/dev/CANARY_HOLDER`), other);
      // Every vault route once more, as nobody and as the wrong principal, with the canary in the body.
      for (const route of vaultRoutes) {
        const path = route.path.replace(/:(\w+)/g, (_m, n) => (n === "fqdn" ? a.domain.fqdn : n === "env" ? "prod" : n === "id" ? id : n === "service" ? "vercel" : "CANARY_HOLDER"));
        keep(await k.app.call(route.method, path, { body: route.method === "GET" ? undefined : { value }, browser: false }), other);
        keep(await k.app.call(route.method, path, { cookie: b.user.cookie, body: route.method === "GET" ? undefined : { value } }), other);
      }
    } finally {
      k.kms.down = false;
      const logged = spies.flatMap((s) => s.mock.calls.flat().map((x) => (typeof x === "string" ? x : JSON.stringify(x)))).join("\n");
      spies.forEach((s) => s.mockRestore());
      other.push(logged);
    }
    expect(allowed.join("\n")).toContain(value);
    const sinks = [other.join("\n"), await everySink(k), await ciphertextColumns(k)].join("\n");
    for (const needle of [value, value.slice(0, 24), value.slice(-16), Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex")]) {
      expect(sinks.includes(needle), `canary fragment found: ${needle.slice(0, 10)}…`).toBe(false);
    }
  });
});
