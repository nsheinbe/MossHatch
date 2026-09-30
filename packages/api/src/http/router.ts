import { withNoUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import type { ActionType, HandlerReq, HandlerResult, Principal, PrincipalKind, Route } from "./types.ts";
import { parseCookies, PRE_AUTH_COOKIE, resolveSession, SESSION_COOKIE } from "./session.ts";
import { sha256, safeEqual } from "../util/bytes.ts";
import { parseToken } from "../util/token.ts";
import { hit } from "../ratelimit.ts";

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
};

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public headers?: Record<string, string>, public extra?: Record<string, unknown>) { super(message ?? code); }
}

/** Registers routes and refuses any without a principal declaration (deny by default). */
export class Router {
  readonly routes: Route[] = [];
  private stepUpGate?: (req: HandlerReq, type: ActionType) => Promise<{ id: string; type: ActionType; params: unknown }>;
  add(...rs: Route[]): this {
    for (const r of rs) {
      if (!r.principals || r.principals.length === 0) throw new Error(`route ${r.method} ${r.path} has no principal declaration`);
      if (r.principals.includes("webhook") && !r.verify) throw new Error(`webhook route ${r.method} ${r.path} has no signature verifier`);
      if (r.stepUp && !r.principals.every((p) => p === "session")) throw new Error(`step-up route ${r.method} ${r.path} must be session-only`);
      this.routes.push(r);
    }
    return this;
  }
  setStepUpGate(fn: NonNullable<Router["stepUpGate"]>) { this.stepUpGate = fn; }

  private match(method: string, pathname: string): { route?: Route; params: Record<string, string>; pathMatched: boolean; allow: string[] } {
    const segs = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    const allow: string[] = [];
    for (const r of this.routes) {
      const rs = r.path.split("/").filter(Boolean);
      if (rs.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < rs.length; i++) {
        if (rs[i]!.startsWith(":")) { try { params[rs[i]!.slice(1)] = decodeURIComponent(segs[i]!); } catch { ok = false; break; } }
        else if (rs[i] !== segs[i]) { ok = false; break; }
      }
      if (!ok) continue;
      pathMatched = true; allow.push(r.method);
      if (r.method === method || (method === "HEAD" && r.method === "GET")) return { route: r, params, pathMatched, allow };
    }
    return { params: {}, pathMatched, allow };
  }

  async dispatch(ctx: AppContext, request: Request): Promise<Response> {
    try {
      return finish(await this.run(ctx, request));
    } catch (e) {
      if (e instanceof HttpError) return finish({ status: e.status, json: { error: { code: e.code, message: e.message === e.code ? undefined : e.message, ...e.extra } }, headers: e.headers });
      // Unexpected: log a class name only (never the message, which may carry values), answer generically.
      console.error("unhandled", (e as Error)?.name, process.env.MH_DEBUG_ERRORS ? (e as Error).message : "");
      return finish({ status: 500, json: { error: { code: "internal" } } });
    }
  }

  private async run(ctx: AppContext, request: Request): Promise<HandlerResult> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const { route, params, pathMatched, allow } = this.match(method, url.pathname);
    if (!route) {
      if (pathMatched) throw new HttpError(405, "method_not_allowed", "method_not_allowed", { Allow: [...new Set(allow)].join(", ") });
      throw new HttpError(404, "not_found");
    }
    const cookies = parseCookies(request.headers.get("cookie"));
    const authz = request.headers.get("authorization");
    // Stricter than ignoring one: both credentials at once is a client bug or an attack.
    if (cookies[SESSION_COOKIE] && authz) throw new HttpError(400, "ambiguous_credentials");

