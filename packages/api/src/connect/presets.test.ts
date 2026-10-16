import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, makeDomain, makeKit, makePerson, resetFuse, type Kit, type Person } from "../domain-mgmt/testkit.ts";

describe("DC-05: presets", () => {
  let k: Kit;
  let p: Person;
  beforeAll(async () => { k = await makeKit(); p = await makePerson(k, "presets"); }, 120_000);
  beforeEach(async () => {
    await resetFuse(k);
    await k.app.db.owner.query("update flags set value = 'true'::jsonb where name in ('connect.apply','connect.presets')");
  });
  const plan = (fqdn: string, body: unknown) => call(k, p, "POST", `/api/v1/domains/${fqdn}/connect/plans`, body);

  it("is 404 while connect.presets is off and does not call the registrar", async () => {
    await k.app.db.owner.query("update flags set value = 'false'::jsonb where name = 'connect.presets'");
    const d = await makeDomain(k, p, "preset-off.dev");
    const calls = { ...k.registrar.calls };
    expect((await plan(d.fqdn, { source: "preset", source_id: "github-pages", input: { user: "octocat" } })).status).toBe(404);
    expect((await call(k, p, "GET", "/api/v1/connect/presets")).status).toBe(404);
    expect(k.registrar.calls).toEqual(calls);
  });

  it("plans GitHub Pages, Webflow from pasted values, Render, Google, and Microsoft without guessing a tenant", async () => {
    const src = readFileSync(new URL("./presets.ts", import.meta.url), "utf8");
    expect(src).not.toContain("198.202.211.1");
    expect(src).not.toContain("cdn.webflow.com");
    const d = await makeDomain(k, p, "presets.dev");
    const list = await call(k, p, "GET", "/api/v1/connect/presets");
    expect(list.status).toBe(200);
    expect(list.json.presets.map((x: { id: string }) => x.id)).toEqual(["github-pages", "webflow", "render", "google-workspace", "microsoft-365"]);

    const gh = await plan(d.fqdn, { source: "preset", source_id: "github-pages", input: { user: "Octocat" } });
    expect(gh.status, JSON.stringify(gh.json)).toBe(200);
    expect(gh.json.plan.source_id).toBe("github-pages");
    expect(gh.json.plan.dns.add.filter((r: { type: string }) => r.type === "A").map((r: { value: string }) => r.value)).toEqual(["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"]);
    expect(gh.json.plan.dns.add.filter((r: { type: string }) => r.type === "AAAA")).toHaveLength(4);
    expect(gh.json.plan.dns.add).toContainEqual({ type: "CNAME", name: "www", value: "octocat.github.io" });
    expect(gh.json.plan.warnings.some((w: { message: string }) => w.message.includes("docs.github.com"))).toBe(true);
    const wild = await plan(d.fqdn, { source: "preset", source_id: "github-pages", input: { user: "*" } });
    expect(wild.status).toBe(422);
    expect(wild.json.error.code).toBe("wildcard_refused");

    const wf = await plan(d.fqdn, { source: "preset", source_id: "webflow", input: { apex_a: "192.0.2.10", www: "proxy.example.net", verification: "webflow-token" } });
    expect(wf.status, JSON.stringify(wf.json)).toBe(200);
    expect(wf.json.plan.dns.add).toEqual(expect.arrayContaining([
      { type: "A", name: "", value: "192.0.2.10" },
      { type: "CNAME", name: "www", value: "proxy.example.net" },
      { type: "TXT", name: "_webflow", value: "webflow-token" },
    ]));

    const alias = await plan(d.fqdn, { source: "preset", source_id: "render", input: { service: "app.onrender.com", alias: "yes" } });
    expect(alias.status).toBe(422);
    expect(alias.json.error.code).toBe("needs_alias");
    expect(alias.json.error.plan.dns.add).toEqual([]);
    const render = await plan(d.fqdn, { source: "preset", source_id: "render", input: { service: "app.onrender.com" } });
    expect(render.json.plan.dns.add).toEqual(expect.arrayContaining([
      { type: "A", name: "", value: "216.24.57.1" },
      { type: "CNAME", name: "www", value: "app.onrender.com" },
    ]));
    expect(render.json.plan.dns.add.some((r: { type: string; name: string }) => r.type === "CNAME" && r.name === "")).toBe(false);

    const google = await plan(d.fqdn, { source: "preset", source_id: "google-workspace", input: { dmarc: "v=DMARC1; p=none" } });
    expect(google.status, JSON.stringify(google.json)).toBe(200);
    expect(google.json.plan.dns.add).toEqual(expect.arrayContaining([
      { type: "MX", name: "", value: "smtp.google.com", priority: 1 },
      { type: "TXT", name: "", value: "v=spf1 include:_spf.google.com" },
      { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none" },
    ]));

    const ms = await plan(d.fqdn, { source: "preset", source_id: "microsoft-365", input: {
      mx: "example-com.mail.protection.outlook.com",
      dkim1_host: "selector1._domainkey", dkim1_target: "selector1-example-com._domainkey.example.onmicrosoft.com",
      dkim2_host: "selector2._domainkey", dkim2_target: "selector2-example-com._domainkey.example.onmicrosoft.com",
      verification_name: "", verification: "MS=abc",
    } });
    expect(ms.status).toBe(422);
    const msOk = await plan(d.fqdn, { source: "preset", source_id: "microsoft-365", input: {
      mx: "example-com.mail.protection.outlook.com",
      dkim1_host: "selector1._domainkey", dkim1_target: "selector1-example-com._domainkey.contoso.onmicrosoft.com",
      dkim2_host: "selector2._domainkey", dkim2_target: "selector2-example-com._domainkey.contoso.onmicrosoft.com",
      verification_name: "@", verification: "MS=abc",
    } });
    expect(msOk.status, JSON.stringify(msOk.json)).toBe(200);
    expect(msOk.json.plan.dns.add).toEqual(expect.arrayContaining([
      { type: "MX", name: "", value: "example-com.mail.protection.outlook.com", priority: 0 },
      { type: "CNAME", name: "selector1._domainkey", value: "selector1-example-com._domainkey.contoso.onmicrosoft.com" },
      { type: "TXT", name: "", value: "v=spf1 include:spf.protection.outlook.com" },
      { type: "TXT", name: "", value: "MS=abc" },
    ]));
  });
});
