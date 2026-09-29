import { describe, expect, it } from "vitest";
import { deriveTraits, deriveCreatureState, mossFromAge, feePerYear, usd, formatUsd } from "./index.ts";

describe("deriveTraits", () => {
  it("is deterministic and case-insensitive", () => {
    expect(deriveTraits("Moonfern.com")).toEqual(deriveTraits("moonfern.com"));
  });
  it("maps extensions to families", () => {
    expect(deriveTraits("a.com").family).toBe("fox");
    expect(deriveTraits("a.ai").family).toBe("moth");
    expect(deriveTraits("a.dev").family).toBe("beetle");
    expect(deriveTraits("a.io").family).toBe("koi");
  });
  it("differs across names", () => {
    expect(deriveTraits("moonfern.com").hue).not.toBe(deriveTraits("marrowbrook.com").hue);
  });
  // Golden values: any change here changes every creature ever hatched.
  it("matches the golden fixture", () => {
    expect(deriveTraits("moonfern.com")).toMatchSnapshot();
    expect(deriveTraits("hatchkind.studio")).toMatchSnapshot();
  });
});

describe("deriveCreatureState", () => {
  const base = { daysToExpiry: 200, transferLock: false, ageDays: 400 };
  it("prioritises", () => {
    expect(deriveCreatureState({ ...base, registering: true }).state).toBe("egg");
    expect(deriveCreatureState({ ...base, daysToExpiry: 12 }).text).toBe("Renews in 12 days");
    expect(deriveCreatureState({ ...base, transferLock: true }).state).toBe("armored");
    expect(deriveCreatureState({ ...base, daysToExpiry: -3 }).state).toBe("sleeping");
    expect(deriveCreatureState({ ...base, attentionReason: "Verify your email" }).state).toBe("attention");
    expect(deriveCreatureState({ ...base, dnsWriteInFlight: true }).state).toBe("shedding");
  });
  it("moss grows with age", () => {
    expect(mossFromAge(0)).toBe(0);
    expect(mossFromAge(2000)).toBeGreaterThan(mossFromAge(200));
  });
});

describe("money", () => {
  it("applies the D-003 fee bands", () => {
    expect(feePerYear(usd(1450)).cents).toBe(400);
    expect(feePerYear(usd(6000)).cents).toBe(900);
    expect(feePerYear(usd(11100)).cents).toBe(1000);
    expect(formatUsd(usd(1925))).toBe("$19.25");
  });
});
