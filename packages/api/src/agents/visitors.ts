import { z } from "zod";
import { withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { appendAudit } from "../audit.ts";
import { scopeString, storedScopes } from "../bindings/scopes.ts";
import { ownedDomain } from "../domain-mgmt/common.ts";
import { parseEnv, pointerMac } from "../vault/secrets.ts";
import { normalizeSecretName } from "../vault/names.ts";
import { vaultOf } from "../vault/context.ts";
import { iso, notFound, sessionUserOf, DAY_MS } from "./common.ts";
import { sendAllHome } from "./sendhome.ts";

/**
 * The visitor experience (PLAN 4.5, threat row 15): everything that holds a token for the account, what each may do, when
 * it was last used, what it has spent against its cap, and one action that sends them all home.
 */

export async function listVisitors(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUserOf(req);
  const now = req.ctx.clock.now();
  const out = await withUser(req.ctx.runtime, userId, async (c) => {
    const rows = (await c.query(
      `select b.*, oc.client_name, oc.registration, oc.redirect_uris,
              (select count(*)::int from agent_requests r where r.binding_id = b.id and r.state = 'pending' and r.expires_at > $2) as pending
         from bindings b left join oauth_clients oc on oc.id = b.oauth_client_id
        where b.user_id = $1 and (b.revoked_at is null or b.revoked_at > $3) order by b.created_at desc limit 200`,
      [userId, now, new Date(now.getTime() - 30 * DAY_MS)])).rows;
    const u = (await c.query("select agent_confirm_threshold_minor, device_login_enabled from users where id = $1", [userId])).rows[0];
    const pending = (await c.query("select count(*)::int as n from agent_requests where user_id = $1 and state = 'pending' and expires_at > $2", [userId, now])).rows[0].n as number;
    return { rows, u, pending };
  });
  return json({
    visitors: out.rows.map((b) => ({
      id: b.id, kind: b.kind, name: b.name, prefix: b.token_prefix, scopes: storedScopes(b.scopes).map(scopeString),
      // What a connected app says about itself: shown as reported, never as a fact.
      connected_app: b.oauth_client_id ? { reported_name: b.client_name ?? null, redirect_host: hostOf(b.redirect_uris?.[0]), registration: b.registration } : null,
      created_at: iso(b.created_at), last_used_at: iso(b.last_used_at), expires_at: iso(b.family_expires_at ?? b.expires_at),
      revoked_at: iso(b.revoked_at), paused: !!b.paused_at,
      spend: { cap_minor: String(b.spend_cap_minor), spent_minor: String(b.spent_minor), reserved_minor: String(b.reserved_minor) },
      pending_requests: b.pending,
    })),
    pending_requests: out.pending,
    confirm_threshold_minor: String(out.u?.agent_confirm_threshold_minor ?? 5000),
    device_login_enabled: out.u?.device_login_enabled === true,
  });
}

function hostOf(u: string | undefined): string | null {
  if (!u) return null;
  try { return new URL(u).host; } catch { return null; }
}

/** "Send all visitors home" (ST-66): the one revoke path, shared with the undo of a recovery (ST-48). */
export { sendAllHome, sendAllHomeIn } from "./sendhome.ts";

export async function sendHomeHandler(req: HandlerReq): Promise<HandlerResult> {
  return json(await sendAllHome(req.ctx, sessionUserOf(req)));
}

const Threshold = z.strictObject({ confirm_threshold_minor: z.number().int().min(0).max(1_000_000_00) });
export async function thresholdHandler(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUserOf(req);
  const b = Threshold.safeParse(req.body);
  if (!b.success) throw new HttpError(422, "invalid_request");
  await withUser(req.ctx.runtime, userId, async (c) => {
    await c.query("update users set agent_confirm_threshold_minor = $2 where id = $1", [userId, b.data.confirm_threshold_minor]);
    await appendAudit(req.ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "visitors.threshold_set", resourceKind: "user", resourceId: userId, detail: { minor: b.data.confirm_threshold_minor } });
  });
  return json({ confirm_threshold_minor: String(b.data.confirm_threshold_minor) });
}

// ---- the Nest's restore for an agent's production write (ST-35) --------------------------------------------------------------

async function secretOf(req: HandlerReq, userId: string) {
  const env = parseEnv(req.params.env);
  const n = normalizeSecretName(req.params.name ?? "");
  if (!env || !n.ok) throw notFound();
  let d;
  try { d = await withUser(req.ctx.runtime, userId, (c) => ownedDomain(c, userId, req.params.fqdn ?? "")); } catch { throw notFound(); }
  return { d, env, name: n.name };
}

/** Versions of one secret: numbers, authors and dates only (the runtime role cannot read ciphertext). */
export async function versionsHandler(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUserOf(req);
  const { d, env, name } = await secretOf(req, userId);
  const rows = await withUser(vaultOf(req.ctx).pool, userId, async (c) => {
    const s = (await c.query("select id, current_version from secrets where user_id = $1 and domain_id = $2 and env = $3 and name = $4 and deleted_at is null", [userId, d.id, env, name])).rows[0];
    if (!s) return null;
    const v = (await c.query("select version, created_by_kind, created_at, destroyed_at from secret_versions where secret_id = $1 and user_id = $2 order by version desc limit 50", [s.id, userId])).rows;
    return { s, v };
  });
  if (!rows) throw notFound();
  return json({ domain: d.fqdn_ascii, env, name, current_version: Number(rows.s.current_version), versions: rows.v.map((v) => ({ version: Number(v.version), by: v.created_by_kind, at: iso(v.created_at), restorable: !v.destroyed_at && Number(v.version) !== Number(rows.s.current_version) })) });
}

const RestoreBody = z.strictObject({ version: z.number().int().min(1) });

/**
 * Point a secret back at a kept version. No value moves: the pointer and its KMS MAC are rewritten under a compare-and-set
 * on the current version, so a concurrent write makes this the loser (409). The value is never in the response.
 */
export async function restoreHandler(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUserOf(req);
  const b = RestoreBody.safeParse(req.body);
  if (!b.success) throw new HttpError(422, "invalid_request");
  const { d, env, name } = await secretOf(req, userId);
  const ctx = req.ctx;
  const out = await withUser(vaultOf(ctx).pool, userId, async (c) => {
    const s = (await c.query("select id, current_version from secrets where user_id = $1 and domain_id = $2 and env = $3 and name = $4 and deleted_at is null for update", [userId, d.id, env, name])).rows[0];
    if (!s) return null;
    const v = (await c.query("select id, version from secret_versions where secret_id = $1 and user_id = $2 and version = $3 and destroyed_at is null", [s.id, userId, b.data.version])).rows[0];
    if (!v) return null;
    if (Number(s.current_version) === b.data.version) throw new HttpError(409, "already_current");
    const mac = await pointerMac(ctx, { id: s.id, domain_id: d.id, name, env, current_version: b.data.version, current_version_id: v.id });
    const up = await c.query("update secrets set current_version = $2, current_version_id = $3, pointer_mac = $4 where id = $1 and current_version = $5", [s.id, b.data.version, v.id, mac, s.current_version]);
    if (up.rowCount !== 1) throw new HttpError(409, "write_conflict");
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "secret.restored", resourceKind: "secret", resourceId: s.id, detail: { domain_id: d.id, env, from_version: Number(s.current_version), to_version: b.data.version } });
    return { from: Number(s.current_version), to: b.data.version };
  });
  if (!out) throw notFound();
  return json({ domain: d.fqdn_ascii, env, name, current_version: out.to, replaced_version: out.from });
}
