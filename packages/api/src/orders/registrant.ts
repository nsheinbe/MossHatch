import { z } from "zod";
import type { PoolClient } from "@mosshatch/db";
import { normalizePhone } from "@mosshatch/core";
import type { AppContext, Envelope } from "../ports.ts";
import type { Registrant } from "./types.ts";

/**
 * The registrant contact as the forms post it (checkout, transfer-in, a change of contact on a domain). The phone may be typed any
 * usual way; it is stored and sent upstream in the EPP form `+CC.number` (packages/core phone.ts), which the adapters require. An
 * unreadable phone is the one field-level refusal (422 invalid_contact with the issue on `phone`); every other rule is a length.
 */
export const RegistrantBody = z.strictObject({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().min(3).max(40),
  street: z.string().trim().min(3).max(200),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(2).max(20),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/).toUpperCase(),
}).transform((o, ctx) => {
  const phone = normalizePhone(o.phone, o.country);
  if (!phone) { ctx.addIssue({ code: "custom", path: ["phone"], message: "phone" }); return z.NEVER; }
  return { ...o, phone } satisfies Registrant;
});

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
