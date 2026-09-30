import { tx, type PoolClient } from "@mosshatch/db";
import { RegistrarError, type DomainStatus } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { enqueue, type JobRow } from "../jobs/registry.ts";
import { withLease } from "../jobs/engine.ts";
import { raiseAlert, closeAlerts } from "../ops/alerts.ts";
import { SYNC_ERROR_ATTENTION_MS, UUID_RE, loadDomain, registrarOf, rowToDomain, type DomainRow } from "./common.ts";
import { finishRun, observeDomain, openFinding, startRun } from "./detector.ts";
import { releaseDomain, restorableUntil } from "./release.ts";
import { ensureTerm } from "./terms.ts";

/**
 * `domain.sync`: the adapter's truth into `domains` (PLAN 4.3b). The row is a cache with `synced_at`; the state shown to the person is
 * derived from it (state.ts) and never advances on its own. The detector runs on every reading, before the cache is overwritten, so a
 * finding and the new values commit together.
 */
export type SyncOutcome = "synced" | "redemption" | "released" | "missing" | "error" | "gone" | "not_restorable_yet";

const idOf = (job: Pick<JobRow, "payload">): string | null => {
  const v = job.payload?.domain_id;
  return typeof v === "string" && UUID_RE.test(v) ? v : null;
};

export async function syncDomain(ctx: AppContext, domainId: string, o: { job?: Pick<JobRow, "id" | "attempt_id">; runId?: string | null } = {}): Promise<SyncOutcome> {
  const d0 = await loadDomain(ctx.cron, domainId);
  if (!d0 || d0.releasedAt) return "gone";
  const registrar = registrarOf(ctx);
  const write = <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => (o.job ? withLease(ctx, o.job, fn) : tx(ctx.cron, fn));

  let up: DomainStatus | null;
  try { up = await registrar.getDomain(d0.fqdn); }
  catch (e) {
    if (!(e instanceof RegistrarError)) throw e;
    const now = ctx.clock.now();
    await write(async (c) => {
      await c.query("update domains set sync_error = $2, sync_error_since = coalesce(sync_error_since, $3) where id = $1 and released_at is null", [d0.id, (e.code ?? e.kind).slice(0, 40), now]);
      const since = (await c.query("select sync_error_since from domains where id = $1", [d0.id])).rows[0]?.sync_error_since;
      if (since && now.getTime() - new Date(since).getTime() > SYNC_ERROR_ATTENTION_MS) await raiseAlert(ctx, c, { severity: "warn", kind: "domain_sync_error", subject: d0.id, detail: { code: e.kind } });
    });
    return "error";
  }

  if (!up) return notFoundUpstream(ctx, d0, registrar, write, o.runId ?? null);

  return write<SyncOutcome>(async (c) => {
    const cur = rowToDomain((await c.query("select * from domains where id = $1 for update", [d0.id])).rows[0]);
    if (cur.releasedAt) return "gone";
    const now = ctx.clock.now();
    await observeDomain(ctx, c, cur, up, o.runId ?? null);
    await c.query(
      `update domains set state = $2, expires_at = $3, locked = $4, nameservers = $5, registry_statuses = $6, ds_present = $7, privacy_status = $8, transfer_away = $9,
              owner_email_hash = coalesce($10, owner_email_hash), let_expire = $11, privacy_service = $12, synced_at = $13, sync_error = null, sync_error_since = null,
              registry_created_at = coalesce($14, registry_created_at), registrar_ref = coalesce(registrar_ref, $15)
        where id = $1 and released_at is null`,
      [cur.id, up.state, up.expiresAt ?? cur.expiresAt, up.locked, up.nameservers, up.registryStatuses, up.dsPresent, up.privacyStatus, !!up.transferAwayInProgress,
        up.ownerEmailHash ?? null, !!up.letExpire, !!up.privacyServiceEnabled, now, up.createdAt ?? null, up.registrarOrderId ?? null]);
    await closeAlerts(c, "domain_sync_error", cur.id);
    const fresh = rowToDomain((await c.query("select * from domains where id = $1", [cur.id])).rows[0]);
    await ensureTerm(c, fresh, now);
    return "synced";
  });
}

