import crypto from "node:crypto";
import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { notifyUser } from "../auth/mail.ts";
import { assertMailSafe, type RenderedMail } from "../mail/templates.ts";

/**
 * The agent surface's emails. Built only from server fields (the owner's own binding name, normalized names, counts and
 * amounts), checked by the shared `assertMailSafe`. None carries an approval link (threat row 43): the person approves in
 * the app after signing in, and "Send all visitors home" is one click there.
 */

const usd = (minor: bigint | string) => { const n = BigInt(minor); const s = (n < 0n ? -n : n).toString().padStart(3, "0"); return `USD ${s.slice(0, -2)}.${s.slice(-2)}`; };
const when = (d: Date) => d.toISOString().replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, " UTC");

async function send(ctx: AppContext, c: PoolClient, userId: string, kind: string, dedupeKey: string, m: RenderedMail, immediate = false): Promise<void> {
  assertMailSafe(m, ctx.config.origin, null);
  await notifyUser(ctx, c, userId, { kind, dedupeKey, subject: m.subject, text: m.text, immediate });
}

export interface RequestFacts { bindingName: string; kind: "register" | "renew" | "dns_change" | "nameservers_change" | "scope"; fqdn: string | null; years: number | null; totalMinor: bigint; sensitive?: number; scopes?: string[] }

function describe(f: RequestFacts): string {
  if (f.kind === "nameservers_change") return `request a registry nameserver change for ${f.fqdn}; execution is blocked until migration safety checks are supported`;
  if (f.kind === "register") return `register ${f.fqdn} for ${f.years} ${f.years === 1 ? "year" : "years"}, up to ${usd(f.totalMinor)} including tax`;
  if (f.kind === "renew") return `renew ${f.fqdn} for ${f.years} ${f.years === 1 ? "year" : "years"}, up to ${usd(f.totalMinor)} including tax`;
  if (f.kind === "dns_change") return `change ${f.sensitive ?? 0} sensitive DNS record${f.sensitive === 1 ? "" : "s"} on ${f.fqdn}`;
  return `use more of your account: ${(f.scopes ?? []).join(", ")}`;
}

/** An agent asked for something that needs you. Coalesced into the security digest under a flood (class B). */
export async function requestNotice(ctx: AppContext, c: PoolClient, userId: string, requestId: string, f: RequestFacts): Promise<void> {
  await send(ctx, c, userId, "agent.request", `agent.request:${requestId}`, {
    subject: "One of your tokens is waiting for your decision",
    text: `Your token "${f.bindingName}" asked to ${describe(f)}.\n\nNothing happens unless you decide in Mosshatch. Sign in, open Account, then Visitors. The request expires on its own after 72 hours.\n\nIf you did not expect this, send every visitor home from the same place.\n`,
  });
}

/** Detective only: a registration is final, so every approval is mailed at once (threat row 18). */
export async function approvedNotice(ctx: AppContext, c: PoolClient, userId: string, requestId: string, f: RequestFacts): Promise<void> {
  await send(ctx, c, userId, "agent.approved", `agent.approved:${requestId}`, {
    subject: "You approved a request from one of your tokens",
    text: `At ${when(ctx.clock.now())} you used your passkey to let your token "${f.bindingName}" ${describe(f)}.\n\n${f.kind === "register" || f.kind === "renew" ? "Nothing is charged until you pay on Stripe. " : ""}If this was not you, sign in and send every visitor home, then write to security@mosshatch.com.\n`,
  }, true);
}

/** GitHub reported the token in public: it is already revoked when this is sent (ST-68). */
export async function leakNotice(ctx: AppContext, c: PoolClient, userId: string, bindingId: string, bindingName: string, kind: string): Promise<void> {
  await send(ctx, c, userId, "binding.leaked", `binding.leaked:${bindingId}`, {
    subject: "We revoked a Mosshatch token that was published on GitHub",
    text: `GitHub found your ${kind === "cli" ? "command-line sign-in" : `token "${bindingName}"`} in a public place and told us. We revoked it at ${when(ctx.clock.now())}. It no longer works anywhere.\n\nIf a program still needs access, create a new token in Mosshatch and keep it out of repositories. Check your Nest and DNS for changes you did not make.\n`,
  }, true);
}

/** ST-35: an agent replaced a production value. The prior version is kept and can be restored in the Nest. */
export async function prodWriteNotice(ctx: AppContext, c: PoolClient, userId: string, o: { secretId: string; version: number; name: string; fqdn: string; bindingName: string }): Promise<void> {
  await send(ctx, c, userId, "agent.prod_write", `agents.prod_write:${o.secretId}:${o.version}`, {
    subject: "A token changed a production secret on your Mosshatch account",
    text: `Your token "${o.bindingName}" wrote ${o.name} (prod) on ${o.fqdn} at ${when(ctx.clock.now())}. It is now version ${o.version}.\n\nThe previous version is kept. If you did not expect this, restore it from the Nest (the secret's history) and revoke the token, because a replaced database address could point at someone else's database.\n`,
  }, true);
}

/** "Send all visitors home" finished. */
export async function sentHomeNotice(ctx: AppContext, c: PoolClient, userId: string, counts: { bindings: number }): Promise<void> {
  await send(ctx, c, userId, "visitors.sent_home", `visitors.sent_home:${crypto.randomUUID()}`, {
    subject: "Every visitor was sent home",
    text: `At ${when(ctx.clock.now())} every token and connected app on your Mosshatch account was revoked (${counts.bindings} in all), and every waiting request was declined.\n\nIf this was not you, sign in and check your passkeys, then write to security@mosshatch.com.\n`,
  }, true);
}
