import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, makeDomain, makeKit, makePerson, resetFuse, type Kit, type Person } from "../domain-mgmt/testkit.ts";

describe("DC-13: delegation", () => {
  let k: Kit;
  let p: Person;
  beforeAll(async () => { k = await makeKit(); p = await makePerson(k, "delegate"); }, 120_000);
  beforeEach(async () => {
    await resetFuse(k);
    await k.app.db.owner.query("update flags set value = 'true'::jsonb where name in ('connect.apply','connect.presets')");
  });
  const plan = (fqdn: string, body: unknown) => call(k, p, "POST", `/api/v1/domains/${fqdn}/connect/plans`, body);

  it("does not replace the zone when Cloudflare Pages is the apex", async () => {
    const d = await makeDomain(k, p, "pages.dev");
    const writes = k.registrar.calls.replaceZone;
    const apex = await plan(d.fqdn, { source: "preset", source_id: "cloudflare-pages", input: { project: "my-project", host: "" } });
    expect(apex.status).toBe(422);
    expect(apex.json.error.code).toBe("needs_alias");
    expect(k.registrar.calls.replaceZone).toBe(writes);
    const sub = await plan(d.fqdn, { source: "preset", source_id: "cloudflare-pages", input: { project: "My-Project", host: "www" } });
    expect(sub.status, JSON.stringify(sub.json)).toBe(200);
    expect(sub.json.plan.dns.add).toEqual([{ type: "CNAME", name: "www", value: "my-project.pages.dev" }]);
    expect(k.registrar.calls.replaceZone).toBe(writes);
  });

  it("refuses a nameserver change without the existing step-up", async () => {
    const d = await makeDomain(k, p, "ns.dev");
    const writes = k.registrar.calls.replaceZone;
    const res = await call(k, p, "POST", `/api/v1/domains/${d.fqdn}/nameservers`, { kind: "nameservers", nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("step_up_required");
    expect(k.registrar.calls.replaceZone).toBe(writes);
  });

  it("plans a pasted Railway www CNAME when presets are on, and does not invent an address", async () => {
    const src = readFileSync(new URL("./presets.ts", import.meta.url), "utf8");
    const railway = src.slice(src.indexOf('id: "railway"'), src.indexOf('id: "wix"'));
    expect(railway).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    const d = await makeDomain(k, p, "rail.dev");
    const res = await plan(d.fqdn, { source: "preset", source_id: "railway", input: { www: "example.up.railway.app", verification_name: "_railway", verification: "check" } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.plan.dns.add).toEqual([
      { type: "CNAME", name: "www", value: "example.up.railway.app" },
      { type: "TXT", name: "_railway", value: "check" },
    ]);
    expect(res.json.plan.dns.add.some((r: { type: string }) => r.type === "A")).toBe(false);
  });
});
