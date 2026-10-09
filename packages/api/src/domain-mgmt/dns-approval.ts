import { z } from "zod";
import type { PoolClient } from "@mosshatch/db";
import type { DnsRecord } from "@mosshatch/registrar/port";
import { canonicalZone, validateZone, zoneHash } from "@mosshatch/registrar/dns";
import { HttpError } from "../http/router.ts";
import type { AppContext } from "../ports.ts";
import type { HandlerReq } from "../http/types.ts";
import { ACTION_HEADER, createStepUpGate, markExecuted } from "../stepup/gate.ts";
import { registerRoutedSpec } from "../agents/specs.ts";
import type { ActionSpec } from "../stepup/specs.ts";
import { assertWritesOpen, registrarOf, type DomainRow } from "./common.ts";
import { checkShape, diffZones, materializeTtl, sensitiveOf, type ZoneChange } from "./dns.ts";

// Full existing records can include provider-supported types the editor cannot create.
// Validation below permits those only when byte-for-byte unchanged from the authoritative read.
const record = z.strictObject({ type: z.string().min(1).max(32), name: z.string().max(253), value: z.string().max(65535),
  priority: z.number().int().optional(), weight: z.number().int().optional(), port: z.number().int().optional(), ttl: z.number().int().min(0).max(2147483647).optional() });
const input = z.strictObject({ before_hash: z.string().regex(/^[a-f0-9]{64}$/), desired: z.array(record).max(10000) });

const spec: ActionSpec<z.infer<typeof input>> = {
  type: "dns.sensitive.approve", held: true, userInput: input,
  async derive(ctx, c, userId, targetId, request) {
    const id = targetId.slice(3);
    const d = (await c.query("select * from domains where id=$1 and user_id=$2 and released_at is null", [id, userId])).rows[0] as DomainRow | undefined;
    if (!d) throw new HttpError(404, "not_found");
    await assertWritesOpen(c);
    const fresh = await registrarOf(ctx).getDns(d.fqdn_ascii);
    if (!fresh.hosted) throw new HttpError(409, "dns_not_hosted");
    const live = canonicalZone(fresh.records);
    if (zoneHash(live) !== request.before_hash) throw new HttpError(409, "zone_changed");
    const desired = materializeTtl(request.desired as DnsRecord[], live, fresh.defaultTtl);
    checkShape(desired); validateZone(desired, live);
    const diff = diffZones(live, desired);
    return { params: { route: "dns_session", user_id: userId, domain_id: d.id, fqdn: d.fqdn_ascii,
      before_hash: request.before_hash, after_hash: zoneHash(desired), desired,
      added: diff.added.length, removed: diff.removed.length, sensitive: sensitiveOf(d.fqdn_ascii, diff, live).length }, resourceId: d.id };
  },
  summary: (p) => `Approve exactly ${String(p.added)} added and ${String(p.removed)} removed DNS records on ${String(p.fqdn)}. Mail, certificates or services may be affected.`,
};

export function registerSessionDnsApproval(): void {
  registerRoutedSpec("dns.sensitive.approve", (t) => /^dz_[0-9a-f-]{36}$/i.test(t), "dns_session", spec as ActionSpec);
}

/** Read again at the intent boundary; avoid late session row locks that invert recovery/closure lock order. */
export async function assertDnsOwnerSession(ctx: AppContext, c: PoolClient, userId: string, sessionHash: Buffer | undefined): Promise<void> {
  if (!sessionHash) throw new HttpError(403, "session_unavailable");
  const session = (await c.query("select s.revoked_at, s.expires_at, s.idle_expires_at, u.status, u.frozen_at from sessions s join users u on u.id=s.user_id where s.id_hash=$1 and s.user_id=$2", [sessionHash, userId])).rows[0];
  const now = ctx.clock.now();
  if (!session || session.revoked_at || session.status !== "active" || session.frozen_at || new Date(session.expires_at) <= now || new Date(session.idle_expires_at) <= now) throw new HttpError(403, "session_unavailable");
}

/** Called under the same domain lock, immediately before the durable write intent commits. */
export async function approveSessionDns(req: HandlerReq, c: PoolClient, d: DomainRow, live: DnsRecord[], change: ZoneChange): Promise<void> {
  await assertDnsOwnerSession(req.ctx, c, d.user_id, req.principal.sessionIdHash);
  if (!change.sensitive.length && !req.request.headers.has(ACTION_HEADER)) return;
  if (!req.request.headers.has(ACTION_HEADER)) throw new HttpError(403, "step_up_required", undefined, undefined, {
    type: "dns.sensitive.approve", target_id: `dz_${d.id}`, user_input: { desired: change.desired, before_hash: zoneHash(live) },
    added: change.diff.added, removed: change.diff.removed, sensitive_records: change.sensitive,
  });
  const action = await createStepUpGate()(req, "dns.sensitive.approve");
  const p = action.params as Record<string, unknown>;
  if (p.route !== "dns_session" || p.user_id !== d.user_id || p.domain_id !== d.id || p.fqdn !== d.fqdn_ascii) throw new HttpError(409, "params_changed");
  if (p.before_hash !== zoneHash(live)) throw new HttpError(409, "zone_changed");
  if (p.after_hash !== zoneHash(change.desired)) throw new HttpError(409, "params_changed");
  await markExecuted(c, action);
}
