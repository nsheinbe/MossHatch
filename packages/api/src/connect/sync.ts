import crypto from "node:crypto";
import { withNoUser, withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { hit } from "../ratelimit.ts";
import { appendAudit } from "../audit.ts";
import { ACTION_HEADER, createStepUpGate, markExecuted } from "../stepup/gate.ts";
import { mapRegistrarError, normalizeFqdn, notFound, ownedDomain, registrarOf, userIdOf } from "../domain-mgmt/common.ts";
import { buildConnectPlan, planHash, planHashHex, type ConnectPlan, type ConnectRecordIn } from "./plan.ts";
import { flagOn } from "./flags.ts";
import { pinnedTemplate } from "./templates.ts";

/**
 * DC-08. A service redirects the browser to the sync apply URL. The signature is RSA-SHA256 over the query
 * string with `sig` and `key` removed, in the order they were sent. The public key is the TXT at
 * `{key}.{syncPubKeyDomain}`. A bad signature, an unpinned template, or a redirect on another host writes nothing.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_TTL_MS = 60 * 60_000;
export type TxtLookup = (name: string) => Promise<string[]>;

interface TplRecord { groupId?: string; type?: string; host?: string; pointsTo?: string; data?: string; priority?: string | number; spfRules?: string }
export interface Tpl {
  providerId?: string; providerName?: string; serviceId?: string; version?: number;
  syncPubKeyDomain?: string; syncRedirectDomain?: string; records?: TplRecord[];
}

export function publicKeyFromTxt(records: readonly string[]): crypto.KeyObject | null {
  const parts: { p: number; d: string }[] = [];
  for (const rec of records) {
    const p = /(?:^|,)p=(\d+)/.exec(rec);
    const a = /(?:^|,)a=([^,\s]+)/.exec(rec);
    const d = /(?:^|,)d=([A-Za-z0-9+/=]+)/.exec(rec);
    if (!p || !d || (a && a[1] !== "RS256")) continue;
    parts.push({ p: Number(p[1]), d: d[1]! });
  }
  if (!parts.length) return null;
  parts.sort((x, y) => x.p - y.p);
  try { return crypto.createPublicKey({ key: Buffer.from(parts.map((x) => x.d).join(""), "base64"), format: "der", type: "spki" }); }
  catch { return null; }
}

/** True when `sig` is a valid RSA-SHA256 over `signed`, the query with sig and key removed. */
export function verifyQuerySignature(signed: string, sig: string, key: crypto.KeyObject): boolean {
  try {
    const v = crypto.createVerify("RSA-SHA256");
    v.update(signed);
    v.end();
    return v.verify(key, Buffer.from(sig, "base64"));
  } catch { return false; }
}

function splitQuery(raw: string): { signed: string; params: URLSearchParams } | null {
  if (raw.length > 4000) return null;
  const params = new URLSearchParams(raw);
  if (!params.get("sig") || !params.get("key")) return null;
  const signed = raw.split("&").filter((p) => { const n = p.split("=")[0]; return n !== "sig" && n !== "key"; }).join("&");
  return { signed, params };
}

function redirectAllowed(redirectUri: string, root: string): boolean {
  let u: URL;
  try { u = new URL(redirectUri); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  const base = root.toLowerCase().replace(/\.$/, "");
  return host === base || host.endsWith(`.${base}`);
}

function withParams(redirectUri: string, extra: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}

const go = (location: string): HandlerResult => ({ status: 302, json: {}, headers: { Location: location } });
const reject = (): HandlerResult => json({ error: { code: "invalid_request" } }, 400);

function subst(value: string, params: URLSearchParams): string | null {
  let missing = false;
  const out = value.replace(/%([A-Za-z0-9_]+)%/g, (_m, name: string) => {
    const got = params.get(name);
    if (got === null) { missing = true; return ""; }
    return got;
  });
  return missing ? null : out;
}

function txtLookup(ctx: AppContext): TxtLookup {
  const injected = (ctx.services as { connectTxt?: TxtLookup }).connectTxt;
  if (injected) return injected;
  return async (name) => {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: "application/dns-json" } });
    if (!res.ok) return [];
    const data = await res.json() as { Answer?: { data?: string }[] };
    return (data.Answer ?? []).map((a) => (a.data ?? "").replace(/^"|"$/g, ""));
  };
}

