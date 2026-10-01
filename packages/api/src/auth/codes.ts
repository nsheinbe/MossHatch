import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { base32, randomBytes, safeEqual, sha256 } from "../util/bytes.ts";
import { hashEmailCode, numericCode } from "./common.ts";

export type CodePurpose = "signup" | "recovery" | "address";

/** Store a fresh emailed code (hashed under the KMS key) and return the plaintext for the mail body. */
export async function putEmailCode(ctx: AppContext, c: PoolClient, purpose: CodePurpose, email: string, userId: string, ttlMs: number): Promise<{ id: string; code: string }> {
  const code = numericCode(8);
  const now = ctx.clock.now();
  const hash = await hashEmailCode(ctx, purpose, email, code);
  const r = await c.query("select auth2_code_put($1,$2,$3,$4,$5,$6) as id", [purpose, email, userId, hash, new Date(now.getTime() + ttlMs), now]);
  return { id: r.rows[0].id, code };
}

export type CodeCheck = { ok: true; codeId: string; userId: string | null } | { ok: false };

/**
 * Check an emailed code. Every call burns one of the code's five tries, right or wrong, so a code dies after five wrong guesses.
 * The consume is a separate conditional update, so two racing correct guesses cannot both win.
 */
export async function checkEmailCode(ctx: AppContext, c: PoolClient, purpose: CodePurpose, email: string, code: string, opts: { userId?: string; consume?: boolean } = {}): Promise<CodeCheck> {
  const now = ctx.clock.now();
  const row = (await c.query("select * from auth2_code_take($1,$2,$3,$4)", [purpose, email, opts.userId ?? null, now])).rows[0] as { id: string; user_id: string | null; code_hash: Buffer } | undefined;
  if (!row) return { ok: false };
  const want = await hashEmailCode(ctx, purpose, email, code);
  if (!safeEqual(want, Buffer.from(row.code_hash))) return { ok: false };
  if (opts.consume !== false) {
    const took = (await c.query("select auth2_code_consume($1,$2) as ok", [row.id, now])).rows[0].ok as boolean;
    if (!took) return { ok: false };
  }
  return { ok: true, codeId: row.id, userId: row.user_id };
}

export async function hasLiveCode(ctx: AppContext, c: PoolClient, purpose: CodePurpose, email: string, userId: string): Promise<boolean> {
  return (await c.query("select auth2_code_live($1,$2,$3,$4) as live", [purpose, email, userId, ctx.clock.now()])).rows[0].live as boolean;
}

export async function consumeCode(ctx: AppContext, c: PoolClient, codeId: string): Promise<boolean> {
  return (await c.query("select auth2_code_consume($1,$2) as ok", [codeId, ctx.clock.now()])).rows[0].ok as boolean;
}

/* Recovery codes: ten 128-bit values, 26 base32 characters, stored as SHA-256 (a hash is enough at 128 bits). */
export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_RE = /^[A-Z2-7]{26}$/;

export const normalizeRecoveryCode = (s: string): string => s.replace(/[\s-]/g, "").toUpperCase();
export const hashRecoveryCode = (code: string): Buffer => sha256(normalizeRecoveryCode(code));

export function newRecoveryCode(): string {
  return base32(randomBytes(16)).slice(0, 26);
}

/** Replace all unused codes with ten new ones. Returns the plaintext, which is shown once and never stored. */
export async function issueRecoveryCodes(ctx: AppContext, c: PoolClient, userId: string): Promise<string[]> {
  await c.query("delete from recovery_codes where user_id = $1 and used_at is null", [userId]);
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  for (const code of codes) await c.query("insert into recovery_codes (user_id, code_hash, created_at) values ($1,$2,$3)", [userId, hashRecoveryCode(code), ctx.clock.now()]);
  return codes;
}

/** Spend one code. A conditional update, so a code works once even under a race. */
export async function spendRecoveryCode(ctx: AppContext, c: PoolClient, userId: string, code: string): Promise<boolean> {
  const n = normalizeRecoveryCode(code);
  if (!RECOVERY_CODE_RE.test(n)) return false;
  const r = await c.query("update recovery_codes set used_at = $3 where user_id = $1 and code_hash = $2 and used_at is null", [userId, sha256(n), ctx.clock.now()]);
  return r.rowCount === 1;
}

export async function unusedRecoveryCodes(c: PoolClient, userId: string): Promise<number> {
  return Number((await c.query("select count(*) as n from recovery_codes where user_id = $1 and used_at is null", [userId])).rows[0].n);
}
