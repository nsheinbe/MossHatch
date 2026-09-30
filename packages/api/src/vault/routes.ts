import { z } from "zod";
import { withUser } from "@mosshatch/db";
import type { Router } from "../http/router.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult, Route } from "../http/types.ts";
import { appendAudit } from "../audit.ts";
import { hit } from "../ratelimit.ts";
import { ownedDomain } from "../domain-mgmt/common.ts";
import type { SecretEnv } from "./kms/types.ts";
import { MAX_VALUE_BYTES } from "./envelope.ts";
import { NO_STORE } from "./context.ts";
import { normalizeSecretName, RESERVED_NAMES, RESERVED_NAMES_VERSION, RESERVED_PREFIXES } from "./names.ts";
import { deleteSecret, listSecrets, parseEnv, writeSecret } from "./secrets.ts";
import { registerRevealSpec, revealHandler } from "./reveal.ts";
import { MAX_READ, readSecretsForBinding } from "./read.ts";
import { disconnect, listConnections, SERVICES, storeConnectionCredential, type Service } from "./connections.ts";

/**
 * The Nest routes (PLAN 4.5). Every response carries `Cache-Control: no-store, private`; only the reveal and the bearer
 * read ever carry a value. Unowned, released, malformed and nonexistent domains, envs and names all end in the same 404.
 * Bodies are parsed by the router (a JSON error never echoes input) and validated here with strict schemas whose errors
 * are never returned.
 */

const notFound = () => new HttpError(404, "not_found", undefined, NO_STORE);
const ok = (data: unknown, status = 200): HandlerResult => json(data, status, { headers: NO_STORE });

function sessionUser(req: HandlerReq): string {
  const p = req.principal;
  if (p.kind !== "session" || !p.userId) throw new HttpError(401, "unauthorized");
  return p.userId;
}

async function domainOf(req: HandlerReq, userId: string): Promise<{ id: string; fqdn: string }> {
  try {
    const d = await withUser(req.ctx.runtime, userId, (c) => ownedDomain(c, userId, req.params.fqdn ?? ""));
    return { id: d.id, fqdn: d.fqdn_ascii };
  } catch { throw notFound(); }
}
function envOf(req: HandlerReq): SecretEnv {
  const e = parseEnv(req.params.env);
  if (!e) throw notFound();
  return e;
}

/** Writes: an own target of 60 a minute per user, so a script cannot turn KMS into a cost or a noise source. */
const WRITE_LIMIT = { bucket: "vault.write.user.m", max: 60, windowSeconds: 60 };

const PutBody = z.strictObject({ value: z.string() });
const ConnBody = z.strictObject({
  kind: z.enum(["pasted_token", "oauth_refresh"]),
  credential: z.string().min(1).max(4096),
  scope_summary: z.string().regex(/^[a-z0-9_:.-]{1,64}$/).optional(),
  external_ref: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).optional(),
});
const ReadBody = z.strictObject({ names: z.array(z.string().max(256)).min(1).max(MAX_READ).optional() }).nullable();

async function nest(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const d = await domainOf(req, userId);
  const q = req.url.searchParams.get("env");
  const env = q === null ? undefined : parseEnv(q);
  if (env === null) throw new HttpError(400, "invalid_request", undefined, NO_STORE);
  const { secrets, connections } = await withUser(req.ctx.runtime, userId, async (c) => ({ secrets: await listSecrets(c, userId, d.id, env), connections: await listConnections(c, userId, d.id) }));
  const envs: Record<string, { count: number; secrets: typeof secrets }> = {};
  for (const e of env ? [env] : (["dev", "preview", "prod"] as const)) { const s = secrets.filter((x) => x.env === e); envs[e] = { count: s.length, secrets: s }; }
  return ok({ domain: d.fqdn, envs, connections });
}

async function list(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const d = await domainOf(req, userId);
  const env = envOf(req);
  const secrets = await withUser(req.ctx.runtime, userId, (c) => listSecrets(c, userId, d.id, env));
  return ok({ domain: d.fqdn, env, secrets: secrets.map(({ env: _e, ...s }) => s) });
}

async function rejectName(req: HandlerReq, userId: string, env: SecretEnv, reason: string): Promise<never> {
  await withUser(req.ctx.runtime, userId, (c) => appendAudit(req.ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "secret.name_rejected", resourceKind: "domain", detail: { env, reason } })).catch(() => undefined);
  throw new HttpError(422, "invalid_name", undefined, NO_STORE);
}

