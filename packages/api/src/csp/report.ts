import { withNoUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError, json, type Router } from "../http/router.ts";
import type { HandlerReq, Route } from "../http/types.ts";
import { hit } from "../ratelimit.ts";
import { getJobDef, registerJob } from "../jobs/registry.ts";
import { registerRecurringJob } from "../jobs/engine.ts";

/**
 * The CSP report endpoint (PLAN 4.3a, `Reporting-Endpoints` row; D-015). The enforced policy names it twice: `report-uri
 * /api/csp-report` (every browser) and `report-to csp` (`Reporting-Endpoints: csp="/api/csp-report"`). It lives outside `/api/v1`
 * as PLAN 4.5 lists it. No credentials: browsers send reports on their own.
 *
 * Every report is attacker-controlled (anyone can POST here). The handler accepts `application/csp-report` (one legacy report) and
 * `application/reports+json` (a Reporting API array), caps the body at 8 KiB, rate limits per network and overall through the
 * shared Postgres limiter, and keeps only three coarse fields counted per day: the directive, the origin of the blocked resource
 * (or a CSP keyword or scheme name), and the document path without its query or fragment. It drops reports caused by browser
 * extensions and reports about documents on other origins, logs nothing, and never stores a full URL, a sample, a source file,
 * a referrer, a user agent or an address.
 */

export const CSP_REPORT_PATH = "/api/csp-report";
export const CSP_REPORT_MAX_BYTES = 8 * 1024;
/** Per source network (/24 or /48). A page with a real violation sends a handful, not dozens. */
export const CSP_REPORT_LIMIT = { bucket: "csp.report", max: 20, windowSeconds: 60 } as const;
/** Across all sources: bounds how many rows a flood from many networks can add. The policy runs violation-free (ST-36). */
export const CSP_REPORT_GLOBAL_LIMIT = { bucket: "csp.report.all", max: 200, windowSeconds: 60 } as const;
export const CSP_REPORT_KEEP_DAYS = 30;
/** Reports read from one Reporting API batch; the rest are ignored. */
const MAX_PER_BODY = 20;

const TYPES = new Set(["application/csp-report", "application/reports+json", "application/json"]);
/** The values browsers put in blocked-uri instead of a URL (CSP3 "violation resource"). */
const KEYWORDS = new Set(["inline", "eval", "wasm-eval", "self", "trusted-types-policy", "trusted-types-sink"]);
const SCHEMES = new Set(["data", "blob", "filesystem", "about", "mediastream"]);
/** Reports caused by extensions (or Safari's masked extension URLs) are noise, never ours: dropped whole. */
const EXTENSION = /^(?:[a-z-]+-extension|webkit-masked-url):/i;

export interface CspRow { directive: string; blocked: string; documentPath: string; disposition: "enforce" | "report" }
interface Raw { documentURL: unknown; blockedURL: unknown; directive: unknown; fallbackDirective: unknown; sourceFile: unknown; disposition: unknown }

