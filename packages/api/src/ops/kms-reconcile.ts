import type { AppContext } from "../ports.ts";
import { raiseAlert } from "./alerts.ts";

export interface KmsDecryptEvent {
  eventId: string;
  at: Date;
  keyId: string;
  /** `decrypt_nonce` from the request's encryption context; null when the caller sent none. */
  nonce: string | null;
}

/**
 * CloudTrail Decrypt events. Correlation contract for the vault and PII code: every Decrypt call sends an encryption
 * context entry `decrypt_nonce=<uuid>` and the audit row for that read carries the same value in `detail.decrypt_nonce`.
 * CloudTrail records the encryption context, so a Decrypt with no matching audit row is a read that bypassed the audit log.
 * The real adapter (CloudTrail LookupEvents or the Athena/S3 log copy) is not built or exercised here.
 */
export interface CloudTrailPort {
  listDecryptEvents(from: Date, to: Date): Promise<KmsDecryptEvent[]>;
}

export class FakeCloudTrail implements CloudTrailPort {
  events: KmsDecryptEvent[] = [];
  async listDecryptEvents(from: Date, to: Date) { return this.events.filter((e) => e.at >= from && e.at < to); }
}

const CURSOR = "audit.kms_reconcile.cursor";
/** CloudTrail delivery lags; events newer than this are left for the next run. */
export const CLOUDTRAIL_LAG_MS = 15 * 60_000;
const PAD_MS = 5 * 60_000;

export interface KmsReconcileResult { events: number; unaudited: string[]; auditWithoutEvent: number }

export async function kmsReconcile(ctx: Pick<AppContext, "cron" | "clock" | "services">, ct: CloudTrailPort): Promise<KmsReconcileResult> {
  const to = new Date(ctx.clock.now().getTime() - CLOUDTRAIL_LAG_MS);
  const cur = (await ctx.cron.query("select value from flags where name = $1", [CURSOR])).rows[0]?.value as string | undefined;
  const from = cur ? new Date(cur) : new Date(to.getTime() - 24 * 3_600_000);
  if (from >= to) return { events: 0, unaudited: [], auditWithoutEvent: 0 };

  const events = await ct.listDecryptEvents(from, to);
  const nonces = (await ctx.cron.query(
    "select distinct detail->>'decrypt_nonce' as n from audit_log where detail ? 'decrypt_nonce' and at >= $1 and at < $2",
    [new Date(from.getTime() - PAD_MS), new Date(ctx.clock.now().getTime() + PAD_MS)],
  )).rows.map((r) => r.n as string);
  const audited = new Set(nonces);
  const unaudited = events.filter((e) => !e.nonce || !audited.has(e.nonce)).map((e) => e.eventId);

  const padded = await ct.listDecryptEvents(new Date(from.getTime() - PAD_MS), new Date(to.getTime() + PAD_MS));
  const seen = new Set(padded.map((e) => e.nonce).filter(Boolean) as string[]);
  const auditRows = (await ctx.cron.query(
    "select distinct detail->>'decrypt_nonce' as n from audit_log where detail ? 'decrypt_nonce' and at >= $1 and at < $2", [from, to])).rows.map((r) => r.n as string);
  const auditWithoutEvent = auditRows.filter((n) => !seen.has(n)).length;

  if (unaudited.length) await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "kms.decrypt_unaudited", subject: "cloudtrail", detail: { count: unaudited.length, event_ids: unaudited.slice(0, 10) } });
  if (auditWithoutEvent) await raiseAlert(ctx, ctx.cron, { severity: "warn", kind: "kms.audit_without_event", subject: "cloudtrail", detail: { count: auditWithoutEvent } });
  await ctx.cron.query(
    "insert into flags (name, value, updated_by) values ($1, to_jsonb($2::text), 'kms_reconcile') on conflict (name) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()",
    [CURSOR, to.toISOString()],
  );
  return { events: events.length, unaudited, auditWithoutEvent };
}
