import { z } from "zod";
import { withUser, type PoolClient } from "@mosshatch/db";
import type { Router } from "../http/router.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult, Principal, Route } from "../http/types.ts";
import type { AppContext } from "../ports.ts";
import { appendAudit } from "../audit.ts";
import { hit } from "../ratelimit.ts";
import { enqueue } from "../jobs/registry.ts";
import { markExecuted, requireAction } from "../stepup/gate.ts";
import { registerActionSpec, type ActionSpec } from "../stepup/specs.ts";
import { ownedDomain } from "../domain-mgmt/common.ts";
import { disconnect } from "../vault/connections.ts";
import { safeEqual } from "../util/bytes.ts";
import { assertApplyScopes, assertPlanScopes, checkVariableNames, computePlan, needsApproval, planHash, planView, recipeOr404, type Plan } from "./plan.ts";
import { RECIPES, type Service } from "./registry.ts";
import { RecipeFail, registerRecipeJobs, writeRecipeZone } from "./apply.ts";
import type { DnsRecord } from "@mosshatch/registrar/port";
import { tldNotices } from "../closure/tld-https.ts";

/**
 * Wire-it routes (PLAN 4.5 Recipes and Connections). A plan is a dry run that stores exactly what apply will do and its
 * hash; apply recomputes the plan, compares hashes, checks the bearer's touched set, and requires the plan-hash approval
 * (`dns.sensitive.approve`) when the plan has a sensitive record or a step that creates a provider resource, whoever
 * started it. One approval covers one plan. The work runs in the `recipe.apply` job.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_TTL_MS = 60 * 60_000;
const PLAN_LIMIT = { bucket: "recipes.plan", max: 30, windowSeconds: 3600 };
const notFound = () => new HttpError(404, "not_found");

type Actor = { userId: string; kind: "user" | "cli" | "agent"; id: string };
/** Who is asking, from either door: a session or a bearer token over REST, or a token over MCP (mcp/tools.ts builds the same). */
export interface RecipeCaller { ctx: AppContext; principal: Principal; actor: Actor }

export function actorOf(p: Principal): Actor {
  if (p.kind === "session" && p.userId) return { userId: p.userId, kind: "user", id: p.userId };
  if (p.kind === "binding" && p.userId && p.bindingId) return { userId: p.userId, kind: p.bindingKind === "cli" ? "cli" : "agent", id: p.bindingId };
  throw new HttpError(401, "unauthorized");
}
const who = (req: HandlerReq): Actor => actorOf(req.principal);
const callerFor = (req: HandlerReq): RecipeCaller => ({ ctx: req.ctx, principal: req.principal, actor: who(req) });
async function ownedOr404(ctx: AppContext, userId: string, fqdn: string) {
  try { return await withUser(ctx.runtime, userId, (c) => ownedDomain(c, userId, fqdn)); } catch { throw notFound(); }
}
const domainOf = (req: HandlerReq, userId: string) => ownedOr404(req.ctx, userId, req.params.fqdn ?? "");

async function rejectNames(ctx: AppContext, actor: Actor, domainId: string, p: Plan): Promise<void> {
  const chk = checkVariableNames(p);
  if (chk.ok) return;
  await withUser(ctx.runtime, actor.userId, (c) => appendAudit(ctx, c, { chainId: actor.userId, actorKind: actor.kind, actorId: actor.id, action: "secret.name_rejected", resourceKind: "domain", resourceId: domainId, detail: { recipe: p.recipe, reasons: chk.reasons } })).catch(() => undefined);
  throw new HttpError(422, "invalid_name");
}

async function listRecipes(): Promise<HandlerResult> {
  return json({ recipes: RECIPES.map((r) => ({ id: r.id, version: r.version, title: r.title, summary: r.summary, services: r.services })) });
}

/** POST /domains/:fqdn/recipes/:recipe/plan: the dry run. Stores the plan (no values) and its hash for one hour. */
async function plan(req: HandlerReq): Promise<HandlerResult> {
  if (req.body !== null && (typeof req.body !== "object" || Object.keys(req.body as object).some((k) => k !== "input"))) throw new HttpError(400, "invalid_request");
  const input = (req.body as { input?: unknown } | null)?.input ?? {};
  return json(await planRecipe(callerFor(req), req.params.fqdn ?? "", req.params.recipe, input), 201);
}

