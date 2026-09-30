import crypto from "node:crypto";
import { withNoUser, withUser, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import type { HandlerReq, HandlerResult, Route } from "../http/types.ts";
import { HttpError, json } from "../http/router.ts";
import { b64u, randomBytes, sha256 } from "../util/bytes.ts";
import { auditUser } from "./common.ts";
import { notifyUser } from "./mail.ts";

export type EmailActionPurpose = "freeze" | "recovery_cancel" | "auto_renew_off";
export const FREEZE_TTL_MS = 72 * 3600_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Mint a single-use protective link token: 256 random bits, only its SHA-256 stored, bound to one purpose and one event.
 * `client` must be a transaction that can write `email_action_tokens` for the user (a user-scoped one, or the cron role).
 * The raw token belongs in the email body link only: use `emailActionUrl`.
 */
export async function mintEmailActionToken(ctx: AppContext, client: PoolClient, o: { userId: string; purpose: EmailActionPurpose; eventId: string; ttlMs: number }): Promise<{ token: string }> {
  const token = b64u(randomBytes(32));
  const now = ctx.clock.now();
  await client.query("insert into email_action_tokens (token_hash, purpose, event_id, user_id, expires_at, created_at) values ($1,$2,$3,$4,$5,$6)",
    [sha256(token), o.purpose, o.eventId, o.userId, new Date(now.getTime() + o.ttlMs), now]);
  return { token };
}

export const emailActionUrl = (ctx: Pick<AppContext, "config">, token: string): string => `${ctx.config.origin}/api/v1/email-actions/${token}`;

/** What a link would do, for the confirm page. Reads only. */
async function describe(ctx: AppContext, token: string): Promise<{ purpose: EmailActionPurpose } | null> {
  if (!TOKEN_RE.test(token)) return null;
  const row = (await withNoUser(ctx.runtime, (c) => c.query("select * from auth_email_action_get($1)", [sha256(token)]))).rows[0];
  if (!row || row.used_at || new Date(row.expires_at) <= ctx.clock.now()) return null;
  return { purpose: row.purpose };
}

export async function freezeAccount(ctx: AppContext, c: PoolClient, userId: string): Promise<void> {
  const now = ctx.clock.now();
  // Sessions die, tokens pause (not revoke), the account flag is set. Nothing is unlocked, no nameserver changes, renewals continue.
  await c.query("update users set frozen_at = coalesce(frozen_at, $2) where id = $1", [userId, now]);
  await c.query("update sessions set revoked_at = $2 where user_id = $1 and revoked_at is null", [userId, now]);
  await c.query("update bindings set paused_at = $2 where user_id = $1 and revoked_at is null and paused_at is null", [userId, now]);
}

/**
 * Consume a link and act. Returns null when the link is unknown, used, expired or (with `expectPurpose`) of another purpose.
 * The token is consumed with a conditional update in the same transaction as its effect.
 */
export async function runEmailAction(ctx: AppContext, token: string, o: { expectPurpose?: EmailActionPurpose } = {}): Promise<{ purpose: EmailActionPurpose; changed: boolean } | null> {
  if (!TOKEN_RE.test(token)) return null;
  const hash = sha256(token);
  const row = (await withNoUser(ctx.runtime, (c) => c.query("select * from auth_email_action_get($1)", [hash]))).rows[0];
  if (!row) return null;
  if (o.expectPurpose && row.purpose !== o.expectPurpose) return null;
  const now = ctx.clock.now();
  if (row.used_at || new Date(row.expires_at) <= now) return null;
  const userId = row.user_id as string;
  return withUser(ctx.runtime, userId, async (c) => {
    const took = await c.query("update email_action_tokens set used_at = $2 where id = $1 and used_at is null and expires_at > $2 returning id", [row.id, now]);
    if (took.rowCount !== 1) return null;
    const purpose = row.purpose as EmailActionPurpose;
    const eventId = row.event_id as string;
    let changed = false;
    if (purpose === "freeze") {
      await freezeAccount(ctx, c, userId);
      changed = true;
      await auditUser(ctx, c, userId, "auth.freeze", { resourceKind: "email_action", resourceId: row.id, detail: { event: eventId } });
      await notifyUser(ctx, c, userId, { kind: "account.frozen", immediate: true, dedupeKey: `freeze:${row.id}`, subject: "Your Mosshatch account is frozen", text: "A freeze link was used. Every session is signed out, agent and CLI tokens are paused, and your account is marked frozen. Nothing was unlocked and no nameservers changed. Sign in with your passkey to unfreeze it." });
    } else if (purpose === "recovery_cancel") {
      changed = await cancelRequest(ctx, c, userId, eventId, "email_link");
    } else if (purpose === "auto_renew_off") {
      const d = await c.query("update domains set auto_renew = false where id = $1 and user_id = $2 and auto_renew", [eventId, userId]);
      const m = await c.query("update renewal_mandates set revoked_at = $3 where domain_id = $1 and user_id = $2 and revoked_at is null", [eventId, userId, now]);
      changed = (d.rowCount ?? 0) + (m.rowCount ?? 0) > 0;
      await auditUser(ctx, c, userId, "auth.auto_renew_off", { resourceKind: "email_action", resourceId: row.id, detail: { event: eventId, changed } });
    }
    return { purpose, changed };
  });
}

/** Cancel one open (pending or cooling-off) recovery request. Zero rows means it is not open any more. */
export async function cancelRequest(ctx: AppContext, c: PoolClient, userId: string, requestId: string, by: string): Promise<boolean> {
  const now = ctx.clock.now();
  const r = await c.query("update recovery_requests set status = 'cancelled', cancelled_by = $3, updated_at = $4 where id = $1 and user_id = $2 and status in ('pending','cooling_off') returning id", [requestId, userId, by, now]);
  if (r.rowCount !== 1) return false;
  await auditUser(ctx, c, userId, "auth.recovery.cancelled", { resourceKind: "recovery_request", resourceId: requestId, detail: { by } });
  await notifyUser(ctx, c, userId, { kind: "recovery.cancelled", immediate: true, dedupeKey: `recovery-cancel:${requestId}`, subject: "Account recovery was cancelled", text: "The recovery request on your Mosshatch account was cancelled. No credential changed." });
  return true;
}

/* ---- Confirm page and routes ---- */

const COPY: Record<EmailActionPurpose, { title: string; body: string; button: string }> = {
  freeze: { title: "Freeze your account", body: "This signs out every session, pauses agent and CLI tokens and marks your account frozen. It does not unlock domains, change nameservers or stop renewals. You unfreeze by signing in with your passkey.", button: "Freeze my account" },
  recovery_cancel: { title: "Cancel account recovery", body: "This cancels the pending recovery request on your account. No credential changes.", button: "Cancel the recovery" },
  auto_renew_off: { title: "Turn off auto-renew", body: "This turns off auto-renew for one domain and revokes its renewal mandate. You can turn it on again later with your passkey.", button: "Turn off auto-renew" },
};

const STYLE = "body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.6rem 1rem}";
const SCRIPT = `document.getElementById('go').addEventListener('click',async function(){var b=this;b.disabled=true;var m=document.getElementById('msg');try{var r=await fetch(location.pathname,{method:'POST',credentials:'omit',headers:{'content-type':'application/json','x-mh-client':'web'},body:'{"confirm":true}'});m.textContent=r.ok?'Done.':'This link is not valid any more.';}catch(e){m.textContent='Something went wrong. Try again.';b.disabled=false;}});`;
const sri = (s: string) => `'sha256-${crypto.createHash("sha256").update(s).digest("base64")}'`;
const CSP = `default-src 'none'; script-src ${sri(SCRIPT)}; style-src ${sri(STYLE)}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function pageHtml(title: string, body: string, button?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${title}</title><style>${STYLE}</style></head><body><h1>${title}</h1><p>${body}</p>${button ? `<p><button id="go" type="button">${button}</button></p><p id="msg" role="status"></p><script>${SCRIPT}</script>` : ""}</body></html>`;
}

