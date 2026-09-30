import dns from "node:dns/promises";
import net from "node:net";
import { z } from "zod";
import { withNoUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { hit } from "../ratelimit.ts";
import { base62, hashOf } from "../util/bytes.ts";

/**
 * OAuth clients of the MCP authorization server (D-019; dossier section 3, F10, F34, F68). Registration priority follows the
 * 2026-07-28 spec: Client ID Metadata Documents (the client id is an https URL whose document we fetch), with Dynamic Client
 * Registration (RFC 7591) as the fallback because VS Code and older Claude clients still start with it. Redirect URIs match
 * exactly, except that a loopback `http` URI matches on any port (RFC 8252 7.3; Claude Code listens on a random port).
 */

export interface ClientRow { id: string; client_id: string; registration: "dcr" | "cimd"; client_name: string | null; redirect_uris: string[]; fetched_at: Date | null; disabled_at: Date | null }

export interface ClientMetadataPort { fetch(url: string): Promise<unknown> }

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** A redirect URI we accept at registration: https with a host and no fragment, or an http loopback address. */
export function redirectAllowed(u: string): boolean {
  if (typeof u !== "string" || u.length < 8 || u.length > 500 || /\s/.test(u)) return false;
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return url.hostname.length > 0;
  return url.protocol === "http:" && LOOPBACK.has(url.hostname);
}

/** Exact match, or the same loopback URI on another port. */
export function redirectMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  let p: URL; try { p = new URL(presented); } catch { return false; }
  if (p.protocol !== "http:" || !LOOPBACK.has(p.hostname)) return false;
  return registered.some((r) => {
    let x: URL; try { x = new URL(r); } catch { return false; }
    return x.protocol === "http:" && x.hostname === p.hostname && x.pathname === p.pathname && x.search === p.search;
  });
}

export const isLoopback = (u: string) => { try { const x = new URL(u); return LOOPBACK.has(x.hostname); } catch { return false; } };
export const hostOf = (u: string) => { try { return new URL(u).host; } catch { return "unknown"; } };

const cleanName = (s: unknown) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || null : null);

// ---- Dynamic Client Registration (RFC 7591), the fallback ----------------------------------------------------------------------

const DcrBody = z.looseObject({
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z.literal("none").optional(),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).max(2).optional(),
  response_types: z.array(z.literal("code")).max(1).optional(),
});
export const DCR_LIMIT = { bucket: "oauth.dcr.ip", max: 20, windowSeconds: 3600 };

export async function registerHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const rl = await withNoUser(ctx.runtime, (c) => hit(ctx, c, `oauth.dcr:${req.ipPrefix}`, DCR_LIMIT));
  if (!rl.allowed) return json({ error: "rate_limited" }, 429, { headers: { "Retry-After": String(rl.retryAfterSeconds) } });
  const b = DcrBody.safeParse(req.body);
  if (!b.success) return json({ error: "invalid_client_metadata" }, 400);
  if (!b.data.redirect_uris.every(redirectAllowed)) return json({ error: "invalid_redirect_uri" }, 400);
  const clientId = `mhc_${base62(32)}`;
  const name = cleanName(b.data.client_name);
  const now = ctx.clock.now();
  await withNoUser(ctx.runtime, (c) => c.query("insert into oauth_clients (client_id, registration, client_name, redirect_uris, ip_prefix, created_at) values ($1,'dcr',$2,$3,$4,$5)", [clientId, name, b.data.redirect_uris, req.ipPrefix, now]));
  return json({
    client_id: clientId, client_id_issued_at: Math.floor(now.getTime() / 1000), client_name: name ?? undefined, redirect_uris: b.data.redirect_uris,
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  }, 201);
}

// ---- Client ID Metadata Documents --------------------------------------------------------------------------------------------

const CimdDoc = z.looseObject({
  client_id: z.string().max(500),
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(z.string()).min(1).max(10),
  token_endpoint_auth_method: z.string().max(50).optional(),
});
export const CIMD_TTL_MS = 24 * 3_600_000;

