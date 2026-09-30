import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@mosshatch/db/testing";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootFromEnv, NotConfigured } from "./boot.ts";
import { listJobDefs, getJobDef } from "./jobs/registry.ts";
import { listDeadLetterHookKinds, listRecurringJobs } from "./jobs/engine.ts";
import { Router } from "./http/router.ts";
import { domainsServices } from "./domains/common.ts";
import { runPosture } from "./domains/posture.ts";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); }, 60_000);
afterAll(async () => { await db?.drop(); });

const base = () => ({ MH_MODE: "local", MH_ORIGIN: "http://localhost:3000", CRON_SECRET: "c".repeat(40), DATABASE_URL: db.urlFor("runtime"), DATABASE_URL_CRON: db.urlFor("cron") });

describe("bootFromEnv", () => {
  it("assembles the app in local mode and serves the health route and search", async () => {
    const { router, ctx } = await bootFromEnv(base());
    const h = await router.dispatch(ctx, new Request("http://localhost:3000/api/health/ticks"));
    expect([200, 503]).toContain(h.status);            // 503 until the first tick has run: the dead-man's switch, by design
    const s = await router.dispatch(ctx, new Request("http://localhost:3000/api/v1/search?name=moonfern&tlds=com"));
    expect(s.status, await s.clone().text()).toBe(200);
    await Promise.all([ctx.runtime.end(), ctx.cron.end()]);
  });
  it("answers not-configured with a reason code, never a value", async () => {
    const e1 = await bootFromEnv({ ...base(), DATABASE_URL: undefined }).catch((e) => e);
    expect(e1).toBeInstanceOf(NotConfigured);
    expect((e1 as NotConfigured).reason).toBe("database_not_configured");
  });
  it("refuses production until the production adapters exist", async () => {
    const e = await (async () => { try { await bootFromEnv({ ...base(), MH_MODE: "production", VERCEL_ENV: "production", DATABASE_URL: "postgres://u:p@db.prod.example.com/x", STRIPE_SECRET_KEY: "sk_live_" + "x".repeat(24), MH_REGISTRAR_MODE: "live" }); } catch (x) { return x; } })();
    expect(e).toBeInstanceOf(NotConfigured);
    expect((e as NotConfigured).reason).toBe("production_adapters_not_built");
  });
  it("the mode guard still applies: a live Stripe key with the mock registrar does not boot", async () => {
    await expect(bootFromEnv({ ...base(), STRIPE_SECRET_KEY: "sk_live_" + "x".repeat(24) })).rejects.toThrow(/mode guard/);
  });
  it("preview needs a KMS root of 32+ characters", async () => {
    const e = await bootFromEnv({ ...base(), MH_MODE: "preview", VERCEL_ENV: "preview" }).catch((x) => x);
    expect((e as NotConfigured).reason).toBe("kms_root_not_configured");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Boot completeness: every job the codebase can register is registered by bootFromEnv (Phase 3 gap: domains and domain-management jobs)
// ---------------------------------------------------------------------------------------------------------------------------------------

const SRC = path.dirname(fileURLToPath(import.meta.url));
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") sourceFiles(p, out); }
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const snapshot = () => ({
  kinds: listJobDefs().map((d) => d.kind).sort(),
  recurring: listRecurringJobs().map((r) => `${r.kind}@${r.everySec}`).sort(),
  dead: listDeadLetterHookKinds().sort(),
});

describe("bootFromEnv installs every job in the codebase (local mode)", () => {
  it("calling every job and route registrar in the source after boot adds no job kind, schedule or dead-letter default", async () => {
    const { ctx } = await bootFromEnv({ ...base(), MH_FAKE_STRIPE: "1" });
    try {
      const booted = snapshot();
      expect(booted.kinds.length).toBeGreaterThan(20);
      // Every exported registrar in non-test source: `register...Jobs()` and the route registrars that also register jobs.
      const files = sourceFiles(SRC).filter((f) => !f.endsWith(".test.ts"));
      const registrars: { file: string; name: string }[] = [];
      for (const f of files) {
        const txt = fs.readFileSync(f, "utf8");
        for (const m of txt.matchAll(/export function (register\w*(?:Jobs|Routes|Ops|Mgmt))\s*\(/g)) registrars.push({ file: f, name: m[1]! });
      }
      expect(registrars.map((r) => r.name)).toEqual(expect.arrayContaining(["registerOrderJobs", "registerOpsJobs", "registerDomainJobs", "registerDomainMgmtJobs"]));
      for (const r of registrars) {
        const mod = await import(r.file) as Record<string, (router?: Router) => unknown>;
        try { mod[r.name]!(new Router()); }
        catch (e) { if (!/registered twice/.test(String((e as Error).message))) throw e; }
      }
      const after = snapshot();
      expect(after.kinds, "a job kind exists in the code but bootFromEnv did not register it").toEqual(booted.kinds);
      expect(after.recurring, "a recurring schedule exists in the code but bootFromEnv did not register it").toEqual(booted.recurring);
      expect(after.dead, "a dead-letter default exists in the code but bootFromEnv did not register it").toEqual(booted.dead);

      // Every job kind a module enqueues by name (non-test source) has a handler after boot, and every kind tests register exists too.
      const enqueued = new Set<string>();
      for (const f of files) for (const m of fs.readFileSync(f, "utf8").matchAll(/enqueue\([^)]*?kind:\s*"([a-z_]+\.[a-z_.]+)"/gs)) enqueued.add(m[1]!);
      const tests = sourceFiles(SRC).filter((f) => f.endsWith(".test.ts") && !f.endsWith("engine.test.ts"));   // the engine test registers synthetic kinds on purpose
      for (const f of tests) for (const m of fs.readFileSync(f, "utf8").matchAll(/registerJob\(\{\s*kind:\s*"([a-z_]+\.[a-z_.]+)"/g)) enqueued.add(m[1]!);
      const missing = [...enqueued].filter((k) => !getJobDef(k));
      expect(missing, "enqueued or test-registered job kinds without a handler after boot").toEqual([]);
      for (const k of ["renewal.scheduler", "renewal.charge", "domain.sync", "renewal.notice", "expiry.notice", "registrar.posture", "registrar.reconcile", "registrar.balance",
        "domain.release", "card.detach_sweep", "transfer.poll", "contact.change.poll", "registrant.verify_sweep", "dns.snapshot_sweep", "domain.code_rerandomize"]) {
        expect(getJobDef(k), k).toBeTruthy();
      }
      expect(booted.recurring).toEqual(expect.arrayContaining(["transfer.poll@300", "registrar.posture@86400", "renewal.scheduler@300", "card.detach_sweep@3600"]));
    } finally { await Promise.all([ctx.runtime.end(), ctx.cron.end()]); }
  }, 60_000);

  it("installs the domains services: the local mock gets its labelled stand-in probe, so posture does not warn about a missing probe", async () => {
    const { ctx } = await bootFromEnv({ ...base(), MH_FAKE_STRIPE: "1" });
    try {
      const s = domainsServices(ctx);
      expect(s.endUserProbe).toBeTruthy();
      expect((s.endUserProbe as { label?: string }).label).toBe("mock-registrar-has-no-end-user-interface");
      const r = await runPosture(ctx);
      expect(r.endUser).toBe("redirects");
      const warn = (await ctx.cron.query("select count(*)::int n from alerts where kind = 'posture_probe_not_configured' and state = 'open'")).rows[0].n;
      expect(warn).toBe(0);
    } finally { await Promise.all([ctx.runtime.end(), ctx.cron.end()]); }
  }, 60_000);

  it("a sandbox registrar with no RPC target does not boot on the mock: it answers not-configured", async () => {
    const e = await bootFromEnv({ ...base(), MH_REGISTRAR_MODE: "sandbox" }).catch((x) => x);
    expect(e).toBeInstanceOf(NotConfigured);
    expect((e as NotConfigured).reason).toBe("registrar_rpc_not_configured");
  });
});
