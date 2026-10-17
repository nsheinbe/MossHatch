import crypto from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashOf } from "../util/bytes.ts";
import { call, makeDomain, makeKit, makePerson, resetFuse, stepUp, type Kit, type Person } from "../domain-mgmt/testkit.ts";
import { clearPinnedTemplates, registerPinnedTemplate } from "./templates.ts";
import { publicKeyFromTxt, verifyQuerySignature } from "./sync.ts";

describe("DC-08 signature", () => {
  it("rebuilds a key from unsorted TXT chunks and checks the query in the order it was sent", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const b64 = (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
    const mid = Math.floor(b64.length / 2);
    const key = publicKeyFromTxt([`p=2,a=RS256,d=${b64.slice(mid)}`, `p=1,a=RS256,d=${b64.slice(0, mid)}`]);
    expect(key).toBeTruthy();
    const query = "domain=a.dev&token=hello&redirect_uri=https%3A%2F%2Fexample.com%2Fdone&state=s1";
    const sig = crypto.sign("RSA-SHA256", Buffer.from(query), privateKey).toString("base64");
    expect(verifyQuerySignature(query, sig, key!)).toBe(true);
    expect(verifyQuerySignature("token=hello&domain=a.dev&redirect_uri=https%3A%2F%2Fexample.com%2Fdone&state=s1", sig, key!)).toBe(false);
  });
});

