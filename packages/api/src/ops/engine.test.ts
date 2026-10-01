import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tx } from "@mosshatch/db";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { Router } from "../http/router.ts";
import { clearJobRegistry, enqueue, registerJob, type JobRow } from "../jobs/registry.ts";
import {
  claimJobs, clearDeadLetterHooks, clearRecurringJobs, completeJob, LeaseLostError, opportunisticTick, reclaimExpired, registerDeadLetterHook,
  registerRecurringJob, runTick, withLease,
} from "../jobs/engine.ts";
import { healthTicksRoute, tickRoute } from "./routes.ts";
import { mintToken } from "../util/token.ts";

let app: TestApp;
const router = new Router().add(tickRoute, healthTicksRoute);
// Wall-clock bounds assume an unloaded database. The parallel suite shares one PostgreSQL with ~100 files, so there the bound
// is only a ceiling against a collapse; CI enforces the real bound in its own sequential step with MH_PERF=1.
const WALL_BOUND_MS = process.env.MH_PERF === "1" ? 30_000 : 100_000;
const runs: { kind: string; at: number }[] = [];
let handlers: Record<string, (job: JobRow) => Promise<void>> = {};

beforeAll(async () => { app = await createTestApp(router); }, 60_000);
afterAll(async () => { await app?.drop(); });
beforeEach(async () => {
  clearJobRegistry(); clearRecurringJobs(); clearDeadLetterHooks(); runs.length = 0; handlers = {};
  for (const [kind, priority, maxRuntimeSec] of [["domain.sync", 1, 20], ["order.fulfil", 0, 30], ["misc.job", 1, 10], ["lease.test", 1, 10], ["renewal.charge", 0, 30]] as const) {
    registerJob({ kind, priority, maxRuntimeSec, maxAttempts: 3, handler: async (_c, job) => { await (handlers[kind]?.(job) ?? Promise.resolve()); } });
  }
  await app.db.owner.query("delete from jobs");
  await app.db.owner.query("delete from alerts");
  await app.db.owner.query("update flags set value = 'null'::jsonb where name = 'heartbeat.tick'");
  await app.db.owner.query("update flags set value = 'false'::jsonb where name = 'registrar_writes_paused'");
  app.clock.set(new Date("2026-10-01T12:00:00Z"));
});

const q = <T = any>(sql: string, p: unknown[] = []) => app.db.owner.query(sql, p).then((r) => r.rows as T[]);
const enq = (kind: string, extra: Record<string, unknown> = {}) => tx(app.ctx.cron, (c) => enqueue(c, { kind, payload: { n: 1 }, runAt: app.clock.now(), ...extra }));

describe("claim", () => {
  it("claims with SKIP LOCKED: concurrent claimers get disjoint sets, unique attempt ids, and lease = now + maxRuntime + 30 s", async () => {
    await q("insert into jobs (kind, priority, run_at, payload) select 'misc.job', 1, $1, '{}' from generate_series(1,100)", [app.clock.now()]);
    const now = app.clock.now();
    const [a, b, c] = await Promise.all([claimJobs(app.ctx.cron, now, 40), claimJobs(app.ctx.cron, now, 40), claimJobs(app.ctx.cron, now, 40)]);
    const ids = [...a, ...b, ...c].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(100);
    expect(new Set([...a, ...b, ...c].map((j) => j.attempt_id)).size).toBe(100);
    const row = (await q("select locked_until, attempts, state from jobs where id = $1", [ids[0]]))[0];
    expect(new Date(row.locked_until).getTime()).toBe(now.getTime() + (10 + 30) * 1000);
    expect(row.attempts).toBe(1); expect(row.state).toBe("running");
  });
  it("orders priority 0 before 1, then oldest first; jobs in the future and unregistered kinds stay queued", async () => {
    const t = app.clock.now().getTime();
    await enq("misc.job", { runAt: new Date(t - 5000) });
    await enq("order.fulfil", { runAt: new Date(t - 1000) });
    await enq("order.fulfil", { runAt: new Date(t - 3000) });
    await enq("misc.job", { runAt: new Date(t + 60_000) });
    await q("insert into jobs (kind, priority, run_at, payload) values ('from.the.future', 0, $1, '{}')", [new Date(t - 9000)]);
    const got = await claimJobs(app.ctx.cron, app.clock.now(), 10);
    expect(got.map((j) => j.kind)).toEqual(["order.fulfil", "order.fulfil", "misc.job"]);
    expect((await q("select state from jobs where kind = 'from.the.future'"))[0].state).toBe("queued");
  });
  it("caps domain.sync at 5 running, even across claimers", async () => {
    await q("insert into jobs (kind, priority, run_at, payload) select 'domain.sync', 1, $1, '{}' from generate_series(1,50)", [app.clock.now()]);
    const parts = await Promise.all([1, 2, 3, 4].map(() => claimJobs(app.ctx.cron, app.clock.now(), 10)));
    expect(parts.flat().length).toBe(5);
    expect((await claimJobs(app.ctx.cron, app.clock.now(), 10)).length).toBe(0);
  });
  it("dedupe_key holds only while a job is queued or running", async () => {
    const first = await enq("misc.job", { dedupeKey: "k1" });
    expect(first.id).toBeTruthy();
    expect((await enq("misc.job", { dedupeKey: "k1" })).id).toBeNull();
    const [j] = await claimJobs(app.ctx.cron, app.clock.now(), 1);
    expect((await enq("misc.job", { dedupeKey: "k1" })).id).toBeNull();            // running still blocks
    expect(await completeJob(app.ctx.cron, j!.id, j!.attempt_id, app.clock.now())).toBe(true);
    expect((await enq("misc.job", { dedupeKey: "k1" })).id).toBeTruthy();          // done frees the key
  });
});

