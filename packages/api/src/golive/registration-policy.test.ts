import { describe, expect, it } from "vitest";
import { commercialCountLimit, commercialRegistrationPolicy, registrarSpendLimitFromEnv } from "./registration-policy.ts";
import { spendFuseFromEnv } from "../compliance/velocity.ts";

describe("operator-selected commercial registration capacity", () => {
  it("keeps the dogfood defaults unless commercial policy is explicitly selected", () => {
    for (const policy of [undefined, "", "dogfood", "Commercial", "typo"]) {
      const env = { MH_REGISTRATION_POLICY: policy };
      expect(commercialRegistrationPolicy(env)).toBe(false);
      expect(spendFuseFromEnv(env, true)).toEqual({ daily: 3, total: 10 });
      expect(registrarSpendLimitFromEnv(env, true)).toBe(5);
    }
  });
  it("commercial policy has no hidden global registration or registrar-operation count ceiling", () => {
    const env = { MH_REGISTRATION_POLICY: "commercial" };
    expect(spendFuseFromEnv(env, true)).toEqual({ daily: null, total: null, ignoreGlobalFlags: true });
    expect(registrarSpendLimitFromEnv(env, true)).toBeNull();
    expect(commercialCountLimit(" unlimited ")).toBeNull();
  });
  it("explicit commercial numbers are honored, including a zero stop and large safe integers", () => {
    const env = { MH_REGISTRATION_POLICY: "commercial", MH_LIVE_DAILY_REGISTRATIONS: "12000", MH_LIVE_TOTAL_REGISTRATIONS: "unlimited", MH_REGISTRAR_DAILY_SPEND_OPS: "0" };
    expect(spendFuseFromEnv(env, true)).toEqual({ daily: 12000, total: null, ignoreGlobalFlags: true });
    expect(registrarSpendLimitFromEnv(env, true)).toBe(0);
    expect(commercialCountLimit(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("malformed explicit commercial overrides stop operations instead of silently becoming unlimited", () => {
    for (const input of ["", "-1", "1.5", "1e3", "Infinity", "NaN", "9007199254740992"]) expect(commercialCountLimit(input)).toBe(0);
  });
});
