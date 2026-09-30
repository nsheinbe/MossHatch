import { z } from "zod";
import { withNoUser, withUser, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { appendAudit } from "../audit.ts";
import { hit, peek, type Limit } from "../ratelimit.ts";
import { b64u, randomBytes, safeEqual, sha256 } from "../util/bytes.ts";
import { registerActionSpec, type ActionSpec } from "../stepup/specs.ts";
import { markExecuted, requireAction } from "../stepup/gate.ts";
import { isNormalizedFqdn, lintScopes, ownedDomainMap, parseScope, ScopeError, scopeString, type Scope } from "./scopes.ts";
import { issueCliGrant, revokeByToken, rotateRefresh } from "./tokens.ts";
import { grantNotice } from "./notice.ts";

/**
 * RFC 8628 device authorization for `mosshatch login` (PLAN 4.5 Device flow).
 *
 * - `device_code` is 256 random bits, stored as SHA-256; `user_code` is 8 letters from a 20-letter alphabet (`XXXX-XXXX`),
 *   stored as a keyed HMAC; `expires_in` 600, `interval` 5 with `slow_down` (+5 s, kept).
 * - `verification_uri_complete` is not offered and the page ignores any code in its URL: the person types the code shown in
 *   their own terminal (device-code phishing, RFC 8628 section 5.4).
 * - Wrong entries are counted per signed-in account and per source address; the sixth in the window is refused even if right.
 * - Approval is `device.approve` with a passkey, binding the request id, the typed code and the exact scopes shown. The token
 *   is issued once, to the first poll after approval; the grant is audited and every notification address is emailed.
 */

export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const DEVICE_TTL_MS = 600_000;
export const POLL_INTERVAL_S = 5;
export const WRONG_LIMITS = {
  user: { bucket: "device.wrong.user", max: 5, windowSeconds: 86_400 } satisfies Limit,
  ip: { bucket: "device.wrong.ip", max: 5, windowSeconds: 86_400 } satisfies Limit,
};
const CODE_LIMIT: Limit = { bucket: "device.code.ip", max: 10, windowSeconds: 3600 };
export const CLIENT_ID = "mosshatch-cli";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** The default grant: read domains and names, read and write secrets, on dev and preview only. */
export const DEFAULT_CAPS = ["domains.read", "nest.names", "secrets.read", "secrets.write"] as const;
const PROD_CAPS = ["nest.names", "secrets.read", "secrets.write"] as const;
type CliEnv = "dev" | "preview";

export function newUserCode(): string {
  const b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[b[i]! % 20];
  // 256 is not a multiple of 20; the bias (6 of 256 values) costs well under a bit of the 34.5 and is accepted.
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
/** Case, spaces and the hyphen are forgiven; anything outside the alphabet is not a code. */
export function normalizeUserCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 32) return null;
  const s = raw.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== 8 || [...s].some((ch) => !USER_CODE_ALPHABET.includes(ch))) return null;
  return s;
}
const userCodeHash = (ctx: Pick<AppContext, "kms">, normalized: string) => ctx.kms.hmac("rate", Buffer.from(`device.user_code:${normalized}`));

// ---- scopes a device may ask for, and what the page grants --------------------------------------------------------------

/** A CLI may ask only for the default capabilities on `*` with dev or preview. `secrets.read:*:prod` and the rest are refused (ST-31). */
export function parseRequestedScope(raw: string): { capability: string; env: CliEnv | null } {
  const s = parseScope(raw, new Map());
  if (!(DEFAULT_CAPS as readonly string[]).includes(s.capability) || s.domain_id !== "*") throw new ScopeError("not_offered");
  if (s.env === "prod" || s.env === "*") throw new ScopeError("prod_not_offered");
  return { capability: s.capability, env: s.env as CliEnv | null };
}