describe("ST-105 lease fence", () => {
  it("ST-105: a lease that expires mid-job cannot commit the first worker's result", async () => {
    await enq("lease.test");
    const [a] = await claimJobs(app.ctx.cron, app.clock.now(), 1);
    expect(a).toBeTruthy();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Worker A: slow. It writes its result through the lease fence after the gate opens.
    const workerA = (async () => {
      await gate;
      await withLease(app.ctx, a!, (c) => c.query("insert into flags (name, value) values ('result.lease.test', '\"A\"')"));
    })();
    app.clock.advance((10 + 30 + 1) * 1000);                                   // lease over
    expect(await reclaimExpired(app.ctx, app.clock.now())).toBe(1);
    const [b] = await claimJobs(app.ctx.cron, app.clock.now(), 1);
    expect(b!.id).toBe(a!.id); expect(b!.attempt_id).not.toBe(a!.attempt_id);
    await withLease(app.ctx, b!, (c) => c.query("insert into flags (name, value) values ('result.lease.test', '\"B\"')"));
    expect(await completeJob(app.ctx.cron, b!.id, b!.attempt_id, app.clock.now())).toBe(true);

    release();
    await expect(workerA).rejects.toBeInstanceOf(LeaseLostError);
    expect(await completeJob(app.ctx.cron, a!.id, a!.attempt_id, app.clock.now())).toBe(false);
    expect((await q("select value from flags where name = 'result.lease.test'"))[0].value).toBe("B");
    expect((await q("select state, attempts from jobs where id = $1", [a!.id]))[0]).toMatchObject({ state: "done", attempts: 2 });
  });
  it("ST-105: an expired but not yet reclaimed lease also cannot commit or complete", async () => {
    await enq("lease.test");
    const [a] = await claimJobs(app.ctx.cron, app.clock.now(), 1);
    app.clock.advance(60_000);
    await expect(withLease(app.ctx, a!, (c) => c.query("insert into flags (name, value) values ('result.x', '1')"))).rejects.toBeInstanceOf(LeaseLostError);
    expect(await completeJob(app.ctx.cron, a!.id, a!.attempt_id, app.clock.now())).toBe(false);
    expect((await q("select 1 from flags where name = 'result.x'")).length).toBe(0);
  });
  it("ST-105: the runtime-role fence (tenant handlers) refuses a lost lease too, and a live lease writes", async () => {
    const uid = (await q("insert into users (email, status) values ('lease@example.com','active') returning id"))[0].id;
    await enq("lease.test", { userId: uid });
    const [a] = await claimJobs(app.ctx.cron, app.clock.now(), 1);
    await withLease(app.ctx, a!, (c) => c.query("insert into notification_addresses (user_id, address, kind) values ($1,'n@example.com','login')", [uid]), { userId: uid });
    expect((await q("select count(*)::int as n from notification_addresses where user_id = $1", [uid]))[0].n).toBe(1);
    app.clock.advance(120_000);
    await expect(withLease(app.ctx, a!, (c) => c.query("insert into notification_addresses (user_id, address, kind) values ($1,'m@example.com','login')", [uid]), { userId: uid })).rejects.toBeInstanceOf(LeaseLostError);
    expect((await q("select count(*)::int as n from notification_addresses where user_id = $1", [uid]))[0].n).toBe(1);
  });
  it("ST-105: a handler that finishes after its lease ran out is not marked done by the tick", async () => {
    await enq("lease.test");
    handlers["lease.test"] = async () => { app.clock.advance(120_000); };      // the job "takes" two minutes of fake time
    const r = await runTick(app.ctx, { budgetMs: 5000 });
    expect(r.done).toBe(0); expect(r.leaseLost).toBe(1);
    expect((await q("select state from jobs where kind = 'lease.test'"))[0].state).toBe("running");   // waits for reclaim
    expect(await reclaimExpired(app.ctx, app.clock.now())).toBe(1);
  });

  it("ST-105: with 10,000 queued domain.sync jobs an order.fulfil starts in the first wave of the next tick, well inside 60 s of tick time", async () => {
    await q("insert into jobs (kind, priority, run_at, payload) select 'domain.sync', 1, $1, '{}' from generate_series(1,10000)", [new Date(app.clock.now().getTime() - 1000)]);
    await enq("order.fulfil");
    let sim = 0;
    let running = 0, maxRunning = 0, started = 0;
    handlers["domain.sync"] = async () => { running++; maxRunning = Math.max(maxRunning, running); started++; await new Promise((r) => setTimeout(r, 1)); sim += 200; running--; };
    let fulfilAt = -1;
    handlers["order.fulfil"] = async () => { fulfilAt = sim; };
    const t0 = performance.now();
    const claimT0 = performance.now();
    const probe = await claimJobs(app.ctx.cron, app.clock.now(), 1, { priority: 0 });
    const claimMs = performance.now() - claimT0;
    expect(probe.map((j) => j.kind)).toEqual(["order.fulfil"]);
    expect(claimMs).toBeLessThan(500);                                            // real Postgres, 10,000 rows behind it
    await q("update jobs set state = 'queued', locked_until = null where id = $1", [probe[0]!.id]);

    const r = await runTick(app.ctx, { budgetMs: 50_000, mono: () => sim });
    expect(fulfilAt).toBe(0);                                                     // simulated tick time when it started
    expect(fulfilAt).toBeLessThan(60_000);
    expect(r.priority0Started).toBe(1);
    expect(maxRunning).toBeLessThanOrEqual(5);                                    // per-kind cap
    expect(started).toBeGreaterThan(100);
    expect(sim).toBeLessThanOrEqual(50_000 + 1000);                               // the tick stopped at its budget
    expect((await q("select state from jobs where kind = 'order.fulfil'"))[0].state).toBe("done");
    expect(performance.now() - t0).toBeLessThan(WALL_BOUND_MS);
  }, 120_000);

  it("ST-105: an order.fulfil enqueued while domain.sync jobs fill the tick starts on the next wave, not after the backlog", async () => {
    await q("insert into jobs (kind, priority, run_at, payload) select 'domain.sync', 1, $1, '{}' from generate_series(1,10000)", [new Date(app.clock.now().getTime() - 1000)]);
    let sim = 0, n = 0, fulfilAt = -1, enqueuedAt = -1;
    handlers["domain.sync"] = async () => {
      sim += 200;
      if (++n === 100) { await enq("order.fulfil"); enqueuedAt = sim; }
    };
    handlers["order.fulfil"] = async () => { fulfilAt = sim; };
    await runTick(app.ctx, { budgetMs: 50_000, mono: () => sim });
    expect(fulfilAt).toBeGreaterThan(0);
    expect(fulfilAt - enqueuedAt).toBeLessThanOrEqual(2000);                     // one or two waves of 5 x 200 ms
    expect(fulfilAt - enqueuedAt).toBeLessThan(60_000);
  }, 120_000);

  it("ST-105: priority 0 spends the first 60% of the budget alone; priority 1 runs only once money work is exhausted or that share is spent", async () => {
    for (let i = 0; i < 24; i++) await enq("order.fulfil");
    for (let i = 0; i < 4; i++) await enq("misc.job");
    let sim = 0; const order: string[] = [];
    handlers["order.fulfil"] = async () => { sim += 4000; order.push("p0"); };      // 4 in parallel: 16 s of tick time per wave
    handlers["misc.job"] = async () => { order.push("p1"); };
    await runTick(app.ctx, { budgetMs: 50_000, mono: () => sim, concurrency: 4 });
    const firstP1 = order.indexOf("p1");
    expect(firstP1 === -1 || order.slice(0, firstP1).every((x) => x === "p0")).toBe(true);
    // Waves ran at sim 0, 16 s, 32 s (past the 30 s share) and 48 s: no priority 1 job could start before the money backlog was drained or the budget ended.
    expect(order.filter((x) => x === "p0").length).toBeGreaterThanOrEqual(16);
    if (firstP1 !== -1) expect(order.slice(0, firstP1).filter((x) => x === "p0").length).toBe(24);
  });

  it("drains 10,000 jobs against Postgres in a reasonable time when caps allow", async () => {
    await q("insert into jobs (kind, priority, run_at, payload) select 'misc.job', 1, $1, '{}' from generate_series(1,10000)", [new Date(app.clock.now().getTime() - 1000)]);
    const t0 = performance.now();
    let total = 0;
    while (total < 10000) { const r = await runTick(app.ctx, { budgetMs: 20_000, concurrency: 50 }); total += r.done; if (r.claimed === 0) break; }
    const ms = performance.now() - t0;
    expect(total).toBe(10000);
    expect(ms).toBeLessThan(WALL_BOUND_MS);
    console.info(`ST-105 drain of 10,000 jobs: ${Math.round(ms)} ms`);
  }, 120_000);
});

