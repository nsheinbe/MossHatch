import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { raiseAlert } from "../ops/alerts.ts";
import type { KmsTrailEvent } from "./kms/types.ts";

/**
 * Detection for the vault (PLAN 4.6 rows 2, 5 and 6; own targets): more than 5 web reveals in an hour, and 10 distinct
 * secrets revealed or read in 10 minutes, per user. Detection, not prevention: the limits are the preventive part.
 */
export const REVEAL_RATE_ALERT = { perHour: 5 };
export const DIVERSITY_ALERT = { distinct: 10, windowMs: 10 * 60_000 };
/** KMS-side alarms on the trail (per principal): Decrypt volume in 5 minutes and secret diversity in 10 minutes. */
export const DECRYPT_VOLUME_ALERT = { max: 200, windowMs: 5 * 60_000 };

export async function vaultAlarms(ctx: Pick<AppContext, "clock" | "services">, c: PoolClient, userId: string): Promise<{ revealRate: boolean; diversity: boolean }> {
  const now = ctx.clock.now();
  const hour = new Date(now.getTime() - 3_600_000), tenMin = new Date(now.getTime() - DIVERSITY_ALERT.windowMs);
  const r = (await c.query(
    `select count(*) filter (where action = 'secret.reveal.released' and at > $2)::int as reveals,
            count(distinct resource_id) filter (where action in ('secret.reveal.released','secret.read') and at > $3)::int as distinct_secrets
       from audit_log where chain_id = $1 and at > $2`, [userId, hour, tenMin])).rows[0];
  const revealRate = r.reveals > REVEAL_RATE_ALERT.perHour;
  const diversity = r.distinct_secrets >= DIVERSITY_ALERT.distinct;
  if (revealRate) await raiseAlert(ctx, c, { severity: "warn", kind: "vault.reveal_rate", subject: userId, detail: { reveals_last_hour: r.reveals } });
  if (diversity) await raiseAlert(ctx, c, { severity: "page", kind: "vault.secret_diversity", subject: userId, detail: { distinct_last_10m: r.distinct_secrets } });
  return { revealRate, diversity };
}

/** Trail alarms (CloudTrail in production, the fake's log here): Decrypt volume and secret diversity per principal. */
export async function trailAlarms(ctx: Pick<AppContext, "cron" | "clock" | "services">, events: KmsTrailEvent[]): Promise<{ volume: string[]; diversity: string[] }> {
  const now = ctx.clock.now().getTime();
  const byPrincipal = new Map<string, KmsTrailEvent[]>();
  for (const e of events) if (e.eventName === "Decrypt" && !e.errorCode) byPrincipal.set(e.principal, [...(byPrincipal.get(e.principal) ?? []), e]);
  const volume: string[] = [], diversity: string[] = [];
  for (const [p, evs] of byPrincipal) {
    const recent = evs.filter((e) => now - e.at.getTime() <= DECRYPT_VOLUME_ALERT.windowMs);
    if (recent.length > DECRYPT_VOLUME_ALERT.max) { volume.push(p); await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "kms.decrypt_volume", subject: p, detail: { count: recent.length } }); }
    const distinct = new Set(evs.filter((e) => now - e.at.getTime() <= DIVERSITY_ALERT.windowMs).map((e) => e.encryptionContext?.secret_id));
    if (distinct.size >= DIVERSITY_ALERT.distinct) { diversity.push(p); await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "kms.secret_diversity", subject: p, detail: { distinct: distinct.size } }); }
  }
  return { volume, diversity };
}
