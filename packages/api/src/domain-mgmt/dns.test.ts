import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DnsRecord } from "@mosshatch/registrar/port";
import { zoneHash } from "@mosshatch/registrar/dns";
import type { DnsOverwriteMode } from "@mosshatch/registrar/mock-port";
import { classifyRecord } from "./classify.ts";
import { call, makeDomain, makeKit, makePerson, poll, resetFuse, type Kit, type Person } from "./testkit.ts";

describe("ST-127: record classification", () => {
  const T = (name: string, value = "x", type: string = "TXT") => classifyRecord({ type: type as DnsRecord["type"], name, value }, "example.com");
  it("the table: DKIM selector, ACME challenge, wildcard, upper case, trailing dot, punycode, @ and a DKIM TXT without v=DKIM1 are all sensitive", () => {
    const sensitive: [string, string, string][] = [
      ["sel._domainkey.example.com", "TXT", "v=DKIM1; k=rsa; p=MIIB"],
      ["sel._domainkey.example.com", "TXT", "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A"],       // no v=DKIM1
      ["sel._domainkey", "TXT", "anything at all"],                                            // relative name, value irrelevant
      ["_acme-challenge.www.example.com", "TXT", "token"],
      ["*.sub.example.com", "A", "192.0.2.1"],
      ["*", "CNAME", "elsewhere.example.net"],
      ["_DMARC.EXAMPLE.COM.", "TXT", "v=DMARC1; p=none"],                                       // upper case and trailing dot
      ["SEL._DomainKey.Example.Com.", "TXT", "x"],
      ["_dmarc.xn--bcher-kva.example", "TXT", "v=DMARC1; p=none"],                              // punycode label after an underscore
      ["_dmarc.bücher.example", "TXT", "v=DMARC1; p=none"],                                     // the same name written in Unicode
      ["@", "A", "192.0.2.1"], ["", "AAAA", "2001:db8::1"], ["example.com", "CNAME", "x.example.net"], ["EXAMPLE.COM.", "A", "192.0.2.1"],
      ["www", "A", "192.0.2.1"], ["autoconfig", "CNAME", "x.example.net"], ["autodiscover", "CNAME", "x.example.net"], ["mta-sts", "A", "192.0.2.1"],
      ["anything", "MX", "mail.example.net"], ["_sip._tcp", "SRV", "sip.example.net"], ["blog", "NS", "ns.example.net"],
      ["random", "TXT", "v=spf1 include:_spf.example.net -all"], ["random", "TXT", '"v=DMARC1; p=reject"'], ["random", "TXT", "google-site-verification=abc"],
      ["random", "TXT", "  V=DKIM1; p=abc"],
    ];
    for (const [name, type, value] of sensitive) expect(T(name, value, type).sensitive, `${type} ${name}`).toBe(true);
  });
  it("ordinary records are not sensitive", () => {
    for (const [name, type, value] of [["blog", "CNAME", "x.example.net"], ["app", "A", "192.0.2.1"], ["api.eu", "AAAA", "2001:db8::1"], ["status", "TXT", "hello world"], ["shop.eu", "A", "192.0.2.9"]] as const)
      expect(T(name, value, type).sensitive, `${type} ${name}`).toBe(false);
  });
  it("the reasons say why", () => {
    expect(T("sel._domainkey", "x").reasons).toContain("underscore_label");
    expect(T("@", "x", "A").reasons).toContain("apex");
    expect(T("*.a", "x", "A").reasons).toContain("wildcard");
    expect(T("blog", "x", "MX").reasons).toContain("type");
  });
});