/** GET and HEAD: says what the link would do. Reads only; nothing here consumes or changes anything. */
async function getPage(req: HandlerReq): Promise<HandlerResult> {
  const d = await describe(req.ctx, req.params.token ?? "");
  const headers = { "Content-Security-Policy": CSP, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
  if (!d) return { status: 404, html: pageHtml("Link not valid", "This link has expired, was already used, or is not valid."), headers };
  const c = COPY[d.purpose];
  return { status: 200, html: pageHtml(c.title, c.body, c.button), headers };
}

/**
 * Anonymous principal with its own proof (the token). It has no cookie session, so the router's CSRF guard does not run;
 * this handler applies the same checks: same origin, a non-cross-site fetch, JSON, our client header, and an explicit confirm.
 */
async function postAct(req: HandlerReq): Promise<HandlerResult> {
  const r = req.request;
  const site = r.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") throw new HttpError(403, "csrf");
  if (r.headers.get("origin") !== req.ctx.config.origin) throw new HttpError(403, "csrf");
  if (!(r.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "unsupported_media_type");
  if (r.headers.get("x-mh-client") !== "web") throw new HttpError(403, "csrf");
  const b = req.body as { confirm?: unknown } | null;
  if (!b || typeof b !== "object" || b.confirm !== true) throw new HttpError(400, "confirm_required");
  const res = await runEmailAction(req.ctx, req.params.token ?? "");
  if (!res) throw new HttpError(404, "not_found");
  return json({ ok: true, purpose: res.purpose, changed: res.changed });
}

export const emailActionRoutes: Route[] = [
  { method: "GET", path: "/api/v1/email-actions/:token", principals: ["anonymous"], handler: getPage, tag: "auth" },
  // csrf "none": no cookie principal is accepted here; postAct applies the equivalent guard itself.
  { method: "POST", path: "/api/v1/email-actions/:token", principals: ["anonymous"], csrf: "none", handler: postAct, tag: "auth" },
];
