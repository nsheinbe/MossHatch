import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@mosshatch/db/testing";
import { bootFromEnv, NotConfigured } from "./boot.ts";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); }, 60_000);
afterAll(async () => { await db?.drop(); });

const base = () => ({ MH_MODE: "local", MH_ORIGIN: "http://localhost:3000", CRON_SECRET: "c".repeat(40), DATABASE_URL: db.urlFor("runtime"), DATABASE_URL_CRON: db.urlFor("cron") });

describe("bootFromEnv", () => {
  it("assembles the app in local mode and serves the health route and search", async () => {
    const { router, ctx } = bootFromEnv(base());
    const h = await router.dispatch(ctx, new Request("http://localhost:3000/api/health/ticks"));
    expect([200, 503]).toContain(h.status);            // 503 until the first tick has run: the dead-man's switch, by design
    const s = await router.dispatch(ctx, new Request("http://localhost:3000/api/v1/search?name=moonfern&tlds=com"));
    expect(s.status, await s.clone().text()).toBe(200);
    await Promise.all([ctx.runtime.end(), ctx.cron.end()]);
  });
  it("answers not-configured with a reason code, never a value", () => {
    const e1 = (() => { try { bootFromEnv({ ...base(), DATABASE_URL: undefined }); } catch (e) { return e; } })();
    expect(e1).toBeInstanceOf(NotConfigured);
    expect((e1 as NotConfigured).reason).toBe("database_not_configured");
  });
  it("refuses production until the production adapters exist", () => {
    const e = (() => { try { bootFromEnv({ ...base(), MH_MODE: "production", VERCEL_ENV: "production", DATABASE_URL: "postgres://u:p@db.prod.example.com/x", STRIPE_SECRET_KEY: "sk_live_" + "x".repeat(24), MH_REGISTRAR_MODE: "live" }); } catch (x) { return x; } })();
    expect(e).toBeInstanceOf(NotConfigured);
    expect((e as NotConfigured).reason).toBe("production_adapters_not_built");
  });
  it("the mode guard still applies: a live Stripe key with the mock registrar does not boot", () => {
    expect(() => bootFromEnv({ ...base(), STRIPE_SECRET_KEY: "sk_live_" + "x".repeat(24) })).toThrow(/mode guard/);
  });
  it("preview needs a KMS root of 32+ characters", () => {
    const e = (() => { try { bootFromEnv({ ...base(), MH_MODE: "preview", VERCEL_ENV: "preview" }); } catch (x) { return x; } })();
    expect((e as NotConfigured).reason).toBe("kms_root_not_configured");
  });
});
