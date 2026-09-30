import type { Pool, PoolClient } from "@mosshatch/db";
import type { RegistrarPort } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { ordersSvc } from "../orders/support.ts";
import type { OrdersServices } from "../orders/types.ts";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Charge day is E - 10 days. */
export const CHARGE_DAYS_BEFORE_EXPIRY = 10;
/** A sync error older than this makes the state "attention" (PLAN creature state 4; own target). */
export const SYNC_ERROR_ATTENTION_MS = 15 * 60_000;
/** `synced_at` older than this and the state is shown as unconfirmed (own target). */
export const STALE_SYNC_MS = 15 * 60_000;
/** How long an export works after a release, and how long destruction waits (`secret_versions` are destroyed 30 days after release). */
export const RELEASE_HOLD_MS = 30 * DAY_MS;

export type Q = Pick<Pool | PoolClient, "query">;

export interface DomainRow {
  id: string; userId: string; fqdn: string; tld: string; registrar: string; registrarRef: string | null;
  state: string; registeredAt: Date | null; registryCreatedAt: Date | null; expiresAt: Date | null;
  locked: boolean; privacyStatus: string; autoRenew: boolean; nameservers: string[]; registryStatuses: string[]; dsPresent: boolean;
  dnsHostedHere: boolean; disputeLockState: string | null; disputeLockedAt: Date | null; livemode: boolean;
  releasedAt: Date | null; releaseReason: string | null; releaseHoldUntil: Date | null;
  syncedAt: Date | null; syncError: string | null; syncErrorSince: Date | null;
  transferAway: boolean; ownerEmailHash: string | null; letExpire: boolean; privacyService: boolean; createdAt: Date;
}

const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string | Date));
export function rowToDomain(r: Record<string, any>): DomainRow {
  return {
    id: r.id, userId: r.user_id, fqdn: r.fqdn_ascii, tld: r.tld, registrar: r.registrar, registrarRef: r.registrar_ref, state: r.state,
    registeredAt: date(r.registered_at), registryCreatedAt: date(r.registry_created_at), expiresAt: date(r.expires_at), locked: r.locked,
    privacyStatus: r.privacy_status, autoRenew: r.auto_renew, nameservers: r.nameservers ?? [], registryStatuses: r.registry_statuses ?? [], dsPresent: r.ds_present,
    dnsHostedHere: r.dns_hosted_here, disputeLockState: r.dispute_lock_state, disputeLockedAt: date(r.dispute_locked_at), livemode: r.livemode,
    releasedAt: date(r.released_at), releaseReason: r.release_reason, releaseHoldUntil: date(r.release_hold_until),
    syncedAt: date(r.synced_at), syncError: r.sync_error, syncErrorSince: date(r.sync_error_since),
    transferAway: !!r.transfer_away, ownerEmailHash: r.owner_email_hash, letExpire: !!r.let_expire, privacyService: !!r.privacy_service, createdAt: new Date(r.created_at),
  };
}

export async function loadDomain(q: Q, id: string): Promise<DomainRow | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await q.query("select * from domains where id = $1", [id]);
  return r.rows[0] ? rowToDomain(r.rows[0]) : null;
}

/** The registrar, Stripe and adapter id, taken from the orders services so the mode guard applies to renewals too. */
export function svcOf(ctx: AppContext): OrdersServices { return ordersSvc(ctx); }
export function registrarOf(ctx: AppContext): RegistrarPort { return ordersSvc(ctx).registrar; }

export interface DomainsServices {
  /** Probe of the registrar's end-user interface (ST-113). Absent: the posture job raises an alert instead of guessing. */
  endUserProbe?: EndUserProbe;
  /** The Horizon test profile username the probe logs in with. */
  probeProfile?: string;
}
/** What the probe saw when a test profile tried the registrar's own end-user login. Only the verdict comes back; never a page or a cookie. */
export interface EndUserProbe {
  probeLogin(profileUsername: string): Promise<{ verdict: "redirects" | "reachable" | "unreachable" }>;
}
export function domainsServices(ctx: Pick<AppContext, "services">): DomainsServices {
  return ((ctx.services as { domains?: DomainsServices }).domains ?? {}) as DomainsServices;
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const yearOf = (d: Date) => d.getUTCFullYear();
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Flag values are jsonb; a missing or wrongly typed one falls back. */
export async function flagNumber(q: Q, name: string, fallback: bigint): Promise<bigint> {
  const v = (await q.query("select value from flags where name = $1", [name])).rows[0]?.value;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? BigInt(Math.trunc(v)) : fallback;
}
export async function flagTrue(q: Q, name: string): Promise<boolean> {
  return (await q.query("select value from flags where name = $1", [name])).rows[0]?.value === true;
}

/** True when a table exists. Later modules (cards, secrets, connections, DNS) create their own tables; release and refund rules use them when present. */
export async function tableExists(q: Q, name: string): Promise<boolean> {
  return (await q.query("select to_regclass($1) is not null as e", [`public.${name}`])).rows[0].e as boolean;
}
