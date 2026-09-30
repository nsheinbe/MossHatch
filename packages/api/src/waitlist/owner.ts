import crypto from "node:crypto";
import type { Pool } from "@mosshatch/db";
import type { EmailPort } from "../ports.ts";
import { INVITE_TTL_MS } from "./gate.ts";
import { newToken, sha256 } from "./service.ts";
import { inviteMail } from "./text.ts";

/**
 * Owner-only work for scripts/waitlist-invite.mjs and scripts/waitlist-stats.mjs. Both run with the cron role (or the owner),
 * never from a request. Output holds counts and names people hatched, never an email address.
 */

export interface InviteOptions { next?: number; email?: string }
export interface InviteResult { invited: number; failed: number; skipped: number }

/**
 * Invite the next N confirmed, still subscribed, never-invited people in line (by confirmation time), or one address. Each invite is
 * a random token of which only the hash is stored; it expires in 14 days. The invite row commits only after the email is accepted,
 * so a failed send leaves the person uninvited and first in line for the next run.
 */
export async function createInvites(pool: Pool, email: EmailPort, origin: string, opts: InviteOptions, now = new Date()): Promise<InviteResult> {
  const base = origin.replace(/\/$/, "");
  const people = opts.email
    ? (await pool.query(
      `select w.id, w.email::text as email from waitlist w where w.email = $1 and w.confirmed_at is not null and w.unsubscribed_at is null
         and not exists (select 1 from waitlist_invites i where i.waitlist_id = w.id and i.used_at is null and i.expires_at > $2)`, [opts.email, now])).rows
    : (await pool.query(
      `select w.id, w.email::text as email from waitlist w where w.confirmed_at is not null and w.unsubscribed_at is null
         and not exists (select 1 from waitlist_invites i where i.waitlist_id = w.id) order by w.confirmed_at, w.id limit $1`, [Math.max(0, Math.floor(opts.next ?? 0))])).rows;
  const out: InviteResult = { invited: 0, failed: 0, skipped: opts.email && people.length === 0 ? 1 : 0 };
  for (const p of people as { id: string; email: string }[]) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const id = crypto.randomUUID();
      const secret = newToken();
      await c.query("insert into waitlist_invites (id, waitlist_id, token_hash, created_at, expires_at) values ($1,$2,$3,$4,$5)", [id, p.id, sha256(secret), now, new Date(now.getTime() + INVITE_TTL_MS)]);
      await c.query("update waitlist set invited_at = $2 where id = $1", [p.id, now]);
      const unsub = newToken();
      await c.query("insert into waitlist_tokens (hash, waitlist_id, purpose, created_at) values ($1,$2,'unsubscribe',$3)", [sha256(unsub), p.id, now]);
      const m = inviteMail(`${base}/invite?t=${id}.${secret}`, `${base}/api/waitlist/unsubscribe?t=${unsub}`);
      await email.send({ dedupeKey: `waitlist:invite:${id}`, kind: "waitlist.invite", to: [p.email], subject: m.subject, text: m.text });
      await c.query("commit");
      out.invited++;
    } catch {
      await c.query("rollback").catch(() => undefined);
      out.failed++;
    } finally { c.release(); }
  }
  return out;
}

export interface WaitlistStats {
  totals: { signups: number; confirmed: number; confirmedRate: number; unsubscribed: number; invited: number; accepted: number; invitesOpen: number; invitesExpired: number };
  perDay: { day: string; signups: number; confirmed: number }[];
  topNames: { name: string; count: number }[];
  topExtensions: { ext: string; count: number }[];
  answers: { answer: string; count: number }[];
}

export async function waitlistStats(pool: Pool, now = new Date(), days = 30): Promise<WaitlistStats> {
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const t = (await q(`select count(*)::int as signups, count(confirmed_at)::int as confirmed, count(unsubscribed_at)::int as unsubscribed,
    count(invited_at)::int as invited from waitlist`))[0];
  const inv = (await q(`select count(used_at)::int as accepted, count(*) filter (where used_at is null and expires_at > $1)::int as open,
    count(*) filter (where used_at is null and expires_at <= $1)::int as expired from waitlist_invites`, [now]))[0];
  const perDay = await q(`select to_char(d, 'YYYY-MM-DD') as day, count(w.id)::int as signups, count(w.confirmed_at)::int as confirmed
    from generate_series(date_trunc('day', $1::timestamptz) - make_interval(days => $2 - 1), date_trunc('day', $1::timestamptz), interval '1 day') d
    left join waitlist w on date_trunc('day', w.created_at) = d group by d order by d`, [now, days]);
  const topNames = await q(`select n as name, count(*)::int as count from waitlist, unnest(requested_names) n group by n order by count desc, n limit 10`);
  const topExtensions = await q(`select coalesce(nullif(substring(n from '\\.([a-z]+)$'), ''), '(none)') as ext, count(*)::int as count
    from waitlist, unnest(requested_names) n group by 1 order by count desc, ext limit 10`);
  const answers = await q(`select coalesce(answer, '(no answer)') as answer, count(*)::int as count from waitlist group by 1 order by count desc, answer`);
  return {
    totals: { signups: t.signups, confirmed: t.confirmed, confirmedRate: t.signups ? t.confirmed / t.signups : 0, unsubscribed: t.unsubscribed, invited: t.invited, accepted: inv.accepted, invitesOpen: inv.open, invitesExpired: inv.expired },
    perDay: perDay as WaitlistStats["perDay"], topNames: topNames as WaitlistStats["topNames"], topExtensions: topExtensions as WaitlistStats["topExtensions"], answers: answers as WaitlistStats["answers"],
  };
}

export function formatStats(s: WaitlistStats): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    "Mosshatch waitlist",
    `  sign-ups ${s.totals.signups}, confirmed ${s.totals.confirmed} (${pct(s.totals.confirmedRate)}), unsubscribed ${s.totals.unsubscribed}`,
    `  invited ${s.totals.invited}, accepted ${s.totals.accepted}, invites open ${s.totals.invitesOpen}, expired unused ${s.totals.invitesExpired}`,
    "", "Sign-ups per day (last 30 days): day, sign-ups, confirmed",
    ...s.perDay.filter((d) => d.signups > 0).map((d) => `  ${d.day}  ${String(d.signups).padStart(5)}  ${String(d.confirmed).padStart(5)}`),
    "", "Top requested names", ...s.topNames.map((n) => `  ${String(n.count).padStart(5)}  ${n.name}`),
    "", "Top extensions", ...s.topExtensions.map((n) => `  ${String(n.count).padStart(5)}  ${n.ext === "(none)" ? n.ext : "." + n.ext}`),
    "", "Would pay for a one-of-a-kind creature", ...s.answers.map((a) => `  ${String(a.count).padStart(5)}  ${a.answer}`),
  ];
  return lines.join("\n");
}