interface Checked {
  template: Tpl;
  params: URLSearchParams;
  redirect: string;
  state: string | null;
  domain: string;
  plan: ConnectPlan;
  intent: { add: ConnectRecordIn[]; remove: ConnectRecordIn[]; replace_addresses: string[]; spf: { name: string; mechanisms: string[] }[]; alias: boolean; warnings: { code: string; message: string }[] };
}

/** Verify the query. A failure is either a redirect (the host was allowed) or a bare 400 (it was not). */
async function check(ctx: AppContext, providerId: string, serviceId: string, raw: string): Promise<{ ok: Checked } | { error: HandlerResult }> {
  if (!(await flagOn(ctx, "domainconnect.apply"))) throw new HttpError(404, "not_found");
  const parts = splitQuery(raw);
  if (!parts) return { error: reject() };
  const pinned = pinnedTemplate(providerId, serviceId);
  const template = pinned && typeof pinned === "object" ? pinned as Tpl : null;
  if (!template || template.syncRedirectDomain === undefined || !Array.isArray(template.records)) return { error: reject() };
  const redirect = parts.params.get("redirect_uri") ?? "";
  if (!redirectAllowed(redirect, template.syncRedirectDomain)) return { error: reject() };
  const domain = normalizeFqdn(parts.params.get("domain") ?? "");
  const keyHost = parts.params.get("key") ?? "";
  if (!domain || !/^[A-Za-z0-9_-]{1,63}$/.test(keyHost)) return { error: go(withParams(redirect, { error: "invalid_request", ...(parts.params.get("state") ? { state: parts.params.get("state")! } : {}) })) };
  const pub = publicKeyFromTxt(await txtLookup(ctx)(`${keyHost}.${template.syncPubKeyDomain}`));
  const sig = parts.params.get("sig") ?? "";
  if (!pub || !verifyQuerySignature(parts.signed, sig, pub)) return { error: go(withParams(redirect, { error: "invalid_request", ...(parts.params.get("state") ? { state: parts.params.get("state")! } : {}) })) };
  const built = intentFrom(template, parts.params);
  if (!built) return { error: go(withParams(redirect, { error: "invalid_request", error_description: "invalid_request", ...(parts.params.get("state") ? { state: parts.params.get("state")! } : {}) })) };
  const row = (await ctx.cron.query("select id, user_id, fqdn_ascii, dns_hosted_here from domains where fqdn_ascii = $1 and released_at is null", [domain])).rows[0];
  if (!row) return { error: go(withParams(redirect, { error: "invalid_request", error_description: "not_found", ...(parts.params.get("state") ? { state: parts.params.get("state")! } : {}) })) };
  let zone;
  try { zone = await registrarOf(ctx).getDns(row.fqdn_ascii); } catch (e) { throw mapRegistrarError(e); }
  const plan = buildConnectPlan({
    source: "domainconnect", source_id: `${providerId}/${serviceId}`.slice(0, 80), source_version: template.version ?? 1,
    domain_id: row.id, fqdn: row.fqdn_ascii, hosted: zone.hosted === true && row.dns_hosted_here === true, live: zone.records,
    add: built.add, remove: [], replace_addresses: [], spf: built.spf, alias: built.alias, warnings: built.warnings,
  });
  if (plan.blocked) return { error: go(withParams(redirect, { error: "invalid_request", error_description: plan.blocked.code, ...(parts.params.get("state") ? { state: parts.params.get("state")! } : {}) })) };
  return { ok: { template, params: parts.params, redirect, state: parts.params.get("state"), domain, plan, intent: { add: built.add, remove: [], replace_addresses: [], spf: built.spf, alias: built.alias, warnings: built.warnings } } };
}

