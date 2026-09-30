import { z } from "zod";
import { withUser } from "@mosshatch/db";
import type { Router } from "../http/router.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult, Route } from "../http/types.ts";
import { appendAudit } from "../audit.ts";
import { hit } from "../ratelimit.ts";
import { markExecuted, requireAction } from "../stepup/gate.ts";
import { ownedDomain } from "../domain-mgmt/common.ts";
import { NO_STORE } from "../vault/context.ts";
import { MAX_VALUE_BYTES } from "../vault/envelope.ts";
import { normalizeSecretName } from "../vault/names.ts";
import { listSecrets, parseEnv } from "../vault/secrets.ts";
import { AGENT_WRITE_LIMIT } from "../agents/capabilities.ts";
import { prodWriteNotice } from "../agents/notices.ts";
import { writeSecretsAtomically } from "./push.ts";
import { isNarrowing, requireScope, scopeString, storedScopes, type Env, type Scope } from "./scopes.ts";
import { AGENT_MAX_MS, createAgentBinding, DAY, revokeAllBindings, revokeBinding } from "./tokens.ts";
import { bindingState, canonical, parseForUser, registerBindingSpecs } from "./specs.ts";
import { deviceApproveHandler, deviceCodeHandler, deviceDenyHandler, deviceLookupHandler, registerDeviceSpec, revokeHandler, tokenHandler } from "./device.ts";
import { grantNotice, revokeLinkPage, revokeLinkPost } from "./notice.ts";

/**
 * Bindings (PLAN 4.5): list, create (`agent.token.create`), narrow (free), widen (`agent.token.widen`), revoke, revoke-all,
 * activity; the device flow; and the bearer carve-outs the CLI uses (whoami, names, push). Every management route is
 * session-only: a bearer can never mint, widen or rename a token. Unowned and nonexistent bindings share one 404.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new HttpError(404, "not_found");

function sessionUser(req: HandlerReq): string {
  const p = req.principal;
  if (p.kind !== "session" || !p.userId) throw new HttpError(401, "unauthorized");
  return p.userId;
}
function bindingOf(req: HandlerReq): { userId: string; bindingId: string; kind: "agent" | "cli" } {
  const p = req.principal;
  if (p.kind !== "binding" || !p.userId || !p.bindingId || !p.bindingKind) throw new HttpError(403, "forbidden_principal");
  return { userId: p.userId, bindingId: p.bindingId, kind: p.bindingKind };
}

const view = (b: Record<string, any>) => ({
  id: b.id, kind: b.kind, name: b.name, prefix: b.token_prefix, scopes: storedScopes(b.scopes).map(scopeString),
  created_at: new Date(b.created_at).toISOString(), expires_at: new Date(b.family_expires_at ?? b.expires_at).toISOString(),
  last_used_at: b.last_used_at ? new Date(b.last_used_at).toISOString() : null, revoked_at: b.revoked_at ? new Date(b.revoked_at).toISOString() : null,
  paused: !!b.paused_at, spend_cap_minor: String(b.spend_cap_minor),
});

async function list(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const rows = await withUser(req.ctx.runtime, userId, async (c) => (await c.query(
    "select * from bindings where user_id = $1 and (revoked_at is null or revoked_at > $2) order by created_at desc limit 200", [userId, new Date(req.ctx.clock.now().getTime() - 30 * DAY)])).rows);
  const settings = await withUser(req.ctx.runtime, userId, async (c) => (await c.query("select device_login_enabled from users where id = $1", [userId])).rows[0]);
  return json({ bindings: rows.map(view), device_login_enabled: settings?.device_login_enabled === true });
}

/** POST /bindings: runs only behind a committed `agent.token.create`. The token is in this response and nowhere else. */
async function create(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const action = requireAction(req, "agent.token.create");
  const p = action.params as { name: string; scopes: Scope[]; spend_cap_minor: number; expires_in_days: number };
  const out = await withUser(req.ctx.runtime, userId, async (c) => {
    await markExecuted(c, action);
    const expiresAt = new Date(req.ctx.clock.now().getTime() + Math.min(p.expires_in_days * DAY, AGENT_MAX_MS));
    const b = await createAgentBinding(req.ctx, c, { userId, name: p.name, scopes: p.scopes, capMinor: BigInt(p.spend_cap_minor), expiresAt, actionId: action.id });
    await appendAudit(req.ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "binding.created", resourceKind: "binding", resourceId: b.id, detail: { kind: "agent", action_id: action.id, scopes: p.scopes.length } });
    await grantNotice(req.ctx, c, userId, b.id, p.scopes, "agent");
    return { ...b, expiresAt };
  });
  return json({ id: out.id, token: out.token, prefix: out.prefix, expires_at: out.expiresAt.toISOString(), scopes: p.scopes.map(scopeString) }, 201, { headers: NO_STORE });
}