describe("DC-08 signed sync apply", () => {
  let k: Kit;
  let p: Person;
  let sign: (query: string) => string;
  beforeAll(async () => {
    k = await makeKit();
    p = await makePerson(k, "sync");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const b64 = (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
    const mid = Math.floor(b64.length / 2);
    const txts = [`p=2,a=RS256,d=${b64.slice(mid)}`, `p=1,a=RS256,d=${b64.slice(0, mid)}`];
    (k.app.ctx.services as { connectTxt: (name: string) => Promise<string[]> }).connectTxt = async (name) => name === "_dc1.example.com" ? txts : [];
    sign = (query) => `${query}&key=_dc1&sig=${encodeURIComponent(crypto.sign("RSA-SHA256", Buffer.from(query), privateKey).toString("base64"))}`;
  }, 120_000);
  beforeEach(async () => {
    await resetFuse(k);
    clearPinnedTemplates();
    await k.app.db.owner.query("update flags set value = 'true'::jsonb where name in ('domainconnect.apply','connect.apply')");
    const txt = { providerId: "example.com", providerName: "Example Service", serviceId: "site", version: 1, syncPubKeyDomain: "example.com", syncRedirectDomain: "example.com", records: [{ groupId: "a", type: "TXT", host: "status", data: "%token%" }] };
    const mx = { providerId: "example.com", providerName: "Example Service", serviceId: "mail", version: 1, syncPubKeyDomain: "example.com", syncRedirectDomain: "example.com", records: [{ type: "MX", host: "@", pointsTo: "mx.example.com", priority: "10" }] };
    registerPinnedTemplate({ providerId: "example.com", serviceId: "site", version: 1, hash: hashOf(txt).toString("hex"), body: txt });
    registerPinnedTemplate({ providerId: "example.com", serviceId: "mail", version: 1, hash: hashOf(mx).toString("hex"), body: mx });
  });
  const plansFor = async (domainId: string) =>
    (await k.app.db.owner.query("select count(*)::int n from connect_plans where domain_id = $1", [domainId])).rows[0].n as number;
  const queryFor = (fqdn: string, extra = "") => `domain=${fqdn}&token=hello&redirect_uri=${encodeURIComponent("https://example.com/done")}&state=s1${extra}`;

  it("is 404 while domainconnect.apply is off", async () => {
    await k.app.db.owner.query("update flags set value = 'false'::jsonb where name = 'domainconnect.apply'");
    const d = await makeDomain(k, p, "sync-off.dev");
    const calls = { ...k.registrar.calls };
    const res = await k.app.call("GET", `/v2/domainTemplates/providers/example.com/services/site/apply?${sign(queryFor(d.fqdn))}`);
    expect(res.status).toBe(404);
    expect(k.registrar.calls).toEqual(calls);
    expect(await plansFor(d.id)).toBe(0);
  });

  it("redirects a bad signature and an unpinned template without a plan or a write", async () => {
    const d = await makeDomain(k, p, "sync-bad.dev");
    const calls = { ...k.registrar.calls };
    const bad = await k.app.call("GET", `/v2/domainTemplates/providers/example.com/services/site/apply?${sign(queryFor(d.fqdn)).replace("token=hello", "token=hellp")}`);
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toContain("error=invalid_request");
    expect(bad.headers.get("location")).toContain("https://example.com/done");
    const missing = await k.app.call("GET", `/v2/domainTemplates/providers/example.com/services/nope/apply?${sign(queryFor(d.fqdn))}`);
    expect(missing.status).toBe(400);
    expect(missing.headers.get("location")).toBeNull();
    const foreign = await k.app.call("GET", `/v2/domainTemplates/providers/example.com/services/site/apply?${sign(queryFor(d.fqdn).replace(encodeURIComponent("https://example.com/done"), encodeURIComponent("https://evil.test/done")))}`);
    expect(foreign.status).toBe(400);
    expect(foreign.headers.get("location")).toBeNull();
    expect(k.registrar.calls).toEqual(calls);
    expect(await plansFor(d.id)).toBe(0);
  });

  it("cancels without a write, and confirm of a TXT redirects with the original state", async () => {
    const d = await makeDomain(k, p, "sync-txt.dev");
    const q = sign(queryFor(d.fqdn));
    const writes = k.registrar.calls.replaceZone;
    const cancel = await call(k, p, "POST", "/api/v1/connect/domainconnect/confirm", { query: q, decision: "cancel", provider_id: "example.com", service_id: "site" });
    expect(cancel.status).toBe(200);
    expect(cancel.json.redirect).toContain("error=access_denied");
    expect(cancel.json.redirect).toContain("error_description=user_cancel");
    expect(cancel.json.redirect).toContain("state=s1");
    expect(k.registrar.calls.replaceZone).toBe(writes);
    expect(await plansFor(d.id)).toBe(0);
    const ok = await call(k, p, "POST", "/api/v1/connect/domainconnect/confirm", { query: q, decision: "confirm", provider_id: "example.com", service_id: "site" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.redirect).toContain("state=s1");
    expect(ok.json.redirect).not.toContain("error=");
    expect((await k.registrar.getDns(d.fqdn)).records).toContainEqual({ type: "TXT", name: "status", value: "hello" });
    const open = await k.app.call("GET", `/v2/domainTemplates/providers/example.com/services/site/apply?${q}`);
    expect(open.status).toBe(302);
    expect(open.headers.get("location")).toContain("/domainconnect/consent/example.com/site?");
  });

  it("requires a passkey for an MX and writes nothing without one", async () => {
    const d = await makeDomain(k, p, "sync-mx.dev");
    const q = sign(`domain=${d.fqdn}&redirect_uri=${encodeURIComponent("https://example.com/done")}&state=mx1`);
    const writes = k.registrar.calls.replaceZone;
    const denied = await call(k, p, "POST", "/api/v1/connect/domainconnect/confirm", { query: q, decision: "confirm", provider_id: "example.com", service_id: "mail" });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe("approval_required");
    expect(denied.json.redirect).toBeUndefined();
    expect(k.registrar.calls.replaceZone).toBe(writes);
    expect((await k.registrar.getDns(d.fqdn)).records.some((r) => r.type === "MX")).toBe(false);
    const action = await stepUp(k, p, "connect.apply", denied.json.error.plan_id);
    const ok = await call(k, p, "POST", "/api/v1/connect/domainconnect/confirm", { query: q, decision: "confirm", provider_id: "example.com", service_id: "mail" }, action);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.redirect).toContain("state=mx1");
    expect((await k.registrar.getDns(d.fqdn)).records).toContainEqual({ type: "MX", name: "", value: "mx.example.com", priority: 10 });
  });
});
