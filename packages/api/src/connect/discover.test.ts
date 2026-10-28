import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashOf } from "../util/bytes.ts";
import type { JobRow } from "../jobs/registry.ts";
import { call, makeDomain, makeKit, makePerson, resetFuse, type Kit, type Person } from "../domain-mgmt/testkit.ts";
import { discoverJob } from "./discover.ts";
import { clearPinnedTemplates, registerPinnedTemplate } from "./templates.ts";

const job = (payload: Record<string, unknown>): JobRow => ({
  id: "00000000-0000-4000-8000-000000000091", kind: "connect.discover", attempt_id: "attempt", attempts: 1, max_attempts: 3, payload, user_id: null,
});

describe("DC-07: Domain Connect discovery", () => {
  let k: Kit;
  let p: Person;
  beforeAll(async () => { k = await makeKit(); p = await makePerson(k, "discover"); }, 120_000);
  beforeEach(async () => {
    await resetFuse(k);
    k.app.ctx.config.domainConnectHost = "dc.mosshatch.test";
    await k.app.db.owner.query("update flags set value = 'false'::jsonb where name = 'domainconnect.discovery'");
    clearPinnedTemplates();
  });
  const on = () => k.app.db.owner.query("update flags set value = 'true'::jsonb where name = 'domainconnect.discovery'");

  it("is 404 while the flag is off and the job does not write a TXT", async () => {
    const d = await makeDomain(k, p, "dark.dev");
    const calls = { ...k.registrar.calls };
    expect((await k.app.call("GET", `/v2/domainconnect/${d.fqdn}/settings`)).status).toBe(404);
    await discoverJob(k.app.ctx, job({ domain_id: d.id }));
    expect(k.registrar.calls).toEqual(calls);
    expect((await k.registrar.getDns(d.fqdn)).records.some((r) => r.name === "_domainconnect")).toBe(false);
  });

  it("publishes settings and one TXT for a hosted domain, and leaves the other records", async () => {
    await on();
    const d = await makeDomain(k, p, "hosted.dev");
    await k.registrar.replaceZone(d.fqdn, [{ type: "A", name: "www", value: "192.0.2.1" }]);
    const writes = k.registrar.calls.replaceZone;
    const adds = k.registrar.calls.addRecords;
    expect(await discoverJob(k.app.ctx, job({ domain_id: d.id })).then(() => "ok")).toBe("ok");
    expect(k.registrar.calls.replaceZone).toBe(writes);
    expect(k.registrar.calls.addRecords).toBe(adds + 1);
    const zone = await k.registrar.getDns(d.fqdn);
    expect(zone.records).toContainEqual({ type: "A", name: "www", value: "192.0.2.1" });
    expect(zone.records).toContainEqual({ type: "TXT", name: "_domainconnect", value: "dc.mosshatch.test" });
    const snap = (await k.app.db.owner.query("select write_state from dns_snapshots where domain_id = $1", [d.id])).rows[0];
    expect(snap.write_state).toBe("applied");
    await discoverJob(k.app.ctx, job({ domain_id: d.id }));
    expect(k.registrar.calls.addRecords).toBe(adds + 1);
    const settings = await k.app.call("GET", `/v2/domainconnect/${d.fqdn}/settings`);
    expect(settings.status).toBe(200);
    expect(settings.json).toEqual({ providerId: "mosshatch.com", providerName: "Moss Hatch", urlAPI: "https://mosshatch.test" });
    expect(settings.json.urlAsyncUX).toBeUndefined();
    expect(settings.json.urlSyncUX).toBeUndefined();
    await k.app.db.owner.query("insert into flags (name, value) values ('domainconnect.apply', 'true'::jsonb) on conflict (name) do update set value = 'true'::jsonb");
    const sync = await k.app.call("GET", `/v2/domainconnect/${d.fqdn}/settings`);
    expect(sync.json.urlSyncUX).toBe("https://mosshatch.test");
    expect(sync.json.urlAsyncUX).toBeUndefined();
  });

  it("does not write when the settings host is unset", async () => {
    await on();
    k.app.ctx.config.domainConnectHost = undefined;
    const d = await makeDomain(k, p, "nohost.dev");
    const calls = { ...k.registrar.calls };
    await discoverJob(k.app.ctx, job({ domain_id: d.id }));
    expect(k.registrar.calls).toEqual(calls);
  });

  it("answers 404 for foreign nameservers and does not write a TXT", async () => {
    await on();
    const d = await makeDomain(k, p, "foreign.dev");
    await k.app.db.owner.query("update domains set nameservers = $2, dns_hosted_here = false where id = $1", [d.id, ["ns1.elsewhere.net", "ns2.elsewhere.net"]]);
    const calls = { ...k.registrar.calls };
    expect((await k.app.call("GET", `/v2/domainconnect/${d.fqdn}/settings`)).status).toBe(404);
    await discoverJob(k.app.ctx, job({ domain_id: d.id }));
    expect(k.registrar.calls).toEqual(calls);
  });

  it("serves only a pinned template", async () => {
    await on();
    const missing = await k.app.call("GET", "/v2/domainTemplates/providers/example.com/services/nope");
    expect(missing.status).toBe(404);
    const body = { providerId: "example.com", serviceId: "site", version: 1, records: [{ type: "TXT", host: "www", pointsTo: "%host%" }] };
    registerPinnedTemplate({ providerId: "example.com", serviceId: "site", version: 1, hash: hashOf(body).toString("hex"), body });
    const got = await k.app.call("GET", "/v2/domainTemplates/providers/example.com/services/site");
    expect(got.status).toBe(200);
    expect(got.json).toEqual(body);
    await k.app.db.owner.query("update flags set value = 'false'::jsonb where name = 'domainconnect.discovery'");
    expect((await k.app.call("GET", "/v2/domainTemplates/providers/example.com/services/site")).status).toBe(404);
  });
});
