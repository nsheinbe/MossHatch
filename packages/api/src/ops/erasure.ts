import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tx } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { appendAudit } from "../audit.ts";
import { isWriteOnceConflict, type S3LikeClient } from "./anchor.ts";

/** Hash stored in the ledger: not the user id, so the ledger file alone names nobody. UUIDv7 ids carry 74 random bits. */
export const erasureHash = (userId: string): string => crypto.createHash("sha256").update("mh-erasure-v1:" + userId).digest("hex");

export interface ErasureEntry { userHash: string; erasedAt: string }

/**
 * The erasure ledger lives OUTSIDE the database so that a point-in-time restore cannot resurrect an erased user:
 * every restore ends by replaying the purge from this ledger (D-027, D-030). Append-only; `list` returns everything.
 * Production keeps it in the log-archive bucket next to the anchors; FileErasureLedger is the local form.
 */
export interface ErasureLedger {
  append(e: ErasureEntry): Promise<void>;
  list(): Promise<ErasureEntry[]>;
}

export class FileErasureLedger implements ErasureLedger {
  constructor(private file: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  async append(e: ErasureEntry) {
    const fd = fs.openSync(this.file, "a", 0o600);
    try { fs.writeSync(fd, JSON.stringify(e) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  async list() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ErasureEntry);
  }
}
/**
 * The production ledger: one write-once object per erasure under `erasures/` in the Object Lock bucket that holds the anchors.
 * An entry is a hash and a time (names nobody); COMPLIANCE retention keeps it for at least as long as any backup it must outlive.
 * A repeated append of the same entry is idempotent.
 */
export class S3ObjectLockErasureLedger implements ErasureLedger {
  constructor(private s3: S3LikeClient, private bucket: string, private retainDays = 3650, private now: () => Date = () => new Date()) {}
  async append(e: ErasureEntry) {
    if (!/^[0-9a-f]{64}$/.test(e.userHash)) throw new Error("erasure_entry_invalid");
    const Key = `erasures/${e.erasedAt.replace(/[:.]/g, "-")}_${e.userHash}.json`;
    try {
      await this.s3.putObject({ Bucket: this.bucket, Key, Body: JSON.stringify({ userHash: e.userHash, erasedAt: e.erasedAt }), ContentType: "application/json", IfNoneMatch: "*", ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: new Date(this.now().getTime() + this.retainDays * 86_400_000) });
    } catch (x) { if (!isWriteOnceConflict(x)) throw x; }
  }
  async list() {
    const out: ErasureEntry[] = [];
    for (const Key of (await this.s3.listKeys({ Bucket: this.bucket, Prefix: "erasures/" })).sort()) {
      const v = JSON.parse(await this.s3.getObject({ Bucket: this.bucket, Key })) as ErasureEntry;
      out.push({ userHash: v.userHash, erasedAt: v.erasedAt });
    }
    return out;
  }
}
export class MemoryErasureLedger implements ErasureLedger {
  items: ErasureEntry[] = [];
  async append(e: ErasureEntry) { this.items.push(e); }
  async list() { return [...this.items]; }
}

type EraseCtx = Pick<AppContext, "cron" | "kms" | "clock">;

/** Record the erasure in the ledger BEFORE deleting, so a crash between the two is repaired by the next purge. */
export async function recordErasure(ledger: ErasureLedger, userId: string, at: Date): Promise<void> {
  await ledger.append({ userHash: erasureHash(userId), erasedAt: at.toISOString() });
}

/**
 * Delete the identifying rows of one user and leave the audit chain intact. The users row stays as a tombstone
 * (orders and payments reference it) with a placeholder address and status `purged`. Idempotent: an already purged user is untouched.
 */
export async function eraseUser(ctx: EraseCtx, userId: string, via: "purge" | "closure" = "purge"): Promise<{ erased: boolean }> {
  return tx(ctx.cron, async (c) => {
    const u = (await c.query("select status from users where id = $1 for update", [userId])).rows[0] as { status: string } | undefined;
    if (!u || u.status === "purged") return { erased: false };
    await c.query("delete from notification_addresses where user_id = $1", [userId]);
    await c.query("delete from contacts where user_id = $1", [userId]);
    await c.query("delete from passkeys where user_id = $1", [userId]);
    await c.query("delete from sessions where user_id = $1", [userId]);
    await c.query("delete from email_action_tokens where user_id = $1", [userId]);
    await c.query("delete from recovery_codes where user_id = $1", [userId]);
    await c.query("delete from webauthn_challenges where user_id = $1", [userId]);
    await c.query("delete from email_codes where user_id = $1", [userId]);
    await c.query("update bindings set revoked_at = coalesce(revoked_at, $2) where user_id = $1", [userId, ctx.clock.now()]);
    await c.query("update renewal_mandates set revoked_at = coalesce(revoked_at, $2) where user_id = $1", [userId, ctx.clock.now()]);
    await c.query("update recovery_requests set status = 'cancelled', cancelled_by = 'erasure' where user_id = $1 and status in ('pending','cooling_off','holding')", [userId]);
    await c.query(
      `update users set email = ('erased-' || id::text || '@erased.invalid')::citext, status = 'purged', billing_country = null,
         webauthn_user_handle = gen_random_bytes(32), closed_at = coalesce(closed_at, $2) where id = $1`,
      [userId, ctx.clock.now()],
    );
    await appendAudit(ctx, c, { chainId: userId, actorKind: "system", action: "account.erased", resourceKind: "user", resourceId: userId, detail: { via } });
    return { erased: true };
  });
}

/** retention.purge, ledger half: re-apply every ledger entry to the database. Run daily and at the end of every restore. */
export async function purgeFromLedger(ctx: EraseCtx, ledger: ErasureLedger): Promise<{ ledgerEntries: number; erased: number }> {
  const entries = await ledger.list();
  if (!entries.length) return { ledgerEntries: 0, erased: 0 };
  const hashes = [...new Set(entries.map((e) => e.userHash))];
  const ids = (await ctx.cron.query(
    "select id from users where status <> 'purged' and encode(sha256(convert_to('mh-erasure-v1:' || id::text, 'UTF8')), 'hex') = any($1::text[])",
    [hashes],
  )).rows.map((r) => r.id as string);
  let erased = 0;
  for (const id of ids) if ((await eraseUser(ctx, id, "purge")).erased) erased++;
  return { ledgerEntries: entries.length, erased };
}
