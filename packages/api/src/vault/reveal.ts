import { z } from "zod";
import { withUser } from "@mosshatch/db";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { HttpError, json } from "../http/router.ts";
import { appendAudit } from "../audit.ts";
import { hit, type Limit } from "../ratelimit.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { notifyUser } from "../auth/mail.ts";
import { markExecuted, requireAction } from "../stepup/gate.ts";
import { registerActionSpec, type ActionSpec } from "../stepup/specs.ts";
import { NO_STORE, vaultFailure, vaultOf } from "./context.ts";
import { loadCurrent, openRow } from "./secrets.ts";
import { VAULT_MAIL } from "./mail.ts";
import { vaultAlarms } from "./alarms.ts";

/**
 * Web reveal (PLAN 4.5, D-019 path 1). One `secret.reveal` step-up reveals one secret once:
 *   prepare (`/actions/prepare`, target = secret id) -> commit (passkey assertion) -> `POST /secrets/{id}/reveal` with
 *   the action id. The gate admits only a committed `secret.reveal` action of this user and session.
 * Then: T1 (vault role) marks the action executed, inserts `secret.reveal.authorized` and the notification, and commits;
 * if T1 fails nothing is decrypted. KMS runs outside any transaction (3-second deadline, no retry). T2 records
 * `released` or `failed`; a T2 failure pages instead of blocking. The value is returned in this one response, with
 * `Cache-Control: no-store, private`. Hiding again is the client's job; the server never serves it again without a new
 * activation, because the action is single use.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A committed reveal must be used within this window (shorter than the 120-second action lifetime). */
export const REVEAL_WINDOW_MS = 60_000;

/** Own targets (PLAN 4.6 row 5). Agent and CLI reads have their own buckets keyed by token id and never count here. */
export const REVEAL_LIMITS = {
  userMinute: { bucket: "vault.reveal.user.m", max: 5, windowSeconds: 60 } satisfies Limit,
  userHour: { bucket: "vault.reveal.user.h", max: 30, windowSeconds: 3600 } satisfies Limit,
  sessionMinute: { bucket: "vault.reveal.session.m", max: 5, windowSeconds: 60 } satisfies Limit,
  secretMinute: { bucket: "vault.reveal.secret.m", max: 3, windowSeconds: 60 } satisfies Limit,
};

// The step-up spec ----------------------------------------------------------------------------------------------

export const secretRevealSpec: ActionSpec<Record<string, never>> = {
  type: "secret.reveal", held: true,
  userInput: z.strictObject({}) as unknown as z.ZodType<Record<string, never>>,
  /** Bound parameters from server state: the secret, its env and the version the person will see. */
  async derive(_ctx, c, userId, targetId) {
    if (!UUID.test(targetId)) throw new HttpError(404, "not_found");
    const r = (await c.query(
      `select s.id, s.env, s.name, s.current_version, s.domain_id from secrets s join domains d on d.id = s.domain_id
        where s.id = $1 and s.user_id = $2 and s.deleted_at is null and s.current_version is not null and d.released_at is null`, [targetId, userId])).rows[0];
    if (!r) throw new HttpError(404, "not_found");
    return { params: { secret_id: r.id, domain_id: r.domain_id, env: r.env, name: r.name, version: Number(r.current_version) }, resourceId: r.id };
  },
  summary: (p) => `Reveal ${String(p.name)} (${String(p.env)}, version ${String(p.version)}) once.`,
};
export function registerRevealSpec(): void { registerActionSpec(secretRevealSpec); }

const stepUpRequired = () => new HttpError(403, "step_up_required", undefined, NO_STORE, { type: "secret.reveal" });

// The reveal ------------------------------------------------------------------------------------------------------