for (const mode of ["whole_zone", "per_type"] as DnsOverwriteMode[]) {
  describe(`ST-128 (${mode} provider): DNS write safety`, () => {
    let k: Kit; let alice: Person; let bob: Person;
    const zone: DnsRecord[] = [
      { type: "A", name: "", value: "192.0.2.10" }, { type: "A", name: "www", value: "192.0.2.10" }, { type: "MX", name: "", value: "mail.example.net", priority: 10 },
      { type: "TXT", name: "", value: "v=spf1 include:_spf.example.net -all" }, { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none" },
      { type: "TXT", name: "note", value: "hello" }, { type: "CNAME", name: "blog", value: "blog.example.net" },
    ];
    let n = 0;
    async function fresh() {
      const d = await makeDomain(k, alice, `st128-${mode.replace("_", "")}-${++n}.com`);
      await k.registrar.replaceZone(d.fqdn, zone);
      return d;
    }
    const live = async (fqdn: string) => (await k.registrar.getDns(fqdn)).records;
    const snaps = async (id: string) => (await k.app.db.owner.query("select * from dns_snapshots where domain_id = $1 order by taken_at, id", [id])).rows;

    beforeAll(async () => { k = await makeKit({ dnsOverwrite: mode }); alice = await makePerson(k, "alice"); bob = await makePerson(k, "bob"); }, 120_000);
    afterAll(async () => { await k?.app.drop(); });
    beforeEach(async () => { await resetFuse(k); k.app.email.clear(); });

    it("a benign add keeps every other record, takes a snapshot first, and sends no alarm", async () => {
      const d = await fresh();
      const before = await live(d.fqdn);
      const res = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/dns`, { records: [{ type: "A", name: "app", value: "192.0.2.77" }] });
      expect(res.status, res.text).toBe(200);
      expect(res.json.changed).toBe(true); expect(res.json.sensitive).toBe(false); expect(res.json.added).toBe(1); expect(res.json.removed).toBe(0);
      const after = await live(d.fqdn);
      expect(after).toHaveLength(before.length + 1);
      for (const r of before) expect(after.some((x) => x.type === r.type && x.name === r.name && x.value === r.value), `${r.type} ${r.name} survived`).toBe(true);
      const s = await snaps(d.id);
      expect(s).toHaveLength(1);
      expect(s[0].zone_hash).toBe(zoneHash(before)); expect(s[0].after_hash).toBe(zoneHash(after)); expect(s[0].records).toHaveLength(before.length);
      expect(new Date(s[0].expires_at).getTime() - new Date(s[0].taken_at).getTime()).toBe(30 * 86_400_000);
      expect(k.app.email.sent.filter((m) => m.kind === "dns.sensitive_changed")).toHaveLength(0);
    });

    it("a human-session change to a sensitive record is allowed, emails every address with a freeze link, and can be rolled back from the snapshot", async () => {
      const d = await fresh();
      const before = await live(d.fqdn);
      const res = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/dns`, { records: [{ type: "TXT", name: "sel._domainkey", value: "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA" }, { type: "MX", name: "", value: "evil.example.org", priority: 5 }] });
      expect(res.status, res.text).toBe(200);
      expect(res.json.sensitive).toBe(true);
      expect(res.json.sensitive_records.map((r: { type: string }) => r.type).sort()).toEqual(["MX", "TXT"]);
      for (const to of [alice.login, alice.second, alice.registrantAddr]) {
        const m = k.app.email.to(to).filter((x) => x.kind === "dns.sensitive_changed");
        expect(m, to).toHaveLength(1);
        expect(/email-actions\/[A-Za-z0-9_-]{43}/.test(m[0]!.text)).toBe(true);
        expect(m[0]!.text).toContain("roll the change back");
        expect(m[0]!.text).not.toContain("evil.example.org");      // names and types, never values
      }
      expect((await k.app.db.owner.query("select detail from audit_log where action = 'dns.sensitive_change' and resource_id = $1", [d.id])).rows).toHaveLength(1);
      expect(await live(d.fqdn)).toHaveLength(before.length + 2);

      const list = await call(k, alice, "GET", `/api/v1/domains/${d.fqdn}/dns-snapshots`);
      expect(list.json.snapshots).toHaveLength(1);
      const rb = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/dns-snapshots/${res.json.snapshot_id}/rollback`, {});
      expect(rb.status, rb.text).toBe(200);
      expect(zoneHash(await live(d.fqdn))).toBe(zoneHash(before));
      // The rollback took its own snapshot, so it can be undone, and it told every address because it touched sensitive records.
      const s = await snaps(d.id);
      expect(s.map((x) => x.reason)).toEqual(["pre_write", "pre_rollback"]);
      expect(k.app.email.to(alice.second).filter((x) => x.kind === "dns.sensitive_changed")).toHaveLength(2);
      const undo = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/dns-snapshots/${rb.json.undo_snapshot_id}/rollback`, {});
      expect(undo.status).toBe(200);
      expect(await live(d.fqdn)).toHaveLength(before.length + 2);
    });

    it("a write that would delete unrelated records is refused and changes nothing", async () => {
      const d = await fresh();
      const before = await live(d.fqdn);
      // The web grid sends the whole zone, and this one forgot the MX and the SPF record.
      const forgot = zone.filter((r) => r.type !== "MX" && !(r.type === "TXT" && r.name === ""));
      const res = await call(k, alice, "PUT", `/api/v1/domains/${d.fqdn}/dns`, { records: [...forgot, { type: "A", name: "app", value: "192.0.2.5" }] });
      expect(res.status).toBe(422); expect(res.json.error.code).toBe("unrelated_delete");
      expect(zoneHash(await live(d.fqdn))).toBe(zoneHash(before));
      expect(await snaps(d.id)).toHaveLength(0);
      // Naming the MX (but not the SPF) is still refused; naming both is allowed.
      const partial = await call(k, alice, "PUT", `/api/v1/domains/${d.fqdn}/dns`, { records: forgot, remove: [{ type: "MX", name: "@" }] });
      expect(partial.json.error.code).toBe("unrelated_delete");
      const ok = await call(k, alice, "PUT", `/api/v1/domains/${d.fqdn}/dns`, { records: forgot, remove: [{ type: "MX", name: "@" }, { type: "TXT", name: "" }] });
      expect(ok.status, ok.text).toBe(200); expect(ok.json.removed).toBe(2);
      expect((await live(d.fqdn)).some((r) => r.type === "MX")).toBe(false);
      expect(await snaps(d.id)).toHaveLength(1);
    });

    it("more than 5 deleted records is refused; 5 is allowed", async () => {
      const d = await makeDomain(k, alice, `st128-many-${mode.replace("_", "")}-${++n}.com`);
      const many: DnsRecord[] = Array.from({ length: 8 }, (_, i) => ({ type: "A", name: `h${i}`, value: `192.0.2.${i + 1}` }));
      await k.registrar.replaceZone(d.fqdn, many);
      const six = await call(k, alice, "PUT", `/api/v1/domains/${d.fqdn}/dns`, { records: many.slice(6) });
      expect(six.status).toBe(422); expect(six.json.error.code).toBe("too_many_deletes");
      expect(await live(d.fqdn)).toHaveLength(8);
      const five = await call(k, alice, "PUT", `/api/v1/domains/${d.fqdn}/dns`, { records: many.slice(5) });
      expect(five.status, five.text).toBe(200);
      expect(await live(d.fqdn)).toHaveLength(3);
    });

    it("edit and delete by record id; the id survives a re-read", async () => {
      const d = await fresh();
      const read = await call(k, alice, "GET", `/api/v1/domains/${d.fqdn}/dns`);
      expect(read.json.hosted).toBe(true); expect(read.json.sync_state).toBe("in_sync");
      const note = read.json.records.find((r: { name: string; type: string }) => r.name === "note");
      const blog = read.json.records.find((r: { name: string }) => r.name === "blog");
      expect(read.json.records.find((r: { name: string; type: string }) => r.type === "MX").sensitive).toBe(true);
      expect(read.json.records.find((r: { name: string }) => r.name === "@" && r.name).name).toBe("@");
      expect(note.sensitive).toBe(false);
      const patch = await call(k, alice, "PATCH", `/api/v1/domains/${d.fqdn}/dns/${note.id}`, { value: "changed" });
      expect(patch.status, patch.text).toBe(200);
      expect((await live(d.fqdn)).find((r) => r.name === "note")!.value).toBe("changed");
      expect((await call(k, alice, "PATCH", `/api/v1/domains/${d.fqdn}/dns/${note.id}`, { value: "again" })).status).toBe(404);   // the old id is gone
      const del = await call(k, alice, "DELETE", `/api/v1/domains/${d.fqdn}/dns/${blog.id}`);
      expect(del.status, del.text).toBe(200);
      expect((await live(d.fqdn)).some((r) => r.name === "blog")).toBe(false);
      expect((await snaps(d.id))).toHaveLength(2);
    });

    it("plain refusals: a TXT value over 254 characters, a CNAME beside other records, an MX without priority", async () => {
      const d = await fresh();
      const long = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/dns`, { records: [{ type: "TXT", name: "big", value: "a".repeat(255) }] });
      expect(long.status).toBe(422); expect(long.json.error.code).toBe("txt_too_long");
      const clash = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/dns`, { records: [{ type: "CNAME", name: "www", value: "x.example.net" }] });
      expect(clash.json.error.code).toBe("cname_conflict");
      const apex = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/dns`, { records: [{ type: "CNAME", name: "@", value: "x.example.net" }] });
      expect(apex.json.error.code).toBe("cname_at_apex");
      const mx = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/dns`, { records: [{ type: "MX", name: "sub", value: "m.example.net" }] });
      expect(mx.json.error.code).toBe("mx_needs_priority");
      expect(await snaps(d.id)).toHaveLength(0);
    });

    it("a write the provider silently drops is caught by the read-back and reported, and the zone is unchanged", async () => {
      const d = await fresh();
      const before = await live(d.fqdn);
      k.registrar.faults.set("dnsWriteIgnored", { times: 1, fqdn: d.fqdn });
      const res = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/dns`, { records: [{ type: "A", name: "lost", value: "192.0.2.99" }] });
      expect(res.status).toBe(502); expect(res.json.error.code).toBe("dns_write_failed");
      expect(zoneHash(await live(d.fqdn))).toBe(zoneHash(before));
    });

    it("two writes at once are serialised by the per-domain lock: both land, and the second snapshot is the first write's result", async () => {
      const d = await fresh();
      const [a, b] = await Promise.all([
        call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/dns`, { records: [{ type: "A", name: "one", value: "192.0.2.1" }] }),
        call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/dns`, { records: [{ type: "A", name: "two", value: "192.0.2.2" }] }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const names = (await live(d.fqdn)).map((r) => r.name);
      expect(names).toContain("one"); expect(names).toContain("two");
      const s = await snaps(d.id);
      expect(s).toHaveLength(2);
      const [first, second] = s;
      expect(second.zone_hash).toBe(first.after_hash);
    });

    it("DNS hosted elsewhere is read-only and says where; a stranger gets 404 for read, write, snapshots and rollback", async () => {
      const d = await fresh();
      const snap = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/dns`, { records: [{ type: "A", name: "x1", value: "192.0.2.1" }] });
      for (const [m, path, body] of [
        ["GET", `/api/v1/domains/${d.fqdn}/dns`, undefined], ["POST", `/api/v1/domains/${d.fqdn}/dns`, { records: [{ type: "A", name: "e", value: "192.0.2.1" }] }],
        ["GET", `/api/v1/domains/${d.fqdn}/dns-snapshots`, undefined], ["POST", `/api/v1/domains/${d.fqdn}/dns-snapshots/${snap.json.snapshot_id}/rollback`, {}],
      ] as const) {
        const r = await call(k, bob, m, path, body);
        expect(r.status, `${m} ${path}`).toBe(404);
      }
      const other = await makeDomain(k, alice, `st128-away-${mode.replace("_", "")}-${++n}.com`);
      await k.registrar.setNameservers(other.fqdn, ["ns1.elsewhere.net", "ns2.elsewhere.net"]);
      await k.app.db.owner.query("update domains set nameservers = $2, dns_hosted_here = false where id = $1", [other.id, ["ns1.elsewhere.net", "ns2.elsewhere.net"]]);
      const read = await call(k, alice, "GET", `/api/v1/domains/${other.fqdn}/dns`);
      expect(read.json.hosted).toBe(false); expect(read.json.read_only).toBe(true); expect(read.json.message).toContain("hosted elsewhere");
      expect(read.json.nameservers).toEqual(["ns1.elsewhere.net", "ns2.elsewhere.net"]);
      const write = await call(k, alice, "POST", `/api/v1/domains/${other.fqdn}/dns`, { records: [{ type: "A", name: "e", value: "192.0.2.1" }] });
      expect(write.status).toBe(409); expect(write.json.error.code).toBe("dns_not_hosted");
    });

    it("snapshots older than 30 days are swept", async () => {
      const d = await fresh();
      await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/dns`, { records: [{ type: "A", name: "sw", value: "192.0.2.1" }] });
      expect(await snaps(d.id)).toHaveLength(1);
      k.app.clock.advance(31 * 86_400_000);
      await poll(k);
      await k.app.db.owner.query("select 1");
      expect((await snaps(d.id)).length).toBe(0);
    });
  });
}
