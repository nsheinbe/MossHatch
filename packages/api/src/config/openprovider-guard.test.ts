import { describe, expect, it } from "vitest";
import { loadConfig, ModeError } from "./modeguard.ts";
import { openproviderGuardReasons } from "./openprovider-guard.ts";

const CRON = "c".repeat(40);
const reasons = (env: Record<string, string | undefined>) => { try { loadConfig({ CRON_SECRET: CRON, MH_ORIGIN: "https://x.example", ...env }); return null; } catch (e) { if (e instanceof ModeError) return e.reasons; throw e; } };
const SANDBOX_CREDS = { OPENPROVIDER_USERNAME: "u@example.test", OPENPROVIDER_PASSWORD: "sandbox-secret-value" };

describe("ST-117 / ST-150 (Openprovider): credentials only in the registrar scope, sandbox and production never crossed", () => {
  it("OPENPROVIDER_* outside the registrar scope does not boot, in any mode", () => {
    for (const MH_MODE of ["local", "staging"]) expect(reasons({ MH_MODE, STRIPE_SECRET_KEY: "sk_test_x", MH_REGISTRAR_MODE: "sandbox", ...SANDBOX_CREDS })).toContain("registrar_key_outside_registrar_scope");
    expect(reasons({ MH_MODE: "staging", STRIPE_SECRET_KEY: "sk_test_x", MH_REGISTRAR_MODE: "sandbox", MH_SCOPE: "registrar", MH_REGISTRAR_PROVIDER: "openprovider", ...SANDBOX_CREDS })).toBeNull();
  });
  it("sandbox credentials are refused in production; production credentials are refused outside production", () => {
    const prod = { MH_MODE: "production", VERCEL_ENV: "production", STRIPE_SECRET_KEY: "sk_live_x", MH_REGISTRAR_MODE: "live", MH_SCOPE: "registrar", MH_REGISTRAR_PROVIDER: "openprovider" };
    expect(reasons({ ...prod, ...SANDBOX_CREDS })).toContain("openprovider_sandbox_credentials_in_production");
    expect(reasons({ ...prod, ...SANDBOX_CREDS, OPENPROVIDER_ENV: "sandbox" })).toContain("openprovider_sandbox_credentials_in_production");
    expect(reasons({ ...prod, ...SANDBOX_CREDS, OPENPROVIDER_ENV: "production" })).toBeNull();
    const staging = { MH_MODE: "staging", STRIPE_SECRET_KEY: "sk_test_x", MH_REGISTRAR_MODE: "sandbox", MH_SCOPE: "registrar", MH_REGISTRAR_PROVIDER: "openprovider" };
    expect(reasons({ ...staging, ...SANDBOX_CREDS, OPENPROVIDER_ENV: "production" })).toContain("openprovider_production_credentials_outside_production");
    expect(reasons({ ...staging, OPENPROVIDER_LIVE_PASSWORD: "x" })).toContain("openprovider_production_credentials_outside_production");
    expect(reasons({ ...staging, ...SANDBOX_CREDS, OPENPROVIDER_ENV: "prod-ish" })).toContain("openprovider_env_invalid");
    expect(reasons({ MH_MODE: "preview", STRIPE_SECRET_KEY: "sk_test_x", MH_SCOPE: "registrar", ...SANDBOX_CREDS })).toContain("registrar_credentials_in_preview");
  });
  it("in the registrar scope the credentials must match MH_REGISTRAR_MODE", () => {
    expect(openproviderGuardReasons({ MH_SCOPE: "registrar", ...SANDBOX_CREDS, OPENPROVIDER_ENV: "production" }, "production", "sandbox")).toContain("openprovider_env_registrar_mode_mismatch");
    expect(openproviderGuardReasons({ MH_SCOPE: "registrar", ...SANDBOX_CREDS }, "staging", "sandbox")).toEqual([]);
  });
  it("MH_REGISTRAR_PROVIDER must name a known provider and never put the mock beside a real one", () => {
    expect(reasons({ MH_REGISTRAR_PROVIDER: "openprovider" })).toContain("registrar_provider_invalid"); // mock mode cannot reach a real provider
    expect(reasons({ MH_MODE: "staging", STRIPE_SECRET_KEY: "sk_test_x", MH_REGISTRAR_MODE: "sandbox", MH_REGISTRAR_PROVIDER: "namecheap" })).toContain("registrar_provider_invalid");
    expect(reasons({ MH_MODE: "staging", STRIPE_SECRET_KEY: "sk_test_x", MH_REGISTRAR_MODE: "sandbox", MH_REGISTRAR_PROVIDER: "opensrs", MH_REGISTRAR_PROVIDER_BY_TLD: "com=openprovider" })).toBeNull();
  });
  it("never puts a credential value into the error", () => {
    try { loadConfig({ CRON_SECRET: CRON, MH_ORIGIN: "https://x.example", MH_MODE: "staging", STRIPE_SECRET_KEY: "sk_test_x", ...SANDBOX_CREDS }); throw new Error("expected throw"); }
    catch (e) { expect(String((e as Error).message) + JSON.stringify(e)).not.toContain("sandbox-secret-value"); }
  });
});
