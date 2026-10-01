import { describe, expect, it } from "vitest";
import { formatUsd } from "@mosshatch/core";
import { MockRegistrar, SAMPLE_PRICE } from "./index.ts";

describe("MockRegistrar", () => {
  const r = new MockRegistrar();
  it("reproduces the plan's first-order prices", () => {
    const want: Record<string, string> = { com: "$19.25", dev: "$21.00", app: "$25.00", studio: "$60.00", io: "$69.00", ai: "$242.00" };
    for (const [tld, p] of Object.entries(want)) expect(formatUsd({ cents: SAMPLE_PRICE[tld]!.cents, currency: "USD" })).toBe(p);
  });
  it("is deterministic and flags samples", async () => {
    const a = await r.quote("moonfern.com"); const b = await r.quote("MoonFern.com");
    expect(a).toEqual(b); expect(a.sample).toBe(true);
  });
  it("keeps the demo name available on .com and the fixed names taken", async () => {
    expect((await r.quote("moonfern.com")).availability).toBe("available");
    expect((await r.quote("google.com")).availability).toBe("taken");
  });
  it("offers three open alternatives", async () => {
    const alts = await r.suggestAlternatives("google", 3);
    expect(alts).toHaveLength(3);
  });
});
