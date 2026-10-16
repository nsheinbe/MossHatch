import crypto from "node:crypto";
import { withNoUser, type Pool, type PoolClient } from "@mosshatch/db";
import type { EmailPort } from "../ports.ts";
import { CONSENT_TEXT, alreadyMail, confirmMail, welcomeMail, type Mail } from "./text.ts";

/**
 * The waitlist, standalone: it needs a database pool, a clock, a mail port, a secret for the keyed hashes and the site origin
 * for links. It never logs an address, a name or a token; failures are reported as codes.
 */
export interface WaitlistDeps {
  pool: Pool;
  clock: { now(): Date };
  email: EmailPort;
  /** Key for the network and address hashes used by rate limits (never stored raw). */
  secret: Buffer;
  /** Origin used in emailed links, e.g. https://mosshatch.com. Never taken from the request. */
  origin: string;
  /** Mail failures, as codes only. */
  warn?: (code: string) => void;
}

export const CONFIRM_TTL_MS = 7 * 86_400_000;
export const MAX_BODY_BYTES = 4096;
/** Per source network (/24 or /48), every POST counts, valid or not. */
export const NET_LIMIT = { bucket: "waitlist.net", max: 10, windowSeconds: 3600 } as const;
/** Per address: how many emails a day any number of sign-ups can cause. Over it, the answer is the same and nothing is sent. */
export const EMAIL_LIMIT = { bucket: "waitlist.email", max: 3, windowSeconds: 86_400 } as const;
/** Across all sources: bounds what a flood from many networks can send. */
export const GLOBAL_LIMIT = { bucket: "waitlist.all", max: 300, windowSeconds: 3600 } as const;
/** Confirm and unsubscribe posts per network. */
export const TOKEN_LIMIT = { bucket: "waitlist.token", max: 30, windowSeconds: 3600 } as const;

export const consentHash = (text = CONSENT_TEXT) => crypto.createHash("sha256").update(text, "utf8").digest();
export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest();
export const newToken = () => crypto.randomBytes(32).toString("base64url");
const keyed = (d: Pick<WaitlistDeps, "secret">, label: string, v: string) => crypto.createHmac("sha256", d.secret).update(label + "\0" + v).digest();

export type Answer = "yes" | "no" | "maybe";
export type Source = "app" | "fallback" | "page" | "signup";
export interface JoinInput { email: string; name: string | null; answer: Answer | null; source: Source; network: string; attribution?: Record<string, string> }

export class WaitlistError extends Error {
  constructor(public status: number, public code: string, public retryAfter?: number) { super(code); this.name = "WaitlistError"; }
}

/** Fixed-window counter in the shared rate_counters table (the key is a keyed hash of the subject, never the subject). */
export async function hitLimit(d: WaitlistDeps, c: PoolClient, subject: string, l: { bucket: string; max: number; windowSeconds: number }) {
  const now = d.clock.now();
  const start = new Date(Math.floor(now.getTime() / (l.windowSeconds * 1000)) * l.windowSeconds * 1000);
  const r = await c.query(
    "insert into rate_counters (key_hash, bucket, window_start, count) values ($1,$2,$3,1) on conflict (key_hash, bucket, window_start) do update set count = rate_counters.count + 1 returning count",
    [keyed(d, "rate", subject), l.bucket, start],
  );
  const count = r.rows[0].count as number;
  return { allowed: count <= l.max, retryAfter: Math.max(1, Math.ceil((start.getTime() + l.windowSeconds * 1000 - now.getTime()) / 1000)) };
}

export async function limitNetwork(d: WaitlistDeps, network: string, l: typeof NET_LIMIT | typeof TOKEN_LIMIT): Promise<void> {
  const r = await withNoUser(d.pool, (c) => hitLimit(d, c, network, l));
  if (!r.allowed) throw new WaitlistError(429, "rate_limited", r.retryAfter);
}

async function mintToken(c: PoolClient, id: string, purpose: "confirm" | "unsubscribe", now: Date): Promise<{ token: string; hash: Buffer }> {
  const token = newToken();
  const hash = sha256(token);
  await c.query("select waitlist_token_put($1,$2,$3,$4,$5)", [id, purpose, hash, now, purpose === "confirm" ? new Date(now.getTime() + CONFIRM_TTL_MS) : null]);
  return { token, hash };
}

