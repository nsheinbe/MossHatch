import { z } from "zod";
import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { appendAudit } from "../audit.ts";
import { b64u, randomBytes, sha256 } from "../util/bytes.ts";
import { PRE_AUTH_COOKIE, parseCookies } from "../http/session.ts";

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const COOLING_OFF_MS = 72 * HOUR;
export const HOLD_MS = { codes_email: 24 * HOUR, email_only: 72 * HOUR } as const;
export const SECRET_REVEAL_HOLD_MS = 24 * HOUR;
export const SUSPENSION_MS = 30 * DAY;
export const TICKET_TTL_S = 30 * 60;
export const LOGIN_CHALLENGE_TTL_S = 120;

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(422, "invalid_request");
  return r.data;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One user-chain audit row. Opaque ids and short enum values only. */
export function auditUser(ctx: AppContext, c: PoolClient, userId: string, action: string, o: { resourceKind?: string; resourceId?: string; detail?: Record<string, unknown>; actor?: "user" | "system" } = {}) {
  return appendAudit(ctx, c, {
    chainId: userId, actorKind: o.actor ?? "user", actorId: o.actor === "system" ? undefined : userId, action,
    resourceKind: o.resourceKind, resourceId: o.resourceId, detail: o.detail,
  });
}

/** A fresh 256-bit pre-auth value and its stored hash. */
export function newPre(): { value: string; hash: Buffer } {
  const raw = randomBytes(32);
  return { value: b64u(raw), hash: sha256(raw) };
}

/** The hash of the presented `__Host-mh_pre` cookie, or null when absent or malformed. */
export function preHashFrom(request: Request): Buffer | null {
  const v = parseCookies(request.headers.get("cookie"))[PRE_AUTH_COOKIE];
  if (!v) return null;
  const raw = Buffer.from(v, "base64url");
  return raw.length === 32 ? sha256(raw) : null;
}

export const mailDomain = (address: string): string => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** Decimal one-time code from a CSPRNG (rejection sampling, no modulo bias). */
export function numericCode(digits = 8): string {
  let out = "";
  while (out.length < digits) for (const b of randomBytes(digits * 2)) { if (b < 250 && out.length < digits) out += String(b % 10); }
  return out;
}

/** Keyed hash of an emailed code, bound to purpose and address. */
export async function hashEmailCode(ctx: AppContext, purpose: string, email: string, code: string): Promise<Buffer> {
  return ctx.kms.hmac("email-token", Buffer.from(`code|${purpose}|${email.toLowerCase()}|${code}`));
}

export const rateLimited = (retryAfterSeconds: number) => new HttpError(429, "rate_limited", "rate_limited", { "Retry-After": String(retryAfterSeconds) });
