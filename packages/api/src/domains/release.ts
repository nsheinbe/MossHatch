import { tx, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { appendAudit } from "../audit.ts";
import { sendMail } from "../email.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { buildMail } from "../mail/templates.ts";
import { customerAddresses } from "../orders/support.ts";
import { DAY_MS, RELEASE_HOLD_MS, loadDomain, tableExists, type DomainRow, type Q } from "./common.ts";

/**
 * Domain release (ST-94, ST-95, ST-96, C-53).
 *
 * A name leaves an account for one of six causes. Each one sets `released_at` and `release_reason` on the domain row and opens a
 * `domain_releases` row. What follows is split in two:
 *   - at once: the domain's agent and CLI bindings are revoked, the auto-renew mandate is cancelled, open renewal work is dropped, the card is unpublished
 *     and connections end. The former owner keeps reading and exporting the record for the hold (30 days).
 *   - after the hold: secret ciphertext and wrapped keys are destroyed (PLAN 4.4: `secret_versions` are destroyed 30 days after a release).
 *
 * A name that can still be restored is not released: while the registry shows it in the auto-renew grace or in redemption it stays in the
 * account as a sleeping domain. Registering the same name again inserts a NEW domain row, so nothing keyed on the old `domain_id`
 * (bindings, secrets, cards, connections) can see it, whoever registers it, the former owner included.
 *
 * Tables the Nest and connections modules own (cards, secrets, secret_versions, connections) are used when they exist, with the column names
 * of PLAN 4.4; others plug in through `registerReleaseHook`.
 */
export type ReleaseCause = "lapsed" | "transferred_out" | "unpaid" | "refunded" | "account_closed" | "deleted";
export const RELEASE_CAUSES: readonly ReleaseCause[] = ["lapsed", "transferred_out", "unpaid", "refunded", "account_closed", "deleted"];

export interface ReleaseHook {
  name: string;
  /** Runs inside the release transaction with the cron role. Revoke, cancel, unpublish. */
  immediate?(ctx: AppContext, c: PoolClient, d: DomainRow): Promise<void>;
  /** Runs once the hold has passed. Destroy. */
  afterHold?(ctx: AppContext, c: PoolClient, d: DomainRow): Promise<void>;
}
const hooks = new Map<string, ReleaseHook>();
export function registerReleaseHook(h: ReleaseHook): void { hooks.set(h.name, h); }
export function clearReleaseHooks(): void { hooks.clear(); }

export type ReleaseResult = { released: true; holdUntil: Date } | { released: false; reason: "restorable" | "not_found" | "already_released" | "bad_cause" };

/** Registry timeline from `tld_policy` (OpenSRS defaults: 40 days grace, 30 days redemption). */
export async function restorableUntil(c: Q, d: Pick<DomainRow, "tld" | "expiresAt" | "registrar">): Promise<Date | null> {
  if (!d.expiresAt) return null;
  const p = (await c.query("select expiry_grace_days, redemption_days from tld_policy where registrar = $1 and tld = $2", [d.registrar, d.tld])).rows[0];
  const grace = Number(p?.expiry_grace_days ?? 40), redemption = Number(p?.redemption_days ?? 30);
  return new Date(d.expiresAt.getTime() + (grace + redemption) * DAY_MS);
}

/** Revoke, cancel and unpublish. Idempotent; runs in the caller's cron transaction. */
async function immediateSteps(ctx: AppContext, c: PoolClient, d: DomainRow, now: Date): Promise<{ bindings: number; mandates: number }> {
  const b = await c.query(
    "update bindings set revoked_at = $3 where user_id = $1 and revoked_at is null and position($2 in scopes::text) > 0",
    [d.userId, d.id, now]);
  const m = await c.query("update renewal_mandates set revoked_at = $2, revoked_by = 'release' where domain_id = $1 and revoked_at is null", [d.id, now]);
  await c.query("update renewal_terms set state = 'skipped', held_reason = 'released' where domain_id = $1 and state in ('scheduled','held','charging','payment_failed')", [d.id]);
  // The register order that held this name no longer does: the name can be registered again, by anyone (ST-94).
  await c.query("update orders set superseded_at = coalesce(superseded_at, $2) where domain_id = $1 and kind = 'register'", [d.id, now]);
  // A renewal order that never charged is dropped; one that charged keeps running to its refund or its renewal.
  await c.query("update orders set state = 'voided', void_reason = 'customer_cancel', next_check_at = null where domain_id = $1 and kind = 'renew' and state = 'draft'", [d.id]);
  if (await tableExists(c, "cards")) await c.query("update cards set unpublished_at = coalesce(unpublished_at, $2) where domain_id = $1", [d.id, now]);
  if (await tableExists(c, "connections")) await c.query("update connections set ended_at = coalesce(ended_at, $2), status = 'ended' where domain_id = $1", [d.id, now]);
  for (const h of hooks.values()) if (h.immediate) await h.immediate(ctx, c, d);
  return { bindings: b.rowCount ?? 0, mandates: m.rowCount ?? 0 };
}

async function destroySteps(ctx: AppContext, c: PoolClient, d: DomainRow, now: Date): Promise<void> {
  if (await tableExists(c, "secret_versions") && await tableExists(c, "secrets")) {
    await c.query("update secret_versions set ciphertext = null, wrapped_dek = null, destroyed_at = coalesce(destroyed_at, $2) where secret_id in (select id from secrets where domain_id = $1)", [d.id, now]);
  }
  if (await tableExists(c, "connection_credentials") && await tableExists(c, "connections")) {
    await c.query("update connection_credentials set revoked_at = coalesce(revoked_at, $2) where connection_id in (select id from connections where domain_id = $1)", [d.id, now]);
  }
  for (const h of hooks.values()) if (h.afterHold) await h.afterHold(ctx, c, d);
}

async function mailReleased(ctx: AppContext, c: PoolClient, d: DomainRow, cause: ReleaseCause, holdUntil: Date): Promise<void> {
  const to = await customerAddresses(c, d.userId);
  if (to.length === 0) return;
  const msg = buildMail("domain_released", { fqdn: d.fqdn, cause, holdUntil: holdUntil.toISOString() }, { to, dedupeKey: `domain.released:${d.id}`, userId: d.userId, origin: ctx.config.origin });
  await sendMail(c, ctx.email, msg);
}

/**
 * Release a domain. `lapsed` is refused while the name is restorable. A domain whose `released_at` was set by another module (the
 * capture-failed ladder sets it for `unpaid`) is completed here: the row exists, the steps have not run.
 */
export async function releaseDomain(ctx: AppContext, domainId: string, cause: ReleaseCause, opts: { client?: PoolClient } = {}): Promise<ReleaseResult> {
  if (!RELEASE_CAUSES.includes(cause)) return { released: false, reason: "bad_cause" };
  const run = async (c: PoolClient): Promise<ReleaseResult> => {
    const raw = (await c.query("select * from domains where id = $1 for update", [domainId])).rows[0];
    if (!raw) return { released: false, reason: "not_found" };
    const d = (await loadDomain(c, domainId))!;
    const now = ctx.clock.now();
    if (d.releasedAt) {
      const has = (await c.query("select 1 from domain_releases where domain_id = $1", [d.id])).rowCount;
      if (has) return { released: false, reason: "already_released" };
      return completeRelease(ctx, c, d, (RELEASE_CAUSES as readonly string[]).includes(d.releaseReason ?? "") ? (d.releaseReason as ReleaseCause) : cause, d.releasedAt);
    }
    if (cause === "lapsed") {
      const until = await restorableUntil(c, d);
      if (d.state !== "pending" && (!until || now < until)) return { released: false, reason: "restorable" };
    }
    const hold = new Date(now.getTime() + RELEASE_HOLD_MS);
    const upd = await c.query("update domains set released_at = $2, release_reason = $3, release_hold_until = $4, auto_renew = false where id = $1 and released_at is null", [d.id, now, cause, hold]);
    if (upd.rowCount !== 1) return { released: false, reason: "already_released" };
    return completeRelease(ctx, c, { ...d, releasedAt: now }, cause, now);
  };
  return opts.client ? run(opts.client) : tx(ctx.cron, run);
}

async function completeRelease(ctx: AppContext, c: PoolClient, d: DomainRow, cause: ReleaseCause, releasedAt: Date): Promise<ReleaseResult> {
  const now = ctx.clock.now();
  const hold = new Date(releasedAt.getTime() + RELEASE_HOLD_MS);
  await c.query("update domains set release_hold_until = coalesce(release_hold_until, $2), auto_renew = false where id = $1", [d.id, hold]);
  const ins = await c.query(
    "insert into domain_releases (domain_id, user_id, cause, released_at, hold_until) values ($1,$2,$3,$4,$5) on conflict (domain_id) do nothing returning id",
    [d.id, d.userId, cause, releasedAt, hold]);
  if (ins.rowCount !== 1) return { released: false, reason: "already_released" };
  const steps = await immediateSteps(ctx, c, d, now);
  await c.query("update domain_releases set bindings_revoked = $2, mandates_revoked = $3, unpublished_at = $4, steps_done_at = $4 where domain_id = $1", [d.id, steps.bindings, steps.mandates, now]);
  await appendAudit(ctx, c, { chainId: d.userId, actorKind: "system", action: "domain.released", resourceKind: "domain", resourceId: d.id, detail: { cause, bindings_revoked: steps.bindings, mandates_revoked: steps.mandates } });
  await mailReleased(ctx, c, d, cause, hold);
  return { released: true, holdUntil: hold };
}

/**
 * `domain.release` job body: finish releases another module started (released_at set, no steps yet) and destroy what the hold protected
 * once it has passed. Returns counts for the tests.
 */
export async function runReleaseSweep(ctx: AppContext): Promise<{ completed: number; destroyed: number }> {
  const now = ctx.clock.now();
  const pending = (await ctx.cron.query(
    "select d.id, d.release_reason from domains d where d.released_at is not null and not exists (select 1 from domain_releases r where r.domain_id = d.id)")).rows;
  let completed = 0;
  for (const p of pending) {
    const cause = (RELEASE_CAUSES as readonly string[]).includes(p.release_reason) ? (p.release_reason as ReleaseCause) : "deleted";
    const r = await releaseDomain(ctx, p.id, cause);
    if (r.released) completed++;
  }
  const due = (await ctx.cron.query("select domain_id from domain_releases where destroyed_at is null and hold_until <= $1", [now])).rows;
  let destroyed = 0;
  for (const row of due) {
    await tx(ctx.cron, async (c) => {
      const d = await loadDomain(c, row.domain_id);
      if (!d) return;
      const claimed = await c.query("update domain_releases set destroyed_at = $2 where domain_id = $1 and destroyed_at is null returning id", [row.domain_id, now]);
      if (claimed.rowCount !== 1) return;
      await destroySteps(ctx, c, d, now);
      await appendAudit(ctx, c, { chainId: d.userId, actorKind: "system", action: "domain.destroyed", resourceKind: "domain", resourceId: d.id, detail: {} });
      destroyed++;
    });
  }
  // A release older than a day whose immediate steps never finished is a bug worth a look.
  const stuck = await ctx.cron.query("select domain_id from domain_releases where steps_done_at is null and created_at < $1", [new Date(now.getTime() - DAY_MS)]);
  for (const s of stuck.rows) await raiseAlert(ctx, ctx.cron, { severity: "warn", kind: "release_steps_incomplete", subject: s.domain_id });
  return { completed, destroyed };
}

/** Whether the former owner may still read and export a released record. */
export const exportOpen = (d: Pick<DomainRow, "releasedAt" | "releaseHoldUntil">, now: Date): boolean => !d.releasedAt || (!!d.releaseHoldUntil && now < d.releaseHoldUntil);
