import { withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { appendAudit } from "../audit.ts";
import { kekClassFor, type SecretEnv } from "../vault/kms/types.ts";
import { kmsContext, seal, type Sealed } from "../vault/envelope.ts";
import { vaultFailure, vaultOf, vaultTimeout } from "../vault/context.ts";
import { pointerMac, secretAad, type WriteActor } from "../vault/secrets.ts";

/**
 * The CLI's `push` writes its batch all or nothing (PLAN 4.5: "push (atomically)"). KMS never runs inside a transaction, so:
 * (1) one read of every name's identity and next version, creating nothing (a new name gets its id here, from the database's
 * own generator); (2) every value is sealed; (3) one transaction inserts the new identities, every version and every
 * pointer, each a compare-and-set against what step 1 read. A KMS failure in step 2 writes nothing; any conflict in step 3
 * (a concurrent writer, a name created meanwhile) rolls the whole batch back as 409. No versionless name is left behind.
 */

export interface BatchItem { name: string; value: Buffer }
export interface BatchWritten { id: string; name: string; version: number; created: boolean }

export async function writeSecretsAtomically(ctx: AppContext, userId: string, actor: WriteActor, domainId: string, env: SecretEnv, items: readonly BatchItem[]): Promise<BatchWritten[]> {
  const v = vaultOf(ctx);
  const names = items.map((i) => i.name);
  const plan = await withUser(v.pool, userId, async (c) => {
    const rows = (await c.query(
      `select s.id, s.name, s.current_version, (select coalesce(max(version), 0) from secret_versions x where x.secret_id = s.id) as maxv
         from secrets s where s.domain_id = $1 and s.env = $2 and s.user_id = $3 and s.deleted_at is null and s.name = any($4::text[])`,
      [domainId, env, userId, names])).rows;
    const known = new Map(rows.map((r) => [r.name as string, r]));
    const fresh = names.filter((n) => !known.has(n));
    const ids = fresh.length ? (await c.query("select uuidv7() as id from generate_series(1, $1)", [fresh.length])).rows.map((r) => r.id as string) : [];
    return names.map((name) => {
      const r = known.get(name);
      if (r) return { name, id: r.id as string, existing: true, current: r.current_version === null ? null : Number(r.current_version), version: Number(r.maxv) + 1 };
      return { name, id: ids.shift()!, existing: false, current: null as number | null, version: 1 };
    });
  });
  const sealed: Sealed[] = [];
  try {
    for (const [i, p] of plan.entries()) {
      try { sealed.push(await seal(v.kms, kekClassFor(env), kmsContext(env, userId, p.id), secretAad({ id: p.id, user_id: userId, domain_id: domainId, name: p.name, env }, p.version), items[i]!.value, vaultTimeout(v))); }
      catch (e) { throw await vaultFailure(ctx, e, p.id); }
    }
    await withUser(v.pool, userId, async (c) => {
      for (const [i, p] of plan.entries()) {
        const s = sealed[i]!;
        if (!p.existing) {
          const ins = await c.query("insert into secrets (id, user_id, domain_id, env, name) values ($1,$2,$3,$4,$5) on conflict (domain_id, env, name) where deleted_at is null do nothing returning id",
            [p.id, userId, domainId, env, p.name]);
          if (ins.rowCount !== 1) throw new HttpError(409, "write_conflict");
        } else {
          const cur = (await c.query("select current_version from secrets where id = $1 and user_id = $2 and deleted_at is null for update", [p.id, userId])).rows[0];
          if (!cur || (cur.current_version === null ? null : Number(cur.current_version)) !== p.current) throw new HttpError(409, "write_conflict");
        }
        const vid = (await c.query(
          `insert into secret_versions (secret_id, user_id, version, ciphertext, nonce, tag, wrapped_dek, kek_ref, kek_class, created_by_kind, created_by_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (secret_id, version) do nothing returning id`,
          [p.id, userId, p.version, s.ciphertext, s.nonce, s.tag, s.wrappedDek, s.kekRef, s.kekClass, actor.kind, actor.id])).rows[0]?.id as string | undefined;
        if (!vid) throw new HttpError(409, "write_conflict");
        const mac = await pointerMac(ctx, { id: p.id, domain_id: domainId, name: p.name, env, current_version: p.version, current_version_id: vid });
        const up = await c.query("update secrets set current_version = $2, current_version_id = $3, pointer_mac = $4 where id = $1 and current_version is not distinct from $5",
          [p.id, p.version, vid, mac, p.current]);
        if (up.rowCount !== 1) throw new HttpError(409, "write_conflict");
        await appendAudit(ctx, c, { chainId: userId, actorKind: actor.kind, actorId: actor.id, action: "secret.write", resourceKind: "secret", resourceId: p.id, detail: { domain_id: domainId, env, version: p.version, created: p.current === null } });
      }
    });
  } finally {
    for (const s of sealed) s.ciphertext.fill(0);
  }
  return plan.map((p) => ({ id: p.id, name: p.name, version: p.version, created: p.current === null }));
}