/** The dry run, for REST and MCP alike. */
export async function planRecipe(w: RecipeCaller, fqdn: string, recipeId: string | undefined, input: unknown) {
  const { ctx, actor } = w;
  const recipe = recipeOr404(recipeId);
  const d = await ownedOr404(ctx, actor.userId, fqdn);
  assertPlanScopes(w.principal, d.id);
  const rl = await withUser(ctx.runtime, actor.userId, (c) => hit(ctx, c, actor.id, PLAN_LIMIT));
  if (!rl.allowed) throw new HttpError(429, "rate_limited", undefined, { "Retry-After": String(rl.retryAfterSeconds) });
  const p = await withUser(ctx.runtime, actor.userId, (c) => computePlan(ctx, c, actor.userId, d, recipe, input));
  await rejectNames(ctx, actor, d.id, p);
  const hash = planHash(p), needs = needsApproval(p);
  const now = ctx.clock.now();
  const id = await withUser(ctx.runtime, actor.userId, async (c) => {
    const r = (await c.query(
      `insert into recipe_applications (user_id, domain_id, recipe_id, recipe_version, input, plan, plan_hash, needs_approval, sensitive_count, created_by_kind, created_by_id, expires_at, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [actor.userId, d.id, recipe.id, recipe.version, JSON.stringify(p.input), JSON.stringify(p), hash, needs, p.sensitive.length, actor.kind, actor.id, new Date(now.getTime() + PLAN_TTL_MS), now])).rows[0].id as string;
    await appendAudit(ctx, c, { chainId: actor.userId, actorKind: actor.kind, actorId: actor.id, action: "recipe.planned", resourceKind: "recipe_application", resourceId: r, detail: { recipe: recipe.id, version: recipe.version, needs_approval: needs, sensitive: p.sensitive.length } });
    return r;
  });
  // C-58: before a recipe writes DNS for a .dev or .app name, the plan says that the name serves over HTTPS only.
  return { application_id: id, state: "planned", expires_at: new Date(now.getTime() + PLAN_TTL_MS).toISOString(), plan: planView(p, hash, needs), notices: tldNotices(d.fqdn_ascii) };
}

const ApplyBody = z.strictObject({ application_id: z.string().regex(UUID), plan_hash: z.string().regex(/^[0-9a-f]{64}$/) });

/** POST /domains/:fqdn/recipes/:recipe/apply. Nothing is applied here: the checks pass or nothing happens, then a job runs it. */
async function apply(req: HandlerReq): Promise<HandlerResult> {
  const actor = who(req);
  const recipe = recipeOr404(req.params.recipe);
  const d = await domainOf(req, actor.userId);
  const b = ApplyBody.safeParse(req.body);
  if (!b.success) throw new HttpError(400, "invalid_request");
  return json(await applyRecipe(callerFor(req), b.data.application_id, b.data.plan_hash, { domainId: d.id, recipeId: recipe.id }), 202);
}

/** Apply a stored plan, for REST (bound to the URL's domain and recipe) and MCP (by application id) alike. */
export async function applyRecipe(w: RecipeCaller, applicationId: string, planHashHex: string, where?: { domainId: string; recipeId: string }) {
  const { ctx, actor } = w;
  if (!UUID.test(applicationId) || !/^[0-9a-f]{64}$/.test(planHashHex)) throw notFound();
  const app = await withUser(ctx.runtime, actor.userId, async (c) => (await c.query(
    "select * from recipe_applications where id = $1 and user_id = $2", [applicationId, actor.userId])).rows[0]);
  if (!app || (where && (app.domain_id !== where.domainId || app.recipe_id !== where.recipeId))) throw notFound();
  const recipe = recipeOr404(app.recipe_id);
  const d = await withUser(ctx.runtime, actor.userId, async (c) => (await c.query("select * from domains where id = $1 and user_id = $2 and released_at is null", [app.domain_id, actor.userId])).rows[0]);
  if (!d) throw notFound();
  if (!safeEqual(Buffer.from(app.plan_hash), Buffer.from(planHashHex, "hex"))) throw new HttpError(409, "plan_changed");
  if (new Date(app.expires_at) <= ctx.clock.now()) throw new HttpError(409, "plan_expired");
  if (app.state !== "planned" && app.state !== "approved") throw new HttpError(409, "plan_used");
  // Recompute now: a different zone, different provider facts or a changed recipe gives a different hash, and nothing runs.
  const p = await withUser(ctx.runtime, actor.userId, (c) => computePlan(ctx, c, actor.userId, d, recipe, app.input));
  if (!safeEqual(planHash(p), Buffer.from(app.plan_hash))) throw new HttpError(409, "plan_changed");
  assertApplyScopes(w.principal, p);
  // Shared by REST and MCP: queued DNS recipes predate grant-bound execution.
  // Bindings use the exact DNS proposal path until that queue policy is implemented.
  if (recipe.touchesDns && (w.principal.kind === "binding" || app.created_by_kind !== "user")) throw new HttpError(403, "agent_dns_recipe_requires_owner");
  await rejectNames(ctx, actor, d.id, p);
  if (needsApproval(p) && app.state !== "approved") throw new HttpError(403, "approval_required", undefined, undefined, { type: "dns.sensitive.approve", application_id: app.id });
  await withUser(ctx.runtime, actor.userId, async (c) => {
    const r = await c.query("update recipe_applications set state = 'applying' where id = $1 and user_id = $2 and state = $3 and plan_hash = $4", [app.id, actor.userId, app.state, app.plan_hash]);
    if (r.rowCount !== 1) throw new HttpError(409, "plan_used");
    // Who asked (ids only): the job mails the owner at once when an agent's apply writes prod (ST-35).
    await enqueue(c, { kind: "recipe.apply", userId: actor.userId, payload: { application_id: app.id, user_id: actor.userId, by_kind: actor.kind, by_id: actor.id }, dedupeKey: `recipe.apply:${app.id}` });
    await appendAudit(ctx, c, { chainId: actor.userId, actorKind: actor.kind, actorId: actor.id, action: "recipe.apply_requested", resourceKind: "recipe_application", resourceId: app.id, detail: { recipe: recipe.id, approved_by: app.approved_by_action_id ?? null } });
  });
  return { application_id: app.id as string, state: "applying" as const };
}

async function getApplication(req: HandlerReq): Promise<HandlerResult> {
  return json(await recipeApplication(callerFor(req), req.params.id ?? ""));
}

/** One stored plan and where it stands. */
export async function recipeApplication(w: RecipeCaller, id: string) {
  const { ctx, actor } = w;
  if (!UUID.test(id)) throw notFound();
  const a = await withUser(ctx.runtime, actor.userId, async (c) => (await c.query("select * from recipe_applications where id = $1 and user_id = $2", [id, actor.userId])).rows[0]);
  if (!a) throw notFound();
  if (w.principal.kind === "binding") assertPlanScopes(w.principal, a.domain_id);
  return { application_id: a.id as string, recipe: a.recipe_id as string, version: a.recipe_version as number, state: a.state as string, needs_approval: a.needs_approval as boolean, failure_code: a.failure_code as string | null, plan: planView(a.plan as Plan, Buffer.from(a.plan_hash), a.needs_approval), applied_at: a.applied_at ? new Date(a.applied_at).toISOString() : null };
}

/**
 * GET /domains/:fqdn/recipe-applications (session): the domain's recent plans, newest first, with who made each one (the owner, or
 * one of their tokens by the name the owner gave it). A plan a token made that waits for the passkey is how an assistant's recipe
 * reaches the owner (the domain's Connect tab).
 */
async function listApplications(req: HandlerReq): Promise<HandlerResult> {
  const p = req.principal;
  if (p.kind !== "session" || !p.userId) throw new HttpError(401, "unauthorized");
  const userId = p.userId;
  const d = await domainOf(req, userId);
  return withUser(req.ctx.runtime, userId, async (c) => {
    const rows = (await c.query(
      `select a.id, a.recipe_id, a.state, a.needs_approval, a.failure_code, a.created_by_kind, a.created_at, a.expires_at, a.applied_at, b.name as binding_name,
              (b.id is not null and b.revoked_at is null and b.paused_at is null) as binding_live
         from recipe_applications a left join bindings b on b.id::text = a.created_by_id::text and a.created_by_kind <> 'user'
        where a.user_id = $1 and a.domain_id = $2 order by a.created_at desc limit 20`, [userId, d.id])).rows;
    const now = req.ctx.clock.now().getTime();
    return json({
      domain: d.fqdn_ascii,
      applications: rows.map((a) => ({
        id: a.id, recipe: a.recipe_id, state: a.state === "planned" && new Date(a.expires_at).getTime() <= now ? "expired" : a.state, needs_approval: a.needs_approval, failure_code: a.failure_code,
        // live: the token that made it still works (not revoked, not paused). Only a live token's plan waits for the owner.
        created_by: a.created_by_kind === "user" ? { kind: "you" } : { kind: a.created_by_kind, name: a.binding_name ?? null, live: a.binding_live === true },
        created_at: new Date(a.created_at).toISOString(), expires_at: new Date(a.expires_at).toISOString(), applied_at: a.applied_at ? new Date(a.applied_at).toISOString() : null,
      })),
    });
  });
}

/**
 * GET /recipe-applications/waiting (session): plans a token made, across the account, that wait for the owner's passkey. Only a
 * token that still works counts: a paused or revoked one (Disconnect everything included) leaves nothing waiting, as with requests.
 */
async function waitingApplications(req: HandlerReq): Promise<HandlerResult> {
  const p = req.principal;
  if (p.kind !== "session" || !p.userId) throw new HttpError(401, "unauthorized");
  const userId = p.userId;
  return withUser(req.ctx.runtime, userId, async (c) => {
    const rows = (await c.query(
      `select a.id, a.recipe_id, a.created_at, a.expires_at, d.id as domain_id, d.fqdn_ascii, b.name as binding_name
         from recipe_applications a join domains d on d.id = a.domain_id and d.released_at is null
         join bindings b on b.id::text = a.created_by_id::text and b.revoked_at is null and b.paused_at is null
        where a.user_id = $1 and a.state = 'planned' and a.needs_approval and a.created_by_kind <> 'user' and a.expires_at > $2
        order by a.created_at desc limit 20`, [userId, req.ctx.clock.now()])).rows;
    return json({ applications: rows.map((a) => ({ id: a.id, recipe: a.recipe_id, domain: a.fqdn_ascii, domain_id: a.domain_id, requester: a.binding_name ?? null, created_at: new Date(a.created_at).toISOString(), expires_at: new Date(a.expires_at).toISOString() })) });
  });
}

// ---- dns.sensitive.approve: one approval binds one plan hash ------------------------------------------------------------------

export const sensitiveApproveSpec: ActionSpec<Record<string, never>> = {
  type: "dns.sensitive.approve", held: true, userInput: z.strictObject({}),
  async derive(ctx, c, userId, targetId) {
    if (!UUID.test(targetId)) throw notFound();
    const a = (await c.query("select a.*, d.fqdn_ascii from recipe_applications a join domains d on d.id = a.domain_id where a.id = $1 and a.user_id = $2 and d.released_at is null", [targetId, userId])).rows[0];
    if (!a) throw notFound();
    if (a.state !== "planned" || new Date(a.expires_at) <= ctx.clock.now()) throw new HttpError(409, "plan_used");
    if (!a.needs_approval) throw new HttpError(409, "approval_not_needed");
    const p = a.plan as Plan;
    return {
      params: {
        application_id: a.id, plan_hash: Buffer.from(a.plan_hash).toString("hex"), recipe: p.recipe, version: p.version, domain: a.fqdn_ascii,
        // Every sensitive record and every resource-creating or unknown-cost step, in full: nothing can hide among benign changes.
        sensitive: p.sensitive.map((s) => `${s.type} ${s.name === "" ? "@" : s.name}`),
        pending: p.pending_records.map((r) => `${r.type} ${r.name}`),
        steps: p.steps.filter((s) => s.creates_resource || s.cost !== "free").map((s) => `${s.service} ${s.op} (${s.cost})`),
        add: p.dns.add.length, remove: p.dns.remove.length, variables: p.variables.map((v) => v.name),
        // A project.create moves the connection off the project it uses now, and every later plan follows: say which one.
        replaces: p.steps.some((s) => s.op === "project.create") ? (p.connections ?? []).filter((c) => c.service === "neon" && c.external_ref).map((c) => `neon project ${c.external_ref}`) : [],
      },
      resourceId: a.id,
    };
  },
  summary: (q) => {
    const list = (x: unknown) => (x as string[]).join(", ");
    const sens = q.sensitive as string[], steps = q.steps as string[], pend = q.pending as string[];
    return `Apply the "${String(q.recipe)}" plan ${String(q.plan_hash).slice(0, 12)} to ${String(q.domain)}: ${String(q.add)} record${q.add === 1 ? "" : "s"} added and ${String(q.remove)} removed. `
      + `Sensitive records (${sens.length}): ${sens.length ? list(sens) : "none"}. `
      + (pend.length ? `Records the provider will create later (${pend.length}): ${list(pend)}. ` : "")
      + `Provider steps that create something or may cost money (${steps.length}): ${steps.length ? list(steps) : "none"}.`
      + ((q.replaces as string[] | undefined)?.length ? ` The connection stops using ${list(q.replaces)} and uses the new project from then on.` : "");
  },
};

async function approve(req: HandlerReq): Promise<HandlerResult> {
  const p = req.principal;
  if (p.kind !== "session" || !p.userId) throw new HttpError(401, "unauthorized");
  const userId = p.userId;
  const action = requireAction(req, "dns.sensitive.approve");
  const q = action.params as { application_id: string; plan_hash: string };
  if (req.params.id !== q.application_id) throw notFound();
  await withUser(req.ctx.runtime, userId, async (c) => {
    await markExecuted(c, action);
    const r = await c.query("update recipe_applications set state = 'approved', approved_by_action_id = $3 where id = $1 and user_id = $2 and state = 'planned' and plan_hash = $4 and expires_at > $5",
      [q.application_id, userId, action.id, Buffer.from(q.plan_hash, "hex"), req.ctx.clock.now()]);
    if (r.rowCount !== 1) throw new HttpError(409, "plan_used");
    await appendAudit(req.ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "recipe.approved", resourceKind: "recipe_application", resourceId: q.application_id, detail: { action_id: action.id } });
  });
  return json({ application_id: q.application_id, state: "approved" });
}

// ---- connections -----------------------------------------------------------------------------------------------------------

const SERVICES: Service[] = ["vercel", "neon", "resend"];

async function listConnections(req: HandlerReq): Promise<HandlerResult> {
  const actor = who(req);
  const d = await domainOf(req, actor.userId);
  return withUser(req.ctx.runtime, actor.userId, async (c) => {
    const conns = (await c.query("select id, service, status, checked_at, created_at, recipe_application_id from connections where user_id = $1 and domain_id = $2 and ended_at is null order by service", [actor.userId, d.id])).rows;
    const findings = (await c.query("select id, kind, host, found_at from recipe_findings where user_id = $1 and domain_id = $2 and state = 'open' order by found_at", [actor.userId, d.id])).rows;
    return json({
      domain: d.fqdn_ascii,
      connections: conns.map((x) => ({ id: x.id, service: x.service, status: x.status, checked_at: x.checked_at ? new Date(x.checked_at).toISOString() : null, connected_at: new Date(x.created_at).toISOString(), recipe_application_id: x.recipe_application_id })),
      findings: findings.map((f) => ({ id: f.id, kind: f.kind, host: f.host, found_at: new Date(f.found_at).toISOString() })),
    });
  });
}

async function checkConnection(req: HandlerReq): Promise<HandlerResult> {
  const actor = who(req);
  const d = await domainOf(req, actor.userId);
  const service = req.params.service as Service;
  if (!SERVICES.includes(service)) throw notFound();
  return withUser(req.ctx.runtime, actor.userId, async (c) => {
    const cn = (await c.query("select id from connections where user_id = $1 and domain_id = $2 and service = $3 and ended_at is null", [actor.userId, d.id, service])).rows[0];
    if (!cn) throw notFound();
    await enqueue(c, { kind: "connection.check", userId: actor.userId, payload: { connection_id: cn.id }, dedupeKey: `connection.check:${cn.id}` });
    return json({ connection_id: cn.id, state: "checking" }, 202);
  });
}

/**
 * DELETE /connections/:id: disconnecting a service deletes the DNS records its recipes wrote (only those still exactly as
 * written), marks those applications removed, then ends the connection and destroys its credential (the vault's trigger).
 */
async function deleteConnection(req: HandlerReq): Promise<HandlerResult> {
  const actor = who(req);
  const id = req.params.id ?? "";
  if (!UUID.test(id)) throw notFound();
  const cn = await withUser(req.ctx.runtime, actor.userId, async (c) => (await c.query(
    "select n.id, n.service, n.domain_id, d.fqdn_ascii from connections n join domains d on d.id = n.domain_id where n.id = $1 and n.user_id = $2 and n.ended_at is null and d.released_at is null", [id, actor.userId])).rows[0]);
  if (!cn) throw notFound();
  let removed = 0;
  try {
    const apps = await withUser(req.ctx.runtime, actor.userId, async (c) => (await c.query("select id, applied_records from recipe_applications where user_id = $1 and domain_id = $2 and state = 'applied' and plan->'connections' @> $3::jsonb", [actor.userId, cn.domain_id, JSON.stringify([{ id: cn.id }])])).rows);
    const records = apps.flatMap((a) => (a.applied_records ?? []) as DnsRecord[]);
    // The applications are marked removed only with a confirmed write (in its follow-up, under the zone lock): a removal whose outcome
    // is unknown keeps its snapshot and leaves them applied. A later attempt reconciles by reading before any further write.
    const done = async (c: PoolClient, n: number) => {
      if (apps.length) await c.query("update recipe_applications set state = 'removed' where id = any($1::uuid[]) and state = 'applied'", [apps.map((a) => a.id)]);
      await appendAudit(req.ctx, c, { chainId: actor.userId, actorKind: "user", actorId: actor.userId, action: "connection.records_removed", resourceKind: "connection", resourceId: cn.id, detail: { applications: apps.length, removed: n } });
      return n;
    };
    removed = records.length
      ? (await writeRecipeZone(req.ctx, actor.userId, { id: cn.domain_id, fqdn: cn.fqdn_ascii }, { add: [], remove: records }, null, { cause: "connection.disconnect" }, (c, w) => done(c, w.removed), req)).after ?? 0
      : await withUser(req.ctx.runtime, actor.userId, (c) => done(c, 0));
  } catch (e) { if (e instanceof RecipeFail) throw new HttpError(409, e.code); throw e; }
  await disconnect(req.ctx, actor.userId, cn.domain_id, cn.service);
  return json({ connection_id: cn.id, status: "ended", records_removed: removed });
}

export const recipeRoutes: Route[] = [
  { method: "GET", path: "/api/v1/recipes", principals: ["anonymous", "session", "binding"], handler: listRecipes, tag: "recipes" },
  { method: "POST", path: "/api/v1/domains/:fqdn/recipes/:recipe/plan", principals: ["session", "binding"], capability: "recipes.plan", handler: plan, tag: "recipes" },
  { method: "POST", path: "/api/v1/domains/:fqdn/recipes/:recipe/apply", principals: ["session", "binding"], capability: "recipes.apply", handler: apply, tag: "recipes" },
  { method: "GET", path: "/api/v1/recipe-applications/waiting", principals: ["session"], handler: waitingApplications, tag: "recipes" },
  { method: "GET", path: "/api/v1/recipe-applications/:id", principals: ["session", "binding"], capability: "recipes.plan", handler: getApplication, tag: "recipes" },
  { method: "GET", path: "/api/v1/domains/:fqdn/recipe-applications", principals: ["session"], handler: listApplications, tag: "recipes" },
  { method: "POST", path: "/api/v1/recipe-applications/:id/approve", principals: ["session"], stepUp: "dns.sensitive.approve", handler: approve, tag: "recipes" },
  { method: "GET", path: "/api/v1/domains/:fqdn/connections", principals: ["session"], handler: listConnections, tag: "recipes" },
  { method: "POST", path: "/api/v1/domains/:fqdn/connections/:service/check", principals: ["session"], handler: checkConnection, tag: "recipes" },
  { method: "DELETE", path: "/api/v1/connections/:id", principals: ["session"], handler: deleteConnection, tag: "recipes" },
];

export function registerRecipes(router: Router): Router {
  registerActionSpec(sensitiveApproveSpec);
  registerRecipeJobs();
  router.add(...recipeRoutes);
  return router;
}
