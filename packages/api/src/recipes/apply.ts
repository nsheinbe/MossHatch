import { tx, withUser, type PoolClient } from "@mosshatch/db";
import type { DnsRecord } from "@mosshatch/registrar/port";
import { canonicalZone, normalizeRecord, validateZone, zoneHash } from "@mosshatch/registrar/dns";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { appendAudit } from "../audit.ts";
import { safeEqual } from "../util/bytes.ts";
import { enqueue, getJobDef, registerJob, type JobRow } from "../jobs/registry.ts";
import { registerRecurringJob } from "../jobs/engine.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { assertWritesOpen, mapRegistrarError, notifyDomainEvent, registrarOf } from "../domain-mgmt/common.ts";
import { checkShape, diffZones, sensitiveOf, SNAPSHOT_TTL_MS as SNAPSHOT_TTL } from "../domain-mgmt/dns.ts";
import { withConnectionCredential } from "../vault/connections.ts";
import { writeSecret } from "../vault/secrets.ts";
import { checkVariableNames, computePlan, planHash, type Plan } from "./plan.ts";
import { recipeById, type Service } from "./registry.ts";
import { isProviderNotFound, providersOf } from "./providers.ts";

/**
 * The two jobs that may decrypt a stored provider credential (PLAN 4.3b, ST-87): `recipe.apply` and `connection.check`.
 * Both run the credential through the vault's `withConnectionCredential`, which audits before decrypting and zeroes the
 * buffer after; values fetched from a provider (a connection string, a sending key) go straight to the vault or the host
 * and are never logged, stored beside the plan or put in a job payload.
 */

export class RecipeFail extends Error { constructor(public code: string) { super(code); } }

async function credentialOf(ctx: AppContext, connectionId: string): Promise<string> {
  const r = (await ctx.cron.query("select id from connection_credentials where connection_id = $1 and revoked_at is null", [connectionId])).rows[0];
  if (!r) throw new RecipeFail("credential_missing");
  return r.id as string;
}

async function withCred<T>(ctx: AppContext, connectionId: string, purpose: "recipe.apply" | "connection.check", fn: (credential: string) => Promise<T>): Promise<T> {
  try { return await withConnectionCredential(ctx, await credentialOf(ctx, connectionId), purpose, fn); }
  catch (e) {
    if (e instanceof RecipeFail) throw e;
    if (e instanceof HttpError) throw new RecipeFail(e.code === "not_found" ? "credential_missing" : e.code);
    throw new RecipeFail(`${String((e as { service?: string }).service ?? "provider")}_error`.replace(/[^a-z_]/g, "_"));
  }
}

async function mergeFacts(ctx: AppContext, connectionId: string, facts: Record<string, unknown>, externalRef?: string): Promise<void> {
  await ctx.cron.query("update connections set provider_facts = provider_facts || $2::jsonb, external_ref = coalesce($3, external_ref) where id = $1", [connectionId, JSON.stringify(facts), externalRef ?? null]);
}

/**
 * Write a DNS change for a recipe under the same per-domain lock the DNS tab uses, against the zone the plan saw (a
 * different live zone fails the write), with a snapshot first so it can be rolled back from the DNS tab.
 */