export function intentFrom(template: Tpl, params: URLSearchParams): { add: ConnectRecordIn[]; spf: { name: string; mechanisms: string[] }[]; alias: boolean; warnings: { code: string; message: string }[] } | null {
  const groups = params.get("groupId");
  const wanted = groups ? new Set(groups.split(",").filter(Boolean)) : null;
  const add: ConnectRecordIn[] = [];
  const spf: { name: string; mechanisms: string[] }[] = [];
  let alias = false;
  for (const rec of template.records ?? []) {
    if (wanted && rec.groupId && !wanted.has(rec.groupId)) continue;
    if (wanted && !rec.groupId) continue;
    const type = (rec.type ?? "").toUpperCase();
    const hostRaw = subst(rec.host ?? "@", params);
    const dataRaw = subst(rec.data ?? rec.pointsTo ?? rec.spfRules ?? "", params);
    if (hostRaw === null || dataRaw === null) return null;
    const host = hostRaw === "@" ? "" : hostRaw;
    if (type === "CNAME" && host === "") { alias = true; continue; }
    if (type === "SPFM") { spf.push({ name: host, mechanisms: dataRaw.split(/\s+/).filter(Boolean) }); continue; }
    const row: ConnectRecordIn = { type, name: host, value: dataRaw };
    if (type === "MX" || type === "SRV") {
      const p = subst(String(rec.priority ?? "0"), params);
      if (p === null || !/^\d+$/.test(p)) return null;
      row.priority = Number(p);
    }
    add.push(row);
  }
  return { add, spf, alias, warnings: [{ code: "provider", message: template.providerName ?? template.providerId ?? "Domain Connect" }] };
}

const view = (p: ConnectPlan) => ({
  v: p.v, source: p.source, source_id: p.source_id, source_version: p.source_version, fqdn: p.fqdn,
  dns: p.dns, warnings: p.warnings, blocked: p.blocked, sensitive: p.sensitive,
});

function rawOf(req: HandlerReq): string {
  const body = req.body as { query?: unknown } | null;
  if (body && typeof body.query === "string") return body.query.replace(/^\?/, "");
  return req.url.search.replace(/^\?/, "");
}

export async function syncApplyGet(req: HandlerReq): Promise<HandlerResult> {
  const found = await check(req.ctx, req.params.providerId ?? "", req.params.serviceId ?? "", req.url.search.replace(/^\?/, ""));
  if ("error" in found) return found.error;
  const providerId = req.params.providerId ?? "";
  const serviceId = req.params.serviceId ?? "";
  if (providerId.includes("/") || serviceId.includes("/")) return reject();
  const q = req.url.search.startsWith("?") ? req.url.search : `?${req.url.search}`;
  return go(`${req.ctx.config.origin}/domainconnect/consent/${encodeURIComponent(providerId)}/${encodeURIComponent(serviceId)}${q}`);
}

export async function syncPreview(req: HandlerReq): Promise<HandlerResult> {
  const found = await check(req.ctx, providerOf(req), serviceOf(req), rawOf(req));
  if ("error" in found) return asJson(found.error);
  return json({ provider_name: found.ok.template.providerName ?? found.ok.template.providerId, fqdn: found.ok.domain, plan: view(found.ok.plan) });
}

/** The consent page is a fetch, so a redirect the GET apply would send becomes JSON the page can follow. */
function asJson(result: HandlerResult): HandlerResult {
  const loc = result.headers?.Location;
  if (result.status === 302 && loc) return json({ redirect: loc });
  return result;
}

function providerOf(req: HandlerReq): string {
  const body = req.body as { provider_id?: unknown } | null;
  return typeof body?.provider_id === "string" ? body.provider_id : (req.params.providerId ?? "");
}
function serviceOf(req: HandlerReq): string {
  const body = req.body as { service_id?: unknown } | null;
  return typeof body?.service_id === "string" ? body.service_id : (req.params.serviceId ?? "");
}

