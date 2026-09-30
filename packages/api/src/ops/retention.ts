import { tx } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { appendAudit, SYSTEM_CHAIN } from "../audit.ts";
import { raiseAlert } from "./alerts.ts";

/**
 * C-19 retention: rows are deleted once `retain_until` has passed, never while `legal_hold` is set. The clocks themselves
 * (RDP 15 months for transfer data, RAA term plus 2 years for consents, 180 days for transaction logs) are chosen by
 * the writer of each row when it sets `retain_until`; this job only enforces them. The schedule is still to be agreed
 * with the upstream and counsel (COMPLIANCE Q9), which is why no clock is hard-coded here except the webhook log below.
 *
 * Not covered: `audit_log` rows are append-only below the application (triggers fire even for the cron role), so an
 * expired sealed chain is dropped as a whole segment by an operator procedure (PLAN 4.3b), not by this job.
 */
export interface PurgeRule {
  table: "consents" | "notices" | "transfer_log" | "renewal_mandates";
  /** Extra condition beyond `retain_until < now and not legal_hold`. */
  extra?: string;
}
export const RETENTION_RULES: PurgeRule[] = [
  // A consent that is the evidence for a live auto-renew mandate stays while the mandate lives.
  { table: "consents", extra: "not exists (select 1 from renewal_mandates m where m.consent_id = t.id and m.revoked_at is null)" },
  { table: "notices" },
  { table: "transfer_log" },
  // A live mandate is never purged, whatever its retain_until says.
  { table: "renewal_mandates", extra: "t.revoked_at is not null" },
];
const BATCH = 2_000;
/**
 * The hold, read through the row's JSON so a table whose `legal_hold` column arrives in a later migration (transfer_log is
 * created in 0900, after this module's 0750) is still purged correctly: no column means no hold.
 */
const HOLD = "coalesce((to_jsonb(t)->>'legal_hold')::boolean, false)";

export interface PurgeExpiredResult { deleted: Record<PurgeRule["table"], number>; held: number }

/** `retention.expire`: delete expired, un-held rows in batches, then write one audit row with the counts (no ids). */
export async function purgeExpired(ctx: Pick<AppContext, "cron" | "clock" | "kms" | "services">, opts: { maxBatches?: number } = {}): Promise<PurgeExpiredResult> {
  const now = ctx.clock.now();
  const deleted = { consents: 0, notices: 0, transfer_log: 0, renewal_mandates: 0 };
  for (const rule of RETENTION_RULES) {
    const where = `t.retain_until < $1 and not ${HOLD} and ${rule.extra ?? "true"}`;
    for (let i = 0; i < (opts.maxBatches ?? 50); i++) {
      const r = await ctx.cron.query(`delete from ${rule.table} where id in (select t.id from ${rule.table} t where ${where} limit ${BATCH})`, [now]);
      deleted[rule.table] += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < BATCH) break;
    }
  }
  let held = 0;
  for (const rule of RETENTION_RULES) held += (await ctx.cron.query(`select count(*)::int as n from ${rule.table} t where t.retain_until < $1 and ${HOLD}`, [now])).rows[0].n as number;
  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  if (total) await tx(ctx.cron, (c) => appendAudit(ctx as AppContext, c, { chainId: SYSTEM_CHAIN, actorKind: "system", action: "retention.expired", detail: { ...deleted, held } }));
  return { deleted, held };
}

/**
 * `webhook_events` holds the raw provider payload (a Stripe object can carry a billing address, name and email). The
 * row is the dedupe record and is kept 180 days (C-19 transaction logs); the payload is only needed for replay and
 * debugging: it is nulled 30 days after a successful processing (Stripe's `GET /v1/events` also covers 30 days) and
 * after 90 days in any case, when an operator is told that events stayed unprocessed.
 */
export const WEBHOOK_PAYLOAD_PROCESSED_DAYS = 30;
export const WEBHOOK_PAYLOAD_MAX_DAYS = 90;
export const WEBHOOK_ROW_DAYS = 180;
const DAY = 86_400_000;

export interface WebhookRetentionResult { payloadsCleared: number; unprocessedCleared: number; rowsDeleted: number }

export async function purgeWebhookPayloads(ctx: Pick<AppContext, "cron" | "clock" | "services">): Promise<WebhookRetentionResult> {
  const now = ctx.clock.now().getTime();
  const processedBefore = new Date(now - WEBHOOK_PAYLOAD_PROCESSED_DAYS * DAY);
  const maxBefore = new Date(now - WEBHOOK_PAYLOAD_MAX_DAYS * DAY);
  const rowBefore = new Date(now - WEBHOOK_ROW_DAYS * DAY);
  const d = await ctx.cron.query("delete from webhook_events where received_at < $1", [rowBefore]);
  const a = await ctx.cron.query("update webhook_events set payload = null where payload is not null and processed_at is not null and received_at < $1", [processedBefore]);
  const b = await ctx.cron.query("update webhook_events set payload = null where payload is not null and processed_at is null and received_at < $1", [maxBefore]);
  if (b.rowCount) await raiseAlert(ctx, ctx.cron, { severity: "warn", kind: "webhook.unprocessed_expired", subject: "webhook_events", detail: { count: b.rowCount } });
  return { payloadsCleared: a.rowCount ?? 0, unprocessedCleared: b.rowCount ?? 0, rowsDeleted: d.rowCount ?? 0 };
}
