import { tx, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { appendAudit } from "../audit.ts";
import { getJobDef, registerJob, enqueue, type JobDef } from "../jobs/registry.ts";
import { registerRecurringJob } from "../jobs/engine.ts";
import { registerReleaseHook } from "../domains/release.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { screenName } from "./screen.ts";
import { countLookup, type PublishServices } from "./service.ts";

const svcOrNull = (ctx: AppContext) => (ctx.services as { publish?: PublishServices }).publish ?? null;
const DAY = 86_400;
/** Take-downs within a year that end a person's publishing (C-66, repeat infringers). Own target. */
export const REPEAT_TAKEDOWNS = 2;

/** Delete the stored portrait of every unpublished card not yet purged. Safe to run twice; a storage failure leaves the row for the next run. */
export async function purgeUnpublished(ctx: AppContext, limit = 50): Promise<{ purged: number; failed: number }> {
  const svc = svcOrNull(ctx);
  if (!svc) return { purged: 0, failed: 0 };
  const rows = (await ctx.cron.query("select id, snapshot_ref from cards where unpublished_at is not null and purged_at is null order by unpublished_at limit $1", [limit])).rows;
  let purged = 0, failed = 0;
  for (const r of rows) {
    try { await svc.storage.delete(r.snapshot_ref); } catch { failed++; continue; }
    const u = await ctx.cron.query("update cards set purged_at = $2 where id = $1 and purged_at is null", [r.id, ctx.clock.now()]);
    purged += u.rowCount ?? 0;
  }
  return { purged, failed };
}

/**
 * Take a card down (C-66): support acting on a valid notice, an authority or registrar-directed hold, or the daily re-scan.
 * Unpublish first, record the decision against the report, and block publishing after repeated take-downs. The take-down holds
 * the domain's card until support reinstates it (`reinstateCard`); when the owner had already unpublished, the name's latest
 * card on its unreleased domain carries the hold, so unpublishing ahead of a notice does not escape it.
 */
export async function takeDownCard(ctx: AppContext, o: { slug: string; reportId?: string; actor: "support" | "system"; cause: "notice" | "authority" | "registrar_hold" | "rescan" }): Promise<{ takenDown: boolean; blocked: boolean }> {
  const now = ctx.clock.now();
  const out = await tx(ctx.cron, async (c) => {
    const dom = (await c.query("select c.domain_id from cards c join domains d on d.id = c.domain_id where c.slug = $1 and d.released_at is null order by c.published_at desc limit 1", [o.slug])).rows[0];
    if (!dom) return { takenDown: false, blocked: false };
    // Serialises with a publish of this domain's card (routes.ts takes the same lock), so neither can slip past the other.
    await c.query("select pg_advisory_xact_lock(hashtextextended('card:' || $1::text, 0))", [dom.domain_id]);
    // The live card, or else the latest one, carries the hold.
    const rows = (await c.query(
      `update cards set takedown_state = 'taken_down', unpublished_at = coalesce(unpublished_at, $2), unpublish_reason = coalesce(unpublish_reason, 'takedown')
       where domain_id = $1 and takedown_state <> 'taken_down'
         and (unpublished_at is null or id = (select id from cards where domain_id = $1 order by published_at desc limit 1))
       returning id, user_id`,
      [dom.domain_id, now])).rows;
    const row = rows[0];
    if (!row) return { takenDown: false, blocked: false };
    if (o.reportId) {
      await c.query("update abuse_reports set target_id = $2, decision = 'takedown', state = 'actioned', actioned_at = $3, actor = $4 where id = $1 and target_kind = 'card'", [o.reportId, row.id, now, o.actor]);
    }
    await appendAudit(ctx, c, { chainId: row.user_id, actorKind: o.actor, action: "card.taken_down", resourceKind: "card", resourceId: row.id, detail: { cause: o.cause } });
    const n = Number((await c.query("select count(*)::int as n from cards where user_id = $1 and takedown_state = 'taken_down' and unpublished_at > $2", [row.user_id, new Date(now.getTime() - 365 * DAY * 1000)])).rows[0].n);
    let blocked = false;
    if (n >= REPEAT_TAKEDOWNS) {
      const b = await c.query("insert into card_publish_blocks (user_id, reason) values ($1, 'repeat_takedown') on conflict do nothing", [row.user_id]);
      blocked = (b.rowCount ?? 0) > 0;
      if (blocked) await appendAudit(ctx, c, { chainId: row.user_id, actorKind: o.actor, action: "card.publish_blocked", resourceKind: "user", resourceId: row.user_id, detail: { takedowns: n } });
    }
    await enqueue(c, { kind: "card.purge", payload: {}, dedupeKey: `card.purge:${row.id}` });
    await enqueue(c, { kind: "cards.rebuild", payload: {}, dedupeKey: `cards.rebuild:${Math.floor(now.getTime() / 60_000)}` });
    return { takenDown: true, blocked };
  });
  if (out.takenDown) await purgeUnpublished(ctx).catch(() => undefined);
  return out;
}

/** Cards per page of the re-scan. It pages through the whole view, so no card is ever left unscreened by a limit. */
export const RESCAN_PAGE = 1000;

/** Daily re-scan of every live card (C-68): the in-house screen may have grown, and a clean name can turn up on a threat list later. */
export async function rescanCards(ctx: AppContext): Promise<{ scanned: number; takenDown: number }> {
  const svc = svcOrNull(ctx);
  if (!svc) return { scanned: 0, takenDown: 0 };
  let scanned = 0, takenDown = 0;
  let after: string | null = null;
  for (;;) {
    // Keyset by slug (unique among live cards): a take-down during the scan neither skips nor repeats a card.
    const rows: { slug: string }[] = (await ctx.cron.query(`select slug from public_cards where ($1::text is null or slug > $1 collate "C") order by slug collate "C" limit $2`, [after, RESCAN_PAGE])).rows;
    for (const r of rows) {
      let bad = !screenName(r.slug).ok;
      if (!bad) {
        try { bad = await svc.webRisk.isFlagged(`http://${r.slug}/`); await countLookup(ctx.cron, ctx.clock.now()); } catch {
          await raiseAlert(ctx, ctx.cron, { severity: "warn", kind: "card_rescan_unavailable", subject: "web_risk" });
          return { scanned, takenDown };
        }
      }
      scanned++;
      if (bad && (await takeDownCard(ctx, { slug: r.slug, actor: "system", cause: "rescan" })).takenDown) takenDown++;
    }
    if (rows.length < RESCAN_PAGE) return { scanned, takenDown };
    after = rows[rows.length - 1]!.slug;
  }
}

/**
 * Support lifts a take-down (C-66: a counter-notice, or a put-back after review). The card stays unpublished; the owner may publish
 * again under a new step-up. Recorded against the report when one is named.
 */
export async function reinstateCard(ctx: AppContext, o: { slug: string; reportId?: string; actor: "support"; cause: "counter_notice" | "put_back" }): Promise<{ reinstated: number }> {
  const now = ctx.clock.now();
  return tx(ctx.cron, async (c) => {
    const rows = (await c.query(
      `update cards set takedown_state = 'reinstated'
       where takedown_state = 'taken_down' and slug = $1 and domain_id in (select id from domains where released_at is null)
       returning id, user_id`, [o.slug])).rows;
    for (const row of rows) {
      await appendAudit(ctx, c, { chainId: row.user_id, actorKind: o.actor, action: "card.reinstated", resourceKind: "card", resourceId: row.id, detail: { cause: o.cause } });
    }
    if (o.reportId && rows.length) {
      await c.query("update abuse_reports set decision = 'reinstated', actioned_at = $2, actor = $3 where id = $1 and target_kind = 'card'", [o.reportId, now, o.actor]);
    }
    return { reinstated: rows.length };
  });
}

const PUBLISH_JOBS: (JobDef & { everySec?: number })[] = [
  { kind: "card.purge", priority: 1, maxRuntimeSec: 60, everySec: 900, handler: async (ctx) => { const r = await purgeUnpublished(ctx); if (r.failed) throw new Error("card_purge_incomplete"); } },
  { kind: "cards.rebuild", priority: 1, maxRuntimeSec: 30, handler: async (ctx) => { const s = svcOrNull(ctx); if (s) await s.site.rebuild(); } },
  { kind: "card.rescan", priority: 1, maxRuntimeSec: 300, everySec: DAY, handler: async (ctx) => { await rescanCards(ctx); } },
];

export function registerPublishJobs(): void {
  for (const { everySec, ...def } of PUBLISH_JOBS) {
    if (!getJobDef(def.kind)) registerJob(def);
    if (everySec) registerRecurringJob({ kind: def.kind, everySec });
  }
}

/**
 * Domain release (ST-95): the release transaction already sets `unpublished_at` on the domain's cards; this hook records why and
 * queues the portrait purge and a cards rebuild in the same transaction.
 */
export function installCardReleaseHook(): void {
  registerReleaseHook({
    name: "publish.cards",
    async immediate(ctx: AppContext, c: PoolClient, d: { id: string }) {
      const now = ctx.clock.now();
      const r = await c.query("update cards set unpublished_at = coalesce(unpublished_at, $2), unpublish_reason = coalesce(unpublish_reason, 'released') where domain_id = $1 and purged_at is null returning id", [d.id, now]);
      if ((r.rowCount ?? 0) === 0) return;
      await enqueue(c, { kind: "card.purge", payload: {}, dedupeKey: `card.purge:release:${d.id}` });
      await enqueue(c, { kind: "cards.rebuild", payload: {}, dedupeKey: `cards.rebuild:${Math.floor(now.getTime() / 60_000)}` });
    },
  });
}