describe("retry, backoff, dead letters", () => {
  it("retries with exponential backoff and jitter, dead-letters at max_attempts, stores no message, pages for money kinds", async () => {
    const SECRET = "sk_live_should_never_be_stored";
    handlers["domain.sync"] = async () => { throw new Error(SECRET); };
    handlers["order.fulfil"] = async () => { throw Object.assign(new Error(SECRET), { name: "StripeError", code: "card_declined" }); };
    const hookCalls: string[] = [];
    registerDeadLetterHook("order.fulfil", async (_c, j) => { hookCalls.push(j.kind); });
    await enq("domain.sync"); await enq("order.fulfil");
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await runTick(app.ctx, { budgetMs: 5000, random: () => 1 });
      if (attempt < 3) {
        const row = (await q("select run_at, state, attempts, last_error from jobs where kind = 'domain.sync'"))[0];
        expect(row.state).toBe("queued"); expect(row.attempts).toBe(attempt);
        delays.push(new Date(row.run_at).getTime() - app.clock.now().getTime());
        app.clock.advance(delays.at(-1)! + 1);
      }
    }
    expect(delays).toEqual([15_000, 30_000]);                                    // 15 s, 30 s with jitter fixed at its top
    const jobs = await q("select kind, state, attempts, last_error from jobs order by kind");
    expect(jobs.map((j) => j.state)).toEqual(["dead", "dead"]);
    expect(jobs.find((j) => j.kind === "order.fulfil")!.last_error).toBe("StripeError:card_declined");
    expect(jobs.find((j) => j.kind === "domain.sync")!.last_error).toBe("Error");
    const alerts = await q("select severity, kind, subject, detail from alerts where kind = 'job.dead' order by subject");
    expect(alerts.map((a) => [a.subject, a.severity])).toEqual([["domain.sync", "warn"], ["order.fulfil", "page"]]);
    expect(JSON.stringify(await q("select * from alerts")) + JSON.stringify(jobs)).not.toContain(SECRET);
    expect(hookCalls).toEqual(["order.fulfil"]);
  });
  it("jitter stays inside 50% to 100% of the base delay", async () => {
    const { backoffMs } = await import("../jobs/engine.ts");
    for (let i = 0; i < 200; i++) { const d = backoffMs(3); expect(d).toBeGreaterThanOrEqual(30_000); expect(d).toBeLessThanOrEqual(60_000); }
    expect(backoffMs(30, () => 1)).toBe(3_600_000);
  });
  it("a handler past its deadline fails the attempt (and its late writes are fenced by the lease)", async () => {
    handlers["misc.job"] = () => new Promise(() => undefined);
    await enq("misc.job");
    const r = await runTick(app.ctx, { budgetMs: 5000, deadlineMs: () => 30 });
    expect(r.retried).toBe(1);
    expect((await q("select last_error, state from jobs"))[0]).toMatchObject({ last_error: "JobDeadlineError", state: "queued" });
  });
  it("an expired lease on the last attempt dead-letters instead of requeueing", async () => {
    await enq("order.fulfil", { maxAttempts: 1 });
    await claimJobs(app.ctx.cron, app.clock.now(), 1);
    app.clock.advance(120_000);
    await reclaimExpired(app.ctx, app.clock.now());
    expect((await q("select state from jobs"))[0].state).toBe("dead");
    expect((await q("select severity from alerts where kind = 'job.dead'"))[0].severity).toBe("page");
  });
});

