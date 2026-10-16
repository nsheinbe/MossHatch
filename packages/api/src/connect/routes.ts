import { z } from "zod";
import { withNoUser, withUser } from "@mosshatch/db";
import type { DnsRecord } from "@mosshatch/registrar/port";
import { zoneHash } from "@mosshatch/registrar/dns";
import { HttpError, json, type Router } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { appendAudit } from "../audit.ts";
import { safeEqual } from "../util/bytes.ts";
import { hit } from "../ratelimit.ts";
import { mapRegistrarError, normalizeFqdn, notFound, ownedDomain, registrarOf, userIdOf, type DomainRow } from "../domain-mgmt/common.ts";
import { diffZones, sensitiveOf, writeZoneLocked, type ZoneWriter } from "../domain-mgmt/dns.ts";
import { registerActionSpec, type ActionSpec } from "../stepup/specs.ts";
import { markExecuted, requireAction } from "../stepup/gate.ts";
import { PRESETS, presetById, presetView } from "./presets.ts";
import { flagOn } from "./flags.ts";
import { discoverJob, registerDiscoveryRoutes } from "./discover.ts";
import { getJobDef, registerJob } from "../jobs/registry.ts";
import { registerRecurringJob } from "../jobs/engine.ts";
import {
  buildConnectPlan, desiredFromPlan, planHash, planHashHex,
  type ConnectPlan, type ConnectRecordIn, type ConnectRequest, type ConnectSource,
} from "./plan.ts";

