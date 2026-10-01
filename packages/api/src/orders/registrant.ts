import type { PoolClient } from "@mosshatch/db";
import type { AppContext, Envelope } from "../ports.ts";
import type { Registrant } from "./types.ts";

/**
 * Registrant contact storage format used by the orders module: `contacts.fields_enc` is an object of one PII envelope per
 * field, each bound to its owner and field name (AAD `contact:<user>:<field>`). ASSUMPTION: the contact-form module that
 * writes this table must use the same format; nothing else in the repository defines it yet.
 */
export const REGISTRANT_FIELDS = ["name", "email", "phone", "street", "city", "region", "postalCode", "country"] as const;
const aad = (userId: string, field: string) => `contact:${userId}:${field}`;

export async function storeRegistrant(ctx: Pick<AppContext, "pii">, c: PoolClient, userId: string, r: Registrant, opts: { verified?: boolean } = {}): Promise<void> {
  const fields: Record<string, Envelope> = {};
  for (const f of REGISTRANT_FIELDS) fields[f] = await ctx.pii.encrypt(r[f], aad(userId, f));
  await c.query("insert into contacts (user_id, fields_enc, email_verified_at, verification_state) values ($1,$2,$3,$4)", [userId, fields, opts.verified === false ? null : new Date(), opts.verified === false ? "pending" : "verified"]);
}

/** The newest verified contact, decrypted. Null when there is none. Values never leave the caller's stack frame. */
export async function loadRegistrant(ctx: Pick<AppContext, "pii" | "cron">, userId: string): Promise<Registrant | null> {
  const row = (await ctx.cron.query("select fields_enc from contacts where user_id = $1 and verification_state = 'verified' order by created_at desc limit 1", [userId])).rows[0];
  if (!row) return null;
  const enc = row.fields_enc as Record<string, Envelope>;
  const out: Partial<Registrant> = {};
  for (const f of REGISTRANT_FIELDS) {
    const e = enc[f];
    if (!e) return null;
    out[f] = await ctx.pii.decrypt(e, aad(userId, f));
  }
  return out as Registrant;
}
