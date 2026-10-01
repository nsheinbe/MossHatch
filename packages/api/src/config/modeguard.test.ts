import { describe, expect, it } from "vitest";
import { assertModeConsistency, assertConfigMode, loadConfig, ModeError, refuseSampleAtLiveCheckout } from "./modeguard.ts";

const codes = (f: () => void) => { try { f(); return null; } catch (e) { if (e instanceof ModeError) return e.reasons; throw e; } };
const CRON = "c".repeat(40);

describe("ST-150: mode guard", () => {
  it("allows the two consistent combinations only", () => {
    for (const registrarMode of ["mock", "sandbox"] as const) for (const mode of ["local", "preview", "staging", "production"] as const) {
      // a test key with a non-live registrar is fine everywhere except that production with test keys is still consistent by the rule
      expect(codes(() => assertModeConsistency({ stripeKeyKind: "test", registrarMode, mode }))).toBeNull();
    }
    expect(codes(() => assertModeConsistency({ stripeKeyKind: "live", registrarMode: "live", mode: "production", vercelEnv: "production" }))).toBeNull();
  });
  it("a live Stripe key with the mock or sandbox adapter fails to boot", () => {
    expect(codes(() => assertModeConsistency({ stripeKeyKind: "live", registrarMode: "mock", mode: "production", vercelEnv: "production" }))).toContain("live_key_with_non_live_registrar");
    expect(codes(() => assertModeConsistency({ stripeKeyKind: "live", registrarMode: "sandbox", mode: "production" }))).toContain("live_key_with_non_live_registrar");
    expect(() => loadConfig({ MH_MODE: "production", VERCEL_ENV: "production", MH_ORIGIN: "https://mosshatch.com", CRON_SECRET: CRON, STRIPE_SECRET_KEY: "sk_live_abc", MH_REGISTRAR_MODE: "mock" })).toThrow(ModeError);
  });
  it("a test Stripe key with the live adapter fails to boot", () => {
    expect(codes(() => assertModeConsistency({ stripeKeyKind: "test", registrarMode: "live", mode: "production", vercelEnv: "production" }))).toContain("test_key_with_live_registrar");
    expect(() => loadConfig({ MH_MODE: "production", VERCEL_ENV: "production", MH_ORIGIN: "https://mosshatch.com", CRON_SECRET: CRON, STRIPE_SECRET_KEY: "rk_test_abc", MH_REGISTRAR_MODE: "live" })).toThrow(ModeError);
  });
  it("a preview or staging deployment cannot select live, whatever it claims", () => {
    for (const mode of ["preview", "staging", "local"] as const) {
      expect(codes(() => assertModeConsistency({ stripeKeyKind: "live", registrarMode: "live", mode })), mode).toContain("live_outside_production");
      expect(codes(() => assertModeConsistency({ stripeKeyKind: "none", registrarMode: "live", mode })), mode).toContain("live_outside_production");
    }
    expect(codes(() => assertModeConsistency({ stripeKeyKind: "live", registrarMode: "live", mode: "production", vercelEnv: "preview" }))).toContain("vercel_env_mismatch");
    // VERCEL_ENV=production cannot be relabelled with MH_MODE
    expect(() => loadConfig({ MH_MODE: "preview", VERCEL_ENV: "production", MH_ORIGIN: "https://x.test", CRON_SECRET: CRON, STRIPE_SECRET_KEY: "sk_test_x" })).toThrow(ModeError);
    expect(codes(() => assertModeConsistency({ stripeKeyKind: "test", registrarMode: "mock", mode: "staging", vercelEnv: "preview" }))).toBeNull();
  });
  it("compares the database host and KMS alias with the environment", () => {
    expect(codes(() => assertModeConsistency({ stripeKeyKind: "live", registrarMode: "live", mode: "production", dbHost: "db-staging.example.internal" }))).toContain("db_host_environment_mismatch");
    expect(codes(() => assertModeConsistency({ stripeKeyKind: "live", registrarMode: "live", mode: "production", kmsAlias: "alias/mosshatch-dev-pii" }))).toContain("kms_alias_environment_mismatch");
    expect(codes(() => assertModeConsistency({ stripeKeyKind: "test", registrarMode: "mock", mode: "preview", kmsAlias: "alias/mosshatch-prod-pii" }))).toContain("kms_alias_environment_mismatch");
    expect(codes(() => assertModeConsistency({ stripeKeyKind: "test", registrarMode: "mock", mode: "preview", dbHost: "ep-prod-1.neon.tech" }))).toContain("db_host_environment_mismatch");
    expect(codes(() => assertModeConsistency({ stripeKeyKind: "live", registrarMode: "live", mode: "production", dbHost: "ep-cool-123.us-east-2.aws.neon.tech", kmsAlias: "alias/mosshatch-prod-pii" }))).toBeNull();
  });
  it("no Stripe key is allowed only outside production with a non-live registrar", () => {
    expect(codes(() => assertModeConsistency({ stripeKeyKind: "none", registrarMode: "mock", mode: "local" }))).toBeNull();
    expect(codes(() => assertModeConsistency({ stripeKeyKind: "none", registrarMode: "mock", mode: "production" }))).toContain("no_stripe_key_in_production");
  });
  it("refuses a sample amount at live checkout and passes it in test mode", () => {
    const sample = { minor: 1925n, currency: "usd" as const, source: "sample" as const };
    const live = { minor: 1925n, currency: "usd" as const, source: "live" as const };
    expect(codes(() => refuseSampleAtLiveCheckout(sample, true))).toEqual(["sample_amount_at_live_checkout"]);
    expect(refuseSampleAtLiveCheckout(sample, false)).toBe(sample);
    expect(refuseSampleAtLiveCheckout(live, true)).toBe(live);
  });
  it("assertConfigMode rejects a livemode flag that disagrees with the key", () => {
    expect(codes(() => assertConfigMode({ stripeKeyKind: "test", registrarMode: "mock", mode: "local", livemode: true }))).not.toBeNull();
    expect(codes(() => assertConfigMode({ stripeKeyKind: "test", registrarMode: "mock", mode: "local", livemode: false }))).toBeNull();
  });
});

