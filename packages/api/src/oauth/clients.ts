import dns from "node:dns";
import https from "node:https";
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

// Control, bidi (overrides, embeddings, isolates, marks), zero-width and line-separator characters: a reported name shown on the
// consent screen cannot reorder or hide its own text.
// eslint-disable-next-line no-control-regex
const cleanName = (s: unknown) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, "").trim().slice(0, 80) || null : null);

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
/** Metadata document fetches (own targets): a document at most 3 times and a host at most 30 times in 10 minutes. */
export const CIMD_FETCH_LIMITS = { url: { bucket: "oauth.cimd.url", max: 3, windowSeconds: 600 }, host: { bucket: "oauth.cimd.host", max: 30, windowSeconds: 600 } };

/** A client id that is a metadata document URL: https, a path, no fragment, no credentials, no query. */
export function isCimdUrl(s: string): boolean {
  let u: URL; try { u = new URL(s); } catch { return false; }
  return u.protocol === "https:" && u.pathname.length > 1 && !u.hash && !u.username && !u.password && !u.search && s.length <= 500;
}

export const CIMD_MAX_BYTES = 16_384;
export const CIMD_TIMEOUT_MS = 5000;

/**
 * The socket's own name lookup: every address a name resolves to must be public, and the connection uses exactly the addresses
 * checked here, so a name that answers differently between a check and the connect (DNS rebinding) cannot reach a private one.
 */
export const publicOnlyLookup = ((host: string, opts: dns.LookupOptions, cb: (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void) => {
  dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err, "");
    const list = addrs as unknown as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => !publicAddress(a.address))) return cb(new Error("private_address"), "");
    if (opts?.all) cb(null, list); else cb(null, list[0]!.address, list[0]!.family);
  });
}) as unknown as net.LookupFunction;

/**
 * The real fetcher (not exercised against a live host in this container: no outbound calls). https only, no redirects (a 3xx is
 * a failure), 5 seconds in all, at most 16 KiB read from the wire (the stream is cut, never buffered first), and only public
 * addresses, checked by the lookup the socket connects with (an IP literal is checked before the request).
 */
export class SafeMetadataFetcher implements ClientMetadataPort {
  constructor(private readonly timeoutMs = CIMD_TIMEOUT_MS) {}
  async fetch(url: string): Promise<unknown> {
    if (!isCimdUrl(url)) throw new Error("bad_url");
    const u = new URL(url);
    const literal = u.hostname.replace(/^\[(.*)\]$/, "$1");
    if (net.isIP(literal) && !publicAddress(literal)) throw new Error("private_address");
    const body = await new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const done = (e: Error | null, v?: Buffer) => { if (settled) return; settled = true; clearTimeout(timer); if (e) { req.destroy(); reject(e); } else resolve(v!); };
      const timer = setTimeout(() => done(new Error("timeout")), this.timeoutMs);
      const req = https.request(u, { method: "GET", headers: { accept: "application/json" }, lookup: publicOnlyLookup, agent: false }, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 299) return done(new Error("fetch_failed"));
        if (Number(res.headers["content-length"] ?? 0) > CIMD_MAX_BYTES) return done(new Error("too_large"));
        const parts: Buffer[] = [];
        let n = 0;
        res.on("data", (chunk: Buffer) => { n += chunk.length; if (n > CIMD_MAX_BYTES) done(new Error("too_large")); else parts.push(chunk); });
        res.on("end", () => done(null, Buffer.concat(parts)));
        res.on("error", () => done(new Error("fetch_failed")));
        res.on("close", () => done(new Error("fetch_failed")));
      });
      req.on("error", (e) => done(e.message === "private_address" ? e : new Error("fetch_failed")));
      req.end();
    });
    return JSON.parse(body.toString("utf8"));
  }
}

// Not public: this host, private and shared ranges, link-local and site-local, multicast and reserved, and the IPv6 forms that
// carry an IPv4 address (mapped, compatible, NAT64, 6to4), whatever that address is.
// Two lists: a BlockList also matches an IPv4 address against IPv6 rules through its mapped form, and ::ffff:0:0/96 is here.
const PRIVATE_V4 = new net.BlockList(), PRIVATE_V6 = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) PRIVATE_V4.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) PRIVATE_V6.addSubnet(a, p, "ipv6");

export function publicAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 0) return false;
  try { return kind === 4 ? !PRIVATE_V4.check(ip, "ipv4") : !PRIVATE_V6.check(ip, "ipv6"); } catch { return false; }
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
  // Anyone can name any URL here (the authorize endpoint is anonymous), so fetches are limited per document and per host: the
  // server is never a free reflector against one site. Over the limit, a cached client is used as it stands.
  const may = await withNoUser(ctx.runtime, async (c) => (await hit(ctx, c, `oauth.cimd:${clientId}`, CIMD_FETCH_LIMITS.url)).allowed
    && (await hit(ctx, c, `oauth.cimd.host:${new URL(clientId).hostname}`, CIMD_FETCH_LIMITS.host)).allowed);
  if (!may) return have ?? null;
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
