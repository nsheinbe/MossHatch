import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { Router } from "../http/router.ts";
import { FakeDns, type FakeZone } from "../mail/dns.ts";
import { BRAND_EMAIL_DNS, checkDomainExpiry, checkEmailDnsRecords, externalChecksJob, loadExpectations, runExternalChecks, type Expectation } from "./external.ts";

let app: TestApp;
beforeAll(async () => { app = await createTestApp(new Router()); }, 60_000);
afterAll(async () => { await app?.drop(); });
beforeEach(async () => {
  await app.db.owner.query("delete from alerts; delete from external_expectations; delete from owned_domains_watch;");
  app.clock.set(new Date("2026-10-01T12:00:00Z"));
});
const q = <T = any>(sql: string, p: unknown[] = []) => app.db.owner.query(sql, p).then((r) => r.rows as T[]);

const GOOD: FakeZone = {
  ns: { "mosshatch.com": ["ns1.dnsprovider.example", "ns2.dnsprovider.example"], "hatchkind.com": ["ns1.dnsprovider.example", "ns2.dnsprovider.example"] },
  mx: { "mosshatch.com": [{ exchange: "mx1.mailbox.example", priority: 10 }, { exchange: "mx2.mailbox.example", priority: 20 }], "hatchkind.com": [{ exchange: "", priority: 0 }] },
  a: { "mosshatch.com": ["76.76.21.21"], "hatchkind.com": ["76.76.21.21"] },
  txt: {
    "mosshatch.com": [["v=spf1 include:_spf.mailbox.example -all"]], "hatchkind.com": [["v=spf1 -all"]],
    "_dmarc.mosshatch.com": [["v=DMARC1; p=reject; adkim=s; aspf=s; rua=mailto:dmarc@mosshatch.com"]], "_dmarc.hatchkind.com": [["v=DMARC1; p=reject; adkim=s; aspf=s"]],
  },
  caa: { "mosshatch.com": [{ critical: 0, issue: "letsencrypt.org" }], "hatchkind.com": [{ critical: 0, issue: "letsencrypt.org" }, { critical: 0, issuewild: "letsencrypt.org" }] },
};
const EXPECT: Expectation[] = [
  { domain: "mosshatch.com", rrtype: "NS", expected: ["ns1.dnsprovider.example", "ns2.dnsprovider.example"] },
  { domain: "mosshatch.com", rrtype: "MX", expected: ["mx1.mailbox.example", "mx2.mailbox.example"] },
  { domain: "mosshatch.com", rrtype: "A", expected: ["76.76.21.21"] },
  { domain: "hatchkind.com", rrtype: "NS", expected: ["ns1.dnsprovider.example", "ns2.dnsprovider.example"] },
  { domain: "hatchkind.com", rrtype: "MX", expected: [] },
  { domain: "hatchkind.com", rrtype: "A", expected: ["76.76.21.21"] },
];
const zone = (patch: (z: FakeZone) => void): FakeDns => { const z: FakeZone = JSON.parse(JSON.stringify(GOOD)); patch(z); return new FakeDns(z); };

describe("ST-111 external DNS check", () => {
  it("ST-111: matching NS, MX and apex A for both domains produce no finding (case and trailing dot ignored)", async () => {
    // hatchkind.com publishes a null MX, which counts as no mail exchanger in the comparison.
    const z = zone((x) => { x.ns!["mosshatch.com"] = ["NS2.DnsProvider.example.", "ns1.dnsprovider.example"]; });
    expect(await runExternalChecks(z, EXPECT)).toEqual([]);
  });
  it("ST-111: a changed NS, a changed MX and a changed apex A each fire, with expected and actual", async () => {
    const z = zone((x) => {
      x.ns!["mosshatch.com"] = ["ns1.attacker.example", "ns2.dnsprovider.example"];
      x.mx!["mosshatch.com"] = [{ exchange: "mx.attacker.example", priority: 1 }];
      x.a!["hatchkind.com"] = ["203.0.113.9"];
    });
    const f = await runExternalChecks(z, EXPECT);
    expect(f.map((x) => `${x.domain}:${x.rrtype}:${x.kind}`).sort()).toEqual(["hatchkind.com:A:mismatch", "mosshatch.com:MX:mismatch", "mosshatch.com:NS:mismatch"]);
    expect(f.find((x) => x.rrtype === "A")).toMatchObject({ expected: ["76.76.21.21"], actual: ["203.0.113.9"] });
  });
  it("ST-111: an added extra record is a difference, and a removed one too", async () => {
    expect((await runExternalChecks(zone((x) => { x.a!["mosshatch.com"] = ["76.76.21.21", "203.0.113.9"]; }), EXPECT)).map((x) => x.rrtype)).toEqual(["A"]);
    expect((await runExternalChecks(zone((x) => { x.ns!["mosshatch.com"] = ["ns1.dnsprovider.example"]; }), EXPECT)).map((x) => x.rrtype)).toEqual(["NS"]);
  });
  it("ST-111: the daily job reads the stored expectation table and pages (S1) on a difference; a resolver failure only warns", async () => {
    for (const e of EXPECT.filter((e) => e.domain === "mosshatch.com")) await q("insert into external_expectations (domain, rrtype, expected) values ($1,$2,$3)", [e.domain, e.rrtype, e.expected]);
    expect(await loadExpectations(app.ctx)).toHaveLength(3);
    expect(await externalChecksJob(app.ctx, zone(() => undefined))).toEqual([]);
    expect(await q("select 1 from alerts")).toHaveLength(0);
    await externalChecksJob(app.ctx, zone((x) => { x.ns!["mosshatch.com"] = ["ns1.attacker.example"]; }));
    const a = await q("select severity, kind, subject from alerts");
    expect(a).toEqual([{ severity: "page", kind: "external.dns_changed", subject: "mosshatch.com:NS" }]);
    await externalChecksJob(app.ctx, zone((x) => { x.fail = ["mosshatch.com"]; }));
    expect((await q("select severity, kind from alerts where kind = 'external.dns_unreachable' order by subject")).every((r) => r.severity === "warn")).toBe(true);
  });
});

