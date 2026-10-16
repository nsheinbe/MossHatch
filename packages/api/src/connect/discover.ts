import type { PoolClient } from "@mosshatch/db";
import { withNoUser } from "@mosshatch/db";
import type { DnsRecord } from "@mosshatch/registrar/port";
import { RegistrarError } from "@mosshatch/registrar/port";
import { zoneHash } from "@mosshatch/registrar/dns";
import type { AppContext } from "../ports.ts";
import { HttpError, json, type Router } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import type { JobRow } from "../jobs/registry.ts";
import { enqueue } from "../jobs/registry.ts";
import { appendAudit } from "../audit.ts";
import { assertWritesOpen, normalizeFqdn, notFound, registrarOf } from "../domain-mgmt/common.ts";
import { SNAPSHOT_TTL_MS, diffZones, sensitiveOf } from "../domain-mgmt/dns.ts";
import { flagOn } from "./flags.ts";
import { pinnedTemplate } from "./templates.ts";

/**
 * DC-07. One TXT, name `_domainconnect`, value the settings host from config. The rest of the zone is not rewritten:
 * the job uses add-only when the port has it, and does nothing when it does not. `replaceZone` is never called.
 */

const PROVIDER_ID = "mosshatch.com";
const PROVIDER_NAME = "Moss Hatch";
const TXT_NAME = "_domainconnect";
/** Same advisory-lock key as a user DNS write, so the two exclude each other. */
const lockKey = (domainId: string) => `mh.dns:${domainId}`;

type Step = <R>(f: (c: PoolClient) => Promise<R>) => Promise<R>;

async function withDnsLock<T>(ctx: AppContext, userId: string, domainId: string, fn: (step: Step) => Promise<T>): Promise<T> {
  const conn = await ctx.runtime.connect();
  let broken = false;
  let locked = false;
  const key = lockKey(domainId);
  const step: Step = async (f) => {
    await conn.query("begin");
    try {
      await conn.query("select set_config('app.user_id', $1, true)", [userId]);
      if (!locked) {
        await conn.query("select pg_advisory_lock(hashtextextended($1, 0))", [key]);
        locked = true;
      }
      const r = await f(conn);
      await conn.query("commit");
      return r;
    } catch (e) {
      await conn.query("rollback").catch(() => { broken = true; });
      throw e;
    }
  };
  try { return await fn(step); }
  finally {
    if (locked) await conn.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => { broken = true; });
    conn.release(broken);
  }
}

async function domainRow(ctx: AppContext, domainId: string): Promise<{ id: string; user_id: string; fqdn_ascii: string; dns_hosted_here: boolean } | undefined> {
  return (await ctx.cron.query("select id, user_id, fqdn_ascii, dns_hosted_here from domains where id = $1 and released_at is null", [domainId])).rows[0];
}

