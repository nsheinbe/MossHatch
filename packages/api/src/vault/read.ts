import { withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { appendAudit } from "../audit.ts";
import { hit, type Limit } from "../ratelimit.ts";
import { enqueue } from "../jobs/registry.ts";
import type { SecretEnv } from "./kms/types.ts";
import { NO_STORE, vaultFailure, vaultOf } from "./context.ts";
import { loadCurrent, openRow } from "./secrets.ts";
import { vaultAlarms } from "./alarms.ts";

/**
 * The second read path (PLAN 4.5, D-019 path 2): a binding created by a passkey step-up (`agent.token.create`, or
 * `device.approve` for the CLI) holding `secrets.read:<domain>:<env>` reads that domain and environment without a
 * per-read ceremony. This file is the read-path interface the tokens, CLI and MCP modules call; the HTTP route in
 * `routes.ts` is one caller.
 *
 * Rules: `:prod` must be named explicitly (a `*` env never covers prod); a missing scope is 403, never an empty list; a
 * binding that also holds `dns.write` (any domain) is refused; limits are keyed by token id (so agent traffic never
 * touches a person's reveal buckets); one audit row per secret is committed before any decrypt, and if that write fails
 * nothing is decrypted; at most 100 secrets per call; KMS errors are 503 `vault_unavailable`.
 */

export interface BindingRef {
  userId: string;
  bindingId: string;
  bindingKind: "agent" | "cli";
  /** `bindings.scopes` as stored. */
  scopes: unknown;
}
export interface ReadRequest { domainId: string; env: SecretEnv; names?: string[] }
export interface ReadSecret { name: string; version: number; value: string }

export const MAX_READ = 100;
export const READ_CONCURRENCY = 10;
export const READ_LIMITS = {
  tokenMinute: { bucket: "vault.read.token.m", max: 20, windowSeconds: 60 } satisfies Limit,
  tokenDay: { bucket: "vault.read.token.d", max: 500, windowSeconds: 86_400 } satisfies Limit,
  prodHour: { bucket: "vault.read.token.prod.h", max: 6, windowSeconds: 3600 } satisfies Limit,
};

export interface ScopeEntry { capability: string; domain_id: string; env: string | null }

/**
 * Scopes as stored in `bindings.scopes` (PLAN 4.4: capability, resolved `domain_id` or `*`, env). Accepts objects
 * `{capability, domain_id, env}` and the string form `capability:domain_id:env`. Anything else is ignored (fails closed).
 */
export function parseScopes(raw: unknown): ScopeEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ScopeEntry[] = [];
  for (const s of raw) {
    if (typeof s === "string") {
      const [capability, domain_id, env] = s.split(":");
      if (capability && domain_id) out.push({ capability, domain_id, env: env ?? null });
    } else if (s && typeof s === "object") {
      const o = s as Record<string, unknown>;
      const capability = typeof o.capability === "string" ? o.capability : typeof o.cap === "string" ? o.cap : null;
      const domain_id = typeof o.domain_id === "string" ? o.domain_id : typeof o.domain === "string" ? o.domain : null;
      if (capability && domain_id) out.push({ capability, domain_id, env: typeof o.env === "string" ? o.env : null });
    }
  }
  return out;
}

export function allowsSecretsRead(scopes: ScopeEntry[], domainId: string, env: SecretEnv): boolean {
  return scopes.some((s) => s.capability === "secrets.read" && (s.domain_id === domainId || s.domain_id === "*") && (s.env === env || (s.env === "*" && env !== "prod")));
}
/** `secrets.read` together with `dns.write`, on any domains: an injected agent could publish a value in a TXT record. */
export const holdsForbiddenPair = (scopes: ScopeEntry[]) => scopes.some((s) => s.capability === "secrets.read") && scopes.some((s) => s.capability === "dns.write");

async function mapLimited<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}

export async function readSecretsForBinding(ctx: AppContext, b: BindingRef, q: ReadRequest): Promise<ReadSecret[]> {
  const scopes = parseScopes(b.scopes);
  if (holdsForbiddenPair(scopes)) throw new HttpError(403, "scope_conflict", undefined, NO_STORE);
  if (!allowsSecretsRead(scopes, q.domainId, q.env)) throw new HttpError(403, "scope_missing", undefined, NO_STORE);
  if (q.names && (q.names.length === 0 || q.names.length > MAX_READ)) throw new HttpError(422, "invalid_request", undefined, NO_STORE);

  const limited = await withUser(ctx.runtime, b.userId, async (c) => {
    const ls: [Limit, boolean][] = [[READ_LIMITS.tokenMinute, true], [READ_LIMITS.tokenDay, true], [READ_LIMITS.prodHour, q.env === "prod"]];
    for (const [l, on] of ls) { if (!on) continue; const h = await hit(ctx, c, b.bindingId, l); if (!h.allowed) return h.retryAfterSeconds; }
    return 0;
  });
  if (limited) throw new HttpError(429, "rate_limited", undefined, { ...NO_STORE, "Retry-After": String(limited) });

  const v = vaultOf(ctx);
  const now = ctx.clock.now();
  const hourStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  let rows;
  try {
    // T1: one audit row per secret, committed before any decrypt.
    rows = await withUser(v.pool, b.userId, async (c) => {
      const rs = await loadCurrent(ctx, c, { domainId: q.domainId, env: q.env, names: q.names }, b.userId);
      if (rs.length > MAX_READ) throw new HttpError(422, "too_many_secrets", undefined, NO_STORE);
      for (const r of rs) {
        await appendAudit(ctx, c, { chainId: b.userId, actorKind: b.bindingKind, actorId: b.bindingId, action: "secret.read", resourceKind: "secret", resourceId: r.id,
          detail: { binding_id: b.bindingId, domain_id: q.domainId, env: q.env, version: r.version, decrypt_nonce: r.id } });
      }
      if (rs.length) {
        await enqueue(c, { kind: "vault.read_digest", userId: b.userId, payload: { user_id: b.userId, binding_id: b.bindingId, hour: hourStart.toISOString() },
          dedupeKey: `vault.read_digest:${b.bindingId}:${hourStart.toISOString()}`, runAt: new Date(hourStart.getTime() + 3_600_000) });
      }
      await vaultAlarms(ctx, c, b.userId);
      return rs;
    });
  } catch (e) {
    throw await vaultFailure(ctx, e, q.domainId);
  }
  try {
    return await mapLimited(rows, READ_CONCURRENCY, async (r) => {
      const buf = await openRow(ctx, r);
      const value = buf.toString("utf8");
      buf.fill(0);
      return { name: r.name, version: r.version, value };
    });
  } catch (e) {
    await withUser(v.pool, b.userId, (c) => appendAudit(ctx, c, { chainId: b.userId, actorKind: b.bindingKind, actorId: b.bindingId, action: "secret.read.failed", resourceKind: "domain", resourceId: q.domainId, detail: { env: q.env, count: rows.length } })).catch(() => undefined);
    throw await vaultFailure(ctx, e, q.domainId);
  }
}
