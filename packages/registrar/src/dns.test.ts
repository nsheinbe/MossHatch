import { describe, expect, it } from "vitest";
import { canonicalZone, validateZone, withDnsTtl, zoneHash } from "./dns.ts";
import type { DnsRecord } from "./port.ts";

describe("complete DNS state", () => {
  it("ST-108: hashes distinguish malicious delimiter and newline content, TTL and opaque RDATA case", () => {
    const txt = (value: string): DnsRecord => ({ type: "TXT", name: "", value });
    // This single TXT used to have the same hash as the following two-record zone.
    expect(zoneHash([txt("a|||\nTXT||b")])).not.toBe(zoneHash([txt("a"), txt("b")]));
    const a: DnsRecord = { type: "A", name: "www", value: "192.0.2.1", ttl: 60 };
    expect(zoneHash([a])).not.toBe(zoneHash([{ ...a, ttl: 900 }]));
    const opaque: DnsRecord = { type: "TYPE65400", name: "", value: "AbC ", ttl: 60 };
    expect(zoneHash([opaque])).not.toBe(zoneHash([{ ...opaque, value: "abc" }]));
    expect(canonicalZone([opaque])).toEqual([opaque]);
    expect(zoneHash([a, txt("b")])).toBe(zoneHash([txt("b"), a]));
  });

  it("ST-108: new records get a provider TTL before approval while existing TTLs survive", () => {
    const existing: DnsRecord = { type: "A", name: "www", value: "192.0.2.1", ttl: 60 };
    const input: DnsRecord[] = [{ type: "A", name: "www", value: "192.0.2.1" }, { type: "TXT", name: "", value: "hello" }];
    expect(withDnsTtl(input, [existing], 900)).toEqual([existing, { ...input[1], ttl: 900 }]);
    expect(withDnsTtl([{ type: "A", name: "www", value: "192.0.2.2" }], [existing], 900)[0]?.ttl).toBe(60);
    expect(withDnsTtl([{ ...existing, ttl: 300 }], [existing], 900)[0]?.ttl).toBe(300);
  });

  it("ST-108: preserves unchanged CAA and unknown records, refusing opaque changes and deletions", () => {
    const live: DnsRecord[] = [
      { type: "CAA", name: "", value: '0 issue "CA.example"', ttl: 3600 },
      { type: "TYPE65400", name: "opaque", value: "AbCd |\\# 2", ttl: 30 },
      { type: "TXT", name: "long", value: "x".repeat(300), ttl: 60 },
    ];
    expect(() => validateZone([...live, { type: "A", name: "www", value: "192.0.2.1" }], live)).not.toThrow();
    expect(() => validateZone(live.slice(1), live)).toThrow(expect.objectContaining({ code: "unsupported_record_change" }));
    expect(() => validateZone([{ ...live[0]!, ttl: 60 }, ...live.slice(1)], live)).toThrow(expect.objectContaining({ code: "unsupported_record_type" }));
  });

  it("ST-108: refuses malicious names, controls, invalid numeric fields and invalid TTLs without exposing values", () => {
    const bad: DnsRecord[] = [
      { type: "TXT", name: "bad\nname", value: "private-canary" },
      { type: "TXT", name: "", value: "private-canary\nA @ 127.0.0.1" },
      { type: "A", name: "", value: "192.0.2.1", ttl: -1 },
      { type: "A", name: "", value: "192.0.2.1", ttl: Infinity },
      { type: "MX", name: "", value: "mail.example", priority: NaN },
      { type: "A", name: "", value: "private-canary" },
    ];
    for (const r of bad) {
      expect(() => validateZone([r])).toThrow();
      try { validateZone([r]); } catch (e) { expect(String(e)).not.toContain("private-canary"); }
    }
  });
});
