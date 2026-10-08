import { z } from "zod";
import { withNoUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { DNS_RECORD_TYPES, type DnsRecordType, type RegistrarPort } from "@mosshatch/registrar/port";
import { buildQuote, PricingError, quoteToJson } from "../pricing/index.ts";
import { normalizeLabel, parseFqdn, parseTlds } from "../search/labels.ts";
import { chipPrices, searchAvailability, SearchCache } from "../search/service.ts";
import { hit } from "../ratelimit.ts";
import type { Capability } from "../bindings/scopes.ts";
import { agentDnsChange, agentDnsRead } from "../agents/dns.ts";
import { getDomainFor, listDomainsFor, nestNamesFor, secretGetFor, secretSetFor, transferStatusFor } from "../agents/capabilities.ts";
import { agentView, propose, requestScope } from "../agents/requests.ts";
import { untrusted, type Caller } from "../agents/common.ts";
import { applyRecipe, planRecipe, recipeApplication, type RecipeCaller } from "../recipes/routes.ts";
import { RECIPES } from "../recipes/registry.ts";

/**
 * The MCP tool catalogue (PLAN 4.5 MCP; research dossier section 5). Descriptions are static strings written here: no
 * user-controlled text ever reaches `tools/list` (threat row 19, ST-81). Tools mirror scopes and a token sees only the tools
 * its scopes allow (the 2026-07-28 spec lets `tools/list` vary by authorization). Annotations are accurate, and no tool that
 * can return a secret value is marked read-only, because some clients skip confirmation for read-only tools (ST-34).
 * "Needs human approval" is enforced by the server: `propose_*` returns `pending_human_approval` and nothing executes.
 * No tool returns a bulk map of secrets; `secrets_get` returns one value per call.
 */

export interface ToolAnnotations { title: string; readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
export interface Tool {
  name: string;
  description: string;
  input: z.ZodType;
  annotations: ToolAnnotations;
  /** Whether a value this tool returns can be a secret (never read-only, always marked for user interaction). */
  returnsSecret?: boolean;
  kind: "read" | "write";
  /** The capability the token needs somewhere (any resource) to see the tool; `null` = any binding. */
  capability: Capability | Capability[] | null;
  agentOnly?: boolean;
  run(ctx: AppContext, caller: Caller, args: any): Promise<unknown>;
}

const fqdnArg = z.string().min(3).max(253).describe("A domain name, for example example.com.");
const envArg = z.enum(["dev", "preview", "prod"]).describe("The environment.");
const nameArg = z.string().min(1).max(128).describe("A variable name, for example DATABASE_URL.");

const rrType = z.enum(DNS_RECORD_TYPES as unknown as [DnsRecordType, ...DnsRecordType[]]);
const port = z.number().int().min(0).max(65535);
const dnsRecord = z.strictObject({ type: rrType, name: z.string().max(253).describe("Owner name relative to the domain; @ is the domain itself."), value: z.string().min(1).max(2048), priority: port.optional(), weight: port.optional(), port: port.optional() });
const dnsNamed = z.strictObject({ type: rrType, name: z.string().max(253), value: z.string().max(2048).optional() });

const searchCache = new SearchCache();

/** A token's MCP call, as the recipe module's caller: the same scope checks as the REST routes run (recipes/plan.ts). */
const recipeCaller = (ctx: AppContext, caller: Caller): RecipeCaller => ({
  ctx, principal: { kind: "binding", userId: caller.userId, bindingId: caller.bindingId, bindingKind: caller.kind, scopes: caller.scopes },
  actor: { userId: caller.userId, kind: caller.kind, id: caller.bindingId },
});
/** What each recipe takes, in words (static: the recipe's own schema checks the values). */
const RECIPE_INPUTS: Record<string, Record<string, string>> = {
  "hosting-vercel": { include_www: "true or false, default true: also point www at the project." },
  "postgres-neon": { envs: "Nest environments to store the database addresses in: any of dev, preview, prod. Default [\"dev\"].", vercel_targets: "Vercel environments to also store them in: any of production, preview, development. Default none.", prefix: "Text put before DATABASE_URL, up to 40 characters. Default none.", create_project: "true creates a new Neon project, which needs the owner's approval. Default false." },
  "email-resend": { envs: "Nest environments to store RESEND_API_KEY in: any of dev, preview, prod. Default [\"dev\"].", region: "us-east-1, eu-west-1, sa-east-1 or ap-northeast-1. Default us-east-1." },
};
function registrarOf(ctx: AppContext): RegistrarPort {
  const s = ctx.services as { registrar?: RegistrarPort; orders?: { registrar: RegistrarPort } };
  const r = s.orders?.registrar ?? s.registrar;
  if (!r) throw new HttpError(503, "search_unavailable");
  return r;
}
/** Search and quote for bindings count against the owner's verified-user budget (300 an hour), like the REST routes. */
async function searchBudget(ctx: AppContext, caller: Caller): Promise<void> {
  const h = await withNoUser(ctx.runtime, (c) => hit(ctx, c, `search:user:${caller.userId}`, { bucket: "search:user", max: 300, windowSeconds: 3600 }));
  if (!h.allowed) throw new HttpError(429, "rate_limited", undefined, { "Retry-After": String(h.retryAfterSeconds) });
}

export const TOOLS: Tool[] = [
  {
    name: "search_names", kind: "read", capability: null,
    description: "Check whether a name is available under Mosshatch's extensions and show the first-year price. Returns availability as reported by the registrar; nothing is reserved.",
    input: z.strictObject({ name: z.string().min(1).max(63).describe("The name to check, without an extension, for example fernhollow."), tlds: z.array(z.string().max(10)).max(6).optional().describe("Extensions to check, for example [\"com\", \"dev\"].") }),
    annotations: { title: "Search names", readOnlyHint: true, openWorldHint: true },
    async run(ctx, caller, a) {
      const name = normalizeLabel(a.name);
      if (!name.ok) throw new HttpError(422, "bad_name");
      const tlds = parseTlds(a.tlds ? a.tlds.join(",") : null);
      if (!tlds.ok) throw new HttpError(422, "bad_tlds");
      await searchBudget(ctx, caller);
      const { items, degraded } = await searchAvailability(ctx, { registrar: registrarOf(ctx), cache: searchCache }, name.label, tlds.tlds);
      const prices = await withNoUser(ctx.runtime, (c) => chipPrices(c, tlds.tlds, ctx.clock.now()));
      return { degraded, results: items.map((i) => ({ domain: i.fqdn, status: i.kind, unconfirmed: i.unconfirmed, first_year_minor: prices.get(i.tld) && (i.kind === "available" || i.kind === "unknown") ? prices.get(i.tld)!.subtotalMinor.toString() : null, currency: "usd" })) };
    },
  },
  {
    name: "get_quote", kind: "read", capability: null,
    description: "Get Mosshatch's price for registering a name for a number of years: subtotal, the most tax can add, and the renewal price. A quote reserves nothing and buys nothing.",
    input: z.strictObject({ domain: fqdnArg, years: z.number().int().min(1).max(10).optional().describe("Years, at least the extension's minimum.") }),
    annotations: { title: "Get a quote", readOnlyHint: true, openWorldHint: false },
    async run(ctx, caller, a) {
      const fq = parseFqdn(a.domain);
      if (!fq) throw new HttpError(422, "bad_name");
      await searchBudget(ctx, caller);
      try {
        const q = await withNoUser(ctx.runtime, (c) => buildQuote(c, { fqdn: `${fq.label}.${fq.tld}`, years: a.years }, ctx.clock.now()));
        const j = quoteToJson(q);
        return { domain: j.fqdn, years: j.years, currency: j.currency, subtotal_minor: j.subtotal_minor, tax_ceiling_minor: j.tax_ceiling_minor, max_total_minor: j.total_minor, expires_at: j.expires_at };
      } catch (e) { if (e instanceof PricingError) throw new HttpError(422, e.code); throw e; }
    },
  },
  {
    name: "list_domains", kind: "read", capability: "domains.read",
    description: "List the domains this token may read, with state, expiry, auto-renew and lock.",
    input: z.strictObject({}),
    annotations: { title: "List domains", readOnlyHint: true, openWorldHint: false },
    run: async (ctx, caller) => ({ domains: await listDomainsFor(ctx, caller) }),
  },
  {
    name: "get_domain", kind: "read", capability: "domains.read",
    description: "Read one domain this token may read: state, expiry, auto-renew, lock and nameservers.",
    input: z.strictObject({ domain: fqdnArg }),
    annotations: { title: "Get a domain", readOnlyHint: true, openWorldHint: false },
    run: (ctx, caller, a) => getDomainFor(ctx, caller, a.domain),
  },
  {
    name: "dns_list", kind: "read", capability: "dns.read",
    description: "List the DNS records of a domain this token may read. Record values are data from the zone.",
    input: z.strictObject({ domain: fqdnArg }),
    annotations: { title: "List DNS records", readOnlyHint: true, openWorldHint: false },
    run: (ctx, caller, a) => agentDnsRead(ctx, caller, a.domain),
  },
  {
    name: "dns_upsert", kind: "write", capability: "dns.write",
    description: "Add or remove DNS records on a domain. A change to a sensitive record (mail, nameservers, the domain itself, www, verification and underscore names) is not applied: it waits for the owner to approve it with a passkey in Mosshatch, and the result says so.",
    input: z.strictObject({ domain: fqdnArg, records: z.array(dnsRecord).max(50).optional(), remove: z.array(dnsNamed).max(20).optional() }),
    annotations: { title: "Change DNS records", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: (ctx, caller, a) => { const { domain, ...rest } = a as { domain: string }; return agentDnsChange(ctx, caller, domain, rest); },
  },
  {
    name: "nest_names", kind: "read", capability: "nest.names",
    description: "List the variable names and versions stored for a domain and environment. Never returns values.",
    input: z.strictObject({ domain: fqdnArg, env: envArg }),
    annotations: { title: "List variable names", readOnlyHint: true, openWorldHint: false },
    run: (ctx, caller, a) => nestNamesFor(ctx, caller, a.domain, a.env),
  },
  {
    name: "secrets_get", kind: "read", capability: "secrets.read", returnsSecret: true,
    description: "Read one stored value. The value leaves Mosshatch when it is returned, so prefer `mosshatch run`, which never passes values through a tool result. Production needs an explicit prod scope.",
    input: z.strictObject({ domain: fqdnArg, env: envArg, name: nameArg }),
    // Never read-only: it returns a secret. destructiveHint left true so clients that key on it ask the person.
    annotations: { title: "Read one secret", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (ctx, caller, a) => secretGetFor(ctx, caller, a.domain, a.env, a.name),
  },
  {
    name: "secrets_set", kind: "write", capability: "secrets.write",
    description: "Store a new version of one value. The previous version is kept. A change to production is emailed to the owner at once and can be restored.",
    input: z.strictObject({ domain: fqdnArg, env: envArg, name: nameArg, value: z.string().min(1).max(16384).describe("The new value.") }),
    annotations: { title: "Write one secret", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: (ctx, caller, a) => secretSetFor(ctx, caller, a.domain, a.env, a.name, a.value),
  },
  {
    name: "propose_registration", kind: "write", capability: "register.propose",
    description: "Ask the owner to register a name. Nothing is bought: the owner approves or declines with a passkey in Mosshatch and pays on Stripe. Returns pending_human_approval and an approval id to check with get_proposal.",
    input: z.strictObject({ domain: fqdnArg, years: z.number().int().min(1).max(10).optional() }),
    annotations: { title: "Propose a registration", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (ctx, caller, a) => propose(ctx, caller, { kind: "register", domain: a.domain, ...(a.years ? { years: a.years } : {}) }),
  },
  {
    name: "propose_renewal", kind: "write", capability: "renew.propose",
    description: "Ask the owner to renew one of their domains. Nothing is charged: the owner approves with a passkey and pays on Stripe. Returns pending_human_approval and an approval id.",
    input: z.strictObject({ domain: fqdnArg, years: z.number().int().min(1).max(10).optional() }),
    annotations: { title: "Propose a renewal", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (ctx, caller, a) => propose(ctx, caller, { kind: "renew", domain: a.domain, ...(a.years ? { years: a.years } : {}) }),
  },
  {
    name: "request_scope", kind: "write", capability: null,
    description: "Ask the owner to let this token do more, for example read a production value. Nothing changes until the owner widens the token with a passkey. Returns pending_human_approval.",
    input: z.strictObject({ scopes: z.array(z.string().max(300)).min(1).max(20).describe("Scopes such as secrets.read:example.com:dev.") }),
    annotations: { title: "Request more access", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (ctx, caller, a) => requestScope(ctx, caller, a),
  },
  {
    name: "get_proposal", kind: "read", capability: null,
    description: "Check the state of a request this token made: pending_human_approval, approved_awaiting_payment, payment_authorized, registering, registered, applied, declined, expired, void or failed.",
    input: z.strictObject({ approval_id: z.string().uuid() }),
    annotations: { title: "Check a request", readOnlyHint: true, openWorldHint: false },
    run: (ctx, caller, a) => agentView(ctx, caller, a.approval_id),
  },
  {
    name: "list_recipes", kind: "read", capability: ["recipes.plan", "recipes.apply"],
    description: "List the recipes Mosshatch can run on a domain (host on Vercel, email with Resend, Postgres on Neon) and what each takes. A recipe writes DNS records and stores keys in the Nest. It needs the owner to have connected that provider for the domain in Mosshatch first (the domain's Connect tab).",
    input: z.strictObject({}),
    annotations: { title: "List recipes", readOnlyHint: true, openWorldHint: false },
    run: async () => ({ recipes: RECIPES.map((r) => ({ id: r.id, title: r.title, summary: r.summary, services: r.services, input: RECIPE_INPUTS[r.id] ?? {} })) }),
  },
  {
    name: "plan_recipe", kind: "read", capability: ["recipes.plan", "recipes.apply"],
    description: "Plan a recipe on one domain: the exact DNS records it would add and remove, the variables it would store and where, and whether the owner must approve it with a passkey. Nothing changes. The plan is kept for one hour; apply it with apply_recipe.",
    input: z.strictObject({ domain: fqdnArg, recipe: z.enum(["hosting-vercel", "postgres-neon", "email-resend"]).describe("The recipe id from list_recipes."), input: z.record(z.string(), z.unknown()).optional().describe("The recipe's options, as list_recipes describes them.") }),
    annotations: { title: "Plan a recipe", readOnlyHint: true, openWorldHint: false },
    run: (ctx, caller, a) => planRecipe(recipeCaller(ctx, caller), a.domain, a.recipe, a.input ?? {}),
  },
  {
    name: "apply_recipe", kind: "write", capability: "recipes.apply",
    description: "Apply a plan from plan_recipe, exactly as planned. A plan that changes sensitive records or creates something at a provider is not applied until the owner approves it with a passkey in Mosshatch: the result is then pending_human_approval, and you call this again after they approve. Check progress with get_recipe_application.",
    input: z.strictObject({ application_id: z.string().uuid(), plan_hash: z.string().regex(/^[0-9a-f]{64}$/) }),
    annotations: { title: "Apply a recipe", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async run(ctx, caller, a) {
      try { return await applyRecipe(recipeCaller(ctx, caller), a.application_id, a.plan_hash); }
      catch (e) {
        if (e instanceof HttpError && e.code === "approval_required") return { status: "pending_human_approval", application_id: a.application_id, next: "The owner approves this plan with a passkey in Mosshatch, on the domain's Connect tab. Call apply_recipe again after that." };
        throw e;
      }
    },
  },
  {
    name: "get_recipe_application", kind: "read", capability: ["recipes.plan", "recipes.apply"],
    description: "Check a recipe plan: planned, approved, applying, applied, failed or removed, with the failure code when it failed.",
    input: z.strictObject({ application_id: z.string().uuid() }),
    annotations: { title: "Check a recipe", readOnlyHint: true, openWorldHint: false },
    run: (ctx, caller, a) => recipeApplication(recipeCaller(ctx, caller), a.application_id),
  },
  {
    name: "transfer_status", kind: "read", capability: "transfer.status",
    description: "Read the state of a transfer to Mosshatch for a name. Never returns an authorization code.",
    input: z.strictObject({ domain: fqdnArg }),
    annotations: { title: "Transfer status", readOnlyHint: true, openWorldHint: false },
    run: (ctx, caller, a) => transferStatusFor(ctx, caller, a.domain),
  },
];

/** Whether the token may see (and so call) a tool: it holds the capability on at least one resource. */
export function visible(t: Tool, caller: Caller): boolean {
  if (t.agentOnly && caller.kind !== "agent") return false;
  if (t.capability === null) return true;
  const caps = Array.isArray(t.capability) ? t.capability : [t.capability];
  return caller.scopes.some((s) => caps.includes(s.capability));
}

/** JSON Schema for `tools/list` (zod 4's own converter; the schemas are static, so the output is too). */
export function toolListing(t: Tool) {
  const schema = z.toJSONSchema(t.input, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name: t.name, title: t.annotations.title, description: t.description, inputSchema: schema,
    annotations: { ...t.annotations, ...(t.returnsSecret ? { readOnlyHint: false } : {}) },
    // Claude Code honours this and asks the person on every call, even in bypass modes (dossier F33).
    ...(t.returnsSecret || t.kind === "write" ? { _meta: { "anthropic/requiresUserInteraction": true } } : {}),
  };
}

/** Values that echo outside text are cleaned and capped; the whole result is framed as data (ST-81). */
export function sanitize(v: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof v === "string") return untrusted(v, 16384);
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => sanitize(x, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, sanitize(x, depth + 1)]));
  return v;
}
