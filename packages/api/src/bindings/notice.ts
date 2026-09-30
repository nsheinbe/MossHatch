import crypto from "node:crypto";
import { z } from "zod";
import { withNoUser, withUser, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { notifyUser } from "../auth/mail.ts";
import { b64u, randomBytes, sha256 } from "../util/bytes.ts";
import { scopeString, type Scope } from "./scopes.ts";
import { revokeBinding } from "./tokens.ts";

/**
 * Every grant emails every notification address with a revoke link (PLAN 4.5). The link opens a page that says what it
 * would do (GET changes nothing); a confirm button POSTs. The token is 256 bits, stored as SHA-256, single use, 7 days.
 * The mail names the scopes (the owner's own domain names) and the observed address; never a token.
 */

export const REVOKE_LINK_TTL_MS = 7 * 86_400_000;
const LINK_RE = /^[A-Za-z0-9_-]{43}$/;

export async function grantNotice(ctx: AppContext, c: PoolClient, userId: string, bindingId: string, scopes: Scope[], what: "cli" | "agent" | "widen" = "cli"): Promise<void> {
  const raw = b64u(randomBytes(32));
  const now = ctx.clock.now();
  await c.query("insert into binding_revoke_links (token_hash, user_id, binding_id, expires_at, created_at) values ($1,$2,$3,$4,$5)", [sha256(raw), userId, bindingId, new Date(now.getTime() + REVOKE_LINK_TTL_MS), now]);
  const at = now.toISOString().replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, " UTC");
  await notifyUser(ctx, c, userId, {
    kind: "binding.granted", immediate: true, dedupeKey: `binding.granted:${bindingId}:${crypto.randomUUID()}`,
    subject: what === "cli" ? "A command-line tool can now use your Mosshatch account" : what === "agent" ? "A new token can use your Mosshatch account" : "A token on your Mosshatch account can now do more",
    text: `At ${at} you approved ${what === "cli" ? "a sign-in for the Mosshatch command-line tool" : what === "agent" ? "a new token" : "a wider token"} with your passkey. It can:\n${scopes.map((s) => `- ${scopeString(s)}`).join("\n")}\n\n${what === "cli" ? "Its access lasts 60 minutes at a time and renews for up to 90 days." : "It works until it expires or you revoke it."}\n\nIf this was not you, revoke it now:\n${ctx.config.origin}/api/v1/binding-revoke/${raw}\n\nThe link works once and expires in 7 days. You can also revoke it from your account at any time.`,
  });
}

const STYLE = "body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#111;background:#fff}button{font:inherit;padding:.5rem 1rem}";
const SCRIPT = `document.getElementById('go').addEventListener('click',async function(){var b=this;b.disabled=true;var m=document.getElementById('msg');try{var r=await fetch(location.pathname,{method:'POST',credentials:'omit',headers:{'content-type':'application/json','x-mh-client':'web'},body:'{"confirm":true}'});m.textContent=r.ok?'Revoked. The tool can no longer use your account.':'This link is not valid any more.';}catch(e){m.textContent='Something went wrong. Try again.';b.disabled=false;}});`;
const sri = (s: string) => `'sha256-${crypto.createHash("sha256").update(s).digest("base64")}'`;
const CSP = `default-src 'none'; script-src ${sri(SCRIPT)}; style-src ${sri(STYLE)}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`;
const page = (title: string, body: string, button?: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${title}</title><style>${STYLE}</style></head><body><h1>${title}</h1><p>${body}</p>${button ? `<p><button id="go" type="button">${button}</button></p><p id="msg" role="status"></p><script>${SCRIPT}</script>` : ""}</body></html>`;
const HEADERS = { "Content-Security-Policy": CSP, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };

async function linkRow(ctx: AppContext, token: string) {
  if (!LINK_RE.test(token)) return null;
  const r = (await withNoUser(ctx.runtime, (c) => c.query("select * from binding_revoke_link_get($1)", [sha256(token)]))).rows[0];
  if (!r || r.used_at || new Date(r.expires_at) <= ctx.clock.now()) return null;
  return r as { id: string; user_id: string; binding_id: string };
}

/** GET and HEAD: describe only. */
export async function revokeLinkPage(req: HandlerReq): Promise<HandlerResult> {
  const r = await linkRow(req.ctx, req.params.token ?? "");
  if (!r) return { status: 404, html: page("Link not valid", "This link has expired, was already used, or is not valid."), headers: HEADERS };
  return { status: 200, html: page("Revoke a command-line sign-in", "This stops the command-line tool you approved from using your account. Nothing else changes."), headers: HEADERS };
}

/** POST: anonymous with its own proof (the token); applies the same-origin JSON checks the CSRF guard would. */
export async function revokeLinkPost(req: HandlerReq): Promise<HandlerResult> {
  const q = req.request;
  const site = q.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") throw new HttpError(403, "csrf");
  if (q.headers.get("origin") !== req.ctx.config.origin) throw new HttpError(403, "csrf");
  if (!(q.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "unsupported_media_type");
  if (q.headers.get("x-mh-client") !== "web") throw new HttpError(403, "csrf");
  const b = z.strictObject({ confirm: z.literal(true) }).safeParse(req.body);
  if (!b.success) throw new HttpError(400, "confirm_required");
  const r = await linkRow(req.ctx, req.params.token ?? "");
  if (!r) throw new HttpError(404, "not_found");
  const done = await withUser(req.ctx.runtime, r.user_id, async (c) => {
    const used = await c.query("update binding_revoke_links set used_at = $2 where id = $1 and used_at is null", [r.id, req.ctx.clock.now()]);
    if (used.rowCount !== 1) return false;
    await revokeBinding(req.ctx, c, r.user_id, r.binding_id, "email_link", { kind: "user", id: r.user_id });
    return true;
  });
  if (!done) throw new HttpError(404, "not_found");
  return json({ revoked: true });
}
