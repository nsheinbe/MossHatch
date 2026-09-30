import crypto from "node:crypto";
import { z } from "zod";
import { withNoUser, withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { appendAudit } from "../audit.ts";
import { sha256 } from "../util/bytes.ts";
import { parseToken } from "../util/token.ts";
import { revokeBinding } from "../bindings/tokens.ts";
import { leakNotice } from "./notices.ts";

/**
 * GitHub secret-scanning partner receiver (PLAN 4.5 Tokens, threat row 15, ST-68). GitHub POSTs a JSON array of
 * `{token, type, url, source}` signed with ECDSA P-256 / SHA-256 over the raw body; the key id and the base64 DER signature
 * arrive in `Github-Public-Key-Identifier` and `Github-Public-Key-Signature`, and the public keys are published at
 * `https://api.github.com/meta/public_keys/secret_scanning` (docs.github.com partner program page, read 2026-09-29 per the
 * research dossier F59). UNVERIFIED against a live delivery: enrolment has not happened, so the header names, the key
 * document shape and the response labels follow the documented shape only. Every reported token is treated as public:
 * it is revoked once, the owner is emailed once, and an audit row records it. The raw body and tokens are never stored.
 */

export const GITHUB_KEYS_URL = "https://api.github.com/meta/public_keys/secret_scanning";
export interface GitHubKey { id: string; pem: string; current: boolean }
export interface GitHubKeysPort { fetchKeys(): Promise<GitHubKey[]> }

/** The real key source (never called in this container). Three-second timeout, no redirects. */
export class FetchGitHubKeys implements GitHubKeysPort {
  constructor(private fetcher: typeof fetch = fetch, private url = GITHUB_KEYS_URL) {}
  async fetchKeys(): Promise<GitHubKey[]> {
    const res = await this.fetcher(this.url, { redirect: "error", signal: AbortSignal.timeout(3000), headers: { accept: "application/json", "user-agent": "mosshatch-secret-scanning" } });
    if (!res.ok) throw new Error("github_keys_unavailable");
    const doc = z.object({ public_keys: z.array(z.object({ key_identifier: z.string().max(200), key: z.string().max(4000), is_current: z.boolean().optional() })) }).parse(await res.json());
    return doc.public_keys.map((k) => ({ id: k.key_identifier, pem: k.key, current: k.is_current !== false }));
  }
}

const KEY_TTL_MS = 3_600_000;
const REFETCH_MIN_MS = 60_000;
const caches = new WeakMap<GitHubKeysPort, { keys: Map<string, string>; fetchedAt: number }>();

export function keysPort(ctx: Pick<AppContext, "services">): GitHubKeysPort {
  const s = ctx.services as { githubKeys?: GitHubKeysPort };
  s.githubKeys ??= new FetchGitHubKeys();
  return s.githubKeys;
}

/** Public keys, cached an hour; an unknown key id refetches at most once a minute (a rotation is picked up, a flood is not). */
async function keyFor(ctx: AppContext, id: string): Promise<string | null> {
  const port = keysPort(ctx);
  const now = ctx.clock.now().getTime();
  let c = caches.get(port);
  const stale = !c || now - c.fetchedAt > KEY_TTL_MS || (!c.keys.has(id) && now - c.fetchedAt > REFETCH_MIN_MS);
  if (stale) {
    try {
      const keys = await port.fetchKeys();
      c = { keys: new Map(keys.map((k) => [k.id, k.pem])), fetchedAt: now };
      caches.set(port, c);
    } catch { if (!c) return null; }
  }
  return c?.keys.get(id) ?? null;
}

/** The router's signature check. Fails closed on a missing header, an unknown key or a bad signature. */
export async function verifyGitHubSignature(request: Request, rawBody: string, ctx: AppContext): Promise<{ ok: boolean; provider: string }> {
  const id = request.headers.get("github-public-key-identifier") ?? "";
  const sig = request.headers.get("github-public-key-signature") ?? "";
  if (!/^[A-Za-z0-9._:+/=-]{8,200}$/.test(id) || !/^[A-Za-z0-9+/=]{16,400}$/.test(sig) || rawBody.length === 0) return { ok: false, provider: "github" };
  const pem = await keyFor(ctx, id);
  if (!pem) return { ok: false, provider: "github" };
  try {
    const ok = crypto.verify("sha256", Buffer.from(rawBody, "utf8"), { key: pem, dsaEncoding: "der" }, Buffer.from(sig, "base64"));
    return { ok, provider: "github" };
  } catch { return { ok: false, provider: "github" }; }
}

const Alert = z.array(z.looseObject({ token: z.string().min(1).max(512), type: z.string().max(100), url: z.string().max(2048).optional(), source: z.string().max(64).optional() })).min(1).max(1000);

/** POST /hooks/github-secret-scanning. Answers with GitHub's documented feedback labels (hashes only, never a raw token). */
export async function secretScanningHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const parsed = Alert.safeParse(req.body);
  if (!parsed.success) throw new HttpError(422, "invalid_payload");
  // One delivery, one dedupe row. A redelivery re-answers the labels and changes nothing (revocation is idempotent anyway).
  const eventId = sha256(JSON.stringify(req.body)).toString("hex");
  await withNoUser(ctx.runtime, (c) => c.query("insert into webhook_events (provider, event_id, type, payload) values ('github', $1, 'secret_scanning.alert', null) on conflict (provider, event_id) do nothing", [eventId]));
  const out: { token_hash: string; token_type: string; label: "true_positive" | "false_positive" }[] = [];
  for (const item of parsed.data) {
    const hashHex = sha256(item.token).toString("hex");
    const tok = parseToken(item.token);
    const owner = tok ? (await withNoUser(ctx.runtime, (c) => c.query("select * from scanning_token_owner($1)", [tok.hash]))).rows[0] : undefined;
    if (!owner) { out.push({ token_hash: hashHex, token_type: item.type.slice(0, 100), label: "false_positive" }); continue; }
    await withUser(ctx.runtime, owner.user_id, async (c) => {
      const b = (await c.query("select id, name, kind from bindings where id = $1 and user_id = $2", [owner.binding_id, owner.user_id])).rows[0];
      const newly = await revokeBinding(ctx, c, owner.user_id, owner.binding_id, "leaked_github", { kind: "system" });
      await appendAudit(ctx, c, { chainId: owner.user_id, actorKind: "system", action: "binding.leak_reported", resourceKind: "binding", resourceId: owner.binding_id, detail: { source: "github", newly_revoked: newly } });
      if (newly && b) await leakNotice(ctx, c, owner.user_id, owner.binding_id, b.name, b.kind);
    });
    out.push({ token_hash: hashHex, token_type: item.type.slice(0, 100), label: "true_positive" });
  }
  await ctx.cron.query("update webhook_events set processed_at = $2 where provider = 'github' and event_id = $1 and processed_at is null", [eventId, ctx.clock.now()]).catch(() => undefined);
  return json(out);
}
