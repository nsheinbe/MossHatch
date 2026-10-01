import { withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import type { SecretEnv } from "../vault/kms/types.ts";
import type { Sealed } from "../vault/envelope.ts";
import { vaultOf } from "../vault/context.ts";
import { commitVersion, sealVersion, type NextVersion, type WriteActor } from "../vault/secrets.ts";

/**
 * The CLI's `push` writes its batch all or nothing (PLAN 4.5: "push (atomically)"). KMS never runs inside a transaction, so:
 * (1) one read of every name's identity and next version, creating nothing (a new name gets its id here, from the database's
 * own generator); (2) every value is sealed; (3) one transaction inserts the new identities, every version and every
 * pointer, each a compare-and-set against what step 1 read. A KMS failure in step 2 writes nothing; any conflict in step 3
 * (a concurrent writer, a name created meanwhile) rolls the whole batch back as 409. No versionless name is left behind.
 * Sealing and the version write are the vault's own (`sealVersion`, `commitVersion`, shared with `writeSecret`), so the AAD, the
 * KEK class, the single-use pointer MAC (migration 0805) and the audit row cannot drift between the two; only step 1 is push's.
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
    return names.map((name): NextVersion & { existing: boolean } => {
      const r = known.get(name);
      if (r) {
        const current = r.current_version === null ? null : Number(r.current_version);
        return { name, id: r.id as string, domainId, env, existing: true, current, version: Number(r.maxv) + 1, created: current === null };
      }
      return { name, id: ids.shift()!, domainId, env, existing: false, current: null, version: 1, created: true };
    });
  });
  const sealed: Sealed[] = [];
  try {
    for (const [i, p] of plan.entries()) sealed.push(await sealVersion(ctx, userId, p, items[i]!.value));
    await withUser(v.pool, userId, async (c) => {
      for (const [i, p] of plan.entries()) {
        if (!p.existing) {
          const ins = await c.query("insert into secrets (id, user_id, domain_id, env, name) values ($1,$2,$3,$4,$5) on conflict (domain_id, env, name) where deleted_at is null do nothing returning id",
            [p.id, userId, domainId, env, p.name]);
          if (ins.rowCount !== 1) throw new HttpError(409, "write_conflict");
        }
        await commitVersion(ctx, c, userId, actor, p, sealed[i]!);
      }
    });
  } finally {
    for (const s of sealed) s.ciphertext.fill(0);
  }
  return plan.map((p) => ({ id: p.id, name: p.name, version: p.version, created: p.created }));
}