/** A client id that is a metadata document URL: https, a path, no fragment, no credentials, no query. */
export function isCimdUrl(s: string): boolean {
  let u: URL; try { u = new URL(s); } catch { return false; }
  return u.protocol === "https:" && u.pathname.length > 1 && !u.hash && !u.username && !u.password && !u.search && s.length <= 500;
}

/**
 * The real fetcher (not exercised in this container: no outbound calls). SSRF-safe as far as `fetch` allows: https only, no
 * redirects, a 5-second timeout, 16 KiB at most, and a name that resolves only to public addresses (checked before the
 * request; a rebinding between the check and the connect is the residual risk this cannot close).
 */
export class SafeMetadataFetcher implements ClientMetadataPort {
  async fetch(url: string): Promise<unknown> {
    if (!isCimdUrl(url)) throw new Error("bad_url");
    const host = new URL(url).hostname;
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    if (addrs.length === 0 || addrs.some((a) => !publicAddress(a.address))) throw new Error("private_address");
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("fetch_failed");
    const text = await res.text();
    if (text.length > 16_384) throw new Error("too_large");
    return JSON.parse(text);
  }
}

export function publicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  const x = ip.toLowerCase();
  return !(x === "::" || x === "::1" || x.startsWith("fe80") || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("::ffff:") || x.startsWith("ff"));
}

export function metadataPort(ctx: Pick<AppContext, "services">): ClientMetadataPort {
  const s = ctx.services as { clientMetadata?: ClientMetadataPort };
  s.clientMetadata ??= new SafeMetadataFetcher();
  return s.clientMetadata;
}

/** Resolve a client id: a registered DCR client, or a metadata document (fetched, checked and cached for a day). */
export async function resolveClient(ctx: AppContext, clientId: unknown): Promise<ClientRow | null> {
  if (typeof clientId !== "string" || clientId.length < 16 || clientId.length > 500) return null;
  const have = (await withNoUser(ctx.runtime, (c) => c.query("select * from oauth_clients where client_id = $1", [clientId]))).rows[0] as ClientRow | undefined;
  if (have?.disabled_at) return null;
  if (have && (have.registration === "dcr" || (have.fetched_at && ctx.clock.now().getTime() - new Date(have.fetched_at).getTime() < CIMD_TTL_MS))) return have;
  if (!isCimdUrl(clientId)) return null;
  let doc;
  try { doc = CimdDoc.parse(await metadataPort(ctx).fetch(clientId)); } catch { return have ?? null; }
  // The document must name itself, and every redirect it lists must be one we would accept.
  if (doc.client_id !== clientId || !doc.redirect_uris.every(redirectAllowed)) return null;
  const now = ctx.clock.now();
  const r = await withNoUser(ctx.runtime, (c) => c.query(
    `insert into oauth_clients (client_id, registration, client_name, redirect_uris, metadata_hash, fetched_at, created_at) values ($1,'cimd',$2,$3,$4,$5,$5)
     on conflict (client_id) do update set client_name = excluded.client_name, redirect_uris = excluded.redirect_uris, metadata_hash = excluded.metadata_hash, fetched_at = excluded.fetched_at
     where oauth_clients.registration = 'cimd' returning *`,
    [clientId, cleanName(doc.client_name), doc.redirect_uris, hashOf({ n: doc.client_name ?? null, r: doc.redirect_uris }), now]));
  return (r.rows[0] as ClientRow | undefined) ?? null;
}

export async function clientByRef(ctx: AppContext, id: string): Promise<ClientRow | null> {
  return ((await withNoUser(ctx.runtime, (c) => c.query("select * from oauth_clients where id = $1", [id]))).rows[0] as ClientRow | undefined) ?? null;
}

export const refuseUnknown = () => new HttpError(400, "invalid_client");
