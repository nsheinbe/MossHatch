import { tx } from "@mosshatch/db";
import { RegistrarError } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { enqueue } from "../jobs/registry.ts";
import { registrarOf, rowToDomain } from "./common.ts";
import { finishRun, openFinding, startRun } from "./detector.ts";

/**
 * `registrar.reconcile` (daily): the registrar's inventory against ours.
 *  - a name the registrar holds under our account that we have no live row for is an `extra_domain`, unless an order of ours explains it
 *    (a registration in flight, or one we gave up on and still watch): a process that died between "registrar succeeded" and "row written" leaves
 *    the detector quiet once the order machine catches up (ST-60);
 *  - a live row the registrar does not list is a `missing_domain`, unless the name is on its way out (redemption, transfer, expiry) and `domain.sync` owns that;
 *  - every name in both gets a `domain.sync`, which runs the field-level detector (lock, nameservers, DS, contact email hash, auto_renew, let_expire, privacy, transfer).
 * The sync sweep runs hourly, so a change is found within an hour; this job is the once-a-day inventory check that also catches names the sweep cannot see.
 */
export interface ReconcileResult { upstream: number; extra: number; missing: number; enqueued: number }

const IN_FLIGHT = ["authorized", "registering", "outcome_unknown", "registered", "capturing", "capture_failed", "registrar_unavailable", "paid_before_registration", "review_hold", "canceling", "registration_failed"];

export async function runReconcile(ctx: AppContext): Promise<ReconcileResult> {
  const reg = registrarOf(ctx);
  const runId = await startRun(ctx.cron, "inventory", ctx.clock.now());
  const out: ReconcileResult = { upstream: 0, extra: 0, missing: 0, enqueued: 0 };
  const upstream = new Map<string, Date>();
  try {
    let cursor: string | undefined;
    do {
      const page = await reg.listDomains({ cursor, limit: 100 });
      for (const r of page.rows) upstream.set(r.fqdn.toLowerCase(), r.expiresAt);
      cursor = page.next;
    } while (cursor);
  } catch (e) {
    if (e instanceof RegistrarError) { await finishRun(ctx.cron, runId, ctx.clock.now(), 0, 0, e.kind); return out; }
    throw e;
  }
  out.upstream = upstream.size;
  const local = (await ctx.cron.query("select * from domains where released_at is null and state <> 'pending'")).rows.map(rowToDomain);
  const localSet = new Set(local.map((d) => d.fqdn.toLowerCase()));

  for (const fqdn of upstream.keys()) {
    if (localSet.has(fqdn)) continue;
    const explained = (await ctx.cron.query(
      "select 1 from orders where fqdn_ascii = $1 and kind in ('register','transfer_in') and (state = any($2) or late_watch_state = 'watching') limit 1", [fqdn, IN_FLIGHT])).rowCount;
    if (explained) continue;
    // A domain row released a moment ago whose name the registrar still lists (release before the upstream delete finished) is also expected.
    const recentlyReleased = (await ctx.cron.query("select 1 from domains where fqdn_ascii = $1 and released_at > $2 limit 1", [fqdn, new Date(ctx.clock.now().getTime() - 3 * 86_400_000)])).rowCount;
    if (recentlyReleased) continue;
    const opened = await tx(ctx.cron, (c) => openFinding(ctx, c, { runId, domain: { id: "", userId: "" }, kind: "extra_domain", fields: [], withFqdn: fqdn, observed: { fqdn }, detail: { extra: true } }));
    if (opened) out.extra++;
  }
  for (const d of local) {
    const here = upstream.has(d.fqdn.toLowerCase());
    if (!here) {
      if (["expired", "redemption", "pending_delete", "transferring_out"].includes(d.state) || d.transferAway || (d.expiresAt && d.expiresAt < ctx.clock.now())) { await enqueueSync(ctx, d.id, d.userId); out.enqueued++; continue; }
      const opened = await tx(ctx.cron, (c) => openFinding(ctx, c, { runId, domain: d, kind: "missing_domain", fields: [], observed: { missing: true } }));
      if (opened) out.missing++;
      continue;
    }
    await enqueueSync(ctx, d.id, d.userId); out.enqueued++;
  }
  await finishRun(ctx.cron, runId, ctx.clock.now(), upstream.size, out.extra + out.missing);
  return out;
}

const enqueueSync = (ctx: AppContext, id: string, userId: string) =>
  tx(ctx.cron, (c) => enqueue(c, { kind: "domain.sync", payload: { domain_id: id }, userId, dedupeKey: `domain.sync:${id}`, priority: 1 }));
