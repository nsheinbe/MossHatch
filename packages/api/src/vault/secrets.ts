import { withUser, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { appendAudit } from "../audit.ts";
import { canonicalJson, safeEqual } from "../util/bytes.ts";
import { kekClassFor, SECRET_ENVS, type SecretEnv } from "./kms/types.ts";
import { kmsContext, open, seal, VaultIntegrityError, type SecretAad } from "./envelope.ts";
import { vaultFailure, vaultOf, vaultTimeout } from "./context.ts";

/** Secret identity and versions. Every function here runs as the vault role, under the owner's tenant context. */

export interface SecretRow {
  id: string; user_id: string; domain_id: string; env: SecretEnv; name: string;
  current_version: number | null; current_version_id: string | null; pointer_mac: Buffer | null;
}
export interface VersionRow {
  version_id: string; version: number; ciphertext: Buffer | null; nonce: Buffer; tag: Buffer; wrapped_dek: Buffer | null;
  kek_ref: string; kek_class: string; destroyed_at: Date | null;
}

export const parseEnv = (raw: string | undefined): SecretEnv | null => (SECRET_ENVS as readonly string[]).includes(raw ?? "") ? raw as SecretEnv : null;

/** KMS HMAC (the `pointer` key) over the secret's identity and its current version: a database writer cannot re-point it. */
export async function pointerMac(ctx: Pick<AppContext, "kms">, s: { id: string; domain_id: string; name: string; env: string; current_version: number; current_version_id: string }): Promise<Buffer> {
  return ctx.kms.hmac("pointer", Buffer.from(canonicalJson({ v: 1, secret_id: s.id, domain_id: s.domain_id, name: s.name, env: s.env, current_version: s.current_version, current_version_id: s.current_version_id })));
}

export const secretAad = (s: Pick<SecretRow, "user_id" | "domain_id" | "id" | "name" | "env">, version: number): SecretAad =>
  ({ kind: "secret", user_id: s.user_id, domain_id: s.domain_id, secret_id: s.id, name: s.name, env: s.env, version, kek_class: kekClassFor(s.env) });

/**
 * Load a live secret and its current version for decrypt, checking the pointer MAC, that the version row is the one the
 * pointer names, and that the stored KEK class matches the class derived from the stored env (never from the request).
 */
export async function loadCurrent(ctx: Pick<AppContext, "kms">, c: PoolClient, where: { id: string } | { domainId: string; env: SecretEnv; names?: string[] }, userId: string): Promise<(SecretRow & VersionRow)[]> {
  const cols = `s.id, s.user_id, s.domain_id, s.env, s.name, s.current_version, s.current_version_id, s.pointer_mac,
                v.id as version_id, v.version, v.ciphertext, v.nonce, v.tag, v.wrapped_dek, v.kek_ref, v.kek_class, v.destroyed_at`;
  const rows = "id" in where
    ? (await c.query(`select ${cols} from secrets s left join secret_versions v on v.id = s.current_version_id where s.id = $1 and s.user_id = $2 and s.deleted_at is null and s.current_version is not null`, [where.id, userId])).rows
    : (await c.query(`select ${cols} from secrets s left join secret_versions v on v.id = s.current_version_id
         where s.domain_id = $1 and s.env = $2 and s.user_id = $3 and s.deleted_at is null and s.current_version is not null and ($4::text[] is null or s.name = any($4::text[])) order by s.name`,
      [where.domainId, where.env, userId, where.names ?? null])).rows;
  for (const r of rows) {
    if (!r.version_id || !r.pointer_mac || Number(r.version) !== Number(r.current_version) || r.kek_class !== kekClassFor(r.env) || r.destroyed_at) throw new VaultIntegrityError();
    const mac = await pointerMac(ctx, { id: r.id, domain_id: r.domain_id, name: r.name, env: r.env, current_version: Number(r.current_version), current_version_id: r.current_version_id });
    if (!safeEqual(mac, Buffer.from(r.pointer_mac))) throw new VaultIntegrityError();
    r.version = Number(r.version); r.current_version = Number(r.current_version);
  }
  return rows as (SecretRow & VersionRow)[];
}

/** Decrypt one loaded row under the role of its stored class. */
export async function openRow(ctx: Pick<AppContext, "services">, r: SecretRow & VersionRow): Promise<Buffer> {
  const v = vaultOf(ctx);
  return open(v.kms, kekClassFor(r.env), kmsContext(r.env, r.user_id, r.id), secretAad(r, r.version),
    { ciphertext: r.ciphertext ? Buffer.from(r.ciphertext) : null, nonce: Buffer.from(r.nonce), tag: Buffer.from(r.tag), wrappedDek: r.wrapped_dek ? Buffer.from(r.wrapped_dek) : null, kekRef: r.kek_ref }, vaultTimeout(v));
}

export interface WriteActor { kind: "user" | "agent" | "cli" | "system"; id: string }

/**
 * Write a new version. Three steps so KMS never runs inside a transaction: (1) make sure the identity row exists and
 * read the version to write; (2) GenerateDataKey and encrypt; (3) compare-and-set the pointer (a concurrent writer that
 * moved it first makes this one the loser: 409). A failed KMS call leaves an identity row with no version, which no
 * list shows and the next write reuses.
 */
export async function writeSecret(ctx: AppContext, userId: string, actor: WriteActor, domainId: string, env: SecretEnv, name: string, value: Buffer): Promise<{ id: string; version: number; created: boolean }> {
  const v = vaultOf(ctx);
  const pre = await withUser(v.pool, userId, async (c) => {
    const ins = await c.query(
      "insert into secrets (user_id, domain_id, env, name) values ($1,$2,$3,$4) on conflict (domain_id, env, name) where deleted_at is null do nothing returning id",
      [userId, domainId, env, name]);
    const r = (await c.query(
      "select s.id, s.current_version, (select coalesce(max(version), 0) from secret_versions x where x.secret_id = s.id) as maxv from secrets s where s.domain_id = $1 and s.env = $2 and s.name = $3 and s.deleted_at is null and s.user_id = $4",
      [domainId, env, name, userId])).rows[0];
    if (!r) throw new HttpError(409, "write_conflict");
    return { id: r.id as string, current: r.current_version === null ? null : Number(r.current_version), maxv: Number(r.maxv), created: ins.rowCount === 1 || r.current_version === null };
  });
  const version = pre.maxv + 1;
  const identity = { id: pre.id, user_id: userId, domain_id: domainId, name, env };
  let sealed;
  try { sealed = await seal(v.kms, kekClassFor(env), kmsContext(env, userId, pre.id), secretAad(identity, version), value, vaultTimeout(v)); }
  catch (e) { throw await vaultFailure(ctx, e, pre.id); }
  try {
    await withUser(v.pool, userId, async (c) => {
      const cur = (await c.query("select current_version from secrets where id = $1 and user_id = $2 and deleted_at is null for update", [pre.id, userId])).rows[0];
      if (!cur || (cur.current_version === null ? null : Number(cur.current_version)) !== pre.current) throw new HttpError(409, "write_conflict");
      const vid = (await c.query(
        `insert into secret_versions (secret_id, user_id, version, ciphertext, nonce, tag, wrapped_dek, kek_ref, kek_class, created_by_kind, created_by_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (secret_id, version) do nothing returning id`,
        [pre.id, userId, version, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.wrappedDek, sealed.kekRef, sealed.kekClass, actor.kind, actor.id])).rows[0]?.id as string | undefined;
      if (!vid) throw new HttpError(409, "write_conflict");
      const mac = await pointerMac(ctx, { id: pre.id, domain_id: domainId, name, env, current_version: version, current_version_id: vid });
      const up = await c.query("update secrets set current_version = $2, current_version_id = $3, pointer_mac = $4 where id = $1 and current_version is not distinct from $5",
        [pre.id, version, vid, mac, pre.current]);
      if (up.rowCount !== 1) throw new HttpError(409, "write_conflict");
      await appendAudit(ctx, c, { chainId: userId, actorKind: actor.kind, actorId: actor.id, action: "secret.write", resourceKind: "secret", resourceId: pre.id, detail: { domain_id: domainId, env, version, created: pre.created } });
    });
  } finally {
    sealed.ciphertext.fill(0);
  }
  return { id: pre.id, version, created: pre.created };
}

/** Delete: the ciphertext and wrapped key of every version are nulled at once; Neon history keeps encrypted copies for its window. */
export async function deleteSecret(ctx: AppContext, userId: string, domainId: string, env: SecretEnv, name: string): Promise<{ id: string; versions: number }> {
  const v = vaultOf(ctx);
  return withUser(v.pool, userId, async (c) => {
    const now = ctx.clock.now();
    const s = (await c.query("update secrets set deleted_at = $5 where domain_id = $1 and env = $2 and name = $3 and user_id = $4 and deleted_at is null returning id", [domainId, env, name, userId, now])).rows[0];
    if (!s) throw new HttpError(404, "not_found");
    const d = await c.query("update secret_versions set ciphertext = null, wrapped_dek = null, destroyed_at = $2 where secret_id = $1 and destroyed_at is null", [s.id, now]);
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "secret.delete", resourceKind: "secret", resourceId: s.id, detail: { domain_id: domainId, env, versions: d.rowCount ?? 0 } });
    return { id: s.id as string, versions: d.rowCount ?? 0 };
  });
}

/** Names and versions only (runtime role: it cannot read ciphertext). */
export async function listSecrets(c: PoolClient, userId: string, domainId: string, env?: SecretEnv) {
  const r = await c.query(
    `select id, env, name, current_version as version, updated_at from secrets
      where user_id = $1 and domain_id = $2 and deleted_at is null and current_version is not null and ($3::text is null or env = $3) order by env, name`,
    [userId, domainId, env ?? null]);
  return r.rows.map((x) => ({ id: x.id as string, env: x.env as SecretEnv, name: x.name as string, version: Number(x.version), updated_at: new Date(x.updated_at).toISOString() }));
}

