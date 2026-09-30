import { describe, expect, it } from "vitest";
import { runRegistrarContract, type ContractSubject } from "./contract.ts";
import { MockRegistrarPort } from "./mock-port.ts";

let n = 0;
runRegistrarContract(() => {
  const mock = new MockRegistrarPort();
  const s: ContractSubject = { adapter: mock, mock, freshName: (tld) => `free-${++n}.${tld}` };
  return s;
}, { tags: ["both", "mock-only"], label: "MockRegistrarPort (mock:opensrs)" });

describe("MockRegistrarPort profile", () => {
  it("mirrors OpenSRS limits in capabilities()", () => {
    const c = new MockRegistrarPort().capabilities();
    expect(c).toMatchObject({ mode: "mock", profile: "mock:opensrs", idempotentRegister: false, idempotencyKey: false, lookupBatchSize: 1, dnsMode: "replace_all", dnsTtl: false, dnsCaa: false, outboundTransfer: "emailed_approval", sandbox: false });
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
});