export async function writeRecipeZone(ctx: AppContext, c: PoolClient, userId: string, d: { id: string; fqdn: string }, change: { add: DnsRecord[]; remove: DnsRecord[] }, expectBefore: string | null, ref: { application?: string; cause: string }): Promise<{ snapshotId: string | null; removed: number; added: number }> {
  await assertWritesOpen(c);
  await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`mh.dns:${d.id}`]);
  let z;
  try { z = await registrarOf(ctx).getDns(d.fqdn); } catch (e) { throw mapRegistrarError(e); }
  if (!z.hosted) throw new RecipeFail("dns_not_hosted");
  const live = canonicalZone(z.records);
  if (expectBefore !== null && zoneHash(live) !== expectBefore) throw new RecipeFail("plan_changed");
  const key = (r: DnsRecord) => JSON.stringify(normalizeRecord(r));
  const rm = new Set(change.remove.map(key));
  const desired = canonicalZone([...live.filter((r) => !rm.has(key(r))), ...change.add]);
  checkShape(desired); validateZone(desired);
  const diff = diffZones(live, desired);
  if (diff.added.length === 0 && diff.removed.length === 0) return { snapshotId: null, removed: 0, added: 0 };
  const sensitive = sensitiveOf(d.fqdn, diff);
  const now = ctx.clock.now();
  const snap = (await c.query(
    `insert into dns_snapshots (user_id, domain_id, reason, zone_hash, records, added_count, removed_count, sensitive_count, actor_kind, taken_at, expires_at)
     values ($1,$2,'pre_write',$3,$4,$5,$6,$7,'recipe',$8,$9) returning id`,
    [userId, d.id, zoneHash(live), JSON.stringify(live), diff.added.length, diff.removed.length, sensitive.length, now, new Date(now.getTime() + SNAPSHOT_TTL)])).rows[0];
  let written;
  try { written = await registrarOf(ctx).replaceZone(d.fqdn, desired); } catch (e) { throw mapRegistrarError(e); }
  await c.query("update dns_snapshots set after_hash = $2 where id = $1", [snap.id, written.hash]);
  await appendAudit(ctx, c, { chainId: userId, actorKind: "system", action: "dns.write", resourceKind: "domain", resourceId: d.id, detail: { snapshot: snap.id, added: diff.added.length, removed: diff.removed.length, sensitive: sensitive.length, actor: "recipe", cause: ref.cause, application: ref.application ?? null } });
  if (sensitive.length) {
    await notifyDomainEvent(ctx, c, userId, {
      kind: "dns.sensitive_changed", domainId: d.id, subject: "A sensitive DNS record on your Mosshatch domain changed",
      text: `A wire-it recipe you approved changed ${sensitive.length} sensitive DNS record${sensitive.length === 1 ? "" : "s"} on ${d.fqdn}:\n${sensitive.slice(0, 10).map((s) => `- ${s.type} ${s.name === "" ? "@ (the domain itself)" : s.name}`).join("\n")}\n\nYou can roll the change back from the DNS tab, under History.`,
    });
  }
  return { snapshotId: snap.id, removed: diff.removed.length, added: diff.added.length };
}

// ---- recipe.apply ------------------------------------------------------------------------------------------------------------

