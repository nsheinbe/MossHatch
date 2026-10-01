import { describe, expect, it } from "vitest";
import { runRegistrarContract, type ContractSubject } from "./contract.ts";
import { MockRegistrarPort, type DnsOverwriteMode } from "./mock-port.ts";
import { OpenSrsAdapter } from "./opensrs/adapter.ts";
import { FakeHorizonTransport } from "./opensrs/fake-horizon.ts";
import { MemoryCredentials, MemoryKillSwitch } from "./opensrs/guards.ts";

let n = 0;
for (const dnsOverwrite of ["whole_zone", "per_type"] as DnsOverwriteMode[]) {
  runRegistrarContract(() => {
    const mock = new MockRegistrarPort({ dnsOverwrite });
    const s: ContractSubject = { adapter: mock, mock, freshName: (tld) => `free-${++n}.${tld}` };
    return s;
  }, { tags: ["both", "replay", "mock-only"], label: `MockRegistrarPort (mock:opensrs, ${dnsOverwrite})` });

  // The Horizon adapter over a fake that replays hand-written documented-shape responses (source: "documented"; no real Horizon response has been seen).
  runRegistrarContract(() => {
    const mock = new MockRegistrarPort({ dnsOverwrite });
    const transport = new FakeHorizonTransport(mock, { username: "reseller1", apiKey: "k".repeat(32) });
    const adapter = new OpenSrsAdapter({ mode: "sandbox", deployment: "staging", credentials: new MemoryCredentials({ username: "reseller1", apiKey: "k".repeat(32) }), transport, killSwitch: new MemoryKillSwitch(), clock: mock.clock });
    const s: ContractSubject = { adapter, mock, freshName: (tld) => `free-${++n}.${tld}` };
    return s;
  }, { tags: ["both", "replay"], label: `OpenSrsAdapter over documented fixtures (${dnsOverwrite})` });
}

describe("MockRegistrarPort profile", () => {
  it("mirrors OpenSRS limits in capabilities()", () => {
    const c = new MockRegistrarPort().capabilities();
    expect(c).toMatchObject({ mode: "mock", profile: "mock:opensrs", idempotentRegister: false, idempotencyKey: false, lookupBatchSize: 1, dnsMode: "replace_all", dnsTtl: false, dnsCaa: false, outboundTransfer: "emailed_approval", sandbox: false, cancelTransferAway: false });
    expect(c.minTermYears).toEqual({ ai: 2 });
    expect(c.authCodeOverrides).toEqual({ io: "person" });
  });
  it("is deterministic for the same name and keeps the Phase 1 demo names", async () => {
    const a = new MockRegistrarPort(), b = new MockRegistrarPort();
    for (const d of ["alpha.com", "bravo.dev", "charlie.io"]) expect((await a.checkAvailability(d)).kind).toBe((await b.checkAvailability(d)).kind);
    expect((await a.checkAvailability("moonfern.com")).kind).toBe("available");
    expect((await a.checkAvailability("google.com")).kind).toBe("taken");
  });
  it("counts calls so tests can assert exactly-once", async () => {
    const m = new MockRegistrarPort();
    await m.checkAvailability("a-b.com"); await m.checkAvailability("a-b.com", { noCache: true });
    expect(m.calls.checkAvailability).toBe(2); expect(m.calls.checkAvailabilityNoCache).toBe(1);
  });
  it("ST-107: a call that omits the period fails (the caller can never rely on the provider default of 2)", async () => {
    const m = new MockRegistrarPort();
    await expect(m.register({ fqdn: "free-x.com", years: undefined as never, regUsername: "abcdef", regPassword: "0123456789ab", registrant: { name: "A B", email: "a@b.test", phone: "+1.1", street: "1", city: "c", region: "r", postalCode: "1", country: "US" } })).rejects.toMatchObject({ code: "period_required" });
    await expect(m.quote("free-x.com", undefined as never)).rejects.toMatchObject({ code: "period_required" });
    await expect(m.renew("free-x.com", undefined as never, 2027)).rejects.toMatchObject({ code: "period_required" });
    expect(m.orders).toHaveLength(0);
  });
});
