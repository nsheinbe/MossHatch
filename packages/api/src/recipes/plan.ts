import type { PoolClient } from "@mosshatch/db";
import type { DnsRecord } from "@mosshatch/registrar/port";
import { canonicalZone, normalizeRecord, validateZone, zoneHash } from "@mosshatch/registrar/dns";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import type { Principal } from "../http/types.ts";
import { hashOf } from "../util/bytes.ts";
import { mapRegistrarError, registrarOf, type DomainRow } from "../domain-mgmt/common.ts";
import { checkShape, diffZones, sensitiveOf, type Sensitive } from "../domain-mgmt/dns.ts";
import { normalizeSecretName, type NameRejection } from "../vault/names.ts";
import { allows, lintScopes, storedScopes } from "../bindings/scopes.ts";
import { recipeById, type ConnFacts, type Env, type PlanParts, type Recipe, type Service } from "./registry.ts";

/**
 * A plan is everything an apply will do, as data: the DNS records added and removed against the live zone (and that
 * zone's hash), the variable names and where each goes, every provider step with its cost class, the connections used,
 * and the sensitive records among the DNS changes. It never holds a value. Its SHA-256 over canonical JSON is what an
 * approval binds and what apply recomputes and compares, so the applied set equals the previewed set (ST-86).
 */

export interface Plan extends PlanParts {
  v: 1;
  recipe: string;
  version: number;
  domain_id: string;
  fqdn: string;
  input: unknown;
  zone_before: string | null;
  connections: { service: Service; id: string }[];
  sensitive: Sensitive[];
  touched: { dns: boolean; envs: Env[] };
}

const keyOf = (r: DnsRecord) => JSON.stringify(normalizeRecord(r));

export const planHash = (p: Plan): Buffer => hashOf(p);

/** A provider step that creates a resource, or whose cost is not known to be free, needs the plan-hash approval whoever asks. */
export const needsApproval = (p: Plan): boolean => p.sensitive.length > 0 || p.steps.some((s) => s.creates_resource || s.cost !== "free");

export async function loadConnections(c: PoolClient, userId: string, domainId: string): Promise<Map<Service, ConnFacts>> {
  const r = await c.query("select id, service, external_ref, provider_facts, checked_at from connections where user_id = $1 and domain_id = $2 and ended_at is null and status = 'active'", [userId, domainId]);
  return new Map(r.rows.map((x) => [x.service as Service, { id: x.id, service: x.service, externalRef: x.external_ref, facts: x.provider_facts ?? {}, checkedAt: x.checked_at ? new Date(x.checked_at).toISOString() : null }]));
}

export async function liveZoneOrNull(ctx: AppContext, d: Pick<DomainRow, "fqdn_ascii">): Promise<DnsRecord[] | null> {
  try {
    const z = await registrarOf(ctx).getDns(d.fqdn_ascii);
    return z.hosted ? canonicalZone(z.records) : null;
  } catch (e) { throw mapRegistrarError(e); }
}

/** Compute the plan from current state. Pure given its inputs; called at plan time, at apply and again inside the job. */
export async function computePlan(ctx: AppContext, c: PoolClient, userId: string, d: Pick<DomainRow, "id" | "fqdn_ascii">, recipe: Recipe, rawInput: unknown): Promise<Plan> {
  const parsed = recipe.input.safeParse(rawInput ?? {});
  if (!parsed.success) throw new HttpError(422, "invalid_input");
  const conns = await loadConnections(c, userId, d.id);
  const live = recipe.touchesDns ? await liveZoneOrNull(ctx, d) : null;
  const parts = recipe.build({ fqdn: d.fqdn_ascii, domainId: d.id, live, conns }, parsed.data);
  const add = canonicalZone(parts.dns.add), remove = canonicalZone(parts.dns.remove);
  if (live && (add.length || remove.length)) {
    const rm = new Set(remove.map(keyOf));
    const desired = canonicalZone([...live.filter((r) => !rm.has(keyOf(r))), ...add]);
    checkShape(desired);
    validateZone(desired);
  }
  const rmKeys = new Set(remove.map(keyOf));
  const sensitive = sensitiveOf(d.fqdn_ascii, diffZones(live ?? [], canonicalZone([...(live ?? []).filter((r) => !rmKeys.has(keyOf(r))), ...add])));
  // Pending provider records are sensitive too (DKIM, MX): their approval is the provider step's approval.
  const envs = new Set<Env>();
  for (const v of parts.variables) for (const t of v.targets) envs.add(t.env);
  const services = [...new Set(parts.services)].sort();
  return {
    v: 1, recipe: recipe.id, version: recipe.version, domain_id: d.id, fqdn: d.fqdn_ascii, input: parsed.data,
    zone_before: recipe.touchesDns && live ? zoneHash(live) : null,
    dns: { add, remove }, pending_records: parts.pending_records, variables: parts.variables, steps: parts.steps, services,
    connections: services.map((s) => ({ service: s, id: conns.get(s)!.id })),
    sensitive,
    touched: { dns: add.length + remove.length > 0, envs: [...envs].sort() },
  };
}