export async function recipeApplyJob(ctx: AppContext, job: JobRow): Promise<void> {
  const appId = String(job.payload.application_id ?? "");
  const userId = String(job.payload.user_id ?? job.user_id ?? "");
  const app = await withUser(ctx.runtime, userId, async (c) => (await c.query("select * from recipe_applications where id = $1 and user_id = $2 and state = 'applying'", [appId, userId])).rows[0]);
  if (!app) return;
  const fail = async (code: string) => {
    await withUser(ctx.runtime, userId, async (c) => {
      const r = await c.query("update recipe_applications set state = 'failed', failure_code = $3 where id = $1 and user_id = $2 and state = 'applying'", [appId, userId, code.slice(0, 48)]);
      if (r.rowCount === 1) await appendAudit(ctx, c, { chainId: userId, actorKind: "system", action: "recipe.failed", resourceKind: "recipe_application", resourceId: appId, detail: { recipe: app.recipe_id, code: code.slice(0, 48) } });
    });
  };
  try {
    const recipe = recipeById(app.recipe_id);
    if (!recipe || recipe.version !== app.recipe_version) throw new RecipeFail("recipe_changed");
    const d = await withUser(ctx.runtime, userId, async (c) => (await c.query("select id, fqdn_ascii from domains where id = $1 and user_id = $2 and released_at is null", [app.domain_id, userId])).rows[0]);
    if (!d) throw new RecipeFail("domain_gone");
    // Recompute and compare: what runs is exactly what was previewed and approved.
    const plan = await withUser(ctx.runtime, userId, (c) => computePlan(ctx, c, userId, d, recipe, app.input));
    if (!safeEqual(planHash(plan), Buffer.from(app.plan_hash))) throw new RecipeFail("plan_changed");
    if (!checkVariableNames(plan).ok) throw new RecipeFail("invalid_name");
    await runPlan(ctx, userId, appId, { id: d.id, fqdn: d.fqdn_ascii }, plan);
    await withUser(ctx.runtime, userId, async (c) => {
      const r = await c.query("update recipe_applications set state = 'applied', applied_records = $3, applied_at = $4 where id = $1 and user_id = $2 and state = 'applying'", [appId, userId, JSON.stringify(plan.dns.add), ctx.clock.now()]);
      if (r.rowCount !== 1) throw new RecipeFail("state_changed");
      await appendAudit(ctx, c, { chainId: userId, actorKind: "system", action: "recipe.applied", resourceKind: "recipe_application", resourceId: appId, detail: { recipe: plan.recipe, version: plan.version, added: plan.dns.add.length, removed: plan.dns.remove.length, variables: plan.variables.length, steps: plan.steps.length } });
    });
    for (const cn of plan.connections) await ctx.cron.query("update connections set recipe_application_id = $2 where id = $1 and ended_at is null", [cn.id, appId]);
  } catch (e) {
    await fail(e instanceof RecipeFail ? e.code : e instanceof HttpError ? e.code : "apply_error");
  }
}

async function runPlan(ctx: AppContext, userId: string, appId: string, d: { id: string; fqdn: string }, plan: Plan): Promise<void> {
  const pv = providersOf(ctx);
  const conn = (s: Service) => { const c = plan.connections.find((x) => x.service === s); if (!c) throw new RecipeFail("connection_missing"); return c.id; };
  const refOf = async (s: Service) => (await ctx.cron.query("select external_ref, provider_facts from connections where id = $1 and ended_at is null", [conn(s)])).rows[0] as { external_ref: string | null; provider_facts: Record<string, unknown> } | undefined;
  // Values fetched for variables live only in this map, and only until they are written.
  const held = new Map<string, Buffer>();
  try {
    for (const step of plan.steps) {
      if (step.service === "vercel" && step.op === "project.domain.add") {
        const ref = (await refOf("vercel"))?.external_ref;
        if (!ref) throw new RecipeFail("connection_unchecked");
        await withCred(ctx, conn("vercel"), "recipe.apply", (cred) => pv.vercel.addProjectDomain(cred, ref, step.target));
      } else if (step.service === "neon" && step.op === "project.create") {
        const f = await refOf("neon");
        if (f?.provider_facts?.created_by_application === appId) continue;   // a retried job never creates twice
        const p = await withCred(ctx, conn("neon"), "recipe.apply", (cred) => pv.neon.createProject(cred, d.fqdn));
        await mergeFacts(ctx, conn("neon"), { project_id: p.id, branch: p.branch, database: p.database, role: p.role, host: p.host, pooler_host: p.poolerHost, created_by_application: appId }, p.id);
      } else if (step.service === "resend" && step.op === "domain.create") {
        const dom = await withCred(ctx, conn("resend"), "recipe.apply", (cred) => pv.resend.createDomain(cred, d.fqdn, String((plan.input as { region?: string }).region ?? "us-east-1")));
        await mergeFacts(ctx, conn("resend"), { domain_id: dom.id, region: dom.region, records: dom.records });
      } else if (step.service === "resend" && step.op === "api_key.create") {
        const f = (await refOf("resend"))?.provider_facts ?? {};
        if (typeof f.domain_id !== "string") throw new RecipeFail("connection_unchecked");
        const k = await withCred(ctx, conn("resend"), "recipe.apply", (cred) => pv.resend.createSendingKey(cred, f.domain_id as string, `mosshatch-${d.fqdn}`.slice(0, 50)));
        held.set("resend.sending_key", Buffer.from(k.token, "utf8"));
        await mergeFacts(ctx, conn("resend"), { sending_key_id: k.id });
      }
    }
    for (const v of plan.variables) {
      let value = held.get(v.source);
      if (!value && (v.source === "neon.pooled" || v.source === "neon.direct")) {
        const ref = (await refOf("neon"))?.external_ref;
        if (!ref) throw new RecipeFail("connection_unchecked");
        value = Buffer.from(await withCred(ctx, conn("neon"), "recipe.apply", (cred) => pv.neon.connectionUri(cred, ref, { pooled: v.source === "neon.pooled" })), "utf8");
        held.set(v.source, value);
      }
      if (!value) throw new RecipeFail("value_unavailable");
      for (const t of v.targets) {
        if (t.kind === "nest") await writeSecret(ctx, userId, { kind: "system", id: appId }, d.id, t.env, v.name, value);
        else {
          const ref = (await refOf("vercel"))?.external_ref;
          if (!ref) throw new RecipeFail("connection_unchecked");
          const plain = value.toString("utf8");
          // Sensitive variables are write-only at Vercel, but cannot target development (documented).
          await withCred(ctx, conn("vercel"), "recipe.apply", (cred) => pv.vercel.upsertEnv(cred, ref, { key: v.name, value: plain, type: t.target === "development" ? "encrypted" : "sensitive", target: [t.target] }));
        }
      }
    }
  } finally {
    for (const b of held.values()) b.fill(0);
  }
  if (plan.dns.add.length || plan.dns.remove.length) {
    await withUser(ctx.runtime, userId, (c) => writeRecipeZone(ctx, c, userId, d, plan.dns, plan.zone_before, { application: appId, cause: "recipe.apply" }));
  }
}

