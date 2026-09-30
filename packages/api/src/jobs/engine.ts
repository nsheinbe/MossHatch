import { tx, withUser, type Pool, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { getJobDef, listJobDefs, type JobDef, type JobPriority, type JobRow } from "./registry.ts";
import { autoSafeMode, closeAlerts, raiseAlert } from "../ops/alerts.ts";

/** Lease = now + maxRuntimeSec + this grace. */
export const LEASE_GRACE_SEC = 30;
/** Per-kind concurrency caps (PLAN 4.3b: own targets). Kinds not listed are uncapped. */
export const DEFAULT_KIND_CAPS: Readonly<Record<string, number>> = { "domain.sync": 5, "dns.verify": 3 };
/** A tick spends this share of its time budget on priority 0 before priority 1 may start. */
export const PRIORITY0_SHARE = 0.6;
export const TICK_STALE_SECONDS = 180;
export const P0_LATENCY_ALARM_SECONDS = 60;

export class LeaseLostError extends Error {
  override name = "LeaseLostError";
  constructor() { super("lease_lost"); }
}
export class JobDeadlineError extends Error {
  override name = "JobDeadlineError";
  constructor() { super("deadline"); }
}

// ---------------------------------------------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------------------------------------------

export interface ClaimOpts {
  /** Only this priority; otherwise priority 0 first, then 1. */
  priority?: JobPriority;
  caps?: Record<string, number>;
}
export interface ClaimedJob extends JobRow { priority: JobPriority }

/**
 * Claim up to `limit` runnable jobs with FOR UPDATE SKIP LOCKED, priority 0 before 1 and oldest run_at first.
 * Each claim gets a fresh `attempt_id` and `locked_until = now + maxRuntimeSec + 30 s`. Only kinds that have a
 * registered handler are claimed (a newer deploy's kind stays queued for a deploy that knows it). Per-kind caps count
 * running jobs under an advisory lock, so two concurrent claimers cannot exceed a cap.
 */
export async function claimJobs(cron: Pool, now: Date, limit: number, opts: ClaimOpts = {}): Promise<ClaimedJob[]> {
  const defs = listJobDefs();
  if (limit <= 0 || defs.length === 0) return [];
  const caps = { ...DEFAULT_KIND_CAPS, ...(opts.caps ?? {}) };
  const runSecs: Record<string, number> = Object.fromEntries(defs.map((d) => [d.kind, d.maxRuntimeSec]));
  const cappedKinds = defs.map((d) => d.kind).filter((k) => caps[k] !== undefined);
  const openKinds = defs.map((d) => d.kind).filter((k) => caps[k] === undefined);
  const priorities: JobPriority[] = opts.priority === undefined ? [0, 1] : [opts.priority];

  return tx(cron, async (c) => {
    const out: ClaimedJob[] = [];
    let left = limit;
    // Serialise capped claims per kind: the running count and the claim must be one atomic step.
    for (const k of cappedKinds) await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", ["mh.jobcap:" + k]);
    const running = new Map<string, number>();
    if (cappedKinds.length) {
      const r = await c.query("select kind, count(*)::int as n from jobs where state = 'running' and kind = any($1::text[]) and locked_until >= $2 group by kind", [cappedKinds, now]);
      for (const row of r.rows) running.set(row.kind, row.n);
    }
    for (const p of priorities) {
      if (left <= 0) break;
      if (openKinds.length) {
        const got = await claimSome(c, now, p, openKinds, left, runSecs);
        out.push(...got); left -= got.length;
      }
      for (const k of cappedKinds) {
        if (left <= 0) break;
        const room = Math.min(left, (caps[k] as number) - (running.get(k) ?? 0));
        if (room <= 0) continue;
        const got = await claimSome(c, now, p, [k], room, runSecs);
        out.push(...got); left -= got.length; running.set(k, (running.get(k) ?? 0) + got.length);
      }
    }
    return out;
  });
}

async function claimSome(c: PoolClient, now: Date, priority: JobPriority, kinds: string[], n: number, runSecs: Record<string, number>): Promise<ClaimedJob[]> {
  const r = await c.query(
    `with pick as (
       select id from jobs where state = 'queued' and priority = $2 and run_at <= $1 and kind = any($3::text[])
       order by run_at, id limit $4 for update skip locked)
     update jobs j set state = 'running', attempt_id = gen_random_uuid(), attempts = j.attempts + 1,
       locked_until = $1::timestamptz + ((($5::jsonb ->> j.kind)::int + ${LEASE_GRACE_SEC}) * interval '1 second')
     from pick where j.id = pick.id
     returning j.id, j.kind, j.priority, j.attempt_id, j.attempts, j.max_attempts, j.payload, j.user_id`,
    [now, priority, kinds, n, JSON.stringify(runSecs)],
  );
  return r.rows as ClaimedJob[];
}

/** Jobs whose lease ran out go back to the queue (or dead-letter when out of attempts). The old attempt can no longer commit. */
export async function reclaimExpired(ctx: Pick<AppContext, "cron" | "services" | "clock">, now: Date): Promise<number> {
  const r = await ctx.cron.query(
    `update jobs set state = case when attempts >= max_attempts then 'dead' else 'queued' end, locked_until = null, run_at = $1, last_error = 'lease_expired'
     where state = 'running' and locked_until < $1 returning id, kind, priority, attempts, state`,
    [now],
  );
  for (const row of r.rows) if (row.state === "dead") await deadLetter(ctx, row, "lease_expired");
  return r.rowCount ?? 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Completion, failure, dead letters
// ---------------------------------------------------------------------------------------------------------------

/** Complete one job. False means the lease is gone or another attempt owns the row: the result must not be treated as committed. */
export async function completeJob(cron: Pool, id: string, attemptId: string, now: Date): Promise<boolean> {
  const r = await cron.query(
    "update jobs set state = 'done', locked_until = null, last_error = null where id = $1 and attempt_id = $2 and state = 'running' and locked_until > $3",
    [id, attemptId, now],
  );
  return r.rowCount === 1;
}

async function completeMany(cron: Pool, jobs: ClaimedJob[], now: Date): Promise<Set<string>> {
  if (!jobs.length) return new Set();
  const r = await cron.query(
    `update jobs set state = 'done', locked_until = null, last_error = null
     from unnest($1::uuid[], $2::uuid[]) as t(id, att)
     where jobs.id = t.id and jobs.attempt_id = t.att and jobs.state = 'running' and jobs.locked_until > $3 returning jobs.id`,
    [jobs.map((j) => j.id), jobs.map((j) => j.attempt_id), now],
  );
  return new Set(r.rows.map((x) => x.id as string));
}

/** Exponential backoff with jitter: 15 s, 30 s, 60 s ... capped at one hour, scaled by 0.5 to 1.0. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(15_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
  return Math.round(base * (0.5 + random() * 0.5));
}

/** A class name and, when it is a short code, the code. Never the message, which may carry values. */
export function errorSummary(e: unknown): string {
  const name = (e as Error)?.name ?? "Error";
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? `${name}:${code}` : String(name).slice(0, 60);
}

export type DeadLetterHook = (ctx: AppContext, job: { id: string; kind: string; attempts: number; reason: string }) => Promise<void>;
const deadHooks = new Map<string, DeadLetterHook[]>();
/** A module's default action when its job dead-letters (e.g. `order.fulfil` cancels the PaymentIntent when the authorization deadline is near). */
export function registerDeadLetterHook(kind: string, hook: DeadLetterHook): void {
  deadHooks.set(kind, [...(deadHooks.get(kind) ?? []), hook]);
}
export function clearDeadLetterHooks(): void { deadHooks.clear(); }

async function deadLetter(ctx: Pick<AppContext, "cron" | "services" | "clock">, job: { id: string; kind: string; priority?: number; attempts: number }, reason: string): Promise<void> {
  const def = getJobDef(job.kind);
  const money = (def?.priority ?? job.priority) === 0;
  await raiseAlert(ctx, ctx.cron, { severity: money ? "page" : "warn", kind: "job.dead", subject: job.kind, detail: { job_id: job.id, attempts: job.attempts, reason, money } });
  for (const h of deadHooks.get(job.kind) ?? []) {
    try { await h(ctx as AppContext, { id: job.id, kind: job.kind, attempts: job.attempts, reason }); }
    catch (e) { await raiseAlert(ctx, ctx.cron, { severity: "warn", kind: "job.dead_hook_failed", subject: job.kind, detail: { job_id: job.id, error: errorSummary(e) } }); }
  }
}

async function failJob(ctx: AppContext, job: ClaimedJob, err: unknown, random: () => number): Promise<"retried" | "dead" | "lost"> {
  const summary = errorSummary(err);
  const dead = job.attempts >= job.max_attempts;
  const runAt = new Date(ctx.clock.now().getTime() + backoffMs(job.attempts, random));
  const r = await ctx.cron.query(
    "update jobs set state = $3, run_at = $4, locked_until = null, last_error = $5 where id = $1 and attempt_id = $2 and state = 'running'",
    [job.id, job.attempt_id, dead ? "dead" : "queued", runAt, summary],
  );
  if (r.rowCount !== 1) return "lost";
  if (dead) { await deadLetter(ctx, job, summary); return "dead"; }
  return "retried";
}

// ---------------------------------------------------------------------------------------------------------------
// Lease fence for handler writes
// ---------------------------------------------------------------------------------------------------------------

/**
 * Run a handler's writes inside a transaction that first takes a share lock on its own job row. If the lease has
 * expired, or the row belongs to a later attempt, it throws LeaseLostError and nothing is written. This is what
 * "a job that outlived its lease cannot commit" means for the handler's own result (ST-105). Pass `userId` to act for
 * a tenant through the runtime role and RLS; otherwise the system (cron) role is used.
 */
export async function withLease<T>(ctx: Pick<AppContext, "cron" | "runtime" | "clock">, job: Pick<JobRow, "id" | "attempt_id">, fn: (c: PoolClient) => Promise<T>, opts: { userId?: string } = {}): Promise<T> {
  const body = async (c: PoolClient) => {
    const ok = (await c.query("select job_lease_lock($1, $2, $3) as ok", [job.id, job.attempt_id, ctx.clock.now()])).rows[0].ok as boolean;
    if (!ok) throw new LeaseLostError();
    return fn(c);
  };
  return opts.userId ? withUser(ctx.runtime, opts.userId, body) : tx(ctx.cron, body);
}

// ---------------------------------------------------------------------------------------------------------------
// Recurring jobs
// ---------------------------------------------------------------------------------------------------------------

interface Recurring { kind: string; everySec: number; payload: Record<string, unknown> }
const recurring = new Map<string, Recurring>();
/** A job the tick enqueues once per `everySec` bucket (UTC-aligned). Safe with duplicated ticks: one row per bucket. */
export function registerRecurringJob(r: { kind: string; everySec: number; payload?: Record<string, unknown> }): void {
  recurring.set(r.kind, { kind: r.kind, everySec: r.everySec, payload: r.payload ?? {} });
}
export function clearRecurringJobs(): void { recurring.clear(); }

export async function enqueueRecurring(ctx: Pick<AppContext, "cron">, now: Date): Promise<number> {
  let n = 0;
  for (const r of recurring.values()) {
    const def: JobDef | undefined = getJobDef(r.kind);
    if (!def) continue;
    const key = `${r.kind}:${Math.floor(now.getTime() / (r.everySec * 1000))}`;
    const res = await ctx.cron.query(
      `insert into jobs (kind, priority, run_at, dedupe_key, payload, max_attempts)
       select $1::text, $2::smallint, $3::timestamptz, $4::text, $5::jsonb, $6::int
       where not exists (select 1 from jobs where kind = $1::text and dedupe_key = $4::text)
       on conflict do nothing`,
      [r.kind, def.priority, now, key, r.payload, def.maxAttempts ?? 8],
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Heartbeat and monitors
// ---------------------------------------------------------------------------------------------------------------

export async function writeHeartbeat(ctx: Pick<AppContext, "cron" | "clock">): Promise<void> {
  await ctx.cron.query("update flags set value = to_jsonb($1::text), updated_by = 'tick', updated_at = now() where name = 'heartbeat.tick'", [ctx.clock.now().toISOString()]);
}

/** Age in seconds of the last completed tick, or null when none has completed. Reads with any role that can select flags. */
export async function tickAgeSeconds(ctx: Pick<AppContext, "clock">, pool: Pick<Pool | PoolClient, "query">): Promise<number | null> {
  const r = await pool.query("select value from flags where name = 'heartbeat.tick'");
  const v = r.rows[0]?.value;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((ctx.clock.now().getTime() - t) / 1000));
}

/** Oldest runnable priority 0 job, in seconds; null when none waits. */
export async function oldestRunnableP0Seconds(ctx: Pick<AppContext, "cron" | "clock">): Promise<number | null> {
  const now = ctx.clock.now();
  const r = await ctx.cron.query("select min(run_at) as t from jobs where state = 'queued' and priority = 0 and run_at <= $1", [now]);
  const t = r.rows[0]?.t as Date | null;
  return t ? Math.max(0, Math.floor((now.getTime() - new Date(t).getTime()) / 1000)) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------------------------------------------

export interface TickOptions {
  /** Time to spend claiming and running work. Default 50 s (a Vercel function is limited to 60 s). */
  budgetMs?: number;
  /** Jobs run in parallel within a wave. */
  concurrency?: number;
  /** Write the dead-man's-switch heartbeat. Off for opportunistic ticks so they cannot mask a dead cron. */
  heartbeat?: boolean;
  /** Monotonic milliseconds; injectable so tests can simulate tick time. */
  mono?: () => number;
  random?: () => number;
  caps?: Record<string, number>;
  /** Deadline for one handler; defaults to the kind's maxRuntimeSec. */
  deadlineMs?: (def: JobDef) => number;
}
export interface TickResult {
  claimed: number; done: number; retried: number; dead: number; leaseLost: number; reclaimed: number; priority0Started: number;
  scheduled: number; elapsedMs: number; oldestP0Seconds: number | null;
}

export async function runTick(ctx: AppContext, opts: TickOptions = {}): Promise<TickResult> {
  const mono = opts.mono ?? (() => performance.now());
  const budgetMs = opts.budgetMs ?? 50_000;
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const random = opts.random ?? Math.random;
  const start = mono();
  const res: TickResult = { claimed: 0, done: 0, retried: 0, dead: 0, leaseLost: 0, reclaimed: 0, priority0Started: 0, scheduled: 0, elapsedMs: 0, oldestP0Seconds: null };

  // Monitors first: a stale heartbeat or a money job waiting too long is visible even if this tick then dies.
  const age = await tickAgeSeconds(ctx, ctx.cron);
  if (age !== null && age > TICK_STALE_SECONDS) await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "tick.stale", subject: "heartbeat.tick", detail: { age_seconds: age } });
  res.oldestP0Seconds = await oldestRunnableP0Seconds(ctx);
  if (res.oldestP0Seconds !== null && res.oldestP0Seconds > P0_LATENCY_ALARM_SECONDS) await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "jobs.p0_latency", subject: "priority0", detail: { oldest_seconds: res.oldestP0Seconds } });
  else await closeAlerts(ctx.cron, "jobs.p0_latency", "priority0");

  res.reclaimed = await reclaimExpired(ctx, ctx.clock.now());
  res.scheduled = await enqueueRecurring(ctx, ctx.clock.now());

  const drain = async (until: number, priority: JobPriority | undefined) => {
    while (mono() < until) {
      const jobs = await claimJobs(ctx.cron, ctx.clock.now(), concurrency, { priority, caps: opts.caps });
      if (jobs.length === 0) return;
      res.claimed += jobs.length;
      res.priority0Started += jobs.filter((j) => j.priority === 0).length;
      const ok: ClaimedJob[] = [];
      await Promise.all(jobs.map(async (j) => {
        try { await runHandler(ctx, j, opts.deadlineMs); ok.push(j); }
        catch (e) {
          const out = await failJob(ctx, j, e, random);
          if (out === "retried") res.retried++; else if (out === "dead") res.dead++; else res.leaseLost++;
        }
      }));
      const committed = await completeMany(ctx.cron, ok, ctx.clock.now());
      res.done += committed.size;
      res.leaseLost += ok.length - committed.size;
    }
  };
  // The first 60% of the budget is priority 0 only; after that both priorities run, money first.
  await drain(start + budgetMs * PRIORITY0_SHARE, 0);
  await drain(start + budgetMs, undefined);

  await autoSafeMode(ctx).catch(() => undefined);
  if (opts.heartbeat !== false) {
    await writeHeartbeat(ctx);
    await closeAlerts(ctx.cron, "tick.stale", "heartbeat.tick");
  }
  res.elapsedMs = Math.round(mono() - start);
  return res;
}

async function runHandler(ctx: AppContext, job: ClaimedJob, deadlineMs?: (def: JobDef) => number): Promise<void> {
  const def = getJobDef(job.kind);
  if (!def) throw new Error("no_handler");
  const ms = deadlineMs ? deadlineMs(def) : def.maxRuntimeSec * 1000;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new JobDeadlineError()), ms); });
  try { await Promise.race([def.handler(ctx, job), deadline]); } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------------------------------------------
// Opportunistic tick (webhook handlers call this after enqueueing)
// ---------------------------------------------------------------------------------------------------------------

let inflight: Promise<unknown> | null = null;
/**
 * Start a short tick without waiting for the cron: `waitUntil` keeps the function alive after the response.
 * One at a time per instance; other instances are safe because claims use SKIP LOCKED. It never writes the
 * heartbeat, so a dead cron is not hidden by webhook traffic.
 */
export function opportunisticTick(ctx: AppContext, waitUntil?: (p: Promise<unknown>) => void, opts: TickOptions = {}): boolean {
  if (inflight) return false;
  const p = runTick(ctx, { budgetMs: 8_000, ...opts, heartbeat: false }).catch(() => undefined).finally(() => { inflight = null; });
  inflight = p;
  waitUntil?.(p);
  return true;
}