describe("loadConfig", () => {
  it("builds a local Config with safe defaults", () => {
    const c = loadConfig({ CRON_SECRET: CRON });
    expect(c).toMatchObject({ mode: "local", origin: "http://localhost:3000", rpId: "localhost", livemode: false, stripeKeyKind: "none", registrarMode: "mock" });
  });
  it("derives production from VERCEL_ENV and sets livemode from the key kind", () => {
    const c = loadConfig({ VERCEL_ENV: "production", MH_ORIGIN: "https://mosshatch.com", CRON_SECRET: CRON, STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x", MH_REGISTRAR_MODE: "live", DATABASE_URL: "postgres://u:p@ep-1.neon.tech/db", MH_KMS_ALIAS: "alias/mosshatch-prod" });
    expect(c).toMatchObject({ mode: "production", rpId: "mosshatch.com", livemode: true, stripeKeyKind: "live", registrarMode: "live", allowedOrigins: ["https://mosshatch.com"] });
  });
  it("never puts a key, host or secret into an error message", () => {
    const secrets = ["sk_live_SUPERSECRET123", "postgres://user:hunter2@db-staging.internal/x"];
    try { loadConfig({ VERCEL_ENV: "production", MH_ORIGIN: "https://mosshatch.com", CRON_SECRET: CRON, STRIPE_SECRET_KEY: secrets[0], MH_REGISTRAR_MODE: "mock", DATABASE_URL: secrets[1] }); throw new Error("expected throw"); }
    catch (e) { const m = String((e as Error).message) + JSON.stringify(e); for (const s of secrets) expect(m).not.toContain(s); expect(m).not.toContain("hunter2"); }
    expect(() => loadConfig({ CRON_SECRET: CRON, STRIPE_SECRET_KEY: "pk_test_notasecretkey" })).toThrow(/stripe_key_unrecognized/);
  });
  it("requires an origin outside local and a long cron secret", () => {
    expect(() => loadConfig({ MH_MODE: "preview", CRON_SECRET: CRON })).toThrow(ModeError);
    expect(() => loadConfig({ CRON_SECRET: "short" })).toThrow(ModeError);
  });
});
