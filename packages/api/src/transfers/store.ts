import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { sendMail } from "../email.ts";
import { buildMail, type MailKind, type MailVars } from "../mail/templates.ts";
import { customerAddresses } from "../orders/support.ts";
import { LOG_RETENTION_MS, type TransferState } from "./policy.ts";

type Q = Pick<PoolClient, "query">;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TransferRow {
  id: string; userId: string; orderId: string; fqdn: string; tld: string; years: number; state: TransferState;
  hasAuthCode: boolean; authCodeWipedAt: Date | null;
  confirmExpiresAt: Date | null; confirmAttempts: number; confirmedAt: Date | null;
  eligibility: Record<string, unknown>; dnssecChecked: boolean;
  registrarOrderId: string | null; sentAt: Date | null; upstreamStatus: string | null; ownerDeadlineAt: Date | null; registryDeadlineAt: Date | null;
  earlyCaptureAt: Date | null; completedAt: Date | null; endedAt: Date | null; failure: string | null; nackReason: string | null;
  domainId: string | null; nextCheckAt: Date | null; checkCount: number; lateWatchUntil: Date | null; createdAt: Date;
}
const d = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string));
export function rowToTransfer(r: Record<string, any>): TransferRow {
  return {
    id: r.id, userId: r.user_id, orderId: r.order_id, fqdn: r.fqdn_ascii, tld: r.tld, years: r.years, state: r.state,
    hasAuthCode: r.auth_code_enc !== null && r.auth_code_enc !== undefined, authCodeWipedAt: d(r.auth_code_wiped_at),
    confirmExpiresAt: d(r.confirm_expires_at), confirmAttempts: r.confirm_attempts, confirmedAt: d(r.confirmed_at),
    eligibility: r.eligibility ?? {}, dnssecChecked: r.dnssec_checked,
    registrarOrderId: r.registrar_order_id, sentAt: d(r.sent_at), upstreamStatus: r.upstream_status, ownerDeadlineAt: d(r.owner_deadline_at), registryDeadlineAt: d(r.registry_deadline_at),
    earlyCaptureAt: d(r.early_capture_at), completedAt: d(r.completed_at), endedAt: d(r.ended_at), failure: r.failure, nackReason: r.nack_reason,
    domainId: r.domain_id, nextCheckAt: d(r.next_check_at), checkCount: r.check_count, lateWatchUntil: d(r.late_watch_until), createdAt: new Date(r.created_at),
  };
}
export async function loadTransfer(q: Q, id: string): Promise<TransferRow | null> {
  if (!UUID_RE.test(id)) return null;
  const r = (await q.query("select * from transfers_in where id = $1", [id])).rows[0];
  return r ? rowToTransfer(r) : null;
}
export async function transferOfOrder(q: Q, orderId: string): Promise<TransferRow | null> {
  const r = (await q.query("select * from transfers_in where order_id = $1", [orderId])).rows[0];
  return r ? rowToTransfer(r) : null;
}

/** C-09: who, when and how, as ids and codes. Runs inside the caller's transaction. */
export async function logTransfer(ctx: Pick<AppContext, "clock">, c: Q, e: { userId: string; direction: "in" | "out"; event: string; actor: "user" | "system" | "operator"; transferId?: string | null; domainId?: string | null; detail?: Record<string, unknown> }): Promise<void> {
  const at = ctx.clock.now();
  await c.query(
    "insert into transfer_log (user_id, domain_id, transfer_in_id, direction, event, actor_kind, detail, at, retain_until) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [e.userId, e.domainId ?? null, e.transferId ?? null, e.direction, e.event, e.actor, e.detail ?? {}, at, new Date(at.getTime() + LOG_RETENTION_MS)]);
}

/** Customer mail from a template, to every verified notification address, deduplicated by key. Inside the caller's transaction. */
export async function mailUser<K extends MailKind>(ctx: AppContext, c: PoolClient, userId: string, kind: K, vars: MailVars<K>, dedupeKey: string): Promise<void> {
  const to = await customerAddresses(c, userId);
  if (to.length === 0) return;
  await sendMail(c, ctx.email, buildMail(kind, vars, { to, dedupeKey, userId, origin: ctx.config.origin }));
}