const str = (v: unknown): string => (typeof v === "string" ? v.slice(0, 2048) : "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Both wire formats to one shape. A body that is neither is 400; a batch entry that is not a CSP violation is skipped. */
export function normalize(body: unknown): Raw[] {
  if (Array.isArray(body)) {
    return body.slice(0, MAX_PER_BODY).flatMap((x): Raw[] => {
      if (!isObj(x) || x.type !== "csp-violation" || !isObj(x.body)) return [];
      const b = x.body;
      return [{ documentURL: b.documentURL ?? x.url, blockedURL: b.blockedURL, directive: b.effectiveDirective, fallbackDirective: b.violatedDirective, sourceFile: b.sourceFile, disposition: b.disposition }];
    });
  }
  if (isObj(body) && isObj(body["csp-report"])) {
    const r = body["csp-report"];
    return [{ documentURL: r["document-uri"], blockedURL: r["blocked-uri"], directive: r["effective-directive"], fallbackDirective: r["violated-directive"], sourceFile: r["source-file"], disposition: r.disposition }];
  }
  throw new HttpError(400, "bad_report");
}

function directiveOf(r: Raw): string {
  const d = (str(r.directive).trim() || str(r.fallbackDirective).trim()).toLowerCase().split(/\s+/)[0] ?? "";
  return /^[a-z-]{1,40}$/.test(d) ? d : "other";
}

/** The origin of a blocked URL, a keyword or a scheme name; `null` for an extension (the report is dropped). */
function blockedOf(v: unknown): string | null {
  const s = str(v).trim();
  if (s === "") return "none";
  if (EXTENSION.test(s)) return null;
  const lower = s.toLowerCase();
  if (KEYWORDS.has(lower) || SCHEMES.has(lower)) return lower;
  let u: URL;
  try { u = new URL(s); } catch { return "other"; }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (SCHEMES.has(scheme)) return scheme;
  // Scheme, host and port only: no credentials, path, query or fragment.
  if (["http", "https", "ws", "wss"].includes(scheme) && u.origin.length <= 120) return u.origin;
  return "other";
}

/** The path of a document on one of our origins, without query or fragment; `null` for anything else (the report is dropped). */
function pathOf(v: unknown, origins: readonly string[]): string | null {
  let u: URL;
  try { u = new URL(str(v)); } catch { return null; }
  if (!origins.includes(u.origin)) return null;
  return /^\/[A-Za-z0-9._~/-]{0,99}$/.test(u.pathname) ? u.pathname : "/(other)";
}

/** One report reduced to the kept fields, or `null` to drop it. */
export function reduce(r: Raw, origins: readonly string[]): CspRow | null {
  if (EXTENSION.test(str(r.sourceFile).trim())) return null;
  const blocked = blockedOf(r.blockedURL);
  const documentPath = pathOf(r.documentURL, origins);
  if (blocked === null || documentPath === null) return null;
  return { directive: directiveOf(r), blocked, documentPath, disposition: str(r.disposition).toLowerCase() === "report" ? "report" : "enforce" };
}

async function receive(req: HandlerReq) {
  const { ctx } = req;
  const type = (req.request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!TYPES.has(type)) throw new HttpError(415, "unsupported_media_type");
  // Per network first; only a report inside that limit counts against the overall cap. The counters commit even when refused.
  const rl = await withNoUser(ctx.runtime, async (c) => {
    const mine = await hit(ctx, c, `csp.report:${req.ipPrefix}`, CSP_REPORT_LIMIT);
    return mine.allowed ? hit(ctx, c, "csp.report:all", CSP_REPORT_GLOBAL_LIMIT) : mine;
  });
  if (!rl.allowed) throw new HttpError(429, "rate_limited", "rate_limited", { "Retry-After": String(rl.retryAfterSeconds) });
  const origins = [...new Set([ctx.config.origin, ...ctx.config.allowedOrigins])];
  const rows = normalize(req.body).map((r) => reduce(r, origins)).filter((r): r is CspRow => r !== null);
  if (rows.length) {
    const day = ctx.clock.now().toISOString().slice(0, 10);
    await withNoUser(ctx.runtime, async (c) => {
      for (const r of rows) {
        await c.query(
          `insert into csp_reports (day, directive, blocked, document_path, disposition) values ($1,$2,$3,$4,$5)
           on conflict (day, directive, blocked, document_path, disposition) do update set count = csp_reports.count + 1`,
          [day, r.directive, r.blocked, r.documentPath, r.disposition]);
      }
    });
  }
  return json({}, 202);
}

export const cspReportRoute: Route = {
  method: "POST", path: CSP_REPORT_PATH, principals: ["anonymous"], tag: "csp", maxBodyBytes: CSP_REPORT_MAX_BYTES, handler: receive,
};

/** Delete days older than the keep window. Cron role. */
export async function sweepCspReports(ctx: Pick<AppContext, "cron" | "clock">): Promise<number> {
  const today = ctx.clock.now().toISOString().slice(0, 10);
  const r = await ctx.cron.query("delete from csp_reports where day < $1::date - $2::int", [today, CSP_REPORT_KEEP_DAYS]);
  return r.rowCount ?? 0;
}

/** The route and its daily retention job. Idempotent. */
export function registerCspRoutes(router: Router): void {
  if (!getJobDef("csp.reports_sweep")) registerJob({ kind: "csp.reports_sweep", priority: 1, maxRuntimeSec: 60, handler: async (ctx) => { await sweepCspReports(ctx); } });
  registerRecurringJob({ kind: "csp.reports_sweep", everySec: 86_400 });
  router.add(cspReportRoute);
}