/**
 * DC-04. A plan is stored for one hour. Apply recomputes it against a fresh zone read and writes nothing
 * when the hash differs. Sensitive diffs need one `connect.apply` approval for that hash. The flag
 * `connect.apply` defaults off: both routes then answer 404 and do not call the registrar.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_TTL_MS = 60 * 60_000;
const FLAG_NAMES = ["connect.apply", "connect.presets", "connect.ui", "domainconnect.discovery", "domainconnect.apply", "connect.verify", "connect.delegate", "connect.ai"] as const;

const num = z.number().int().min(0).max(65535);
const RecordIn = z.object({
  type: z.string().trim().min(1).max(16),
  name: z.string().trim().max(253),
  value: z.string().min(1).max(4096),
  priority: num.optional(), weight: num.optional(), port: num.optional(),
}).strict();
const PlanBody = z.object({
  source: z.enum(["pasted", "preset", "ai", "domainconnect", "recipe"]),
  source_id: z.string().trim().min(1).max(80).optional(),
  source_version: z.number().int().min(1).max(1000).optional(),
  records: z.array(RecordIn).max(100).optional(),
  remove: z.array(RecordIn).max(100).optional(),
  replace_addresses: z.array(z.string().trim().max(253)).max(20).optional(),
  spf: z.array(z.object({ name: z.string().trim().max(253), mechanisms: z.array(z.string().trim().min(1).max(200)).max(20) }).strict()).max(5).optional(),
  alias: z.boolean().optional(),
  input: z.record(z.string().max(40), z.string().max(500)).optional(),
}).strict();
const ApplyBody = z.object({ plan_hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

interface Intent {
  add: ConnectRecordIn[];
  remove: ConnectRecordIn[];
  replace_addresses: string[];
  spf: { name: string; mechanisms: string[] }[];
  alias: boolean;
  warnings: { code: string; message: string }[];
  txtMax?: number;
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(422, "invalid_input");
  return r.data;
}

const publicPlan = (p: ConnectPlan) => ({
  v: p.v, source: p.source, source_id: p.source_id, source_version: p.source_version, fqdn: p.fqdn,
  zone_before: p.zone_before, dns: p.dns, warnings: p.warnings, blocked: p.blocked, sensitive: p.sensitive,
});

async function capabilities(req: HandlerReq): Promise<HandlerResult> {
  const rows = (await req.ctx.runtime.query("select name, value from flags where name = any($1)", [FLAG_NAMES as unknown as string[]])).rows as { name: string; value: unknown }[];
  const on = new Set(rows.filter((r) => r.value === true).map((r) => r.name));
  return json({
    apply: on.has("connect.apply"),
    presets: on.has("connect.presets"),
    ui: on.has("connect.ui"),
    discovery: on.has("domainconnect.discovery"),
    domainconnect_apply: on.has("domainconnect.apply"),
    verify: on.has("connect.verify"),
    delegate: on.has("connect.delegate"),
    ai: on.has("connect.ai"),
  });
}

async function listPresets(req: HandlerReq): Promise<HandlerResult> {
  if (!(await flagOn(req.ctx, "connect.presets"))) throw new HttpError(404, "not_found");
  return json({ presets: PRESETS.map(presetView) });
}

async function createPlan(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  if (!(await flagOn(ctx, "connect.apply"))) throw new HttpError(404, "not_found");
  const userId = userIdOf(req);
  const body = parse(PlanBody, req.body);
  if (body.source !== "pasted" && body.source !== "preset") throw new HttpError(404, "not_found");
  if (body.source === "preset" && !(await flagOn(ctx, "connect.presets"))) throw new HttpError(404, "not_found");
  const rl = await withNoUser(ctx.runtime, (c) => hit(ctx, c, `connect:plan:${userId}`, { bucket: "connect.plan", max: 30, windowSeconds: 3600 }));
  if (!rl.allowed) throw new HttpError(429, "rate_limited", "rate_limited", { "Retry-After": String(rl.retryAfterSeconds) });
  let source: ConnectSource = "pasted";
  let sourceId = body.source_id ?? "pasted";
  let version = body.source_version ?? 1;
  let intent: Intent = {
    add: body.records ?? [], remove: body.remove ?? [], replace_addresses: body.replace_addresses ?? [],
    spf: body.spf ?? [], alias: body.alias ?? false, warnings: [],
  };
  if (body.source === "preset") {
    const preset = presetById(body.source_id ?? "");
    if (!preset) throw new HttpError(404, "not_found");
    const draft = preset.build(body.input ?? {});
    if (draft.blocked) throw new HttpError(422, draft.blocked.code, draft.blocked.message);
    source = "preset"; sourceId = preset.id; version = preset.version;
    intent = { add: draft.add, remove: [], replace_addresses: draft.replace_addresses ?? [], spf: draft.spf ?? [], alias: draft.alias ?? false, warnings: draft.warnings };
  }
  const d = await withUser(ctx.runtime, userId, (c) => ownedDomain(c, userId, req.params.fqdn ?? ""));
  let zone;
  try { zone = await registrarOf(ctx).getDns(d.fqdn_ascii); } catch (e) { throw mapRegistrarError(e); }
  const plan = buildConnectPlan(requestOf(d, source, sourceId, version, intent, zone.hosted, zone.records));
  if (plan.blocked) throw new HttpError(422, plan.blocked.code, plan.blocked.message, undefined, { plan: publicPlan(plan) });
  const hash = planHash(plan);
  const now = ctx.clock.now();
  const exp = new Date(now.getTime() + PLAN_TTL_MS);
  const id = await withUser(ctx.runtime, userId, async (c) => {
    const ins = await c.query(
      `insert into connect_plans (user_id, domain_id, source, source_id, source_version, intent, plan, plan_hash, sensitive_count, expires_at, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [userId, d.id, plan.source, plan.source_id, plan.source_version, JSON.stringify(intent), JSON.stringify(plan), hash, plan.sensitive.length, exp, now]);
    const planId = ins.rows[0].id as string;
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "connect.planned", resourceKind: "domain", resourceId: d.id, detail: { plan_id: planId, source: plan.source, source_id: plan.source_id, plan_hash: hash.toString("hex"), added: plan.dns.add.length, removed: plan.dns.remove.length, sensitive: plan.sensitive.length } });
    return planId;
  });
  return json({ plan_id: id, plan_hash: hash.toString("hex"), expires_at: exp.toISOString(), plan: publicPlan(plan) });
}

function requestOf(d: DomainRow, source: ConnectSource, sourceId: string, version: number, intent: Intent, hosted: boolean, live: readonly DnsRecord[]): ConnectRequest {
  return {
    source, source_id: sourceId, source_version: version, domain_id: d.id, fqdn: d.fqdn_ascii, hosted, live,
    add: intent.add, remove: intent.remove, replace_addresses: intent.replace_addresses, spf: intent.spf, alias: intent.alias, warnings: intent.warnings, txtMax: intent.txtMax,
  };
}

const connectWriter = (userId: string, source: string): ZoneWriter => ({
  snapshotKind: "user", actorKind: "user", actorId: userId,
  notice: ({ fqdn, sensitive, maybe }) => {
    const n = sensitive.length;
    const lines = sensitive.slice(0, 10).map((x) => `- ${x.type} ${x.name === "" ? "@ (the domain itself)" : x.name}`).join("\n");
    const tail = "These records control mail, certificates and where the domain points. You can roll the change back from the DNS tab, under History.";
    return maybe
      ? { subject: "A sensitive DNS record on your Mosshatch domain may have changed", text: `A connect change (${source}) from your signed-in session to ${n} sensitive DNS record${n === 1 ? "" : "s"} on ${fqdn} may have been applied: our registrar did not confirm it.\n${lines}\n\n${tail}` }
      : { subject: "A sensitive DNS record on your Mosshatch domain changed", text: `A connect change (${source}) from your signed-in session touched ${n} sensitive DNS record${n === 1 ? "" : "s"} on ${fqdn}:\n${lines}\n\n${tail}` };
  },
});

async function applyPlan(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  if (!(await flagOn(ctx, "connect.apply"))) throw new HttpError(404, "not_found");
  const userId = userIdOf(req);
  const id = req.params.id ?? "";
  if (!UUID.test(id)) throw notFound();
  const body = parse(ApplyBody, req.body ?? {});
  const row = await withUser(ctx.runtime, userId, async (c) => (await c.query(
    `select p.*, d.fqdn_ascii from connect_plans p join domains d on d.id = p.domain_id
      where p.id = $1 and p.user_id = $2 and d.user_id = $2 and d.released_at is null`, [id, userId])).rows[0]);
  if (!row || normalizeFqdn(req.params.fqdn ?? "") !== row.fqdn_ascii) throw notFound();
  if (new Date(row.expires_at) <= ctx.clock.now() || (row.state !== "planned" && row.state !== "approved")) throw new HttpError(409, "plan_used");
  const stored = Buffer.from(row.plan_hash) as Buffer;
  if (!safeEqual(stored, Buffer.from(body.plan_hash, "hex"))) throw new HttpError(409, "plan_changed");
  const d = await withUser(ctx.runtime, userId, (c) => ownedDomain(c, userId, row.fqdn_ascii));
  let zone;
  try { zone = await registrarOf(ctx).getDns(d.fqdn_ascii); } catch (e) { throw mapRegistrarError(e); }
  const intent = row.intent as Intent;
  const again = buildConnectPlan(requestOf(d, row.source, row.source_id, row.source_version, intent, zone.hosted, zone.records));
  const againHex = planHashHex(again);
  if (againHex !== stored.toString("hex")) throw new HttpError(409, "plan_changed", undefined, undefined, { plan: publicPlan(again), plan_hash: againHex });
  if (again.sensitive.length > 0 && row.state !== "approved") throw new HttpError(403, "approval_required", undefined, undefined, { type: "connect.apply", plan_id: id });
  if (again.dns.add.length + again.dns.remove.length > 0) {
    const rl = await withNoUser(ctx.runtime, (c) => hit(ctx, c, `dns:write:${userId}`, { bucket: "dns_write", max: 120, windowSeconds: 3600 }));
    if (!rl.allowed) throw new HttpError(429, "rate_limited", "rate_limited", { "Retry-After": String(rl.retryAfterSeconds) });
  }
  const source = `${again.source}:${again.source_id}`;
  try {
    const written = await writeZoneLocked(ctx, userId, d.id, connectWriter(userId, source), (live, dom) => {
      if (zoneHash(live) !== again.zone_before) throw new HttpError(409, "plan_changed");
      const desired = desiredFromPlan(live, again);
      const diff = diffZones(live, desired);
      return { desired, diff, sensitive: sensitiveOf(dom.fqdn_ascii, diff) };
    }, {
      detail: { source: again.source, plan_id: id, plan_hash: againHex },
      claim: async (c) => {
        const r = await c.query("update connect_plans set state = 'applying' where id = $1 and user_id = $2 and state = any($3::text[]) and plan_hash = $4", [id, userId, [row.state], stored]);
        if (r.rowCount !== 1) throw new HttpError(409, "plan_used");
        await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "connect.apply_requested", resourceKind: "domain", resourceId: d.id, detail: { plan_id: id, source: again.source, plan_hash: againHex } });
      },
      failed: async (c, outcome) => {
        const code = outcome === "refused" ? "refused" : "outcome_unknown";
        await c.query("update connect_plans set state = 'failed', failure_code = $3 where id = $1 and user_id = $2 and state = 'applying'", [id, userId, code]);
        await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "connect.failed", resourceKind: "domain", resourceId: d.id, detail: { plan_id: id, source: again.source, plan_hash: againHex, code } });
      },
      after: async (c, r) => {
        const changed = r.change !== null && (r.change.diff.added.length + r.change.diff.removed.length > 0);
        await c.query("update connect_plans set state = 'applied', applied_records = $3, applied_at = $4 where id = $1 and user_id = $2 and state = 'applying'", [id, userId, JSON.stringify(again.dns.add), ctx.clock.now()]);
        await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "connect.applied", resourceKind: "domain", resourceId: d.id, detail: { plan_id: id, source: again.source, plan_hash: againHex, added: again.dns.add.length, removed: again.dns.remove.length, snapshot: r.snapshotId } });
        return changed;
      },
    });
    const changed = written.change !== null;
    return json({ plan_id: id, state: "applied", changed, snapshot_id: written.snapshotId, zone_hash: written.zoneHash }, changed ? 202 : 200);
  } catch (e) { throw mapRegistrarError(e); }
}

export const connectApplySpec: ActionSpec<Record<string, never>> = {
  type: "connect.apply", held: true, userInput: z.strictObject({}),
  async derive(ctx, c, userId, targetId) {
    if (!UUID.test(targetId)) throw notFound();
    const a = (await c.query(
      `select p.*, d.fqdn_ascii from connect_plans p join domains d on d.id = p.domain_id
        where p.id = $1 and p.user_id = $2 and d.released_at is null`, [targetId, userId])).rows[0];
    if (!a) throw notFound();
    if (a.state !== "planned" || new Date(a.expires_at) <= ctx.clock.now()) throw new HttpError(409, "plan_used");
    const p = a.plan as ConnectPlan;
    if (p.sensitive.length === 0) throw new HttpError(409, "approval_not_needed");
    return {
      params: {
        plan_id: a.id, plan_hash: Buffer.from(a.plan_hash).toString("hex"), domain: a.fqdn_ascii,
        sensitive: p.sensitive.map((s) => `${s.type} ${s.name === "" ? "@" : s.name}`),
      },
      resourceId: a.id as string,
    };
  },
  summary: (q) => `Apply connect plan ${String(q.plan_hash).slice(0, 12)} to ${String(q.domain)}. Sensitive records: ${(q.sensitive as string[]).join(", ")}.`,
};

async function approve(req: HandlerReq): Promise<HandlerResult> {
  if (!(await flagOn(req.ctx, "connect.apply"))) throw new HttpError(404, "not_found");
  const action = requireAction(req, "connect.apply");
  const q = action.params as { plan_id: string; plan_hash: string };
  if (req.params.id !== q.plan_id) throw notFound();
  const userId = userIdOf(req);
  await withUser(req.ctx.runtime, userId, async (c) => {
    await markExecuted(c, action);
    const r = await c.query(
      "update connect_plans set state = 'approved', approved_by_action_id = $3 where id = $1 and user_id = $2 and state = 'planned' and plan_hash = $4 and expires_at > $5",
      [q.plan_id, userId, action.id, Buffer.from(q.plan_hash, "hex"), req.ctx.clock.now()]);
    if (r.rowCount !== 1) throw new HttpError(409, "plan_used");
  });
  return json({ plan_id: q.plan_id, state: "approved" });
}

export function registerConnectRoutes(router: Router): Router {
  registerActionSpec(connectApplySpec);
  if (!getJobDef("connect.discover")) registerJob({ kind: "connect.discover", priority: 1, maxRuntimeSec: 60, handler: discoverJob });
  registerRecurringJob({ kind: "connect.discover", everySec: 3600 });
  registerDiscoveryRoutes(router);
  router.add(
    { method: "GET", path: "/api/v1/connect/capabilities", principals: ["anonymous", "session"], handler: capabilities, tag: "connect" },
    { method: "GET", path: "/api/v1/connect/presets", principals: ["anonymous", "session"], handler: listPresets, tag: "connect" },
    { method: "POST", path: "/api/v1/domains/:fqdn/connect/plans", principals: ["session"], handler: createPlan, tag: "connect" },
    { method: "POST", path: "/api/v1/domains/:fqdn/connect/plans/:id/apply", principals: ["session"], handler: applyPlan, tag: "connect" },
    { method: "POST", path: "/api/v1/connect/plans/:id/approve", principals: ["session"], stepUp: "connect.apply", handler: approve, tag: "connect" },
  );
  return router;
}