const PatchBody = z.strictObject({
  name: z.string().max(64).optional(),
  scopes: z.array(z.string().max(300)).max(50).optional(),
  spend_cap_minor: z.number().int().min(0).optional(),
  expires_in_days: z.number().int().min(1).max(90).optional(),
});

/** PATCH /bindings/:id (session only). A narrowing is free; anything else, any rename and any parse doubt is a widening. */
async function patch(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const id = req.params.id ?? "";
  if (!UUID.test(id)) throw notFound();
  return withUser(req.ctx.runtime, userId, async (c) => {
    const { row } = await bindingState(c, userId, id);
    const body = PatchBody.safeParse(req.body);
    const widening = () => new HttpError(403, "step_up_required", undefined, undefined, { type: "agent.token.widen" });
    if (!body.success) throw widening();
    if (body.data.name !== undefined && body.data.name !== row.name) throw widening();
    let after: Scope[];
    try { after = body.data.scopes ? await parseForUser(c, userId, body.data.scopes) : storedScopes(row.scopes); } catch { throw widening(); }
    const now = req.ctx.clock.now();
    const beforeExp = new Date(row.family_expires_at ?? row.expires_at);
    const afterExp = body.data.expires_in_days ? new Date(now.getTime() + body.data.expires_in_days * DAY) : beforeExp;
    const narrowing = isNarrowing(
      { scopes: storedScopes(row.scopes), capMinor: BigInt(row.spend_cap_minor), expiresAt: beforeExp },
      { scopes: after, capMinor: BigInt(body.data.spend_cap_minor ?? Number(row.spend_cap_minor)), expiresAt: afterExp });
    if (!narrowing) throw widening();
    const r = await c.query(
      `update bindings set scopes = $3, spend_cap_minor = $4, expires_at = least(expires_at, $5), family_expires_at = case when family_expires_at is null then null else least(family_expires_at, $5) end
        where id = $1 and user_id = $2 and revoked_at is null returning *`,
      [id, userId, JSON.stringify(canonical(after)), String(body.data.spend_cap_minor ?? row.spend_cap_minor), afterExp]);
    if (r.rowCount !== 1) throw notFound();
    await appendAudit(req.ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "binding.narrowed", resourceKind: "binding", resourceId: id, detail: { scopes: after.length } });
    return json({ binding: view(r.rows[0]) });
  });
}

/** POST /bindings/:id/widen: behind a committed `agent.token.widen`. Also resumes a paused binding. */
async function widen(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const action = requireAction(req, "agent.token.widen");
  const p = action.params as { binding_id: string; before_hash: string; after: { name: string; scopes: Scope[]; spend_cap_minor: number; expires_in_days: number | null } };
  if (req.params.id !== p.binding_id) throw notFound();
  return withUser(req.ctx.runtime, userId, async (c) => {
    await markExecuted(c, action);
    const cur = await bindingState(c, userId, p.binding_id);
    if (cur.beforeHash !== p.before_hash) throw new HttpError(409, "params_changed");
    const now = req.ctx.clock.now();
    const exp = p.after.expires_in_days ? new Date(now.getTime() + Math.min(p.after.expires_in_days * DAY, AGENT_MAX_MS)) : null;
    const r = await c.query(
      `update bindings set name = $3, scopes = $4, spend_cap_minor = $5, paused_at = null,
              expires_at = case when kind = 'agent' and $6::timestamptz is not null then $6 else expires_at end,
              family_expires_at = case when kind = 'cli' and $6::timestamptz is not null then least($6, created_at + interval '90 days') else family_expires_at end
        where id = $1 and user_id = $2 and revoked_at is null returning *`,
      [p.binding_id, userId, p.after.name, JSON.stringify(p.after.scopes), String(p.after.spend_cap_minor), exp]);
    if (r.rowCount !== 1) throw notFound();
    await appendAudit(req.ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "binding.widened", resourceKind: "binding", resourceId: p.binding_id, detail: { action_id: action.id, scopes: p.after.scopes.length } });
    await grantNotice(req.ctx, c, userId, p.binding_id, p.after.scopes, "widen");
    return json({ binding: view(r.rows[0]) });
  });
}

