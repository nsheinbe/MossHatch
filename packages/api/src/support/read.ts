import { tx } from "@mosshatch/db";
import { appendAudit, SYSTEM_CHAIN } from "../audit.ts";
import { STAFF_ID_RE, SupportError, UUID_RE, type SupportActor, type SupportCtx } from "./types.ts";

/*
 * Read-only support views. METADATA ONLY: opaque ids, states, timestamps, counts. No contact field, no notification
 * address, no domain name, no credential id or key, no secret, ciphertext or payload. Every read writes an audit row
 * with actor_kind 'support' into the customer's own chain, so the customer's audit trail shows it.
 */

const need = (a: SupportActor, userId?: string) => {
  if (!STAFF_ID_RE.test(a?.staffId ?? "")) throw new SupportError("bad_actor");
  if (userId !== undefined && !UUID_RE.test(userId)) throw new SupportError("bad_id");
};

/** Find the opaque user id for an address the customer gave us. Returns the id and status only; the address is never stored or logged. */
export async function lookupUserByEmail(ctx: SupportCtx, actor: SupportActor, address: string): Promise<{ userId: string; status: string } | null> {
  need(actor);
  return tx(ctx.cron, async (c) => {
    const r = (await c.query("select id, status from users where email = $1 and status in ('active','closing','pending') order by created_at desc limit 1", [address.trim()])).rows[0];
    await appendAudit(ctx, c, { chainId: SYSTEM_CHAIN, actorKind: "support", actorId: actor.staffId, action: "support.lookup", resourceKind: "user", resourceId: r?.id, detail: { found: !!r } });
    if (r) await appendAudit(ctx, c, { chainId: r.id, actorKind: "support", actorId: actor.staffId, action: "support.lookup", resourceKind: "user", resourceId: r.id, detail: {} });
    return r ? { userId: r.id as string, status: r.status as string } : null;
  });
}

export interface AccountSummary {
  userId: string;
  status: string;
  createdAt: string;
  emailVerified: boolean;
  frozen: boolean;
  riskState: string;
  hardenedMode: boolean;
  counts: { passkeys: number; notificationAddresses: number; domains: number; orders: number; openOrders: number; activeBindings: number };
  recovery: { id: string; status: string; path: string; createdAt: string; coolingOffUntil: string | null; holdUntil: string | null } | null;
}

export async function getAccountSummary(ctx: SupportCtx, actor: SupportActor, userId: string): Promise<AccountSummary | null> {
  need(actor, userId);
  return tx(ctx.cron, async (c) => {
    const u = (await c.query(
      "select id, status, created_at, email_verified_at is not null as verified, frozen_at is not null as frozen, risk_state, hardened_mode from users where id = $1", [userId])).rows[0];
    if (!u) return null;
    const n = (await c.query(
      `select (select count(*) from passkeys where user_id = $1 and revoked_at is null)::int as passkeys,
              (select count(*) from notification_addresses where user_id = $1 and removed_at is null)::int as addrs,
              (select count(*) from domains where user_id = $1 and released_at is null)::int as domains,
              (select count(*) from orders where user_id = $1)::int as orders,
              (select count(*) from orders where user_id = $1 and state in ('checkout_open','authorized','registering','outcome_unknown','registered','capturing','capture_failed','canceling','registrar_unavailable','paid_before_registration','refund_pending'))::int as open_orders,
              (select count(*) from bindings where user_id = $1 and revoked_at is null and expires_at > $2)::int as bindings`, [userId, ctx.clock.now()])).rows[0];
    const rec = (await c.query("select id, status, path, created_at, cooling_off_until, hold_until from recovery_requests where user_id = $1 order by created_at desc limit 1", [userId])).rows[0];
    await appendAudit(ctx, c, { chainId: userId, actorKind: "support", actorId: actor.staffId, action: "support.view_account", resourceKind: "user", resourceId: userId, detail: {} });
    return {
      userId: u.id, status: u.status, createdAt: new Date(u.created_at).toISOString(), emailVerified: u.verified, frozen: u.frozen, riskState: u.risk_state, hardenedMode: u.hardened_mode,
      counts: { passkeys: n.passkeys, notificationAddresses: n.addrs, domains: n.domains, orders: n.orders, openOrders: n.open_orders, activeBindings: n.bindings },
      recovery: rec ? { id: rec.id, status: rec.status, path: rec.path, createdAt: new Date(rec.created_at).toISOString(), coolingOffUntil: rec.cooling_off_until ? new Date(rec.cooling_off_until).toISOString() : null, holdUntil: rec.hold_until ? new Date(rec.hold_until).toISOString() : null } : null,
    };
  });
}

export interface OrderMeta { id: string; kind: string; state: string; years: number; totalMinor: string; createdAt: string; updatedAt: string }
/** Order states and timestamps. The domain name is not returned: the order id is enough to find it in the order tooling. */
export async function listAccountOrders(ctx: SupportCtx, actor: SupportActor, userId: string, limit = 50): Promise<OrderMeta[]> {
  need(actor, userId);
  return tx(ctx.cron, async (c) => {
    const rows = (await c.query("select id, kind, state, years, total_minor, created_at, updated_at from orders where user_id = $1 order by created_at desc limit $2", [userId, Math.min(Math.max(limit, 1), 100)])).rows;
    await appendAudit(ctx, c, { chainId: userId, actorKind: "support", actorId: actor.staffId, action: "support.view_orders", resourceKind: "user", resourceId: userId, detail: { count: rows.length } });
    return rows.map((r) => ({ id: r.id, kind: r.kind, state: r.state, years: r.years, totalMinor: String(BigInt(r.total_minor)), createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString() }));
  });
}

export interface DomainMeta { id: string; state: string; registeredAt: string | null; expiresAt: string | null }
/** Domain ids and states only: no name, no nameservers, no contact or lock detail. */
export async function listAccountDomainStates(ctx: SupportCtx, actor: SupportActor, userId: string, limit = 100): Promise<DomainMeta[]> {
  need(actor, userId);
  return tx(ctx.cron, async (c) => {
    const rows = (await c.query("select id, state, registered_at, expires_at from domains where user_id = $1 and released_at is null order by created_at desc limit $2", [userId, Math.min(Math.max(limit, 1), 200)])).rows;
    await appendAudit(ctx, c, { chainId: userId, actorKind: "support", actorId: actor.staffId, action: "support.view_domains", resourceKind: "user", resourceId: userId, detail: { count: rows.length } });
    return rows.map((r) => ({ id: r.id, state: r.state, registeredAt: r.registered_at ? new Date(r.registered_at).toISOString() : null, expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null }));
  });
}
