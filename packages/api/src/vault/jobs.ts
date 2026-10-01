import { tx } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { appendAudit, SYSTEM_CHAIN } from "../audit.ts";
import { getJobDef, registerJob, type JobRow } from "../jobs/registry.ts";
import { notifyUser } from "../auth/mail.ts";
import { KmsError } from "./kms/types.ts";
import { kmsContext } from "./envelope.ts";
import { vaultOf } from "./context.ts";
import { VAULT_MAIL } from "./mail.ts";

/**
 * Vault jobs. Payloads carry ids only (the jobs table rejects secret-shaped keys).
 *  - `vault.read_digest`: the hourly email summarising a token's reads (PLAN 4.5), counts only.
 *  - `vault.rewrap`: move every wrapped data key from one KEK to another with KMS `ReEncrypt` under the operator role.
 *    Values, nonces, tags and the AAD are untouched (the AAD names the KEK class, not the ARN). Resumable and
 *    idempotent: each row is a compare-and-set on the old wrapped key.
 */

export async function sendReadDigest(ctx: AppContext, job: Pick<JobRow, "payload">): Promise<{ sent: boolean; reads: number }> {
  const { user_id, binding_id, hour } = job.payload as { user_id: string; binding_id: string; hour: string };
  const from = new Date(hour), to = new Date(from.getTime() + 3_600_000);
  return tx(ctx.cron, async (c) => {
    const r = (await c.query(
      `select count(*)::int as reads, count(*) filter (where detail->>'env' = 'prod')::int as prod from audit_log
        where chain_id = $1 and action = 'secret.read' and actor_id = $2 and at >= $3 and at < $4`, [user_id, binding_id, from, to])).rows[0];
    if (!r.reads) return { sent: false, reads: 0 };
    const mail = VAULT_MAIL.readDigest({ reads: r.reads, prodReads: r.prod, bindingRef: binding_id.replace(/-/g, "").slice(-8), hour: from.toISOString() }, ctx.config.origin);
    const out = await notifyUser(ctx, c, user_id, { kind: "secret.read_digest", subject: mail.subject, text: mail.text, dedupeKey: `vault.read_digest:${binding_id}:${from.toISOString()}`, immediate: true });
    return { sent: out.sent, reads: r.reads };
  });
}

export interface RewrapResult { rewrapped: number; lost: number; remaining: number }

/** One batch. KMS errors propagate (the job retries with backoff); a lost compare-and-set means another worker won. */
export async function rewrapBatch(ctx: AppContext, fromKek: string, toKek: string, limit = 200): Promise<RewrapResult> {
  const v = vaultOf(ctx);
  let rewrapped = 0, lost = 0;
  const secrets = (await ctx.cron.query(
    `select v.id, v.user_id, v.wrapped_dek, s.env, s.id as record_id from secret_versions v join secrets s on s.id = v.secret_id
      where v.kek_ref = $1 and v.destroyed_at is null order by v.id limit $2`, [fromKek, limit])).rows;
  for (const r of secrets) {
    const context = kmsContext(r.env, r.user_id, r.record_id);
    const out = await v.kms.reEncrypt("operator", { ciphertextBlob: Buffer.from(r.wrapped_dek), sourceKeyId: fromKek, sourceContext: context, destinationKeyId: toKek, destinationContext: context });
    if (out.keyId !== toKek) throw new KmsError("IncorrectKeyException");
    const u = await ctx.cron.query("update secret_versions set wrapped_dek = $3, kek_ref = $4 where id = $1 and wrapped_dek = $2 and kek_ref = $5", [r.id, r.wrapped_dek, out.ciphertextBlob, toKek, fromKek]);
    if (u.rowCount === 1) rewrapped++; else lost++;
  }
  const creds = (await ctx.cron.query("select id, user_id, wrapped_dek from connection_credentials where kek_ref = $1 and revoked_at is null order by id limit $2", [fromKek, limit])).rows;
  for (const r of creds) {
    const context = kmsContext("prod", r.user_id, r.id);
    const out = await v.kms.reEncrypt("operator", { ciphertextBlob: Buffer.from(r.wrapped_dek), sourceKeyId: fromKek, sourceContext: context, destinationKeyId: toKek, destinationContext: context });
    const u = await ctx.cron.query("update connection_credentials set wrapped_dek = $3, kek_ref = $4 where id = $1 and wrapped_dek = $2 and kek_ref = $5", [r.id, r.wrapped_dek, out.ciphertextBlob, toKek, fromKek]);
    if (u.rowCount === 1) rewrapped++; else lost++;
  }
  const remaining = (await ctx.cron.query(
    "select (select count(*) from secret_versions where kek_ref = $1 and destroyed_at is null) + (select count(*) from connection_credentials where kek_ref = $1 and revoked_at is null) as n", [fromKek])).rows[0].n;
  return { rewrapped, lost, remaining: Number(remaining) };
}

/** Run batches until nothing is left under `fromKek`. One system audit row with counts. */
export async function rewrapAll(ctx: AppContext, fromKek: string, toKek: string, batch = 200): Promise<{ rewrapped: number; batches: number }> {
  let total = 0, batches = 0;
  for (;;) {
    const r = await rewrapBatch(ctx, fromKek, toKek, batch);
    total += r.rewrapped; batches++;
    if (r.remaining === 0) break;
    if (r.rewrapped === 0 && r.lost === 0) break;
  }
  await tx(ctx.cron, (c) => appendAudit(ctx, c, { chainId: SYSTEM_CHAIN, actorKind: "system", action: "vault.rewrap", detail: { rewrapped: total, batches } }));
  return { rewrapped: total, batches };
}

export function registerVaultJobs(): void {
  if (!getJobDef("vault.read_digest")) registerJob({ kind: "vault.read_digest", priority: 1, maxRuntimeSec: 60, handler: async (ctx, job) => { await sendReadDigest(ctx, job); } });
  if (!getJobDef("vault.rewrap")) registerJob({ kind: "vault.rewrap", priority: 1, maxRuntimeSec: 300, maxAttempts: 20, handler: async (ctx, job) => {
    const { from_kek, to_kek } = job.payload as { from_kek: string; to_kek: string };
    await rewrapAll(ctx, from_kek, to_kek);
  } });
}