export async function revealHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const action = requireAction(req, "secret.reveal");
  const p = req.principal;
  if (p.kind !== "session" || !p.userId || !p.sessionIdHash) throw new HttpError(403, "forbidden_principal");
  const userId = p.userId, sessionHex = p.sessionIdHash.toString("hex");
  const params = action.params as { secret_id: string; domain_id: string; env: string; name: string; version: number };
  // One assertion reveals one secret: the action names the secret, and a different id in the path is refused.
  if (req.params.id !== params.secret_id) throw stepUpRequired();

  // Committed recently? The action row carries committed_at; a stale commit needs a new activation.
  const fresh = await withUser(ctx.runtime, userId, async (c) => {
    const r = (await c.query("select committed_at from actions where id = $1 and user_id = $2 and state = 'committed'", [action.id, userId])).rows[0];
    return !!r?.committed_at && ctx.clock.now().getTime() - new Date(r.committed_at).getTime() <= REVEAL_WINDOW_MS;
  });
  if (!fresh) throw stepUpRequired();

  // Limits, counted in their own committed statement so a refused try still costs a slot.
  const limited = await withUser(ctx.runtime, userId, async (c) => {
    for (const [subject, limit] of [[userId, REVEAL_LIMITS.userMinute], [userId, REVEAL_LIMITS.userHour], [`${userId}:${sessionHex}`, REVEAL_LIMITS.sessionMinute], [params.secret_id, REVEAL_LIMITS.secretMinute]] as const) {
      const h = await hit(ctx, c, subject, limit);
      if (!h.allowed) return h.retryAfterSeconds;
    }
    return 0;
  });
  if (limited) throw new HttpError(429, "rate_limited", undefined, { ...NO_STORE, "Retry-After": String(limited) });

  const v = vaultOf(ctx);
  // T1: single use, audit and notice commit together, before any decrypt.
  let row;
  try {
    row = await withUser(v.pool, userId, async (c) => {
      const rows = await loadCurrent(ctx, c, { id: params.secret_id }, userId);
      const r = rows[0];
      if (!r) throw new HttpError(404, "not_found", undefined, NO_STORE);
      if (r.version !== params.version || r.env !== params.env) throw new HttpError(409, "secret_changed", undefined, NO_STORE);
      await markExecuted(c, action);
      await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "secret.reveal.authorized", resourceKind: "secret", resourceId: r.id,
        detail: { action_id: action.id, env: r.env, version: r.version, decrypt_nonce: r.id } });
      const fqdn = (await c.query("select fqdn_ascii from domains where id = $1", [r.domain_id])).rows[0]?.fqdn_ascii as string;
      const mail = VAULT_MAIL.revealed({ name: r.name, env: r.env, fqdn, ua: (["chrome", "firefox", "safari", "edge"].includes(req.uaFamily) ? req.uaFamily : "other") as "other", at: ctx.clock.now().toISOString() }, ctx.config.origin);
      await notifyUser(ctx, c, userId, { kind: "secret.revealed", subject: mail.subject, text: mail.text, dedupeKey: `secret.reveal:${action.id}`, immediate: true });
      return r;
    });
  } catch (e) {
    throw await vaultFailure(ctx, e, params.secret_id);
  }

  // KMS, outside any transaction. A failure here does not reopen the action: a new activation is needed.
  let value: Buffer;
  try { value = await openRow(ctx, row); }
  catch (e) {
    const code = e instanceof Error ? e.name === "VaultIntegrityError" ? "integrity" : "kms" : "kms";
    await t2(req, userId, row.id, "secret.reveal.failed", { action_id: action.id, reason: code });
    throw await vaultFailure(ctx, e, row.id);
  }
  await t2(req, userId, row.id, "secret.reveal.released", { action_id: action.id, version: row.version });
  const text = value.toString("utf8");
  value.fill(0);
  return json({ secret_id: row.id, name: row.name, env: row.env, version: row.version, value: text }, 200, { headers: NO_STORE });
}

/** T2: record the outcome. Never blocks the response; a failure pages. */
async function t2(req: HandlerReq, userId: string, secretId: string, action: string, detail: Record<string, unknown>): Promise<void> {
  const { ctx } = req;
  try {
    await withUser(vaultOf(ctx).pool, userId, async (c) => {
      await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action, resourceKind: "secret", resourceId: secretId, detail });
      await vaultAlarms(ctx, c, userId);
    });
  } catch {
    await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "vault.reveal_t2_failed", subject: secretId }).catch(() => undefined);
  }
}
