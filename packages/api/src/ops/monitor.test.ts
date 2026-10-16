import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { Router } from "../http/router.ts";
import { clearJobRegistry } from "../jobs/registry.ts";
import { runTick, writeHeartbeat } from "../jobs/engine.ts";
import { checkP0Latency, checkTickAge } from "./monitor.ts";
import { healthTicksRoute, tickRoute } from "./routes.ts";

const SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/ops-external-check.mjs");
// Loaded by variable path: the script is plain JavaScript outside the TypeScript project.
const script: any = await import(/* @vite-ignore */ SCRIPT);

let app: TestApp;
beforeAll(async () => { app = await createTestApp(new Router().add(tickRoute, healthTicksRoute)); }, 60_000);
afterAll(async () => { await app?.drop(); });
beforeEach(async () => {
  clearJobRegistry();
  await app.db.owner.query("delete from alerts; delete from jobs;");
  await app.db.owner.query("update flags set value = 'null'::jsonb where name = 'heartbeat.tick'");
});
const alerts = (kind: string) => app.db.owner.query("select severity, state, detail from alerts where kind = $1", [kind]).then((r) => r.rows);

describe("ST-138 dead-man's switch", () => {
  it("ST-138: checkTickAge raises a page alert when no tick has completed in 3 minutes, and closes it when a tick completes", async () => {
    expect((await checkTickAge(app.ctx)).stale).toBe(true);                       // never ticked
    expect(await alerts("tick.stale")).toHaveLength(1);
    await runTick(app.ctx, { budgetMs: 500 });
    app.clock.advance(179_000);
    expect(await checkTickAge(app.ctx)).toEqual({ ageSeconds: 179, stale: false });
    expect((await alerts("tick.stale"))[0].state).toBe("closed");
    app.clock.advance(2_000);                                                       // 181 s
    const r = await checkTickAge(app.ctx);
    expect(r).toEqual({ ageSeconds: 181, stale: true });
    const rows = await alerts("tick.stale");
    expect(rows.filter((x) => x.state === "open")).toHaveLength(1);
    expect(rows.find((x) => x.state === "open")!.severity).toBe("page");
    await checkTickAge(app.ctx);                                                    // repeated checks do not stack pages
    expect((await alerts("tick.stale")).filter((x) => x.state === "open")).toHaveLength(1);
  });
  it("alarm when the oldest runnable priority 0 job is older than 60 seconds", async () => {
    const t = app.clock.now().getTime();
    await app.db.owner.query("insert into jobs (kind, priority, run_at) values ('order.fulfil', 0, $1), ('domain.sync', 1, $2), ('order.reconcile', 0, $3)", [new Date(t - 59_000), new Date(t - 3_600_000), new Date(t + 60_000)]);
    expect((await checkP0Latency(app.ctx)).alarm).toBe(false);                    // priority 1 and future jobs do not count
    app.clock.advance(2_000);
    expect(await checkP0Latency(app.ctx)).toEqual({ oldestSeconds: 61, alarm: true });
    expect((await alerts("jobs.p0_latency"))[0].severity).toBe("page");
  });
  it("a tick raises the priority 0 latency alarm when it starts behind", async () => {
    await app.db.owner.query("insert into jobs (kind, priority, run_at) values ('order.fulfil', 0, $1)", [new Date(app.clock.now().getTime() - 90_000)]);
    await runTick(app.ctx, { budgetMs: 500 });
    expect(await alerts("jobs.p0_latency")).toHaveLength(1);
  });

  it("ST-138: the external script pages when age is over 3 minutes, on no tick yet, on a bad status, a bad body and an unreachable host", () => {
    expect(script.evaluateTicks(200, { ageSeconds: 10 })).toEqual({ ok: true, ageSeconds: 10 });
    expect(script.evaluateTicks(200, { ageSeconds: 180 }).ok).toBe(true);
    expect(script.evaluateTicks(200, { ageSeconds: 181 })).toMatchObject({ ok: false, reason: "stale" });
    expect(script.evaluateTicks(200, { ageSeconds: null })).toMatchObject({ ok: false, reason: "no_tick_yet" });
    expect(script.evaluateTicks(503, { ageSeconds: 181 })).toMatchObject({ ok: false, reason: "stale", ageSeconds: 181 });
    expect(script.evaluateTicks(503, { ageSeconds: null })).toMatchObject({ ok: false, reason: "no_tick_yet" });
    expect(script.evaluateTicks(503, { ageSeconds: 1 })).toMatchObject({ ok: false, reason: "bad_status" });
    expect(script.evaluateTicks(500, { ageSeconds: 1 })).toMatchObject({ ok: false, reason: "bad_status" });
    expect(script.evaluateTicks(200, {})).toMatchObject({ ok: false, reason: "bad_body" });
    expect(script.evaluateTicks(200, { ageSeconds: -5 })).toMatchObject({ ok: false, reason: "bad_body" });
    expect(script.evaluateTicks(200, null)).toMatchObject({ ok: false, reason: "bad_body" });
  });

  it("ST-138: end to end over HTTP against the real router: quiet while ticking, pages the webhook after 3 minutes without one", async () => {
    const pages: any[] = [];
    const pager = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { pages.push(JSON.parse(b)); res.end("ok"); }); });
    const site = http.createServer(async (req, res) => {
      const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const r = await app.router!.dispatch(app.ctx, new Request("http://localhost" + req.url, { method: req.method, headers }));
      res.statusCode = r.status; res.end(await r.text());
    });
    await Promise.all([new Promise<void>((r) => pager.listen(0, "127.0.0.1", r)), new Promise<void>((r) => site.listen(0, "127.0.0.1", r))]);
    const url = (s: http.Server) => `http://127.0.0.1:${(s.address() as any).port}`;
    try {
      await writeHeartbeat(app.ctx);
      const healthy = await script.checkTicks({ baseUrl: url(site), pageWebhook: url(pager) });
      expect(healthy).toMatchObject({ ok: true, paged: false }); expect(pages).toHaveLength(0);
      app.clock.advance(181_000);
      const dead = await script.checkTicks({ baseUrl: url(site), pageWebhook: url(pager) });
      expect(dead).toMatchObject({ ok: false, reason: "stale", paged: true });
      expect(pages).toEqual([{ severity: "S1", check: "cron-heartbeat", reason: "stale", ageSeconds: 181 }]);
      // The second trigger: with the cron secret the script also ticks, which restores the heartbeat.
      const ticked = await script.checkTicks({ baseUrl: url(site), cronSecret: app.ctx.config.cronSecret });
      expect(ticked.ticked).toBe(200);
      expect((await script.checkTicks({ baseUrl: url(site) })).ok).toBe(true);
      // Unreachable host pages too.
      const down = await script.checkTicks({ baseUrl: "http://127.0.0.1:9", pageWebhook: url(pager), timeoutMs: 500 });
      expect(down).toMatchObject({ ok: false, reason: "unreachable", paged: true });
    } finally { pager.close(); site.close(); }
  });

  it("the script runs as a CLI: exit 2 without configuration", async () => {
    await expect(promisify(execFile)(process.execPath, [SCRIPT], { env: { ...process.env, MH_BASE_URL: "" } })).rejects.toMatchObject({ code: 2 });
  });
});