    let principal: Principal;
    try { principal = await this.authenticate(ctx, route, cookies, authz, request); }
    catch (e) {
      // RFC 9728 / MCP authorization: a 401 names where the protected resource metadata lives.
      if (e instanceof HttpError && e.status === 401 && route.challenge) throw new HttpError(401, e.code, undefined, { ...(e.headers ?? {}), "WWW-Authenticate": route.challenge(ctx) });
      throw e;
    }
    const isCookieRoute = route.principals.includes("session") || url.pathname.startsWith("/api/v1/auth/");
    if (method !== "GET" && method !== "HEAD" && isCookieRoute && route.csrf !== "none" && principal.kind !== "binding" && principal.kind !== "cron" && principal.kind !== "webhook") csrfGuard(ctx, request);

    let rawBody = "";
    let body: unknown = null;
    if (method !== "GET" && method !== "HEAD") {
      rawBody = await request.text();
      if (rawBody.length > 256_000) throw new HttpError(413, "too_large");
      if (route.principals.includes("webhook") && route.verify) {
        const v = await route.verify(request, rawBody, ctx);
        if (!v.ok) throw new HttpError(400, "bad_signature");
        principal.kind = "webhook"; principal.provider = v.provider;
      }
      if (rawBody && route.body === "form" && (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
        // Form bodies (OAuth endpoints): a repeated parameter is an error (RFC 6749 3.1), so it becomes an array the handler rejects.
        const o: Record<string, string | string[]> = {};
        for (const [k, v] of new URLSearchParams(rawBody)) o[k] = k in o ? ([] as string[]).concat(o[k]!, v) : v;
        body = o;
      } else if (rawBody) { try { body = JSON.parse(rawBody); } catch { if (!route.principals.includes("webhook")) throw new HttpError(400, "bad_json"); body = rawBody; } }
    } else if (route.principals.includes("webhook") && route.verify) {
      const v = await route.verify(request, "", ctx);
      if (!v.ok) throw new HttpError(400, "bad_signature");
      principal.kind = "webhook"; principal.provider = v.provider;
    }

    const req: HandlerReq = { ctx, request, url, params, principal, body, ipPrefix: ipPrefix(request), uaFamily: uaFamily(request) };
    if (route.stepUp) {
      if (!this.stepUpGate) throw new HttpError(503, "step_up_unavailable");
      req.action = await this.stepUpGate(req, route.stepUp);
    }
    void cookies[PRE_AUTH_COOKIE];
    return route.handler(req);
  }

  private async authenticate(ctx: AppContext, route: Route, cookies: Record<string, string>, authz: string | null, _req: Request): Promise<Principal> {
    const allowed = new Set<PrincipalKind>(route.principals);
    // Cron: the Authorization value is compared only with CRON_SECRET and is never treated as a binding token.
    if (allowed.has("cron") && !allowed.has("session") && !allowed.has("binding")) {
      const want = Buffer.from(`Bearer ${ctx.config.cronSecret}`);
      const got = Buffer.from(authz ?? "");
      if (!ctx.config.cronSecret || !safeEqual(sha256(want), sha256(got))) throw new HttpError(401, "unauthorized");
      return { kind: "cron" };
    }
    if (authz !== null) {
      // On every non-cron route a value that is not an mh_ token is 401, and the cron secret is just a bad token here.
      const m = /^Bearer (\S+)$/.exec(authz);
      const parsed = m ? parseToken(m[1]!) : null;
      if (!parsed) { await countBearerFailure(ctx, _req, (m?.[1] ?? authz).slice(0, 12)); throw new HttpError(401, "unauthorized"); }
      if (!allowed.has("binding")) throw new HttpError(403, "forbidden_principal");
      const row = (await withNoUser(ctx.runtime, (c) => c.query("select * from auth_binding_get($1, $2)", [parsed.prefix, parsed.hash]))).rows[0];
      const now = ctx.clock.now();
      if (!row || row.revoked_at || new Date(row.expires_at) <= now) { await countBearerFailure(ctx, _req, parsed.prefix); throw new HttpError(401, "unauthorized"); }
      if (row.paused_at) throw new HttpError(403, "binding_paused");
      // Idle limit and last-used, in the database on every request (ST-62): 30 days without use ends a token.
      const live = (await withNoUser(ctx.runtime, (c) => c.query("select auth_binding_touch($1, $2, '30 days'::interval) as ok", [row.id, now]))).rows[0];
      if (!live?.ok) throw new HttpError(401, "unauthorized");
      return { kind: "binding", userId: row.user_id, bindingId: row.id, bindingKind: row.kind, scopes: row.scopes };
    }
    if (cookies[SESSION_COOKIE]) {
      const s = await resolveSession(ctx, cookies[SESSION_COOKIE]);
      if (s.ok) {
        if (!allowed.has("session")) { if (allowed.has("anonymous")) return { kind: "anonymous" }; throw new HttpError(403, "forbidden_principal"); }
        return { kind: "session", userId: s.userId, sessionIdHash: s.idHash, authCredentialId: s.credentialId };
      }
      if (!allowed.has("anonymous")) throw new HttpError(401, "unauthorized");
      return { kind: "anonymous" };
    }
    if (allowed.has("anonymous") || allowed.has("webhook")) return { kind: allowed.has("anonymous") ? "anonymous" : "webhook" };
    throw new HttpError(401, "unauthorized");
  }
}