async function del(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const id = req.params.id ?? "";
  if (!UUID.test(id)) throw notFound();
  const ok = await withUser(req.ctx.runtime, userId, (c) => revokeBinding(req.ctx, c, userId, id, "user", { kind: "user", id: userId }));
  if (!ok) throw notFound();
  return json({ id, revoked: true });
}

/** POST /bindings/revoke-all (ST-66). Outside every rate limit. */
async function revokeAll(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const out = await withUser(req.ctx.runtime, userId, (c) => revokeAllBindings(req.ctx, c, userId, "user"));
  return json({ revoked: out.bindings, refresh_tokens: out.refresh, device_grants: out.devices, requests_declined: out.requests });
}

async function activity(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const id = req.params.id ?? "";
  if (!UUID.test(id)) throw notFound();
  return withUser(req.ctx.runtime, userId, async (c) => {
    const b = (await c.query("select id from bindings where id = $1 and user_id = $2", [id, userId])).rows[0];
    if (!b) throw notFound();
    const rows = (await c.query(
      "select seq, at, actor_kind, action, resource_kind, resource_id from audit_log where chain_id = $1 and (actor_id = $2 or resource_id = $2) order by seq desc limit 100", [userId, id])).rows;
    return json({ id, activity: rows.map((r) => ({ at: new Date(r.at).toISOString(), actor: r.actor_kind, action: r.action, resource_kind: r.resource_kind, resource_id: r.resource_id })) });
  });
}

const DeviceLoginBody = z.strictObject({ enabled: z.boolean() });
async function deviceLogin(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const b = DeviceLoginBody.safeParse(req.body);
  if (!b.success) throw new HttpError(400, "invalid_request");
  await withUser(req.ctx.runtime, userId, async (c) => {
    await c.query("update users set device_login_enabled = $2 where id = $1", [userId, b.data.enabled]);
    await appendAudit(req.ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: b.data.enabled ? "device_login.enabled" : "device_login.disabled", resourceKind: "user", resourceId: userId });
  });
  return json({ device_login_enabled: b.data.enabled });
}

// ---- bearer carve-outs -----------------------------------------------------------------------------------------------------

async function whoami(req: HandlerReq): Promise<HandlerResult> {
  const b = bindingOf(req);
  const row = await withUser(req.ctx.runtime, b.userId, async (c) => (await c.query("select * from bindings where id = $1 and user_id = $2", [b.bindingId, b.userId])).rows[0]);
  if (!row) throw new HttpError(401, "unauthorized");
  return json({ binding: { id: row.id, kind: row.kind, name: row.name, scopes: storedScopes(row.scopes).map(scopeString), expires_at: new Date(row.expires_at).toISOString(), grant_expires_at: new Date(row.family_expires_at ?? row.expires_at).toISOString() } }, 200, { headers: NO_STORE });
}

async function domainAndEnv(req: HandlerReq, userId: string): Promise<{ id: string; fqdn: string; env: Env }> {
  let d;
  try { d = await withUser(req.ctx.runtime, userId, (c) => ownedDomain(c, userId, req.params.fqdn ?? "")); } catch { throw new HttpError(404, "not_found", undefined, NO_STORE); }
  const env = parseEnv(req.params.env);
  if (!env) throw new HttpError(404, "not_found", undefined, NO_STORE);
  return { id: d.id, fqdn: d.fqdn_ascii, env };
}