async function put(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const d = await domainOf(req, userId);
  const env = envOf(req);
  const n = normalizeSecretName(req.params.name);
  if (!n.ok) return rejectName(req, userId, env, n.reason);
  const body = PutBody.safeParse(req.body);
  if (!body.success) throw new HttpError(400, "invalid_request", undefined, NO_STORE);
  const value = body.data.value;
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new HttpError(413, "too_large", undefined, NO_STORE);
  // Lone surrogates, NUL and U+FFFD (what a non-UTF-8 body decodes to) are refused rather than stored altered.
  if (value.length === 0 || /\p{Surrogate}/u.test(value) || value.includes("\u0000") || value.includes("�")) throw new HttpError(422, "invalid_value", undefined, NO_STORE);
  const rl = await withUser(req.ctx.runtime, userId, (c) => hit(req.ctx, c, userId, WRITE_LIMIT));
  if (!rl.allowed) throw new HttpError(429, "rate_limited", undefined, { ...NO_STORE, "Retry-After": String(rl.retryAfterSeconds) });
  const buf = Buffer.from(value, "utf8");
  try {
    const r = await writeSecret(req.ctx, userId, { kind: "user", id: userId }, d.id, env, n.name, buf);
    return ok({ id: r.id, name: n.name, env, version: r.version }, r.created ? 201 : 200);
  } finally { buf.fill(0); }
}

async function del(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const d = await domainOf(req, userId);
  const env = envOf(req);
  const n = normalizeSecretName(req.params.name);
  if (!n.ok) throw notFound();
  const r = await deleteSecret(req.ctx, userId, d.id, env, n.name);
  return ok({ id: r.id, deleted: true, versions_destroyed: r.versions });
}

/** Bearer only (a cookie session is refused by the router before this runs). */
async function bearerRead(req: HandlerReq): Promise<HandlerResult> {
  const p = req.principal;
  if (p.kind !== "binding" || !p.userId || !p.bindingId || !p.bindingKind) throw new HttpError(403, "forbidden_principal");
  const userId = p.userId;
  const d = await domainOf(req, userId);
  const env = envOf(req);
  const body = ReadBody.safeParse(req.body);
  if (!body.success) throw new HttpError(400, "invalid_request", undefined, NO_STORE);
  let names: string[] | undefined;
  if (body.data?.names) {
    names = [];
    for (const raw of body.data.names) { const n = normalizeSecretName(raw); if (!n.ok) throw new HttpError(422, "invalid_name", undefined, NO_STORE); names.push(n.name); }
  }
  const secrets = await readSecretsForBinding(req.ctx, { userId, bindingId: p.bindingId, bindingKind: p.bindingKind, scopes: p.scopes }, { domainId: d.id, env, names });
  return ok({ domain: d.fqdn, env, secrets });
}

async function connPut(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const d = await domainOf(req, userId);
  const service = req.params.service as Service;
  if (!(SERVICES as readonly string[]).includes(service)) throw notFound();
  const body = ConnBody.safeParse(req.body);
  if (!body.success) throw new HttpError(400, "invalid_request", undefined, NO_STORE);
  const buf = Buffer.from(body.data.credential, "utf8");
  try {
    const r = await storeConnectionCredential(req.ctx, userId, d.id, service, { kind: body.data.kind, credential: buf, scopeSummary: body.data.scope_summary, externalRef: body.data.external_ref });
    return ok({ connection_id: r.connectionId, service, status: "active" }, 201);
  } finally { buf.fill(0); }
}

async function connDelete(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const d = await domainOf(req, userId);
  const service = req.params.service as Service;
  if (!(SERVICES as readonly string[]).includes(service)) throw notFound();
  await disconnect(req.ctx, userId, d.id, service);
  return ok({ service, status: "ended" });
}

async function reservedNames(): Promise<HandlerResult> {
  return ok({ version: RESERVED_NAMES_VERSION, names: RESERVED_NAMES, prefixes: RESERVED_PREFIXES, grammar: "^[A-Z][A-Z0-9_]{0,127}$", compare: "case-insensitive" });
}

export const vaultRoutes: Route[] = [
  { method: "GET", path: "/api/v1/vault/reserved-names", principals: ["anonymous", "session", "binding"], handler: reservedNames, tag: "vault" },
  { method: "GET", path: "/api/v1/domains/:fqdn/nest", principals: ["session"], handler: nest, tag: "vault" },
  { method: "GET", path: "/api/v1/domains/:fqdn/secrets/:env", principals: ["session"], handler: list, tag: "vault" },
  { method: "POST", path: "/api/v1/domains/:fqdn/secrets/:env/read", principals: ["binding"], capability: "secrets.read", handler: bearerRead, tag: "vault" },
  { method: "PUT", path: "/api/v1/domains/:fqdn/secrets/:env/:name", principals: ["session"], handler: put, tag: "vault" },
  { method: "DELETE", path: "/api/v1/domains/:fqdn/secrets/:env/:name", principals: ["session"], handler: del, tag: "vault" },
  { method: "POST", path: "/api/v1/secrets/:id/reveal", principals: ["session"], stepUp: "secret.reveal", handler: revealHandler, tag: "vault" },
  { method: "PUT", path: "/api/v1/domains/:fqdn/connections/:service", principals: ["session"], handler: connPut, tag: "vault" },
  { method: "DELETE", path: "/api/v1/domains/:fqdn/connections/:service", principals: ["session"], handler: connDelete, tag: "vault" },
];

export function registerVaultRoutes(router: Router): Router {
  registerRevealSpec();
  router.add(...vaultRoutes);
  return router;
}