/** The grant the page shows: default capabilities on the chosen envs, plus `prod` only for domains named on the page. */
export function grantScopes(envs: readonly CliEnv[], prodDomains: readonly { id: string; fqdn: string }[]): Scope[] {
  const out: Scope[] = [{ capability: "domains.read", domain_id: "*", env: null, label: "*" }];
  for (const env of envs) for (const cap of ["nest.names", "secrets.read", "secrets.write"] as const) out.push({ capability: cap, domain_id: "*", env, label: "*" });
  for (const d of prodDomains) for (const cap of PROD_CAPS) out.push({ capability: cap, domain_id: d.id, env: "prod", label: d.fqdn });
  return out;
}

// ---- wrong-entry counting -------------------------------------------------------------------------------------------------

async function assertNotLocked(ctx: AppContext, userId: string, ipPrefix: string): Promise<void> {
  const [u, i] = await withNoUser(ctx.runtime, async (c) => [await peek(ctx, c, userId, WRONG_LIMITS.user), await peek(ctx, c, ipPrefix, WRONG_LIMITS.ip)]);
  if ((u ?? 0) >= WRONG_LIMITS.user.max || (i ?? 0) >= WRONG_LIMITS.ip.max) throw new HttpError(429, "device_code_locked", undefined, { "Retry-After": "3600" });
}
/** Counted in its own committed statements, so a failing request still costs an attempt. */
async function countWrong(ctx: AppContext, userId: string, ipPrefix: string): Promise<void> {
  await withNoUser(ctx.runtime, async (c) => { await hit(ctx, c, userId, WRONG_LIMITS.user); await hit(ctx, c, ipPrefix, WRONG_LIMITS.ip); });
  await withUser(ctx.runtime, userId, (c) => appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "device.code_wrong", detail: {} })).catch(() => undefined);
}

async function deviceLoginEnabled(c: PoolClient, userId: string): Promise<boolean> {
  return (await c.query("select device_login_enabled from users where id = $1", [userId])).rows[0]?.device_login_enabled === true;
}
async function devicePaused(ctx: AppContext): Promise<boolean> {
  const v = (await withNoUser(ctx.runtime, (c) => c.query("select value from flags where name = 'device_login_paused'"))).rows[0]?.value;
  return v !== false;
}

// ---- POST /oauth/device/code (anonymous) ---------------------------------------------------------------------------------

const CodeBody = z.strictObject({
  client_id: z.literal(CLIENT_ID),
  scope: z.string().max(600).optional(),
  client_name: z.string().regex(/^[A-Za-z0-9 ._-]{1,40}$/).optional(),
  client_version: z.string().regex(/^[A-Za-z0-9._+-]{1,24}$/).optional(),
});

export async function deviceCodeHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const rl = await withNoUser(ctx.runtime, (c) => hit(ctx, c, req.ipPrefix, CODE_LIMIT));
  if (!rl.allowed) throw new HttpError(429, "rate_limited", undefined, { "Retry-After": String(rl.retryAfterSeconds) });
  const b = CodeBody.safeParse(req.body);
  if (!b.success) throw new HttpError(400, "invalid_request");
  if (await devicePaused(ctx)) throw new HttpError(403, "device_login_disabled");
  const requested: string[] = [];
  for (const s of (b.data.scope ?? "").split(" ").filter(Boolean)) {
    try { parseRequestedScope(s); } catch { throw new HttpError(400, "invalid_scope"); }
    requested.push(s);
  }
  const now = ctx.clock.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const deviceCode = b64u(randomBytes(32));
    const userCode = newUserCode();
    const id = (await withNoUser(ctx.runtime, async (c) => (await c.query("select device_request_create($1,$2,$3,$4,$5,$6,$7,$8,$9::interval) as id",
      [sha256(deviceCode), await userCodeHash(ctx, normalizeUserCode(userCode)!), b.data.client_name ?? null, b.data.client_version ?? null, JSON.stringify(requested), req.ipPrefix, req.uaFamily, now, `${DEVICE_TTL_MS} milliseconds`])).rows[0].id)) as string | null;
    if (!id) continue;   // a live request already holds this user code: draw another
    return json({ device_code: deviceCode, user_code: userCode, verification_uri: `${ctx.config.origin}/device`, expires_in: DEVICE_TTL_MS / 1000, interval: POLL_INTERVAL_S });
  }
  throw new HttpError(503, "try_again");
}

