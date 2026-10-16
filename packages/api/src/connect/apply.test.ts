import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, makeDomain, makeKit, makePerson, resetFuse, stepUp, type Kit, type Person } from "../domain-mgmt/testkit.ts";

describe("DC-04: connect plans apply only when the hash still matches", () => {
  let k: Kit;
  let p: Person;
  beforeAll(async () => { k = await makeKit(); p = await makePerson(k, "connect"); }, 120_000);
  beforeEach(async () => {
    await resetFuse(k);
    await k.app.db.owner.query("update flags set value = 'true'::jsonb where name = 'connect.apply'");
  });

  const plans = (fqdn: string, body: unknown) => call(k, p, "POST", `/api/v1/domains/${fqdn}/connect/plans`, body);
  const apply = (fqdn: string, id: string, planHash: string) => call(k, p, "POST", `/api/v1/domains/${fqdn}/connect/plans/${id}/apply`, { plan_hash: planHash });

  it("answers 404 for plan and apply while the flag is off, and does not call the registrar", async () => {
    await k.app.db.owner.query("update flags set value = 'false'::jsonb where name = 'connect.apply'");
    const d = await makeDomain(k, p, "flag-off.dev");
    const calls = { ...k.registrar.calls };
    expect((await plans(d.fqdn, { source: "pasted", records: [{ type: "A", name: "@", value: "192.0.2.1" }] })).status).toBe(404);
    expect((await apply(d.fqdn, "00000000-0000-7000-8000-000000000099", "ab".repeat(32))).status).toBe(404);
    expect(k.registrar.calls).toEqual(calls);
  });

  it("an empty diff is 200 and does not replace the zone", async () => {
    const d = await makeDomain(k, p, "empty-diff.dev");
    await k.registrar.replaceZone(d.fqdn, [{ type: "TXT", name: "status", value: "hello" }]);
    const writes = k.registrar.calls.replaceZone;
    const planned = await plans(d.fqdn, { source: "pasted", records: [{ type: "TXT", name: "status", value: "hello" }] });
    expect(planned.status, JSON.stringify(planned.json)).toBe(200);
    expect(planned.json.plan.dns).toEqual({ add: [], remove: [] });
    const done = await apply(d.fqdn, planned.json.plan_id, planned.json.plan_hash);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.changed).toBe(false);
    expect(k.registrar.calls.replaceZone).toBe(writes);
  });

  it("adds an apex A after connect.apply, and refuses the same plan without the passkey", async () => {
    const d = await makeDomain(k, p, "apex-a.dev");
    const planned = await plans(d.fqdn, { source: "pasted", records: [{ type: "A", name: "@", value: "192.0.2.1" }] });
    expect(planned.status, JSON.stringify(planned.json)).toBe(200);
    expect(planned.json.plan.sensitive.some((s: { type: string; name: string }) => s.type === "A" && s.name === "")).toBe(true);
    const refused = await apply(d.fqdn, planned.json.plan_id, planned.json.plan_hash);
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("approval_required");
    expect((await k.registrar.getDns(d.fqdn)).records).toEqual([]);

    const action = await stepUp(k, p, "connect.apply", planned.json.plan_id, {});
    const approved = await call(k, p, "POST", `/api/v1/connect/plans/${planned.json.plan_id}/approve`, {}, action);
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    const done = await apply(d.fqdn, planned.json.plan_id, planned.json.plan_hash);
    expect(done.status, JSON.stringify(done.json)).toBe(202);
    expect(done.json.snapshot_id).toBeTruthy();
    expect((await k.registrar.getDns(d.fqdn)).records).toEqual([{ type: "A", name: "", value: "192.0.2.1" }]);
    const snap = (await k.app.db.owner.query("select write_state from dns_snapshots where id = $1", [done.json.snapshot_id])).rows[0];
    expect(snap.write_state).toBe("applied");
    const audit = (await k.app.db.owner.query("select action, detail from audit_log where action = 'connect.applied' and resource_id = $1", [d.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toMatchObject({ source: "pasted", plan_id: planned.json.plan_id, plan_hash: planned.json.plan_hash });
    expect(JSON.stringify(audit[0].detail)).not.toContain("192.0.2.1");
    expect(k.app.email.sent.some((m) => m.text.includes("connect change (pasted:pasted)") && m.text.includes(d.fqdn))).toBe(true);
  });

  it("a zone that changed between plan and apply is left as it is", async () => {
    const d = await makeDomain(k, p, "changed.dev");
    await k.registrar.replaceZone(d.fqdn, [{ type: "TXT", name: "status", value: "one" }]);
    const planned = await plans(d.fqdn, { source: "pasted", records: [{ type: "A", name: "@", value: "192.0.2.8" }] });
    expect(planned.status).toBe(200);
    await k.registrar.replaceZone(d.fqdn, [{ type: "TXT", name: "status", value: "two" }]);
    const writes = k.registrar.calls.replaceZone;
    const done = await apply(d.fqdn, planned.json.plan_id, planned.json.plan_hash);
    expect(done.status, JSON.stringify(done.json)).toBe(409);
    expect(done.json.error.code).toBe("plan_changed");
    expect(k.registrar.calls.replaceZone).toBe(writes);
    expect((await k.registrar.getDns(d.fqdn)).records).toEqual([{ type: "TXT", name: "status", value: "two" }]);
  });

  it("an approval is not a pass for a different hash, and a paused registrar writes nothing", async () => {
    const d = await makeDomain(k, p, "other-hash.dev");
    const planned = await plans(d.fqdn, { source: "pasted", records: [{ type: "A", name: "@", value: "192.0.2.4" }] });
    const action = await stepUp(k, p, "connect.apply", planned.json.plan_id, {});
    expect((await call(k, p, "POST", `/api/v1/connect/plans/${planned.json.plan_id}/approve`, {}, action)).status).toBe(200);
    const writes = k.registrar.calls.replaceZone;
    const other = await apply(d.fqdn, planned.json.plan_id, "ab".repeat(32));
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe("plan_changed");
    expect(k.registrar.calls.replaceZone).toBe(writes);
    expect((await k.registrar.getDns(d.fqdn)).records).toEqual([]);

    const txt = await plans(d.fqdn, { source: "pasted", records: [{ type: "TXT", name: "status", value: "hello" }] });
    expect(txt.json.plan.sensitive).toEqual([]);
    await k.app.db.owner.query("update flags set value = 'true'::jsonb where name = 'registrar_writes_paused'");
    const paused = await apply(d.fqdn, txt.json.plan_id, txt.json.plan_hash);
    expect(paused.status, JSON.stringify(paused.json)).toBe(503);
    expect(paused.json.error.code).toBe("registrar_writes_paused");
    expect(k.registrar.calls.replaceZone).toBe(writes);
    expect((await k.registrar.getDns(d.fqdn)).records).toEqual([]);
  });
});