describe("tick, heartbeat, routes", () => {
  it("GET /api/cron/tick accepts only CRON_SECRET, runs a tick and writes the heartbeat", async () => {
    expect((await app.call("GET", "/api/cron/tick")).status).toBe(401);
    expect((await app.call("GET", "/api/cron/tick", { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await app.call("GET", "/api/cron/tick", { authorization: `Bearer ${mintToken("live").token}` })).status).toBe(401);
    expect((await app.call("GET", "/api/cron/tick", { authorization: app.ctx.config.cronSecret })).status).toBe(401);   // no Bearer scheme
    await enq("misc.job");
    const ok = await app.call("GET", "/api/cron/tick", { authorization: `Bearer ${app.ctx.config.cronSecret}` });
    expect(ok.status).toBe(200); expect(ok.json.done).toBe(1);
    expect((await q("select value from flags where name = 'heartbeat.tick'"))[0].value).toBe(app.clock.now().toISOString());
    expect((await app.call("POST", "/api/cron/tick", { authorization: `Bearer ${app.ctx.config.cronSecret}`, browser: false })).status).toBe(405);
  });
  it("ST-138: GET /api/health/ticks reports the age of the last completed tick and nothing else, anonymously", async () => {
    const before = await app.call("GET", "/api/health/ticks");
    expect(before.status).toBe(200); expect(before.json).toEqual({ ageSeconds: null });
    await app.call("GET", "/api/cron/tick", { authorization: `Bearer ${app.ctx.config.cronSecret}` });
    app.clock.advance(200_000);
    const after = await app.call("GET", "/api/health/ticks");
    expect(after.json).toEqual({ ageSeconds: 200 });
    expect(Object.keys(after.json)).toEqual(["ageSeconds"]);
    expect((await app.call("POST", "/api/health/ticks")).status).toBe(405);
  });
  it("an opportunistic tick runs jobs, never writes the heartbeat, and is single-flight", async () => {
    await enq("misc.job");
    let gate!: () => void;
    handlers["misc.job"] = () => new Promise<void>((r) => { gate = r; });
    let waited: Promise<unknown> | undefined;
    expect(opportunisticTick(app.ctx, (p) => { waited = p; })).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(opportunisticTick(app.ctx)).toBe(false);
    gate(); await waited;
    expect((await q("select state from jobs"))[0].state).toBe("done");
    expect((await q("select value from flags where name = 'heartbeat.tick'"))[0].value).toBeNull();
  });
  it("recurring jobs are enqueued once per bucket, even when ticks are duplicated, and again in the next bucket", async () => {
    registerRecurringJob({ kind: "misc.job", everySec: 86_400 });
    await Promise.all([runTick(app.ctx, { budgetMs: 2000 }), runTick(app.ctx, { budgetMs: 2000 })]);
    await runTick(app.ctx, { budgetMs: 2000 });
    expect((await q("select count(*)::int as n from jobs where kind = 'misc.job'"))[0].n).toBe(1);
    app.clock.advance(86_400_000);
    await runTick(app.ctx, { budgetMs: 2000 });
    expect((await q("select count(*)::int as n from jobs where kind = 'misc.job'"))[0].n).toBe(2);
  });
  it("auto-safe mode: a page nobody acknowledged for 30 minutes sets registrar_writes_paused", async () => {
    await q("insert into alerts (severity, kind, subject, raised_at) values ('page','order.stuck','x',$1)", [new Date(app.clock.now().getTime() - 31 * 60_000)]);
    await runTick(app.ctx, { budgetMs: 1000 });
    expect((await q("select value from flags where name = 'registrar_writes_paused'"))[0].value).toBe(true);
    expect((await q("select 1 from alerts where kind = 'auto_safe.engaged'")).length).toBe(1);
  });
  it("auto-safe mode leaves the flag alone when the page was acknowledged or is recent", async () => {
    await q("insert into alerts (severity, kind, subject, raised_at, acked_at, acked_by) values ('page','a','x',$1,$1,'op')", [new Date(app.clock.now().getTime() - 60 * 60_000)]);
    await q("insert into alerts (severity, kind, subject, raised_at) values ('page','b','x',$1)", [new Date(app.clock.now().getTime() - 5 * 60_000)]);
    await runTick(app.ctx, { budgetMs: 1000 });
    expect((await q("select value from flags where name = 'registrar_writes_paused'"))[0].value).toBe(false);
  });
});