// ---- POST /oauth/device/lookup (session): the approval page asks what the typed code belongs to ------------------------

const LookupBody = z.strictObject({ user_code: z.string().max(32) });

export async function deviceLookupHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const userId = sessionUser(req);
  await assertNotLocked(ctx, userId, req.ipPrefix);
  const b = LookupBody.safeParse(req.body);
  if (!b.success) throw new HttpError(400, "invalid_request");
  if (!(await withUser(ctx.runtime, userId, (c) => deviceLoginEnabled(c, userId)))) throw new HttpError(403, "device_login_disabled");
  const code = normalizeUserCode(b.data.user_code);
  const row = code ? (await withNoUser(ctx.runtime, async (c) => c.query("select * from device_request_by_user_code($1,$2)", [await userCodeHash(ctx, code), ctx.clock.now()]))).rows[0] : undefined;
  if (!row) { await countWrong(ctx, userId, req.ipPrefix); throw new HttpError(404, "not_found"); }
  const envs = requestedEnvs(row.requested_scopes);
  const domains = await withUser(ctx.runtime, userId, (c) => ownedDomainMap(c, userId));
  return json({
    request_id: row.id,
    // Facts the server observed.
    observed: { address: row.ip_prefix, requested_at: new Date(row.created_at).toISOString(), expires_at: new Date(row.expires_at).toISOString() },
    // Claims the device made about itself: never shown as fact.
    reported: { client_name: row.client_name ?? null, client_version: row.client_version ?? null, scopes: row.requested_scopes },
    default_envs: envs,
    grant: grantScopes(envs, []).map(scopeString),
    prod_choices: [...domains.keys()].sort(),
  });
}

function requestedEnvs(raw: unknown): CliEnv[] {
  const envs = new Set<CliEnv>();
  if (Array.isArray(raw)) for (const s of raw) { try { const p = parseRequestedScope(String(s)); if (p.env) envs.add(p.env); } catch { /* ignored */ } }
  return envs.size ? (["dev", "preview"] as const).filter((e) => envs.has(e)) : ["dev", "preview"];
}

function sessionUser(req: HandlerReq): string {
  const p = req.principal;
  if (p.kind !== "session" || !p.userId) throw new HttpError(401, "unauthorized");
  return p.userId;
}

// ---- device.approve (step-up) ---------------------------------------------------------------------------------------------

const approveInput = z.strictObject({
  user_code: z.string().max(32),
  envs: z.array(z.enum(["dev", "preview"])).min(1).max(2).optional(),
  prod_domains: z.array(z.string().max(253)).max(20).optional(),
});

