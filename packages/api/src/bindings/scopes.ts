import { domainToASCII, domainToUnicode } from "node:url";
import type { PoolClient } from "@mosshatch/db";
import { HttpError } from "../http/router.ts";
import type { Principal } from "../http/types.ts";

/**
 * Scope vocabulary (PLAN 4.5). Grammar `capability:resource[:env]`, lower-case ASCII, no globs. The resource is `*` or one
 * of the caller's own live domains, stored as its `domain_id` and shown as its `fqdn_ascii` (a display label only). Unknown
 * scopes fail closed. Stored form in `bindings.scopes`: `{capability, domain_id, env, label}`.
 */

export const CAPABILITIES = [
  "domains.read", "dns.read", "dns.write", "nameservers.propose", "nest.names", "secrets.read", "secrets.write",
  "recipes.plan", "recipes.apply", "register.propose", "renew.propose", "transfer.status",
  // C-34: an agent may turn auto-renew off (never on); used by the domains module's DELETE /domains/:id/auto-renew.
  "mandate.off",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const ENVS = ["dev", "preview", "prod"] as const;
export type Env = (typeof ENVS)[number];
type EnvSel = Env | "*";

const ENV_REQUIRED = new Set<Capability>(["secrets.read", "secrets.write", "recipes.apply", "nest.names"]);
const ENV_OPTIONAL = new Set<Capability>(["recipes.plan"]);
const STAR_ONLY = new Set<Capability>(["register.propose"]);

export interface Scope { capability: Capability; domain_id: string; env: EnvSel | null; label: string }

export class ScopeError extends Error { constructor(public reason: string) { super(reason); } }

const FQDN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A name is accepted only in its own normalized A-label form: no upper case, no trailing dot, no Unicode, no punycode variant. */
export function isNormalizedFqdn(s: string): boolean {
  if (!FQDN_RE.test(s)) return false;
  let back: string;
  try { back = domainToASCII(domainToUnicode(s)); } catch { return false; }
  return back === s;
}

/** Parse one scope string against the caller's owned domains (fqdn to id). Throws ScopeError with a reason code. */
export function parseScope(raw: string, owned: ReadonlyMap<string, string>): Scope {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 300) throw new ScopeError("malformed");
  if (raw !== raw.toLowerCase()) throw new ScopeError("upper_case");
  if (/[?[\]{}]/.test(raw) || /\*[^:]|[^:]\*/.test(raw)) throw new ScopeError("glob");
  if (!/^[\x21-\x7e]+$/.test(raw)) throw new ScopeError("not_ascii");
  const parts = raw.split(":");
  if (parts.length < 2 || parts.length > 3) throw new ScopeError("malformed");
  const [cap, res, env] = parts as [string, string, string | undefined];
  if (cap === "*") throw new ScopeError("star_capability");
  if (!(CAPABILITIES as readonly string[]).includes(cap)) throw new ScopeError("unknown_capability");
  const capability = cap as Capability;
  if (capability === "nameservers.propose" && res === "*") throw new ScopeError("domain_required");
  let envSel: EnvSel | null = null;
  if (env !== undefined) {
    if (!ENV_REQUIRED.has(capability) && !ENV_OPTIONAL.has(capability)) throw new ScopeError("env_forbidden");
    if (env !== "*" && !(ENVS as readonly string[]).includes(env)) throw new ScopeError("unknown_env");
    envSel = env as EnvSel;
  } else if (ENV_REQUIRED.has(capability)) throw new ScopeError("env_missing");
  let domainId: string, label: string;
  if (res === "*") { domainId = "*"; label = "*"; }
  else {
    if (STAR_ONLY.has(capability)) throw new ScopeError("star_only");
    if (res.endsWith(".")) throw new ScopeError("trailing_dot");
    if (!isNormalizedFqdn(res)) throw new ScopeError("unnormalized_name");
    const id = owned.get(res);
    if (!id) throw new ScopeError("unowned_domain");
    domainId = id; label = res;
  }
  if (capability === "secrets.read" && domainId === "*" && (envSel === "*" || envSel === "prod")) throw new ScopeError("secrets_read_star_prod");
  return { capability, domain_id: domainId, env: envSel, label };
}

/** Parse a list; duplicates collapse. At most 50 scopes per binding. */
export function parseScopes(raw: unknown, owned: ReadonlyMap<string, string>): Scope[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) throw new ScopeError("malformed");
  const out = new Map<string, Scope>();
  for (const s of raw) { const p = parseScope(s as string, owned); out.set(`${p.capability}|${p.domain_id}|${p.env}`, p); }
  return [...out.values()].sort((a, b) => key(a).localeCompare(key(b)));
}
const key = (s: Pick<Scope, "capability" | "domain_id" | "env">) => `${s.capability}|${s.domain_id}|${s.env ?? ""}`;