const link = (d: WaitlistDeps, path: string, token: string) => `${d.origin}${path}?t=${token}`;

async function send(d: WaitlistDeps, to: string, kind: string, dedupe: Buffer, m: Mail, required = false): Promise<void> {
  try { await d.email.send({ dedupeKey: `waitlist:${kind}:${dedupe.toString("hex").slice(0, 32)}`, kind: `waitlist.${kind}`, to: [to], subject: m.subject, text: m.text, klass: "A" }); }
  catch (e) {
    const rawCode = (e as { code?: unknown }).code;
    const code = typeof rawCode === "string" && /^[a-z0-9_]{1,80}$/i.test(rawCode) ? rawCode : "delivery_failed";
    d.warn?.(`waitlist.mail_failed kind=${kind} code=${code}`);
    if (required) throw new WaitlistError(503, "delivery_unavailable");
  }
}

/**
 * Join. The caller answers the same way whatever happens here (no enumeration): a new or unconfirmed address gets a confirm link,
 * a confirmed one gets a short "already on the list" note, and an address over its daily limit gets nothing. The network limit
 * has already been applied by the caller; the global limit is applied here.
 */
export async function join(d: WaitlistDeps, input: JoinInput): Promise<void> {
  const now = d.clock.now();
  const out = await withNoUser(d.pool, async (c) => {
    const global = await hitLimit(d, c, "all", GLOBAL_LIMIT);
    if (!global.allowed) throw new WaitlistError(429, "busy", global.retryAfter);
    const perEmail = await hitLimit(d, c, "email:" + input.email.toLowerCase(), EMAIL_LIMIT);
    const row = (await c.query("select id, state from waitlist_join($1,$2,$3,$4,$5,$6,$7,$8)", [input.email, input.name, input.answer, consentHash(), input.source, keyed(d, "net", input.network), now, JSON.stringify(input.attribution ?? {})])).rows[0] as { id: string; state: "new" | "pending" | "confirmed" };
    await c.query("select waitlist_sweep($1)", [now]);
    if (!perEmail.allowed) return null;
    const unsub = await mintToken(c, row.id, "unsubscribe", now);
    if (row.state === "confirmed") {
      const place = (await c.query("select waitlist_place($1) as n", [row.id])).rows[0].n as number;
      return { kind: "already", dedupe: unsub.hash, mail: alreadyMail(place, link(d, "/api/waitlist/unsubscribe", unsub.token)) };
    }
    const confirm = await mintToken(c, row.id, "confirm", now);
    return { kind: "confirm", dedupe: confirm.hash, mail: confirmMail(link(d, "/api/waitlist/confirm", confirm.token), link(d, "/api/waitlist/unsubscribe", unsub.token)) };
  });
  if (out) await send(d, input.email, out.kind, out.dedupe, out.mail, true);
}

export async function tokenLive(d: WaitlistDeps, token: string, purpose: "confirm" | "unsubscribe"): Promise<boolean> {
  if (!validToken(token)) return false;
  return (await withNoUser(d.pool, (c) => c.query("select waitlist_token_live($1,$2,$3) as ok", [sha256(token), purpose, d.clock.now()]))).rows[0].ok === true;
}

/** Confirm once. Returns the place in line, or null for an unknown, used or expired link. Sends the "#N in line" note. */
export async function confirm(d: WaitlistDeps, token: string): Promise<number | null> {
  if (!validToken(token)) return null;
  const now = d.clock.now();
  const out = await withNoUser(d.pool, async (c) => {
    const r = (await c.query("select id, email, place from waitlist_confirm($1,$2)", [sha256(token), now])).rows[0] as { id: string; email: string; place: number } | undefined;
    if (!r) return null;
    const unsub = await mintToken(c, r.id, "unsubscribe", now);
    return { ...r, unsub };
  });
  if (!out) return null;
  await send(d, out.email, "welcome", out.unsub.hash, welcomeMail(out.place, link(d, "/api/waitlist/unsubscribe", out.unsub.token)));
  return out.place;
}

export async function unsubscribe(d: WaitlistDeps, token: string): Promise<boolean> {
  if (!validToken(token)) return false;
  return (await withNoUser(d.pool, (c) => c.query("select waitlist_unsubscribe($1,$2) as ok", [sha256(token), d.clock.now()]))).rows[0].ok === true;
}

export const validToken = (t: string) => /^[A-Za-z0-9_-]{43}$/.test(t);