export const deviceApproveSpec: ActionSpec<z.infer<typeof approveInput>> = {
  type: "device.approve", held: true, userInput: approveInput,
  async derive(ctx, c, userId, targetId, input) {
    if (!/^[0-9a-f-]{36}$/i.test(targetId)) throw new HttpError(404, "not_found");
    if (!(await deviceLoginEnabled(c, userId))) throw new HttpError(403, "device_login_disabled");
    // Wrong entries at prepare count against the account (in their own committed statements); the sixth is refused even if right.
    const tries = await withNoUser(ctx.runtime, (x) => peek(ctx, x, userId, WRONG_LIMITS.user));
    if (tries >= WRONG_LIMITS.user.max) throw new HttpError(429, "device_code_locked");
    const code = normalizeUserCode(input.user_code);
    const row = (await c.query("select * from device_request_get($1,$2)", [targetId, ctx.clock.now()])).rows[0];
    const hash = code ? await userCodeHash(ctx, code) : null;
    // Approval without the typed code, or with a code of another request, fails (ST-70).
    if (!row || !hash || !safeEqual(Buffer.from(row.user_code_hash), hash)) {
      await withNoUser(ctx.runtime, (x) => hit(ctx, x, userId, WRONG_LIMITS.user));
      throw new HttpError(404, "not_found");
    }
    const owned = await ownedDomainMap(c, userId);
    const prod: { id: string; fqdn: string }[] = [];
    for (const f of [...new Set(input.prod_domains ?? [])].sort()) {
      const id = isNormalizedFqdn(f) ? owned.get(f) : undefined;
      if (!id) throw new HttpError(422, "invalid_scope");
      prod.push({ id, fqdn: f });
    }
    const envs = (input.envs ?? ["dev", "preview"]).slice().sort() as CliEnv[];
    const scopes = grantScopes([...new Set(envs)], prod);
    if (lintScopes(scopes)) throw new HttpError(422, "invalid_scope");
    return {
      params: { request_id: row.id, user_code_hash: hash.toString("hex"), scopes: scopes.map((s) => ({ capability: s.capability, domain_id: s.domain_id, env: s.env, label: s.label })), address: row.ip_prefix, requested_at: new Date(row.created_at).toISOString() },
      resourceId: row.id,
    };
  },
  summary: (p) => `Let the command-line tool that asked from ${String(p.address ?? "an unknown address")} at ${String(p.requested_at ?? "")} use: ${(p.scopes as Scope[]).map(scopeString).join(", ")}.`,
};

export function registerDeviceSpec(): void { registerActionSpec(deviceApproveSpec); }

/** POST /oauth/device/approve (session, `device.approve`). Records the approval; the token goes to the device's next poll. */
export async function deviceApproveHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const userId = sessionUser(req);
  const action = requireAction(req, "device.approve");
  const p = action.params as { request_id: string; user_code_hash: string; scopes: Scope[] };
  await withUser(ctx.runtime, userId, async (c) => {
    await markExecuted(c, action);
    if (!(await deviceLoginEnabled(c, userId))) throw new HttpError(403, "device_login_disabled");
    const ok = (await c.query("select device_request_decide($1,$2,$3,'approved',$4,$5,$6) as ok",
      [p.request_id, Buffer.from(p.user_code_hash, "hex"), userId, JSON.stringify(p.scopes), action.id, ctx.clock.now()])).rows[0].ok;
    if (!ok) throw new HttpError(409, "request_unavailable");
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "device.approved", resourceKind: "device_request", resourceId: p.request_id, detail: { action_id: action.id, scopes: p.scopes.length } });
  });
  return json({ state: "approved", scopes: p.scopes.map(scopeString) });
}

const DenyBody = z.strictObject({ request_id: z.string().uuid(), user_code: z.string().max(32) });

/** POST /oauth/device/deny (session). Needs the typed code too; wrong codes count. */
export async function deviceDenyHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const userId = sessionUser(req);
  await assertNotLocked(ctx, userId, req.ipPrefix);
  const b = DenyBody.safeParse(req.body);
  if (!b.success) throw new HttpError(400, "invalid_request");
  const code = normalizeUserCode(b.data.user_code);
  const ok = code ? await withUser(ctx.runtime, userId, async (c) => {
    const r = (await c.query("select device_request_decide($1,$2,$3,'denied',null,null,$4) as ok", [b.data.request_id, await userCodeHash(ctx, code), userId, ctx.clock.now()])).rows[0].ok as boolean;
    if (r) await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "device.denied", resourceKind: "device_request", resourceId: b.data.request_id, detail: {} });
    return r;
  }) : false;
  if (!ok) { await countWrong(ctx, userId, req.ipPrefix); throw new HttpError(404, "not_found"); }
  return json({ state: "denied" });
}

// ---- POST /oauth/token (anonymous): device_code and refresh_token grants ---------------------------------------------------

const TokenBody = z.discriminatedUnion("grant_type", [
  z.strictObject({ grant_type: z.literal(DEVICE_GRANT), device_code: z.string().min(20).max(100), client_id: z.literal(CLIENT_ID) }),
  z.strictObject({ grant_type: z.literal("refresh_token"), refresh_token: z.string().min(20).max(100), client_id: z.literal(CLIENT_ID) }),
]);

