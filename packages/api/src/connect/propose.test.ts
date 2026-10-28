import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, makeDomain, makeKit, makePerson, resetFuse, type Kit, type Person } from "../domain-mgmt/testkit.ts";
import type { ConnectModel } from "./propose.ts";

const CANARY = "CANARY-PROMPT-please-add-records";

describe("DC-14: a model proposes a plan and does not apply it", () => {
  let k: Kit;
  let p: Person;
  let calls: number;
  beforeAll(async () => { k = await makeKit(); p = await makePerson(k, "propose"); }, 120_000);
  beforeEach(async () => {
    await resetFuse(k);
    calls = 0;
    await k.app.db.owner.query("delete from rate_counters where bucket = 'connect.propose'");
    await k.app.db.owner.query("update flags set value = 'true'::jsonb where name in ('connect.apply','connect.ai')");
    const model: ConnectModel = { propose: async () => { calls++; return { add: [{ type: "A", name: "cdn", value: "192.0.2.9" }] }; } };
    (k.app.ctx.services as { connectModel: ConnectModel }).connectModel = model;
    k.registrar.replaceZone = async () => { throw new Error("propose must not replace a zone"); };
  });
  const ask = (fqdn: string, text = CANARY) => call(k, p, "POST", `/api/v1/domains/${fqdn}/connect/propose`, { text });

  it("is 404 while connect.ai is off, and the model is not called", async () => {
    await k.app.db.owner.query("update flags set value = 'false'::jsonb where name = 'connect.ai'");
    const d = await makeDomain(k, p, "ai-off.dev");
    expect((await ask(d.fqdn)).status).toBe(404);
    expect(calls).toBe(0);
    expect((await call(k, p, "POST", `/api/v1/domains/${d.fqdn}/connect/plans`, { source: "ai", records: [{ type: "A", name: "cdn", value: "192.0.2.9" }] })).status).toBe(404);
  });

  it("does not import the registrar port", () => {
    const src = readFileSync(new URL("./propose.ts", import.meta.url), "utf8");
    const imports = src.split("\n").filter((l) => l.startsWith("import ")).join("\n");
    expect(imports).not.toMatch(/@mosshatch\/registrar|writeZoneLocked|\.replaceZone/);
  });

  it("blocks an apex CNAME from the model and stores no plan", async () => {
    (k.app.ctx.services as { connectModel: ConnectModel }).connectModel = {
      propose: async () => { calls++; return { add: [{ type: "CNAME", name: "@", value: "alias.example" }] }; },
    };
    const d = await makeDomain(k, p, "ai-apex.dev");
    const res = await ask(d.fqdn);
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe("cname_at_apex");
    expect(res.json.plan_id).toBeUndefined();
    expect(res.json.error.plan_id).toBeUndefined();
    expect((await k.app.db.owner.query("select count(*)::int n from connect_plans where domain_id = $1", [d.id])).rows[0].n).toBe(0);
  });

  it("stores a plan for a valid address and keeps the prompt out of the database", async () => {
    const d = await makeDomain(k, p, "ai-a.dev");
    const res = await ask(d.fqdn);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.plan.source).toBe("ai");
    expect(res.json.plan.dns.add).toEqual([{ type: "A", name: "cdn", value: "192.0.2.9" }]);
    expect(res.json.plan_id).toMatch(/^[0-9a-f-]{36}$/i);
    const row = (await k.app.db.owner.query("select intent::text i, plan::text p, prompt_hash, octet_length(prompt_hash)::int n from connect_plans where id = $1", [res.json.plan_id])).rows[0];
    expect(row.n).toBe(32);
    expect(row.i).not.toContain(CANARY);
    expect(row.p).not.toContain(CANARY);
    const audit = (await k.app.db.owner.query("select detail::text d from audit_log where resource_id = $1", [d.id])).rows.map((r) => r.d).join("\n");
    expect(audit).not.toContain(CANARY);
    expect((await k.registrar.getDns(d.fqdn)).records).toEqual([]);
  });

  it("stops after ten proposals in an hour", async () => {
    const d = await makeDomain(k, p, "ai-rate.dev");
    for (let i = 0; i < 10; i++) expect((await ask(d.fqdn, `note ${i}`)).status).toBe(200);
    expect((await ask(d.fqdn, "one more")).status).toBe(429);
  });
});