/** Variable names get the same grammar and reserved-list check as every other writer (ST-88). */
export function checkVariableNames(p: Plan): { ok: true } | { ok: false; reasons: Partial<Record<NameRejection, number>> } {
  const reasons: Partial<Record<NameRejection, number>> = {};
  for (const v of p.variables) { const n = normalizeSecretName(v.name); if (!n.ok || n.name !== v.name) { const r = n.ok ? "grammar" : n.reason; reasons[r] = (reasons[r] ?? 0) + 1; } }
  return Object.keys(reasons).length ? { ok: false, reasons } : { ok: true };
}

/**
 * Bearer authority over a plan (PLAN 4.5 Recipes): `recipes.apply` is an authorization to run a plan, not a bypass. The
 * touched set comes from the hash-checked plan: `recipes.apply` for the domain (and each env written), `dns.write` for any
 * DNS step, `secrets.write` for each env written; a `prod` target needs an explicit `:prod`. Anything missing is 403.
 */
export function assertApplyScopes(principal: Principal, p: Plan): void {
  if (principal.kind === "session") return;
  if (principal.kind !== "binding") throw new HttpError(403, "forbidden_principal");
  const scopes = storedScopes(principal.scopes);
  if (lintScopes(scopes)) throw new HttpError(403, "scope_conflict");
  const d = p.domain_id;
  const missing = (cap: Parameters<typeof allows>[1], env: Env | null) => !allows(scopes, cap, d, env);
  if (p.touched.envs.length === 0 ? missing("recipes.apply", null) : p.touched.envs.some((e) => missing("recipes.apply", e))) throw new HttpError(403, "scope_missing");
  if (p.touched.dns && missing("dns.write", null)) throw new HttpError(403, "scope_missing");
  for (const e of p.touched.envs) if (missing("secrets.write", e)) throw new HttpError(403, "scope_missing");
}

export function assertPlanScopes(principal: Principal, domainId: string): void {
  if (principal.kind === "session") return;
  if (principal.kind !== "binding") throw new HttpError(403, "forbidden_principal");
  const scopes = storedScopes(principal.scopes);
  if (lintScopes(scopes)) throw new HttpError(403, "scope_conflict");
  if (!allows(scopes, "recipes.plan", domainId, null) && !allows(scopes, "recipes.apply", domainId, null)) throw new HttpError(403, "scope_missing");
}

export function recipeOr404(id: string | undefined): Recipe {
  const r = recipeById(id ?? "");
  if (!r) throw new HttpError(404, "not_found");
  return r;
}

/** What a person or agent sees: the records (public anyway) and variable names, never a value. */
export function planView(p: Plan, hash: Buffer, needs: boolean) {
  return {
    recipe: p.recipe, version: p.version, domain: p.fqdn, plan_hash: hash.toString("hex"), needs_approval: needs,
    dns: { add: p.dns.add.map((r) => ({ ...r, name: r.name === "" ? "@" : r.name })), remove: p.dns.remove.map((r) => ({ ...r, name: r.name === "" ? "@" : r.name })) },
    pending_records: p.pending_records,
    variables: p.variables.map((v) => ({ name: v.name, targets: v.targets.map((t) => (t.kind === "nest" ? `nest:${t.env}` : `vercel:${t.target}`)) })),
    steps: p.steps, sensitive: p.sensitive.map((s) => ({ type: s.type, name: s.name === "" ? "@" : s.name, reasons: s.reasons })),
    fidelity: p.pending_records.length ? "pending_provider_create" : "exact",
  };
}