async function names(req: HandlerReq): Promise<HandlerResult> {
  const b = bindingOf(req);
  const d = await domainAndEnv(req, b.userId);
  requireScope(req.principal, "nest.names", d.id, d.env);
  const secrets = await withUser(req.ctx.runtime, b.userId, (c) => listSecrets(c, b.userId, d.id, d.env));
  return json({ domain: d.fqdn, env: d.env, names: secrets.map((s) => ({ name: s.name, version: s.version })) }, 200, { headers: NO_STORE });
}

export const PUSH_LIMIT = { bucket: "vault.write.token.m", max: 60, windowSeconds: 60 };
const PushBody = z.strictObject({ secrets: z.record(z.string().max(256), z.string()) });

/**
 * POST /domains/:fqdn/secrets/:env/write (bearer, `secrets.write`): the CLI's `push`. Every name and value is checked
 * before anything is written, so one reserved or malformed name refuses the whole batch (422, one audit row, nothing
 * written). The batch is then written all or nothing (`writeSecretsAtomically`). Values never appear in the response.
 */
async function push(req: HandlerReq): Promise<HandlerResult> {
  const b = bindingOf(req);
  const d = await domainAndEnv(req, b.userId);
  requireScope(req.principal, "secrets.write", d.id, d.env);
  const body = PushBody.safeParse(req.body);
  if (!body.success) throw new HttpError(400, "invalid_request", undefined, NO_STORE);
  const entries = Object.entries(body.data.secrets);
  if (entries.length === 0 || entries.length > 100) throw new HttpError(422, "invalid_request", undefined, NO_STORE);
  const clean: [string, string][] = [];
  const reasons = new Map<string, number>();
  for (const [raw, value] of entries) {
    const n = normalizeSecretName(raw);
    if (!n.ok) { reasons.set(n.reason, (reasons.get(n.reason) ?? 0) + 1); continue; }
    if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new HttpError(413, "too_large", undefined, NO_STORE);
    if (value.length === 0 || /\p{Surrogate}/u.test(value) || value.includes("\u0000") || value.includes("�")) throw new HttpError(422, "invalid_value", undefined, NO_STORE);
    clean.push([n.name, value]);
  }
  if (reasons.size) {
    await withUser(req.ctx.runtime, b.userId, (c) => appendAudit(req.ctx, c, { chainId: b.userId, actorKind: b.kind, actorId: b.bindingId, action: "secret.name_rejected", resourceKind: "domain", resourceId: d.id, detail: { env: d.env, reasons: Object.fromEntries(reasons), batch: entries.length } })).catch(() => undefined);
    throw new HttpError(422, "invalid_name", undefined, NO_STORE);
  }
  if (new Set(clean.map(([n]) => n)).size !== clean.length) throw new HttpError(422, "duplicate_name", undefined, NO_STORE);
  const rl = await withUser(req.ctx.runtime, b.userId, (c) => hit(req.ctx, c, b.bindingId, PUSH_LIMIT));
  if (!rl.allowed) throw new HttpError(429, "rate_limited", undefined, { ...NO_STORE, "Retry-After": String(rl.retryAfterSeconds) });
  if (b.kind === "agent") {
    // An agent token writes no faster through push than through its own write route: every value counts (ST-35).
    const over = await withUser(req.ctx.runtime, b.userId, async (c) => {
      for (let i = 0; i < clean.length; i++) { const r = await hit(req.ctx, c, b.bindingId, AGENT_WRITE_LIMIT); if (!r.allowed) return r; }
      return null;
    });
    if (over) throw new HttpError(429, "rate_limited", undefined, { ...NO_STORE, "Retry-After": String(over.retryAfterSeconds) });
  }
  const bufs = clean.map(([name, value]) => ({ name, value: Buffer.from(value, "utf8") }));
  let written;
  try { written = await writeSecretsAtomically(req.ctx, b.userId, { kind: b.kind, id: b.bindingId }, d.id, d.env, bufs); }
  finally { for (const x of bufs) x.value.fill(0); }
  if (d.env === "prod" && b.kind === "agent") {
    // ST-35: an agent's write to prod emails every address at once, as the agent's own write route does. The database also
    // queues the same notice (same dedupe key), so a failure here still ends in a mail.
    await withUser(req.ctx.runtime, b.userId, async (c) => {
      const bindingName = (await c.query("select name from bindings where id = $1", [b.bindingId])).rows[0]?.name ?? "token";
      for (const w of written) await prodWriteNotice(req.ctx, c, b.userId, { secretId: w.id, version: w.version, name: w.name, fqdn: d.fqdn, bindingName });
    }).catch(() => undefined);
  }
  return json({ domain: d.fqdn, env: d.env, written: written.map((w) => ({ name: w.name, version: w.version })) }, 200, { headers: NO_STORE });
}