const tokenResponse = (t: { accessToken: string; refreshToken: string; expiresIn: number }, scopes: string[]): HandlerResult =>
  json({ access_token: t.accessToken, token_type: "Bearer", expires_in: t.expiresIn, refresh_token: t.refreshToken, scope: scopes.join(" ") }, 200, { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });

export async function tokenHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const b = TokenBody.safeParse(req.body);
  if (!b.success) throw new HttpError(400, "invalid_request");
  if (b.data.grant_type === "refresh_token") {
    const t = await rotateRefresh(ctx, b.data.refresh_token);
    const scopes = (await withNoUser(ctx.cron, (c) => c.query("select scopes from bindings where id = $1", [t.bindingId]))).rows[0]?.scopes as Scope[] | undefined;
    return tokenResponse(t, (scopes ?? []).map(scopeString));
  }
  const now = ctx.clock.now();
  const deviceHash = sha256(b.data.device_code);
  const row = (await withNoUser(ctx.runtime, (c) => c.query("select * from device_request_poll($1,$2)", [deviceHash, now]))).rows[0];
  if (!row) throw new HttpError(400, "invalid_grant");
  if (row.state === "expired" || (row.state === "pending" && new Date(row.expires_at) <= now)) {
    await withNoUser(ctx.runtime, (c) => c.query("select device_request_expire($1)", [row.id]));
    throw new HttpError(400, "expired_token");
  }
  if (row.prev_polled_at && now.getTime() - new Date(row.prev_polled_at).getTime() < row.interval_seconds * 1000) {
    const next = (await withNoUser(ctx.runtime, (c) => c.query("select device_request_slow_down($1) as i", [row.id]))).rows[0].i as number;
    throw new HttpError(400, "slow_down", undefined, undefined, { interval: next });
  }
  if (row.state === "pending") throw new HttpError(400, "authorization_pending");
  if (row.state === "denied") throw new HttpError(400, "access_denied");
  if (row.state !== "approved" || !row.user_id) throw new HttpError(400, "invalid_grant");   // consumed: one-time use
  const userId = row.user_id as string;
  const scopes = row.approved_scopes as Scope[];
  const issued = await withUser(ctx.runtime, userId, async (c) => {
    // The one-time use: a compare-and-set from approved. A second poll, or a racing one, gets invalid_grant.
    const won = await c.query("update device_requests set state = 'consumed' where id = $1 and state = 'approved' and user_id = $2", [row.id, userId]);
    if (won.rowCount !== 1) return null;
    if (!(await deviceLoginEnabled(c, userId))) return null;
    const t = await issueCliGrant(ctx, c, { userId, deviceRequestId: row.id, actionId: row.approved_by_action_id, scopes });
    await c.query("update device_requests set binding_id = $2 where id = $1", [row.id, t.bindingId]);
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "binding.granted", resourceKind: "binding", resourceId: t.bindingId, detail: { kind: "cli", device_request_id: row.id, action_id: row.approved_by_action_id, scopes: scopes.length } });
    await grantNotice(ctx, c, userId, t.bindingId, scopes);
    return t;
  });
  if (!issued) throw new HttpError(400, "invalid_grant");
  return tokenResponse(issued, scopes.map(scopeString));
}

// ---- POST /oauth/revoke (RFC 7009; anonymous or the bearer revoking itself) ----------------------------------------------

const RevokeBody = z.strictObject({ token: z.string().max(200), token_type_hint: z.enum(["access_token", "refresh_token"]).optional(), client_id: z.string().max(40).optional() });

export async function revokeHandler(req: HandlerReq): Promise<HandlerResult> {
  const b = RevokeBody.safeParse(req.body);
  if (!b.success) throw new HttpError(400, "invalid_request");
  await revokeByToken(req.ctx, b.data.token);
  return json({ revoked: true });
}