export async function syncConfirm(req: HandlerReq): Promise<HandlerResult> {
  const body = req.body as { decision?: unknown; provider_id?: unknown; service_id?: unknown } | null;
  const decision = body?.decision === "cancel" ? "cancel" : body?.decision === "confirm" ? "confirm" : "";
  const found = await check(req.ctx, providerOf(req), serviceOf(req), rawOf(req));
  if ("error" in found) return found.error;
  const { ok } = found;
  const state: Record<string, string> = ok.state ? { state: ok.state } : {};
  if (decision === "cancel") return json({ redirect: withParams(ok.redirect, { error: "access_denied", error_description: "user_cancel", ...state }) });
  if (decision !== "confirm") return reject();
  if (req.principal.kind !== "session") throw new HttpError(401, "unauthorized");
  const userId = userIdOf(req);
  const d = await withUser(req.ctx.runtime, userId, (c) => ownedDomain(c, userId, ok.domain));
  const hash = planHash(ok.plan);
  const hex = hash.toString("hex");
  const rl = await withNoUser(req.ctx.runtime, (c) => hit(req.ctx, c, `connect:plan:${userId}`, { bucket: "connect.plan", max: 30, windowSeconds: 3600 }));
  if (!rl.allowed) throw new HttpError(429, "rate_limited", "rate_limited", { "Retry-After": String(rl.retryAfterSeconds) });
  const now = req.ctx.clock.now();
  const id = await withUser(req.ctx.runtime, userId, async (c) => {
    const have = (await c.query(
      "select id from connect_plans where user_id = $1 and domain_id = $2 and plan_hash = $3 and state = any($4::text[]) and expires_at > $5 order by created_at desc limit 1",
      [userId, d.id, hash, ["planned", "approved"], now])).rows[0];
    if (have) return have.id as string;
    const ins = await c.query(
      `insert into connect_plans (user_id, domain_id, source, source_id, source_version, intent, plan, plan_hash, sensitive_count, expires_at, created_at)
       values ($1,$2,'domainconnect',$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [userId, d.id, ok.plan.source_id, ok.plan.source_version, JSON.stringify(ok.intent), JSON.stringify(ok.plan), hash, ok.plan.sensitive.length, new Date(now.getTime() + PLAN_TTL_MS), now]);
    const planId = ins.rows[0].id as string;
    await appendAudit(req.ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "connect.planned", resourceKind: "domain", resourceId: d.id, detail: { plan_id: planId, source: "domainconnect", source_id: ok.plan.source_id, plan_hash: hex, added: ok.plan.dns.add.length, removed: ok.plan.dns.remove.length, sensitive: ok.plan.sensitive.length } });
    return planId;
  });
  if (ok.plan.sensitive.length > 0 && !UUID.test(req.request.headers.get(ACTION_HEADER) ?? "")) {
    throw new HttpError(403, "approval_required", undefined, undefined, { type: "connect.apply", plan_id: id });
  }
  if (ok.plan.sensitive.length > 0) {
    const action = await createStepUpGate()(req, "connect.apply");
    const q = action.params as { plan_id?: string; plan_hash?: string };
    if (q.plan_id !== id || q.plan_hash !== hex) throw new HttpError(409, "plan_changed");
    await withUser(req.ctx.runtime, userId, async (c) => {
      await markExecuted(c, action);
      const r = await c.query("update connect_plans set state = 'approved', approved_by_action_id = $3 where id = $1 and user_id = $2 and state = 'planned' and plan_hash = $4 and expires_at > $5", [id, userId, action.id, hash, req.ctx.clock.now()]);
      if (r.rowCount !== 1) throw new HttpError(409, "plan_used");
    });
  }
  const { applyStoredPlan } = await import("./routes.ts");
  const applied = await applyStoredPlan(req.ctx, userId, d.fqdn_ascii, id, planHashHex(ok.plan));
  return json({ ...(applied.json as Record<string, unknown>), redirect: withParams(ok.redirect, state) });
}