export const bindingRoutes: Route[] = [
  { method: "GET", path: "/api/v1/bindings", principals: ["session"], handler: list, tag: "bindings" },
  { method: "POST", path: "/api/v1/bindings", principals: ["session"], stepUp: "agent.token.create", handler: create, tag: "bindings" },
  { method: "POST", path: "/api/v1/bindings/revoke-all", principals: ["session"], handler: revokeAll, tag: "bindings" },
  { method: "PUT", path: "/api/v1/bindings/device-login", principals: ["session"], handler: deviceLogin, tag: "bindings" },
  { method: "PATCH", path: "/api/v1/bindings/:id", principals: ["session"], handler: patch, tag: "bindings" },
  { method: "DELETE", path: "/api/v1/bindings/:id", principals: ["session"], handler: del, tag: "bindings" },
  { method: "POST", path: "/api/v1/bindings/:id/widen", principals: ["session"], stepUp: "agent.token.widen", handler: widen, tag: "bindings" },
  { method: "GET", path: "/api/v1/bindings/:id/activity", principals: ["session"], handler: activity, tag: "bindings" },
  // Device flow (RFC 8628) and token endpoints.
  { method: "POST", path: "/api/v1/oauth/device/code", principals: ["anonymous"], handler: deviceCodeHandler, tag: "bindings" },
  { method: "POST", path: "/api/v1/oauth/device/lookup", principals: ["session"], handler: deviceLookupHandler, tag: "bindings" },
  { method: "POST", path: "/api/v1/oauth/device/approve", principals: ["session"], stepUp: "device.approve", handler: deviceApproveHandler, tag: "bindings" },
  { method: "POST", path: "/api/v1/oauth/device/deny", principals: ["session"], handler: deviceDenyHandler, tag: "bindings" },
  { method: "POST", path: "/api/v1/oauth/token", principals: ["anonymous"], handler: tokenHandler, tag: "bindings" },
  { method: "POST", path: "/api/v1/oauth/revoke", principals: ["anonymous", "binding"], handler: revokeHandler, tag: "bindings" },
  { method: "GET", path: "/api/v1/binding-revoke/:token", principals: ["anonymous"], handler: revokeLinkPage, tag: "bindings" },
  // csrf "none": no cookie principal is accepted here; revokeLinkPost applies the equivalent guard itself.
  { method: "POST", path: "/api/v1/binding-revoke/:token", principals: ["anonymous"], csrf: "none", handler: revokeLinkPost, tag: "bindings" },
  // Bearer carve-outs.
  { method: "GET", path: "/api/v1/whoami", principals: ["binding"], handler: whoami, tag: "bindings" },
  { method: "GET", path: "/api/v1/domains/:fqdn/nest/:env/names", principals: ["binding"], capability: "nest.names", handler: names, tag: "bindings" },
  { method: "POST", path: "/api/v1/domains/:fqdn/secrets/:env/write", principals: ["binding"], capability: "secrets.write", handler: push, tag: "bindings" },
];

export function registerBindings(router: Router): Router {
  registerBindingSpecs();
  registerDeviceSpec();
  router.add(...bindingRoutes);
  return router;
}