/** Add the discovery TXT when it is absent. Returns without a registrar write when the flag, the host, or the zone says not to. */
export async function ensureDomainConnectTxt(ctx: AppContext, domainId: string): Promise<"added" | "present" | "skipped"> {
  if (!(await flagOn(ctx, "domainconnect.discovery"))) return "skipped";
  const host = ctx.config.domainConnectHost;
  if (!host) return "skipped";
  const row = await domainRow(ctx, domainId);
  if (!row || row.dns_hosted_here !== true) return "skipped";
  const port = registrarOf(ctx);
  if (!port.addRecords) return "skipped";
  const txt: DnsRecord = { type: "TXT", name: TXT_NAME, value: host };
  return withDnsLock(ctx, row.user_id, row.id, async (step) => {
    await step(async () => undefined);
    const zone = await port.getDns(row.fqdn_ascii);
    if (!zone.hosted || zone.records.some((r) => r.type === "TXT" && r.name === TXT_NAME)) return zone.hosted ? "present" : "skipped";
    let snapId = "";
    const opened = await step(async (c) => {
      try { await assertWritesOpen(c); } catch (e) { if (e instanceof HttpError && e.code === "registrar_writes_paused") return false; throw e; }
      const desired = [...zone.records, txt];
      const diff = diffZones(zone.records, desired);
      const sensitive = sensitiveOf(row.fqdn_ascii, diff);
      const now = ctx.clock.now();
      const snap = (await c.query(
        `insert into dns_snapshots (user_id, domain_id, reason, zone_hash, records, added_count, removed_count, sensitive_count, actor_kind, taken_at, expires_at, write_state, intended_hash)
         values ($1,$2,'pre_write',$3,$4,$5,$6,$7,'system',$8,$9,'pending',$10) returning id`,
        [row.user_id, row.id, zoneHash(zone.records), JSON.stringify(zone.records), diff.added.length, diff.removed.length, sensitive.length, now, new Date(now.getTime() + SNAPSHOT_TTL_MS), zoneHash(desired)])).rows[0];
      snapId = snap.id as string;
      await appendAudit(ctx, c, { chainId: row.user_id, actorKind: "system", action: "dns.write_intent", resourceKind: "domain", resourceId: row.id, detail: { snapshot: snapId, source: "domainconnect", added: diff.added.length, removed: diff.removed.length } });
      return true;
    });
    if (!opened) return "skipped";
    try {
      const written = await port.addRecords!(row.fqdn_ascii, [txt]);
      await step(async (c) => {
        await c.query("update dns_snapshots set write_state = 'applied', after_hash = $2 where id = $1 and write_state = 'pending'", [snapId, written.hash]);
        await appendAudit(ctx, c, { chainId: row.user_id, actorKind: "system", action: "dns.write", resourceKind: "domain", resourceId: row.id, detail: { snapshot: snapId, source: "domainconnect", added: 1, removed: 0 } });
      });
      return "added";
    } catch (e) {
      const refused = e instanceof RegistrarError && e.kind === "rejected";
      await step(async (c) => {
        await c.query("update dns_snapshots set write_state = $2 where id = $1 and write_state = 'pending'", [snapId, refused ? "refused" : "unknown"]);
      }).catch(() => undefined);
      throw e;
    }
  });
}

/** One domain when `domain_id` is set. Otherwise enqueue one job per hosted domain. The flag off does neither. */
export async function discoverJob(ctx: AppContext, job: JobRow): Promise<void> {
  if (!(await flagOn(ctx, "domainconnect.discovery"))) return;
  const domainId = job.payload.domain_id;
  if (typeof domainId === "string") { await ensureDomainConnectTxt(ctx, domainId); return; }
  const rows = (await ctx.cron.query("select id, user_id from domains where dns_hosted_here = true and released_at is null order by id limit 100")).rows as { id: string; user_id: string }[];
  await withNoUser(ctx.cron, async (c) => {
    for (const row of rows) await enqueue(c, { kind: "connect.discover", payload: { domain_id: row.id }, dedupeKey: `connect.discover:${row.id}`, userId: row.user_id });
  });
}

export async function settings(req: HandlerReq): Promise<HandlerResult> {
  if (!(await flagOn(req.ctx, "domainconnect.discovery"))) throw notFound();
  const name = normalizeFqdn(req.params.domain ?? "");
  const row = name ? (await req.ctx.cron.query("select dns_hosted_here from domains where fqdn_ascii = $1 and released_at is null", [name])).rows[0] : undefined;
  if (!row || row.dns_hosted_here !== true) throw notFound();
  const body: Record<string, string> = { providerId: PROVIDER_ID, providerName: PROVIDER_NAME, urlAPI: req.ctx.config.origin };
  if (await flagOn(req.ctx, "domainconnect.apply")) body.urlSyncUX = req.ctx.config.origin;
  return json(body);
}

export async function template(req: HandlerReq): Promise<HandlerResult> {
  if (!(await flagOn(req.ctx, "domainconnect.discovery"))) throw notFound();
  const body = pinnedTemplate(req.params.providerId ?? "", req.params.serviceId ?? "");
  if (!body || typeof body !== "object") throw notFound();
  return json(body as Record<string, unknown>);
}

export function registerDiscoveryRoutes(router: Router): void {
  router.add(
    { method: "GET", path: "/v2/domainconnect/:domain/settings", principals: ["anonymous"], handler: settings, tag: "connect" },
    { method: "GET", path: "/v2/domainTemplates/providers/:providerId/services/:serviceId", principals: ["anonymous"], handler: template, tag: "connect" },
  );
}
