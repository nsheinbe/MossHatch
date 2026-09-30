import { withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { hit } from "../ratelimit.ts";
import { allows, lintScopes, type Env } from "../bindings/scopes.ts";
import { ownedDomain, type DomainRow } from "../domain-mgmt/common.ts";
import { MAX_VALUE_BYTES } from "../vault/envelope.ts";
import { normalizeSecretName } from "../vault/names.ts";
import { listSecrets, parseEnv, writeSecret } from "../vault/secrets.ts";
import { readSecretsForBinding } from "../vault/read.ts";
import { NO_STORE } from "../vault/context.ts";
import { displayName, iso, notFound, type Caller } from "./common.ts";
import { prodWriteNotice } from "./notices.ts";

/**
 * The capabilities an agent binding exercises, shared by the MCP tools and the REST routes under /api/v1/agent. Every call is
 * authorized against the presented binding's scopes and the target's owner, never against the server's own authority
 * (threat row 20, ST-83): the domain is resolved to the caller's own live row first (unowned and nonexistent are one 404),
 * then the scope is checked on that domain id (out of scope on an owned domain is 403 `scope_missing`).
 */

export async function callerDomain(ctx: AppContext, caller: Caller, fqdn: string): Promise<DomainRow> {
  if (typeof fqdn !== "string") throw notFound();
  try { return await withUser(ctx.runtime, caller.userId, (c) => ownedDomain(c, caller.userId, fqdn)); } catch { throw notFound(); }
}

export function need(caller: Caller, capability: Parameters<typeof allows>[1], domainId: string, env: Env | null): void {
  if (lintScopes(caller.scopes)) throw new HttpError(403, "scope_conflict");
  if (!allows(caller.scopes, capability, domainId, env)) throw new HttpError(403, "scope_missing");
}

/** Domains the binding may read: only those its `domains.read` scopes cover (a `*` scope covers all the owner's live names). */
export async function listDomainsFor(ctx: AppContext, caller: Caller) {
  const rows = await withUser(ctx.runtime, caller.userId, async (c) => (await c.query(
    "select id, fqdn_ascii, state, expires_at, auto_renew, locked, dispute_lock_state from domains where user_id = $1 and released_at is null order by fqdn_ascii limit 500", [caller.userId])).rows);
  const visible = rows.filter((d) => allows(caller.scopes, "domains.read", d.id, null));
  if (visible.length === 0 && !caller.scopes.some((s) => s.capability === "domains.read")) throw new HttpError(403, "scope_missing");
  // C-23: a dispute lock (UDRP/URS, set only on registrar instruction) is part of the state every client sees.
  return visible.map((d) => ({ domain: d.fqdn_ascii, unicode: displayName(d.fqdn_ascii).unicode, state: d.state, expires_at: iso(d.expires_at), auto_renew: d.auto_renew, locked: d.locked, dispute_lock: d.dispute_lock_state ?? null }));
}

export async function getDomainFor(ctx: AppContext, caller: Caller, fqdn: string) {
  const d = await callerDomain(ctx, caller, fqdn);
  need(caller, "domains.read", d.id, null);
  return { domain: d.fqdn_ascii, unicode: displayName(d.fqdn_ascii).unicode, state: d.state, expires_at: iso(d.expires_at), auto_renew: d.auto_renew, locked: d.locked, dispute_lock: d.dispute_lock_state ?? null, nameservers: d.nameservers, dns_hosted_here: d.dns_hosted_here };
}

export async function nestNamesFor(ctx: AppContext, caller: Caller, fqdn: string, envRaw: string) {
  const d = await callerDomain(ctx, caller, fqdn);
  const env = parseEnv(envRaw);
  if (!env) throw new HttpError(422, "invalid_env");
  need(caller, "nest.names", d.id, env);
  const s = await withUser(ctx.runtime, caller.userId, (c) => listSecrets(c, caller.userId, d.id, env));
  return { domain: d.fqdn_ascii, env, names: s.slice(0, 200).map((x) => ({ name: x.name, version: x.version })) };
}

/** One value per call (no bulk map over MCP, ST-34). The vault's read path audits before decrypt and limits by token id. */
export async function secretGetFor(ctx: AppContext, caller: Caller, fqdn: string, envRaw: string, nameRaw: string) {
  const d = await callerDomain(ctx, caller, fqdn);
  const env = parseEnv(envRaw);
  if (!env) throw new HttpError(422, "invalid_env");
  const n = normalizeSecretName(nameRaw);
  if (!n.ok) throw new HttpError(422, "invalid_name");
  need(caller, "secrets.read", d.id, env);
  const rows = await readSecretsForBinding(ctx, { userId: caller.userId, bindingId: caller.bindingId, bindingKind: caller.kind, scopes: caller.scopes }, { domainId: d.id, env, names: [n.name] });
  if (rows.length === 0) throw new HttpError(404, "not_found", undefined, NO_STORE);
  return { domain: d.fqdn_ascii, env, name: rows[0]!.name, version: rows[0]!.version, value: rows[0]!.value };
}

export const AGENT_WRITE_LIMIT = { bucket: "agent.secret_write.m", max: 30, windowSeconds: 60 };

/**
 * `secrets.write` for one name. An agent's write to `prod` keeps the prior version (versions are append-only), emails every
 * address at once and can be restored from the Nest (ST-35); the database also queues the same notice for other write paths.
 */
export async function secretSetFor(ctx: AppContext, caller: Caller, fqdn: string, envRaw: string, nameRaw: string, value: unknown) {
  const d = await callerDomain(ctx, caller, fqdn);
  const env = parseEnv(envRaw);
  if (!env) throw new HttpError(422, "invalid_env");
  need(caller, "secrets.write", d.id, env);
  const n = normalizeSecretName(nameRaw);
  if (!n.ok) throw new HttpError(422, "invalid_name");
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") || /\p{Surrogate}/u.test(value)) throw new HttpError(422, "invalid_value");
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new HttpError(413, "too_large");
  const rl = await withUser(ctx.runtime, caller.userId, (c) => hit(ctx, c, caller.bindingId, AGENT_WRITE_LIMIT));
  if (!rl.allowed) throw new HttpError(429, "rate_limited", undefined, { "Retry-After": String(rl.retryAfterSeconds) });
  const buf = Buffer.from(value, "utf8");
  let w;
  try { w = await writeSecret(ctx, caller.userId, { kind: caller.kind, id: caller.bindingId }, d.id, env, n.name, buf); } finally { buf.fill(0); }
  if (env === "prod" && caller.kind === "agent") {
    await withUser(ctx.runtime, caller.userId, async (c) => {
      const b = (await c.query("select name from bindings where id = $1", [caller.bindingId])).rows[0];
      await prodWriteNotice(ctx, c, caller.userId, { secretId: w.id, version: w.version, name: n.name, fqdn: d.fqdn_ascii, bindingName: b?.name ?? "token" });
    });
  }
  return { domain: d.fqdn_ascii, env, name: n.name, version: w.version, created: w.created, previous_version_kept: w.version > 1 };
}

/** `transfer.status`: the state of a transfer in for a name, never an authorization code (ST-22). */
export async function transferStatusFor(ctx: AppContext, caller: Caller, fqdn: string) {
  const name = typeof fqdn === "string" ? fqdn.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!/^[a-z0-9.-]{3,253}$/.test(name)) throw notFound();
  const rows = await withUser(ctx.runtime, caller.userId, async (c) => {
    const d = (await c.query("select id from domains where user_id = $1 and fqdn_ascii = $2 and released_at is null", [caller.userId, name])).rows[0];
    const t = (await c.query("select id, state, created_at, updated_at, completed_at from transfers_in where user_id = $1 and fqdn_ascii = $2 order by created_at desc limit 5", [caller.userId, name])).rows;
    // Existence first (neither owned nor a transfer of the caller: the same 404 as a name nobody has), then the scope: a name
    // not yet owned (a transfer in) is covered only by `transfer.status:*`, an owned one also by its own scope.
    if (!d && t.length === 0) throw notFound();
    if (!allows(caller.scopes, "transfer.status", d?.id ?? "*", null)) throw new HttpError(403, "scope_missing");
    return t;
  });
  return { domain: name, transfers: rows.map((t) => ({ id: t.id, state: t.state, started_at: iso(t.created_at), updated_at: iso(t.updated_at), completed_at: iso(t.completed_at) })) };
}