/** Token-wide lint at creation and at any widening (PLAN 4.5). Returns a reason code, or null when clean. */
export function lintScopes(scopes: readonly Pick<Scope, "capability" | "domain_id" | "env">[]): string | null {
  if (scopes.some((s) => s.capability === "secrets.read") && scopes.some((s) => s.capability === "dns.write")) return "secrets_read_with_dns_write";
  if (scopes.some((s) => s.capability === "secrets.read" && s.domain_id === "*" && (s.env === "prod" || s.env === "*"))) return "secrets_read_star_prod";
  return null;
}

/** The stored scopes of a binding, read defensively: anything that is not a known well-formed entry is dropped (fails closed). */
export function storedScopes(raw: unknown): Scope[] {
  if (!Array.isArray(raw)) return [];
  const out: Scope[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (!(CAPABILITIES as readonly string[]).includes(o.capability as string) || typeof o.domain_id !== "string") continue;
    if (o.capability === "nameservers.propose" && o.domain_id === "*") continue;
    const env = o.env === null || o.env === undefined ? null : (["dev", "preview", "prod", "*"].includes(o.env as string) ? o.env as EnvSel : undefined);
    if (env === undefined) continue;
    out.push({ capability: o.capability as Capability, domain_id: o.domain_id, env, label: typeof o.label === "string" ? o.label : o.domain_id });
  }
  return out;
}

/** Does `s` cover the (capability, domain, env) asked for? `*` covers any domain; an env `*` never covers `prod`. */
export function covers(s: Pick<Scope, "capability" | "domain_id" | "env">, capability: string, domainId: string, env: Env | null): boolean {
  if (s.capability !== capability) return false;
  if (capability === "nameservers.propose" && s.domain_id === "*") return false;
  if (s.domain_id !== "*" && s.domain_id !== domainId) return false;
  if (env === null) return true;
  return s.env === env || (s.env === "*" && env !== "prod");
}
export const allows = (scopes: readonly Scope[], capability: Capability, domainId: string, env: Env | null) => scopes.some((s) => covers(s, capability, domainId, env));

/** Coverage of one proposed entry by one stored entry, for the widening classifier. */
function entryCovered(stored: Pick<Scope, "capability" | "domain_id" | "env">, p: Pick<Scope, "capability" | "domain_id" | "env">): boolean {
  if (stored.capability !== p.capability) return false;
  if (stored.capability === "nameservers.propose" && (stored.domain_id === "*" || p.domain_id === "*")) return false;
  if (stored.domain_id !== "*" && stored.domain_id !== p.domain_id) return false;
  if (stored.env === p.env) return true;
  if (p.env === null) return stored.env === null;
  if (stored.env === "*") return p.env !== "prod" && p.env !== "*";
  return false;
}

export interface Grant { scopes: readonly Pick<Scope, "capability" | "domain_id" | "env">[]; capMinor: bigint; expiresAt: Date }

/**
 * The widening classifier (ST-64): a change is a narrowing only if every proposed entry is covered by a stored one, the cap
 * is not higher and the expiry not later. Anything else, including any parse doubt (pass `null`), is a widening.
 */
export function isNarrowing(before: Grant, after: Grant | null): boolean {
  if (!after) return false;
  if (!Array.isArray(after.scopes) || after.scopes.length === 0) return false;
  if (after.capMinor > before.capMinor) return false;
  if (!(after.expiresAt instanceof Date) || Number.isNaN(after.expiresAt.getTime()) || after.expiresAt.getTime() > before.expiresAt.getTime()) return false;
  return after.scopes.every((p) => before.scopes.some((s) => entryCovered(s, p)));
}

/** The caller's live domains, fqdn to id (runtime role, under the caller's tenant context). */
export async function ownedDomainMap(c: PoolClient, userId: string): Promise<Map<string, string>> {
  const r = await c.query("select id, fqdn_ascii from domains where user_id = $1 and released_at is null", [userId]);
  return new Map(r.rows.map((x) => [x.fqdn_ascii as string, x.id as string]));
}

/** Scope strings for display (`capability:fqdn[:env]`). */
export const scopeString = (s: Pick<Scope, "capability" | "label" | "env">) => `${s.capability}:${s.label}${s.env ? `:${s.env}` : ""}`;

/**
 * Bearer carve-out check: the binding must hold `capability` on the domain (and env). A session principal passes (its own
 * authority is the ownership join the handler already did). A missing scope is 403, never an empty answer.
 */
export function requireScope(p: Principal, capability: Capability, domainId: string, env: Env | null): void {
  if (p.kind === "session") return;
  if (p.kind !== "binding") throw new HttpError(403, "forbidden_principal");
  const scopes = storedScopes(p.scopes);
  if (lintScopes(scopes)) throw new HttpError(403, "scope_conflict");
  if (!allows(scopes, capability, domainId, env)) throw new HttpError(403, "scope_missing");
}
