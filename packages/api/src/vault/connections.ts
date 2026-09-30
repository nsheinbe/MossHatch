import { withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { appendAudit } from "../audit.ts";
import { kekClassFor } from "./kms/types.ts";
import { kmsContext, open, seal, type ConnectionAad } from "./envelope.ts";
import { vaultFailure, vaultOf, vaultTimeout } from "./context.ts";

/**
 * Stored provider credentials for wire-it recipes (PLAN 4.3b: Vercel, Neon and Resend). Same envelope as secrets, with
 * `kind: "connection"` and the connection id, credential id and service in the AAD; always the `prod` class. No route,
 * tool or command returns one: only `withConnectionCredential`, called by the `recipe.apply` and `connection.check` jobs,
 * decrypts, and it hands the value to a callback and zeroes its buffer afterwards. Revoking destroys the ciphertext in the
 * same statement (a trigger), whoever revokes.
 */

export const SERVICES = ["vercel", "neon", "resend"] as const;
export type Service = (typeof SERVICES)[number];
export type CredentialPurpose = "recipe.apply" | "connection.check";

const CONNECTION_ENV = "prod" as const;
const aadFor = (userId: string, domainId: string, connectionId: string, credentialId: string, service: string): ConnectionAad =>
  ({ kind: "connection", user_id: userId, domain_id: domainId, connection_id: connectionId, credential_id: credentialId, service, env: CONNECTION_ENV, version: 1, kek_class: kekClassFor(CONNECTION_ENV) });

export async function storeConnectionCredential(ctx: AppContext, userId: string, domainId: string, service: Service, input: { kind: "pasted_token" | "oauth_refresh"; credential: Buffer; scopeSummary?: string; externalRef?: string }): Promise<{ connectionId: string; credentialId: string }> {
  const v = vaultOf(ctx);
  const ids = await withUser(v.pool, userId, async (c) => {
    await c.query("insert into connections (user_id, domain_id, service, external_ref) values ($1,$2,$3,$4) on conflict (domain_id, service) where ended_at is null do nothing", [userId, domainId, service, input.externalRef ?? null]);
    const conn = (await c.query("select id from connections where domain_id = $1 and service = $2 and ended_at is null and user_id = $3", [domainId, service, userId])).rows[0];
    if (!conn) throw new HttpError(409, "write_conflict");
    const cred = (await c.query("select uuidv7() as id")).rows[0].id as string;
    return { connectionId: conn.id as string, credentialId: cred };
  });
  let sealed;
  try { sealed = await seal(v.kms, kekClassFor(CONNECTION_ENV), kmsContext(CONNECTION_ENV, userId, ids.credentialId), aadFor(userId, domainId, ids.connectionId, ids.credentialId, service), input.credential, vaultTimeout(v)); }
  catch (e) { throw await vaultFailure(ctx, e, ids.connectionId); }
  try {
    await withUser(v.pool, userId, async (c) => {
      // The connection must still be live: a disconnect that landed while KMS ran makes this write the loser (409), so no
      // credential is ever stored under an ended connection, where nothing could destroy it. The lock also serialises
      // concurrent writes to one connection (the later one replaces the earlier credential).
      const live = (await c.query("select id from connections where id = $1 and user_id = $2 and ended_at is null for update", [ids.connectionId, userId])).rows[0];
      if (!live) throw new HttpError(409, "write_conflict");
      const now = ctx.clock.now();
      await c.query("update connection_credentials set revoked_at = $2 where connection_id = $1 and revoked_at is null", [ids.connectionId, now]);
      await c.query(
        `insert into connection_credentials (id, connection_id, user_id, kind, scope_summary, ciphertext, nonce, tag, wrapped_dek, kek_ref, kek_class)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [ids.credentialId, ids.connectionId, userId, input.kind, input.scopeSummary ?? null, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.wrappedDek, sealed.kekRef, sealed.kekClass]);
      await c.query("update connections set status = 'active' where id = $1 and ended_at is null", [ids.connectionId]);
      await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "connection.credential.stored", resourceKind: "connection", resourceId: ids.connectionId, detail: { service, credential_id: ids.credentialId } });
    });
  } catch (e) {
    if (!(e instanceof HttpError) && (e as { code?: unknown }).code === "23505" && (e as { constraint?: unknown }).constraint === "connection_credentials_live") throw new HttpError(409, "write_conflict");
    throw e;
  } finally {
    sealed.ciphertext.fill(0);
  }
  return ids;
}

/** Disconnect: end the connection and destroy its credential (the trigger nulls ciphertext and wrapped key). */
export async function disconnect(ctx: AppContext, userId: string, domainId: string, service: Service): Promise<void> {
  const v = vaultOf(ctx);
  await withUser(v.pool, userId, async (c) => {
    const now = ctx.clock.now();
    const conn = (await c.query("update connections set ended_at = $3, status = 'ended' where domain_id = $1 and service = $2 and ended_at is null and user_id = $4 returning id", [domainId, service, now, userId])).rows[0];
    if (!conn) throw new HttpError(404, "not_found");
    const r = await c.query("update connection_credentials set revoked_at = $2 where connection_id = $1 and revoked_at is null", [conn.id, now]);
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "connection.disconnected", resourceKind: "connection", resourceId: conn.id, detail: { service, credentials_destroyed: r.rowCount ?? 0 } });
  });
}

/**
 * The only decrypt path for a stored credential: system jobs (`recipe.apply`, `connection.check`). The owner is looked up
 * under the cron role; the row is read and the audit row written by the vault role under the owner's tenant context
 * (PLAN 4.4: `connection.credential.used` is a vault-only audit row, 0805). The audit row commits before the decrypt; the
 * value exists only for the callback and its buffer is zeroed after.
 */
export async function withConnectionCredential<T>(ctx: AppContext, credentialId: string, purpose: CredentialPurpose, fn: (value: string) => Promise<T>): Promise<T> {
  const v = vaultOf(ctx);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(credentialId)) throw new HttpError(404, "not_found");
  const owner = (await ctx.cron.query("select user_id from connection_credentials where id = $1", [credentialId])).rows[0]?.user_id as string | undefined;
  if (!owner) throw new HttpError(404, "not_found");
  const row = await withUser(v.pool, owner, async (c) => {
    const r = (await c.query(
      `select k.*, n.domain_id, n.service from connection_credentials k join connections n on n.id = k.connection_id
        where k.id = $1 and k.user_id = $2 and k.revoked_at is null and n.ended_at is null`, [credentialId, owner])).rows[0];
    if (!r) throw new HttpError(404, "not_found");
    await appendAudit(ctx, c, { chainId: r.user_id, actorKind: "system", action: "connection.credential.used", resourceKind: "connection", resourceId: r.connection_id, detail: { purpose, credential_id: r.id, decrypt_nonce: r.id } });
    await c.query("update connection_credentials set last_used_at = $2 where id = $1", [r.id, ctx.clock.now()]);
    return r;
  });
  let buf: Buffer;
  try {
    buf = await open(v.kms, kekClassFor(CONNECTION_ENV), kmsContext(CONNECTION_ENV, row.user_id, row.id), aadFor(row.user_id, row.domain_id, row.connection_id, row.id, row.service),
      { ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag, wrappedDek: row.wrapped_dek, kekRef: row.kek_ref }, vaultTimeout(v));
  } catch (e) { throw await vaultFailure(ctx, e, row.connection_id); }
  try { return await fn(buf.toString("utf8")); } finally { buf.fill(0); }
}

export async function listConnections(c: import("@mosshatch/db").PoolClient, userId: string, domainId: string) {
  const r = await c.query("select id, service, status, created_at from connections where user_id = $1 and domain_id = $2 and ended_at is null order by service", [userId, domainId]);
  return r.rows.map((x) => ({ id: x.id as string, service: x.service as string, status: x.status as string, connected_at: new Date(x.created_at).toISOString() }));
}
