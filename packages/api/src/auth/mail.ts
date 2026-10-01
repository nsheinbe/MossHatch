import { tx, withNoUser, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { hit, type Limit } from "../ratelimit.ts";
import { sendMail } from "../email.ts";

/** Class A: mail an unauthenticated request can trigger. Per target address, plus a global ceiling. */
export const CLASS_A = {
  perAddressHour: { bucket: "mailA.addr.h", max: 3, windowSeconds: 3600 } satisfies Limit,
  perAddressDay: { bucket: "mailA.addr.d", max: 10, windowSeconds: 86_400 } satisfies Limit,
  global: { bucket: "mailA.global", max: 5000, windowSeconds: 3600 } satisfies Limit,
};
/** Class B: security notices about an existing account. Own bucket; over it they coalesce into a digest, never dropped. */
export const CLASS_B: Limit = { bucket: "mailB.user", max: 10, windowSeconds: 3600 };

/**
 * Kinds of class A mail. Each has its own per-address buckets, so a flood of sign-up starts for an address (which mails
 * nothing when the account exists) cannot use up the budget for the owner's recovery code. The global ceiling is shared.
 */
export type ClassAKind = "signup" | "address" | "recovery";
export const CLASS_A_KINDS: readonly ClassAKind[] = ["signup", "address", "recovery"];

/** Count a class A mail in its own committed transaction and say whether it may be sent. */
export async function classAAllowed(ctx: AppContext, address: string, kind: ClassAKind): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  return withNoUser(ctx.runtime, async (c) => {
    // Short-circuit in order, so a rejected try does not also burn the wider buckets (and the global ceiling counts mail that may go out).
    const a = await hit(ctx, c, address.toLowerCase(), { ...CLASS_A.perAddressHour, bucket: `${CLASS_A.perAddressHour.bucket}.${kind}` });
    if (!a.allowed) return { allowed: false, retryAfterSeconds: a.retryAfterSeconds };
    const b = await hit(ctx, c, address.toLowerCase(), { ...CLASS_A.perAddressDay, bucket: `${CLASS_A.perAddressDay.bucket}.${kind}` });
    if (!b.allowed) return { allowed: false, retryAfterSeconds: b.retryAfterSeconds };
    const g = await hit(ctx, c, "global", CLASS_A.global);
    return { allowed: g.allowed, retryAfterSeconds: g.allowed ? 0 : g.retryAfterSeconds };
  });
}

export interface Recipient { id: string; address: string; kind: string }

/** Every live notification address that can receive notices: verified ones, and registrant addresses. Runs under the user's tenant context. */
export async function recipientsOf(c: PoolClient, userId: string): Promise<Recipient[]> {
  const r = await c.query("select id, address::text as address, kind from notification_addresses where user_id = $1 and removed_at is null and (verified_at is not null or kind = 'registrant') order by created_at", [userId]);
  return r.rows;
}

export interface Notice {
  kind: string;
  subject: string;
  text: string;
  /** Unique per event; the per-address suffix is added here. */
  dedupeKey: string;
  /** Sent at once whatever the class B bucket says (recovery started, freeze, credential restore). */
  immediate?: boolean;
  /** Also mail these addresses (for example the address just removed). */
  extraTo?: string[];
}

const DIGEST_LABELS: Record<string, string> = {
  "passkey.added": "A passkey was added", "passkey.removed": "A passkey was removed", "address.added": "A notification address was added",
  "address.verified": "A notification address was verified", "address.removed": "A notification address was removed", "codes.regenerated": "Recovery codes were replaced",
  "sessions.revoked": "All sessions were signed out", "login.new_device": "A sign-in from a new device", "recovery.cancelled": "A recovery request was cancelled",
  "recovery.unavailable": "A recovery request was refused",
};

/** Tell every notification address. Runs inside the caller's user-scoped transaction. */
export async function notifyUser(ctx: AppContext, c: PoolClient, userId: string, n: Notice): Promise<{ sent: boolean; queued: boolean }> {
  const b = await hit(ctx, c, userId, CLASS_B);
  if (!n.immediate && !b.allowed) {
    await c.query("insert into security_notice_queue (user_id, kind, created_at) values ($1,$2,$3)", [userId, n.kind, ctx.clock.now()]);
    return { sent: false, queued: true };
  }
  const to = await recipientsOf(c, userId);
  const seen = new Set<string>();
  const targets = [...to.map((t) => ({ key: t.id, address: t.address })), ...(n.extraTo ?? []).map((a) => ({ key: "x:" + a.toLowerCase(), address: a }))]
    .filter((t) => { const k = t.address.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  for (const t of targets) {
    await sendMail(c, ctx.email, { dedupeKey: `${n.dedupeKey}:${t.key}`, kind: n.kind, userId, to: [t.address], subject: n.subject, text: n.text, klass: "B" });
  }
  return { sent: targets.length > 0, queued: false };
}

/** Send one digest per user for queued class B notices. Run by the ops sweeper with the cron role. */
export async function flushSecurityDigests(ctx: AppContext): Promise<number> {
  const users = (await ctx.cron.query("select user_id, array_agg(id::text order by id) as ids, array_agg(kind) as kinds from security_notice_queue where sent_at is null group by user_id")).rows as { user_id: string; ids: string[]; kinds: string[] }[];
  let sent = 0;
  for (const u of users) {
    await tx(ctx.cron, async (c) => {
      const counts = new Map<string, number>();
      for (const k of u.kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
      const lines = [...counts].map(([k, n]) => `- ${DIGEST_LABELS[k] ?? k}${n > 1 ? ` (${n} times)` : ""}`).join("\n");
      const to = await recipientsOf(c, u.user_id);
      for (const t of to) {
        await sendMail(c, ctx.email, {
          dedupeKey: `digest:${u.ids[u.ids.length - 1]}:${t.id}`, kind: "security.digest", userId: u.user_id, to: [t.address], klass: "B",
          subject: "Security activity on your Mosshatch account", text: `These security events happened on your account:\n${lines}\n\nIf you do not recognise them, sign in and review your passkeys and sessions.`,
        });
      }
      await c.query("update security_notice_queue set sent_at = $2 where id = any($1::uuid[]) and sent_at is null", [u.ids, ctx.clock.now()]);
      sent += to.length;
    });
  }
  return sent;
}
