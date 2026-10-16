import { describe, expect, it } from "vitest";
import type { DnsRecord } from "@mosshatch/registrar/port";
import { buildConnectPlan, mergeSpf, planHashHex, type ConnectRequest } from "./plan.ts";

const base = (over: Partial<ConnectRequest> = {}): ConnectRequest => ({
  source: "pasted", source_id: "pasted", source_version: 1, domain_id: "00000000-0000-7000-8000-000000000001",
  fqdn: "example.dev", hosted: true, live: [], ...over,
});
const a = (name: string, value: string): DnsRecord => ({ type: "A", name, value });
const txt = (name: string, value: string): DnsRecord => ({ type: "TXT", name, value });

describe("DC-02: one connect plan", () => {
  it("is empty when the request only restates the live zone, and the hash does not depend on input order", () => {
    const live = [a("", "192.0.2.1"), txt("www", "hello")];
    const p = buildConnectPlan(base({ live, add: [txt("www", "hello"), a("@", "192.0.2.1")] }));
    expect(p.blocked).toBeNull();
    expect(p.dns).toEqual({ add: [], remove: [] });
    const again = buildConnectPlan(base({ live: [...live].reverse(), add: [a("", "192.0.2.1"), txt("WWW.", "hello")] }));
    expect(planHashHex(p)).toBe(planHashHex(again));
    expect(planHashHex(p)).toBe(planHashHex(buildConnectPlan(base({ live, add: [a("@", "192.0.2.1"), txt("www", "hello")] }))));
  });

  it("turns shape failures into blocked codes and does not throw", () => {
    expect(buildConnectPlan(base({ hosted: false, add: [a("", "192.0.2.1")] })).blocked?.code).toBe("dns_not_hosted");
    expect(buildConnectPlan(base({ alias: true })).blocked?.code).toBe("needs_alias");
    expect(buildConnectPlan(base({ add: [{ type: "CNAME", name: "@", value: "alias.example.net" }] })).blocked?.code).toBe("cname_at_apex");
    expect(buildConnectPlan(base({ add: [{ type: "CNAME", name: "www", value: "a.example.net" }, a("www", "192.0.2.1")] })).blocked?.code).toBe("cname_conflict");
    expect(buildConnectPlan(base({ live: [a("www", "192.0.2.1")], add: [{ type: "CNAME", name: "www", value: "a.example.net" }] })).blocked).toBeNull();
    const beside = buildConnectPlan(base({ live: [{ type: "CNAME", name: "www", value: "a.example.net" }], add: [a("www", "192.0.2.9")] }));
    expect(beside.blocked?.code).toBe("cname_conflict");
    expect(buildConnectPlan(base({ add: [{ type: "A", name: "*", value: "192.0.2.1" }] })).blocked?.code).toBe("wildcard_refused");
    expect(buildConnectPlan(base({ add: [{ type: "NS", name: "sub", value: "ns.example.net" }] })).blocked?.code).toBe("unsupported_type");
    expect(buildConnectPlan(base({ add: [{ type: "REDIR301", name: "", value: "https://example.net" }] })).blocked?.code).toBe("unsupported_type");
    expect(buildConnectPlan(base({ add: [txt("", "x".repeat(255))] })).blocked?.code).toBe("txt_too_long");
    for (const p of [buildConnectPlan(base({ hosted: false })), buildConnectPlan(base({ add: [{ type: "CNAME", name: "", value: "x.example.net" }] }))]) {
      expect(p.dns).toEqual({ add: [], remove: [] });
    }
  });

  it("replaces MX at a name and replaces A and AAAA only when the host must not be split", () => {
    const live = [
      { type: "MX" as const, name: "", value: "old.example.net", priority: 10 },
      a("", "192.0.2.1"), a("www", "192.0.2.2"),
    ];
    const mx = buildConnectPlan(base({ live, add: [{ type: "MX", name: "@", value: "smtp.google.com", priority: 1 }] }));
    expect(mx.blocked).toBeNull();
    expect(mx.dns.remove).toEqual([{ type: "MX", name: "", value: "old.example.net", priority: 10 }]);
    expect(mx.dns.add).toEqual([{ type: "MX", name: "", value: "smtp.google.com", priority: 1 }]);
    expect(mx.sensitive.some((s) => s.type === "MX")).toBe(true);
    const kept = buildConnectPlan(base({ live, add: [a("", "192.0.2.9")] }));
    expect(kept.dns.remove).toEqual([]);
    expect(kept.dns.add).toEqual([a("", "192.0.2.9")]);
    const replaced = buildConnectPlan(base({ live, add: [a("", "192.0.2.9")], replace_addresses: [""] }));
    expect(replaced.dns.remove).toEqual([a("", "192.0.2.1")]);
    expect(replaced.dns.add).toEqual([a("", "192.0.2.9")]);
    expect(replaced.dns.remove.some((r) => r.name === "www")).toBe(false);
  });

  it("merges SPF into one record and refuses a second", () => {
    expect(mergeSpf(null, ["include:_spf.google.com"]).ok && mergeSpf(null, ["include:_spf.google.com"])).toEqual({ ok: true, value: "v=spf1 include:_spf.google.com" });
    expect(mergeSpf("v=spf1 include:_spf.example.com ~all", ["include:_spf.google.com"])).toEqual({ ok: true, value: "v=spf1 include:_spf.example.com include:_spf.google.com ~all" });
    expect(mergeSpf("v=spf1 include:_spf.google.com ~all", ["include:_spf.google.com"])).toEqual({ ok: true, value: "v=spf1 include:_spf.google.com ~all" });
    expect(mergeSpf("v=spf1 -all", ["v=spf1 include:x"]).ok).toBe(false);
    const live = [txt("", "v=spf1 include:_spf.example.com ~all")];
    const p = buildConnectPlan(base({ live, spf: [{ name: "@", mechanisms: ["include:_spf.google.com"] }] }));
    expect(p.blocked).toBeNull();
    expect(p.dns.add).toEqual([txt("", "v=spf1 include:_spf.example.com include:_spf.google.com ~all")]);
    expect(p.dns.remove).toEqual(live);
    expect(p.sensitive.some((s) => s.reasons.includes("txt_value"))).toBe(true);
    const dup = buildConnectPlan(base({ live: [txt("", "v=spf1 a ~all"), txt("", "v=spf1 mx ~all")], spf: [{ name: "", mechanisms: ["include:_spf.google.com"] }] }));
    expect(dup.blocked?.code).toBe("spf_duplicate");
    expect(dup.dns.add).toEqual([]);
  });
});