describe("ST-111 expiry alarms", () => {
  const watch = (days: number) => q("insert into owned_domains_watch (domain, registrar, expires_at) values ('mosshatch.com','namecheap',$1) on conflict (domain) do update set expires_at = excluded.expires_at", [new Date(app.clock.now().getTime() + days * 86_400_000 + 3600_000)]);
  it("ST-111: fires at 90, 60 and 30 days, once each, and stays quiet at 91 days", async () => {
    await watch(91); expect(await checkDomainExpiry(app.ctx)).toEqual([]);
    await watch(90); expect((await checkDomainExpiry(app.ctx)).map((f) => f.threshold)).toEqual([90]);
    expect(await checkDomainExpiry(app.ctx)).toEqual([]);                                  // same day again: nothing new
    await watch(60); expect((await checkDomainExpiry(app.ctx)).map((f) => f.threshold)).toEqual([60]);
    await watch(45); expect(await checkDomainExpiry(app.ctx)).toEqual([]);
    await watch(30); expect((await checkDomainExpiry(app.ctx)).map((f) => f.threshold)).toEqual([30]);
    await watch(10); expect(await checkDomainExpiry(app.ctx)).toEqual([]);
    const a = await q("select severity, subject from alerts where kind = 'domain.expiry' order by raised_at, subject");
    expect(a.map((x) => x.subject).sort()).toEqual(["mosshatch.com:30", "mosshatch.com:60", "mosshatch.com:90"]);
    expect(a.find((x) => x.subject.endsWith(":90"))!.severity).toBe("info");
  });
  it("ST-111: a jump straight to under 30 days fires the 30-day alarm only, and a renewal re-arms all three", async () => {
    await watch(25); expect((await checkDomainExpiry(app.ctx)).map((f) => f.threshold)).toEqual([30]);
    await watch(1800); await checkDomainExpiry(app.ctx);                                    // renewed for five years
    expect((await q("select alerted_days from owned_domains_watch"))[0].alerted_days).toEqual([]);
    await watch(85); expect((await checkDomainExpiry(app.ctx)).map((f) => f.threshold)).toEqual([90]);
  });
  it("ST-111: an expired watched domain pages", async () => {
    await watch(-2); await checkDomainExpiry(app.ctx);
    expect((await q("select severity from alerts where kind = 'domain.expiry'"))[0].severity).toBe("page");
  });
});

describe("ST-112 published email records", () => {
  it("ST-112: both domains publish the expected DMARC, SPF, null-MX (hatchkind) and CAA records", async () => {
    expect(await checkEmailDnsRecords(zone(() => undefined), BRAND_EMAIL_DNS)).toEqual([]);
  });
  it("ST-112: each missing or weakened record is named", async () => {
    const cases: [string, (z: FakeZone) => void, string][] = [
      ["dmarc missing", (z) => { delete z.txt!["_dmarc.hatchkind.com"]; }, "hatchkind.com:dmarc:missing"],
      ["dmarc p=none", (z) => { z.txt!["_dmarc.mosshatch.com"] = [["v=DMARC1; p=none; adkim=s; aspf=s"]]; }, "mosshatch.com:dmarc:policy_not_reject"],
      ["dmarc relaxed", (z) => { z.txt!["_dmarc.mosshatch.com"] = [["v=DMARC1; p=reject"]]; }, "mosshatch.com:dmarc:not_strict"],
      ["hatchkind spf allows others", (z) => { z.txt!["hatchkind.com"] = [["v=spf1 include:_spf.google.com -all"]]; }, "hatchkind.com:spf:not_dash_all_only"],
      ["mosshatch spf open", (z) => { z.txt!["mosshatch.com"] = [["v=spf1 +all"]]; }, "mosshatch.com:spf:not_closed"],
      ["spf missing", (z) => { delete z.txt!["mosshatch.com"]; }, "mosshatch.com:spf:missing"],
      ["hatchkind has real mx", (z) => { z.mx!["hatchkind.com"] = [{ exchange: "mail.example", priority: 10 }]; }, "hatchkind.com:mx:not_null_mx"],
      ["hatchkind mx missing", (z) => { delete z.mx!["hatchkind.com"]; }, "hatchkind.com:mx:not_null_mx"],
      ["mosshatch null mx", (z) => { z.mx!["mosshatch.com"] = [{ exchange: "", priority: 0 }]; }, "mosshatch.com:mx:null_mx_on_receiving_domain"],
      ["caa missing", (z) => { delete z.caa!["hatchkind.com"]; }, "hatchkind.com:caa:missing"],
      ["caa rogue issuer", (z) => { z.caa!["mosshatch.com"] = [{ critical: 0, issue: "letsencrypt.org" }, { critical: 0, issue: "evilca.example" }]; }, "mosshatch.com:caa:unexpected_issuer"],
    ];
    for (const [name, patch, want] of cases) {
      const f = await checkEmailDnsRecords(zone(patch), BRAND_EMAIL_DNS);
      expect(f.map((x) => `${x.domain}:${x.check}:${x.code}`), name).toContain(want);
    }
  });
  it("ST-112: a resolver failure is reported, not treated as a pass", async () => {
    const f = await checkEmailDnsRecords(zone((z) => { z.fail = ["_dmarc.mosshatch.com"]; }), BRAND_EMAIL_DNS);
    expect(f.some((x) => x.code === "dns_error")).toBe(true);
  });
});
