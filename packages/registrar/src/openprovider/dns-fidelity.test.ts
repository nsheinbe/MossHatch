import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { zoneHash } from "../dns.ts";
import type { DnsRecord } from "../port.ts";
import { MemoryKillSwitch } from "../opensrs/guards.ts";
import { MemoryOpenproviderCredentials, OpenproviderAdapter } from "./adapter.ts";
import type { OpHttpRequest } from "./transport.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/dns-fidelity.documented.json", import.meta.url), "utf8")) as { source: string; records: Record<string, unknown>[] };
type Step = unknown | Error;
const domain = { id: 7, domain: { name: "abc", extension: "com" }, name_servers: [{ name: "ns1.openprovider.nl" }] };
const records = (rows: unknown[]) => ({ results: rows, total: rows.length });
function rig(steps: Step[]) {
  const sent: OpHttpRequest[] = [], logs: unknown[] = [];
  const queue = [{ results: [domain], total: 1 }, ...steps];
  const adapter = new OpenproviderAdapter({
    mode: "sandbox", deployment: "local", killSwitch: new MemoryKillSwitch(),
    credentials: new MemoryOpenproviderCredentials({ username: "fixture", password: "fixture-password" }),
    log: (e) => logs.push(e), transport: { async request(req) {
      sent.push(req);
      const step = req.url.endsWith("/auth/login") ? { token: "fixture-token" } : queue.shift();
      if (step instanceof Error) throw step;
      if (step === undefined) throw new Error("fixture exhausted");
      return { status: 200, body: JSON.stringify({ code: 0, data: step }) };
    } },
  });
  return { adapter, sent, logs, puts: () => sent.filter((x) => x.method === "PUT") };
}
const live: DnsRecord[] = [
  { type: "A", name: "www", value: "192.0.2.1", ttl: 60 },
  { type: "CAA", name: "", value: '0 issue "CA.example"', ttl: 3600 },
  { type: "NS", name: "child", value: "ns.child.example.", ttl: 1800 },
  { type: "TXT", name: "", value: "v=spf1 -all", ttl: 600 },
  { type: "TYPE65400", name: "opaque", value: "AbCd | data ", ttl: 30 },
];

describe("Openprovider DNS fidelity (source: documented fixtures)", () => {
  it("ST-108: reads CAA, opaque RR types, child delegations and exact TTLs without truncation", async () => {
    expect(fixture.source).toBe("documented");
    const r = rig([domain, records(fixture.records)]);
    expect(await r.adapter.getDns("abc.com")).toEqual({ hosted: true, records: live, defaultTtl: 900 });
  });

  it("ST-108: an ordinary A edit preserves security records and unrelated TTLs byte-for-byte", async () => {
    const after = fixture.records.map((r) => r.type === "A" ? { ...r, value: "192.0.2.2" } : r);
    const r = rig([domain, records(fixture.records), {}, {}, domain, records(after)]);
    const desired = live.map((r) => r.type === "A" ? { ...r, value: "192.0.2.2" } : r);
    expect((await r.adapter.replaceZone("abc.com", desired, { expectedHash: zoneHash(live) })).records).toEqual(desired);
    expect(r.puts().map((x) => JSON.parse(x.body!).records)).toEqual([
      { remove: [{ name: "www", type: "A", value: "192.0.2.1", ttl: 60 }] },
      { add: [{ name: "www", type: "A", value: "192.0.2.2", ttl: 60 }] },
    ]);
  });

  it("ST-108: refuses a hidden-record deletion or stale expected state before any write", async () => {
    const dropped = rig([domain, records(fixture.records)]);
    await expect(dropped.adapter.replaceZone("abc.com", live.filter((r) => r.type !== "CAA"))).rejects.toMatchObject({ code: "unsupported_record_change", outcomeUnknown: false });
    expect(dropped.puts()).toHaveLength(0);
    const stale = rig([domain, records(fixture.records)]);
    await expect(stale.adapter.replaceZone("abc.com", live, { expectedHash: zoneHash(live.map((r) => ({ ...r, ttl: 1 }))) })).rejects.toMatchObject({ code: "dns_state_changed" });
    expect(stale.puts()).toHaveLength(0);
  });

  it("ST-108: fails closed for missing TTL, partial pages, unknown fields or ambiguous TXT", async () => {
    const invalid = [
      records([{ name: "abc.com", type: "A", value: "192.0.2.1" }]),
      { results: fixture.records, total: 20 },
      records([fixture.records[2], fixture.records[2]]),
      records([{ ...fixture.records[2], disabled: true }]),
      records([{ name: "abc.com", type: "TXT", value: '"one" "two"', ttl: 60 }]),
    ];
    for (const response of invalid) {
      const r = rig([domain, response]);
      await expect(r.adapter.replaceZone("abc.com", [])).rejects.toMatchObject({ outcomeUnknown: false });
      expect(r.puts()).toHaveLength(0);
    }
  });

  it("ST-108: does not retry after a timeout on remove or after a partially applied remove/add sequence", async () => {
    const wanted = live.map((r) => r.type === "A" ? { ...r, value: "192.0.2.2" } : r);
    for (const acceptedFirst of [false, true]) {
      const r = rig([domain, records(fixture.records), ...(acceptedFirst ? [{}] : []), new Error("private-provider-canary")]);
      await expect(r.adapter.replaceZone("abc.com", wanted)).rejects.toMatchObject({ outcomeUnknown: true, retryable: false });
      expect(r.puts()).toHaveLength(acceptedFirst ? 2 : 1);
      expect(JSON.stringify(r.logs)).not.toMatch(/private-provider-canary|fixture-password|fixture-token|192\.0\.2/);
    }
  });

  it("ST-108: readback errors after accepted writes stay unknown and never restore old records", async () => {
    const r = rig([domain, records(fixture.records), {}, {}, new Error("read failed")]);
    await expect(r.adapter.replaceZone("abc.com", live.map((r) => r.type === "A" ? { ...r, ttl: 300 } : r))).rejects.toMatchObject({ outcomeUnknown: true, retryable: false });
    expect(r.puts()).toHaveLength(2);
  });
});