/** Bearer failures per (source /24 or /48, presented-token prefix): an alarm, never a block (plan 4.5 rate-limit table, ST-136). */
export const BEARER_FAILURE_ALARM = { bucket: "bearer.fail.pair", max: 30, windowSeconds: 60 } as const;
/**
 * Count a failed bearer authentication. Keyed on the pair, never on the address alone, so a burst of bad tokens from a shared
 * connector range (claude.ai's 160.79.104.0/21) cannot deny anyone's valid token; a tripped counter raises one open alert.
 * Nothing here stores the address, the prefix or the token (the counter key is an HMAC). Never throws.
 */
async function countBearerFailure(ctx: AppContext, r: Request, tokenPrefix: string): Promise<void> {
  try {
    await withNoUser(ctx.runtime, async (c) => {
      const h = await hit(ctx, c, `bearer.fail:${ipPrefix(r)}|${tokenPrefix}`, BEARER_FAILURE_ALARM);
      if (h.count === BEARER_FAILURE_ALARM.max + 1) {
        await c.query("insert into alerts (severity, kind, subject, detail) select 'warn', 'bearer.failure_burst', null, $1::jsonb where not exists (select 1 from alerts where kind = 'bearer.failure_burst' and state = 'open')", [{ count: h.count }]);
      }
    });
  } catch { /* counting is best effort; the 401 stands */ }
}

/** Every non-GET request to a cookie route: same origin, JSON, and our own header. */
function csrfGuard(ctx: AppContext, r: Request) {
  const site = r.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") throw new HttpError(403, "csrf");
  const origin = r.headers.get("origin");
  if (origin !== ctx.config.origin) throw new HttpError(403, "csrf");
  if (!(r.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "unsupported_media_type");
  if (r.headers.get("x-mh-client") !== "web") throw new HttpError(403, "csrf");
}

function ipPrefix(r: Request): string {
  const ip = (r.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split(".").slice(0, 3).join(".") + ".0/24";
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + "::/48";
  return "unknown";
}
function uaFamily(r: Request): string {
  const ua = r.headers.get("user-agent") ?? "";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Edg\//.test(ua)) return "edge";
  if (/Chrome\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

function finish(r: HandlerResult): Response {
  const headers = new Headers(SECURITY_HEADERS);
  for (const [k, v] of Object.entries(r.headers ?? {})) headers.set(k, v);
  for (const c of r.cookies ?? []) headers.append("Set-Cookie", c);
  if (r.html !== undefined) {
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Robots-Tag", "noindex");
    return new Response(r.html, { status: r.status ?? 200, headers });
  }
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(r.json ?? {}, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { status: r.status ?? 200, headers });
}

export const json = (data: unknown, status = 200, extra?: Partial<HandlerResult>): HandlerResult => ({ status, json: data, ...extra });
