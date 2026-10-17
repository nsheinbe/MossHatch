import { z } from "zod";
import { withNoUser, withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { appendAudit } from "../audit.ts";
import { hit } from "../ratelimit.ts";
import { hashOf } from "../util/bytes.ts";
import { mapRegistrarError, ownedDomain, registrarOf, userIdOf } from "../domain-mgmt/common.ts";
import { buildConnectPlan, planHash, type ConnectPlan, type ConnectRecordIn } from "./plan.ts";
import { flagOn } from "./flags.ts";

/**
 * DC-14. The model returns records. This file turns them into a connect plan and stores that plan.
 * It does not import the registrar port, and it never calls replaceZone or writeZoneLocked.
 * The prompt is hashed and discarded. Apply is the existing connect.apply route.
 */

const PLAN_TTL_MS = 60 * 60_000;
const num = z.number().int().min(0).max(65535);
const RecordIn = z.object({
  type: z.string().trim().min(1).max(16),
  name: z.string().trim().max(253),
  value: z.string().min(1).max(4096),
  priority: num.optional(), weight: num.optional(), port: num.optional(),
}).strict();
const Draft = z.object({
  add: z.array(RecordIn).max(100).default([]),
  remove: z.array(RecordIn).max(100).default([]),
  spf: z.array(z.object({ name: z.string().trim().max(253), mechanisms: z.array(z.string().trim().min(1).max(200)).max(20) }).strict()).max(5).default([]),
  alias: z.boolean().optional(),
  warnings: z.array(z.object({ code: z.string().trim().max(40), message: z.string().max(300) }).strict()).max(20).default([]),
}).strict();

export interface ConnectModel {
  /** Untrusted. The return value is data, parsed below, and is not a tool call. */
  propose(input: { text: string; image?: { media_type: string; data: string } }): Promise<unknown>;
}

const view = (p: ConnectPlan) => ({
  v: p.v, source: p.source, source_id: p.source_id, source_version: p.source_version, fqdn: p.fqdn,
  zone_before: p.zone_before, dns: p.dns, warnings: p.warnings, blocked: p.blocked, sensitive: p.sensitive,
});

export async function proposePlan(req: HandlerReq): Promise<HandlerResult> {
  const ctx: AppContext = req.ctx;
  if (!(await flagOn(ctx, "connect.ai"))) throw new HttpError(404, "not_found");
  if (!(await flagOn(ctx, "connect.apply"))) throw new HttpError(404, "not_found");
  const model = (ctx.services as { connectModel?: ConnectModel }).connectModel;
  if (!model) throw new HttpError(404, "not_found");
  const body = (req.body ?? {}) as { text?: unknown; image?: { media_type?: unknown; data?: unknown } };
  const text = typeof body.text === "string" ? body.text : "";
  const image = body.image && typeof body.image.data === "string" && typeof body.image.media_type === "string"
    ? { media_type: body.image.media_type, data: body.image.data }
    : undefined;
  if ((!text && !image) || text.length > 8000 || (image && (image.data.length > 200_000 || image.media_type.length > 80))) throw new HttpError(422, "invalid_input");
  const userId = userIdOf(req);
  const rl = await withNoUser(ctx.runtime, (c) => hit(ctx, c, `connect:propose:${userId}`, { bucket: "connect.propose", max: 10, windowSeconds: 3600 }));
  if (!rl.allowed) throw new HttpError(429, "rate_limited", "rate_limited", { "Retry-After": String(rl.retryAfterSeconds) });
  const raw = await model.propose({ text, ...(image ? { image } : {}) });
  const parsed = Draft.safeParse(raw);
  if (!parsed.success) throw new HttpError(422, "invalid_input");
  const d = await withUser(ctx.runtime, userId, (c) => ownedDomain(c, userId, req.params.fqdn ?? ""));
  let zone;
  try { zone = await registrarOf(ctx).getDns(d.fqdn_ascii); } catch (e) { throw mapRegistrarError(e); }
  const draft = parsed.data;
  const intent = {
    add: draft.add as ConnectRecordIn[], remove: draft.remove as ConnectRecordIn[], replace_addresses: [] as string[],
    spf: draft.spf, alias: draft.alias === true, warnings: draft.warnings,
  };
  const plan = buildConnectPlan({
    source: "ai", source_id: "model", source_version: 1, domain_id: d.id, fqdn: d.fqdn_ascii,
    hosted: zone.hosted, live: zone.records, ...intent,
  });
  if (plan.blocked) throw new HttpError(422, plan.blocked.code, plan.blocked.message, undefined, { plan: view(plan) });
  const hash = planHash(plan);
  const promptHash = hashOf(image ? { text, image: image.data } : text);
  const now = ctx.clock.now();
  const id = await withUser(ctx.runtime, userId, async (c) => {
    const ins = await c.query(
      `insert into connect_plans (user_id, domain_id, source, source_id, source_version, intent, plan, plan_hash, sensitive_count, prompt_hash, expires_at, created_at)
       values ($1,$2,'ai','model',1,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [userId, d.id, JSON.stringify(intent), JSON.stringify(plan), hash, plan.sensitive.length, promptHash, new Date(now.getTime() + PLAN_TTL_MS), now]);
    const planId = ins.rows[0].id as string;
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "connect.planned", resourceKind: "domain", resourceId: d.id, detail: { plan_id: planId, source: "ai", source_id: "model", plan_hash: hash.toString("hex"), prompt_hash: promptHash.toString("hex"), added: plan.dns.add.length, removed: plan.dns.remove.length, sensitive: plan.sensitive.length } });
    return planId;
  });
  return json({ plan_id: id, plan_hash: hash.toString("hex"), expires_at: new Date(now.getTime() + PLAN_TTL_MS).toISOString(), plan: view(plan) });
}