/**
 * `getDomain` answered "not found". Three explanations, in order: the name is in redemption (still ours, restorable), it left by an
 * outbound transfer that completed, or it lapsed and the registry deleted it. Anything else is unexpected and a finding.
 */
async function notFoundUpstream(ctx: AppContext, d: DomainRow, registrar: ReturnType<typeof registrarOf>, write: <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>, runId: string | null): Promise<SyncOutcome> {
  const now = ctx.clock.now();
  let deleted;
  try { deleted = await registrar.getDeletedDomains(); }
  catch (e) { if (e instanceof RegistrarError) return "error"; throw e; }
  const del = deleted.find((x) => x.fqdn.toLowerCase() === d.fqdn.toLowerCase());
  if (del) {
    await write(async (c) => { await c.query("update domains set state = 'redemption', synced_at = $2, sync_error = null, sync_error_since = null where id = $1 and released_at is null", [d.id, now]); });
    return "redemption";
  }
  if (d.transferAway || d.state === "transferring_out") {
    const r = await releaseDomain(ctx, d.id, "transferred_out");
    return r.released ? "released" : "gone";
  }
  if (["expired", "redemption", "pending_delete"].includes(d.state) || (d.expiresAt && d.expiresAt < now)) {
    const until = await restorableUntil(ctx.cron, d);
    if (until && now >= until) {
      const r = await releaseDomain(ctx, d.id, "lapsed");
      return r.released ? "released" : "not_restorable_yet";
    }
    // The registry timeline says it should still be restorable, yet the registrar does not know it and it is not in the deleted list.
    await write(async (c) => { await c.query("update domains set sync_error = 'missing_upstream', sync_error_since = coalesce(sync_error_since, $2) where id = $1", [d.id, now]); await openFinding(ctx, c, { runId, domain: d, kind: "missing_domain", fields: [], observed: { restorable: true } }); });
    return "not_restorable_yet";
  }
  await write(async (c) => {
    await c.query("update domains set sync_error = 'missing_upstream', sync_error_since = coalesce(sync_error_since, $2) where id = $1", [d.id, now]);
    await openFinding(ctx, c, { runId, domain: d, kind: "missing_domain", fields: [], observed: { missing: true } });
  });
  return "missing";
}

/** `domain.sync` job: with a `domain_id` sync that domain; without one, sweep every live domain into one job each (deduplicated). */
export async function domainSyncJob(ctx: AppContext, job: JobRow): Promise<void> {
  const id = idOf(job);
  if (id) { await syncDomain(ctx, id, { job }); return; }
  await enqueueSyncs(ctx);
}

export async function enqueueSyncs(ctx: AppContext): Promise<number> {
  const rows = (await ctx.cron.query("select id, user_id from domains where released_at is null and state <> 'pending' order by id")).rows;
  let n = 0;
  for (const r of rows) {
    const e = await tx(ctx.cron, (c) => enqueue(c, { kind: "domain.sync", payload: { domain_id: r.id }, userId: r.user_id, dedupeKey: `domain.sync:${r.id}`, priority: 1 }));
    if (e.id) n++;
  }
  return n;
}

/** Run the detector over the live inventory right now, inline, and record the run. Used by tests and by `registrar.reconcile`. */
export async function syncAllInline(ctx: AppContext): Promise<{ seen: number; opened: number }> {
  const run = await startRun(ctx.cron, "sync", ctx.clock.now());
  const rows = (await ctx.cron.query("select id from domains where released_at is null and state <> 'pending' order by id")).rows;
  for (const r of rows) await syncDomain(ctx, r.id, { runId: run });
  const opened = (await ctx.cron.query("select count(*)::int n from reconciliation_findings where run_id = $1", [run])).rows[0].n as number;
  await finishRun(ctx.cron, run, ctx.clock.now(), rows.length, opened);
  return { seen: rows.length, opened };
}