// ---- connection.check ------------------------------------------------------------------------------------------------------

export async function connectionCheckJob(ctx: AppContext, job: JobRow): Promise<void> {
  const connectionId = String(job.payload.connection_id ?? "");
  const cn = (await ctx.cron.query(
    "select n.id, n.user_id, n.domain_id, n.service, n.external_ref, n.provider_facts, d.fqdn_ascii from connections n join domains d on d.id = n.domain_id where n.id = $1 and n.ended_at is null and d.released_at is null", [connectionId])).rows[0];
  if (!cn) return;
  const pv = providersOf(ctx);
  let facts: Record<string, unknown> | null = null;
  try {
    if (cn.service === "vercel") {
      if (!cn.external_ref) throw new RecipeFail("connection_unchecked");
      const cfg = await withCred(ctx, cn.id, "connection.check", (cred) => pv.vercel.domainConfig(cred, cn.external_ref, cn.fqdn_ascii));
      facts = { project_id: cn.external_ref, a: cfg.recommendedIPv4.slice(0, 4), cname: cfg.recommendedCNAME, misconfigured: cfg.misconfigured };
    } else if (cn.service === "neon") {
      if (cn.external_ref) {
        const p = await withCred(ctx, cn.id, "connection.check", (cred) => pv.neon.describeProject(cred, cn.external_ref));
        facts = { project_id: p.id, branch: p.branch, database: p.database, role: p.role, host: p.host, pooler_host: p.poolerHost };
      } else facts = {};
    } else if (cn.service === "resend") {
      const dom = await withCred(ctx, cn.id, "connection.check", (cred) => pv.resend.findDomain(cred, cn.fqdn_ascii));
      facts = dom ? { domain_id: dom.id, region: dom.region, records: dom.records } : { domain_id: null, records: null };
    }
    await ctx.cron.query("update connections set provider_facts = provider_facts || $2::jsonb, checked_at = $3, status = 'active' where id = $1", [cn.id, JSON.stringify(facts ?? {}), ctx.clock.now()]);
  } catch {
    await ctx.cron.query("update connections set checked_at = $2, status = 'error' where id = $1 and ended_at is null", [cn.id, ctx.clock.now()]);
  }
  await scanDangling(ctx, cn);
}

