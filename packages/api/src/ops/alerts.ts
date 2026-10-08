import type { Pool, PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { optSvc } from "./services.ts";

export type Severity = "info" | "warn" | "page";
export interface AlertInput {
  severity: Severity;
  kind: string;
  /** Opaque subject (a job kind, a chain id, a domain the operator owns). At most one open alert per (kind, subject). */
  subject?: string;
  /** Ids, counts and enumerated codes only. Never values, addresses or tokens. */
  detail?: Record<string, unknown>;
  /** Email the operator although this is not a page: a condition a person must act on that must not engage auto-safe. */
  email?: boolean;
}
type Q = Pick<Pool | PoolClient, "query">;

const SECRETISH = /secret|token|password|authcode|auth_code|key/i;
function scrub(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail ?? {})) {
    if (SECRETISH.test(k)) continue;
    out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  return out;
}

/**
 * Raise an alert unless one with the same kind and subject is already open. A `page` also goes to the notifier
 * (phone push plus email, wired in production); a notifier failure never hides the row.
 */
export async function raiseAlert(ctx: Pick<AppContext, "services">, q: Q, a: AlertInput): Promise<{ id: string | null; created: boolean }> {
  const r = await q.query(
    `insert into alerts (severity, kind, subject, detail)
     select $1::text, $2::text, $3::text, $4::jsonb where not exists (select 1 from alerts where kind = $2::text and subject is not distinct from $3::text and state = 'open')
     returning id`,
    [a.severity, a.kind, a.subject ?? null, scrub(a.detail)],
  );
  const id = (r.rows[0]?.id as string | undefined) ?? null;
  if (id && (a.severity === "page" || a.email)) {
    try { await optSvc(ctx, "alertNotifier")?.notify({ id, severity: a.severity, kind: a.kind, subject: a.subject ?? null, email: a.email }); } catch { /* the row is the record */ }
  }
  return { id, created: id !== null };
}

/** Close open alerts for a kind and subject (the condition cleared). */
export async function closeAlerts(q: Q, kind: string, subject?: string): Promise<number> {
  const r = await q.query("update alerts set state = 'closed' where kind = $1 and subject is not distinct from $2::text and state = 'open'", [kind, subject ?? null]);
  return r.rowCount ?? 0;
}

/**
 * Auto-safe mode (PLAN Operations): an S1 page nobody acknowledged within `minutes` sets `registrar_writes_paused`.
 * It is a database row, not an environment variable, because deploys may be unavailable. Clearing it is an operator SQL statement.
 */
export async function autoSafeMode(ctx: Pick<AppContext, "cron" | "clock" | "services">, minutes = 30): Promise<{ engaged: boolean }> {
  const cutoff = new Date(ctx.clock.now().getTime() - minutes * 60_000);
  const stale = await ctx.cron.query("select count(*)::int as n from alerts where severity = 'page' and state = 'open' and acked_at is null and raised_at <= $1 and kind <> 'auto_safe.engaged'", [cutoff]);
  if (!stale.rows[0].n) return { engaged: false };
  const set = await ctx.cron.query(
    "update flags set value = 'true', updated_by = 'auto-safe', updated_at = $1 where name = 'registrar_writes_paused' and value <> 'true'::jsonb returning name",
    [ctx.clock.now()],
  );
  if (set.rowCount) await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "auto_safe.engaged", subject: "registrar_writes_paused", detail: { unacked_pages: stale.rows[0].n, minutes } });
  return { engaged: (set.rowCount ?? 0) > 0 };
}

/** Raise an alert only if no alert with this kind and subject exists in any state: one alert per condition, even after it is closed. */
export async function raiseAlertOnce(ctx: Pick<AppContext, "services">, q: Q, a: AlertInput): Promise<{ id: string | null; created: boolean }> {
  const seen = await q.query("select 1 from alerts where kind = $1 and subject is not distinct from $2::text limit 1", [a.kind, a.subject ?? null]);
  if (seen.rowCount) return { id: null, created: false };
  return raiseAlert(ctx, q, a);
}