/** ST-130: every host a recipe pointed at the provider is probed; the provider's not-found answer opens a finding and alerts. */
async function scanDangling(ctx: AppContext, cn: { id: string; user_id: string; domain_id: string; service: string; fqdn_ascii: string }): Promise<void> {
  if (cn.service !== "vercel") return;
  const apps = (await ctx.cron.query("select id, applied_records from recipe_applications where domain_id = $1 and user_id = $2 and state = 'applied' and recipe_id = 'hosting-vercel'", [cn.domain_id, cn.user_id])).rows;
  const pv = providersOf(ctx);
  for (const a of apps) {
    const hosts = new Set<string>();
    for (const r of (a.applied_records ?? []) as DnsRecord[]) if (r.type === "A" || r.type === "AAAA" || r.type === "CNAME") hosts.add(r.name === "" ? cn.fqdn_ascii : `${r.name}.${cn.fqdn_ascii}`);
    for (const host of hosts) {
      let res;
      try { res = await pv.probe.probe(host); } catch { continue; }   // unreachable is not proof of a dangling record
      await tx(ctx.cron, async (c) => {
        if (isProviderNotFound(res)) {
          const ins = await c.query(
            "insert into recipe_findings (user_id, domain_id, connection_id, application_id, kind, host, found_at) values ($1,$2,$3,$4,'dangling_target',$5,$6) on conflict do nothing returning id",
            [cn.user_id, cn.domain_id, cn.id, a.id, host, ctx.clock.now()]);
          if (ins.rowCount === 1) {
            await appendAudit(ctx, c, { chainId: cn.user_id, actorKind: "system", action: "recipe.dangling_found", resourceKind: "recipe_finding", resourceId: ins.rows[0].id, detail: { domain_id: cn.domain_id, application: a.id } });
            await raiseAlert(ctx, c, { severity: "warn", kind: "recipe.dangling_target", subject: cn.domain_id, detail: { finding: ins.rows[0].id } }).catch(() => undefined);
          }
        } else {
          await c.query("update recipe_findings set state = 'resolved', resolved_at = $3 where domain_id = $1 and host = $2 and state = 'open'", [cn.domain_id, host, ctx.clock.now()]);
        }
      });
    }
  }
}

/** Every 6 hours (own target): a check of every live connection that a recipe wired, so a dangling record is found in one scan. */
export const SCAN_EVERY_SEC = 6 * 3600;
export async function connectionScanJob(ctx: AppContext, _job: JobRow): Promise<void> {
  const rows = (await ctx.cron.query(
    `select distinct n.id, n.user_id from connections n join domains d on d.id = n.domain_id
      where n.ended_at is null and d.released_at is null and n.recipe_application_id is not null`)).rows;
  await tx(ctx.cron, async (c) => {
    for (const r of rows) await enqueue(c, { kind: "connection.check", userId: r.user_id, payload: { connection_id: r.id }, dedupeKey: `connection.check:${r.id}` });
  });
}

export function registerRecipeJobs(): void {
  if (!getJobDef("connection.scan")) registerJob({ kind: "connection.scan", priority: 1, maxRuntimeSec: 60, maxAttempts: 3, handler: connectionScanJob });
  registerRecurringJob({ kind: "connection.scan", everySec: SCAN_EVERY_SEC });
  if (!getJobDef("recipe.apply")) registerJob({ kind: "recipe.apply", priority: 1, maxRuntimeSec: 120, maxAttempts: 1, handler: recipeApplyJob });
  if (!getJobDef("connection.check")) registerJob({ kind: "connection.check", priority: 1, maxRuntimeSec: 60, maxAttempts: 3, handler: connectionCheckJob });
}
