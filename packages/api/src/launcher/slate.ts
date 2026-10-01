import crypto from "node:crypto";
import { z } from "zod";
import type { Brief } from "@mosshatch/core/brief";

/**
 * Client for Slate's partner API (the website builder, a separate app; docs/LAUNCHER.md "Slate contract"). Every request is signed:
 *
 *   x-slate-partner        SLATE_PARTNER_ID ("mosshatch")
 *   x-slate-timestamp      unix seconds
 *   x-slate-nonce          24 random url-safe characters
 *   x-slate-partner-user   hex HMAC-SHA256(SLATE_PARTNER_USER_KEY, <Mosshatch user id>): stable per account, never the id or email
 *   x-slate-signature      hex HMAC-SHA256(SLATE_PARTNER_SECRET, `${ts}\n${nonce}\n${METHOD}\n${pathWithQuery}\n${sha256hex(rawBody)}`)
 *
 * `pathWithQuery` is the request URL's path and query exactly as sent (with the base path, e.g. `/api/partner/v1/quote`); confirm with
 * Slate that this is the form they verify (listed under "unverified" in LAUNCHER.md). Every response is parsed with a schema: Slate is
 * a separate system and its answers are input, not truth.
 */

export const SLATE_TIMEOUT_MS = 15_000;
export const EXPORT_MAX_BYTES = 25 * 1024 * 1024;
/** Slate refuses request bodies over 64 KB (422); refused here first so nothing is sent. */
export const MAX_BODY_BYTES = 64 * 1024;

export type SlateStatus = "queued" | "building" | "ready" | "failed" | "refunded";
export interface SlateStep { id: string; label: string; state: "pending" | "active" | "done" | "failed" }
export interface SlateQuote { quote_id: string; kind: "website"; model: string; price_minor: number; currency: string; expires_at: string }
export interface SlateBuild {
  build_id: string; status: SlateStatus; steps: SlateStep[]; title?: string; summary?: string; preview_url?: string; error?: string;
  price_minor: number; charged_minor: number;
}
export interface SlateQuoteBody { kind: "website"; brief: Brief; model?: string; base_build_id?: string; instruction?: string }
export interface SlateExport { body: Uint8Array<ArrayBuffer>; contentType: string; filename: string }

/** A Slate refusal or failure, as its code (Slate's `error.code`, or ours for transport problems). Never carries Slate's message text onward. */
export class SlateError extends Error {
  override name = "SlateError";
  constructor(readonly status: number, readonly code: string) { super(code); }
  /**
   * True when Slate certainly did not act: any 4xx but a timeout (409 is a refusal here: a revision whose base is not ready, a cancel
   * after dispatch), or a 503 `partner_unfunded`. A 503 `unavailable`, a 5xx or a lost connection is unknown: retry with the same key.
   */
  get definite(): boolean { return (this.status >= 400 && this.status < 500 && this.status !== 408) || (this.status === 503 && this.code === "partner_unfunded"); }
}

export interface SlatePort {
  models(userId: string): Promise<unknown>;
  quote(userId: string, body: SlateQuoteBody): Promise<SlateQuote>;
  createBuild(userId: string, body: { quote_id: string; idempotency_key: string }): Promise<{ build_id: string; status: SlateStatus }>;
  getBuild(userId: string, buildId: string): Promise<SlateBuild>;
  exportBuild(userId: string, buildId: string): Promise<SlateExport>;
  cancel(userId: string, buildId: string): Promise<{ status: SlateStatus } | SlateBuild>;
}

// ---- signing (pure; the known-vector tests pin it) -----------------------------------------------------------------------------

export const sha256hex = (data: string | Uint8Array) => crypto.createHash("sha256").update(data).digest("hex");
export const hmacHex = (key: string, data: string) => crypto.createHmac("sha256", key).update(data).digest("hex");

/** The canonical string Slate verifies. */
export function canonicalRequest(p: { ts: number; nonce: string; method: string; pathWithQuery: string; rawBody: string }): string {
  return `${p.ts}\n${p.nonce}\n${p.method.toUpperCase()}\n${p.pathWithQuery}\n${sha256hex(p.rawBody)}`;
}
export function signRequest(secret: string, p: Parameters<typeof canonicalRequest>[0]): string {
  return hmacHex(secret, canonicalRequest(p));
}
/** The pseudonymous user id Slate sees: stable per account, unlinkable without the key, never the id or email itself. */
export function partnerUser(userKey: string, userId: string): string {
  return hmacHex(userKey, userId);
}
/** 18 random bytes as base64url: exactly 24 url-safe characters. */
export const newNonce = () => crypto.randomBytes(18).toString("base64url");
export const NONCE_RE = /^[A-Za-z0-9_-]{24}$/;

// ---- response schemas ----------------------------------------------------------------------------------------------------------

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const minor = z.number().int().min(0).max(10_000_000);
const status = z.enum(["queued", "building", "ready", "failed", "refunded"]);
const QuoteRes = z.object({ quote_id: id, kind: z.literal("website"), model: z.string().min(1).max(100), price_minor: minor, currency: z.string().min(3).max(3).transform((s) => s.toLowerCase()), expires_at: z.string().datetime({ offset: true }) });
const StepRes = z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(120), state: z.enum(["pending", "active", "done", "failed"]).catch("pending") });
const errorCode = z.union([z.string(), z.object({ code: z.string() }).transform((e) => e.code)]).transform((s) => s.replace(/[^a-z0-9_]/gi, "").slice(0, 64) || "error");
const BuildRes = z.object({
  build_id: id, status, steps: z.array(StepRes).max(40).catch([]), title: z.string().max(200).optional(), summary: z.string().max(1000).optional(),
  preview_url: z.string().url().max(2000).optional(), error: errorCode.optional(), price_minor: minor, charged_minor: minor,
});
const CreateRes = z.object({ build_id: id, status });
const CancelRes = z.union([BuildRes, z.object({ status })]);
const ErrorRes = z.object({ error: z.object({ code: z.string().max(64), message: z.string().optional() }) });

export interface SlateHttpOptions {
  baseUrl: string;
  partnerId: string;
  secret: string;
  userKey: string;
  fetch?: (req: Request) => Promise<Response>;
  now?: () => Date;
  nonce?: () => string;
  timeoutMs?: number;
}

export class SlateHttp implements SlatePort {
  private readonly base: URL;
  private readonly doFetch: (req: Request) => Promise<Response>;
  constructor(private o: SlateHttpOptions) {
    this.base = new URL(o.baseUrl.replace(/\/+$/, ""));
    if (this.base.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(this.base.hostname)) throw new Error("slate_url_not_https");
    this.doFetch = o.fetch ?? ((r) => fetch(r));
  }

  /** Build, sign and send one request. Exposed for the contract tests. */
  async request(userId: string, method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    const url = new URL(this.base.toString() + path);
    const rawBody = body === undefined ? "" : JSON.stringify(body);
    if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) throw new SlateError(422, "body_too_large");
    const ts = Math.floor((this.o.now?.() ?? new Date()).getTime() / 1000);
    const nonce = this.o.nonce?.() ?? newNonce();
    const pathWithQuery = url.pathname + url.search;
    const headers = new Headers({
      accept: "application/json",
      "x-slate-partner": this.o.partnerId,
      "x-slate-timestamp": String(ts),
      "x-slate-nonce": nonce,
      "x-slate-partner-user": partnerUser(this.o.userKey, userId),
      "x-slate-signature": signRequest(this.o.secret, { ts, nonce, method, pathWithQuery, rawBody }),
    });
    if (body !== undefined) headers.set("content-type", "application/json");
    const req = new Request(url, { method, headers, body: body === undefined ? undefined : rawBody, signal: AbortSignal.timeout(this.o.timeoutMs ?? SLATE_TIMEOUT_MS), redirect: "error" });
    try { return await this.doFetch(req); }
    catch (e) { throw new SlateError(0, (e as Error)?.name === "TimeoutError" ? "slate_timeout" : "slate_unreachable"); }
  }

  private async json<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const e = ErrorRes.safeParse(parsed);
      throw new SlateError(res.status, e.success ? e.data.error.code.replace(/[^a-z0-9_]/gi, "").slice(0, 64) || "slate_error" : `slate_http_${res.status}`);
    }
    const r = schema.safeParse(parsed);
    if (!r.success) throw new SlateError(502, "slate_bad_response");
    return r.data;
  }

  async models(userId: string) { return this.json(await this.request(userId, "GET", "/models"), z.unknown()); }
  async quote(userId: string, body: SlateQuoteBody) { return this.json(await this.request(userId, "POST", "/quote", body), QuoteRes) as Promise<SlateQuote>; }
  async createBuild(userId: string, body: { quote_id: string; idempotency_key: string }) { return this.json(await this.request(userId, "POST", "/builds", body), CreateRes); }
  async getBuild(userId: string, buildId: string) { return this.json(await this.request(userId, "GET", `/builds/${encodeURIComponent(buildId)}`), BuildRes) as Promise<SlateBuild>; }
  async cancel(userId: string, buildId: string) { return this.json(await this.request(userId, "POST", `/builds/${encodeURIComponent(buildId)}/cancel`, {}), CancelRes) as Promise<SlateBuild | { status: SlateStatus }>; }
  async exportBuild(userId: string, buildId: string): Promise<SlateExport> {
    const res = await this.request(userId, "GET", `/builds/${encodeURIComponent(buildId)}/export`);
    if (!res.ok) return this.json(res, z.never());
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > EXPORT_MAX_BYTES) throw new SlateError(502, "slate_export_too_large");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > EXPORT_MAX_BYTES) throw new SlateError(502, "slate_export_too_large");
    const ct = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const contentType = ["application/zip", "application/gzip", "application/x-tar", "application/json", "application/octet-stream"].includes(ct) ? ct : "application/octet-stream";
    const ext = contentType === "application/zip" ? "zip" : contentType === "application/gzip" ? "tar.gz" : contentType === "application/x-tar" ? "tar" : contentType === "application/json" ? "json" : "bin";
    return { body: buf, contentType, filename: `site-${buildId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}.${ext}` };
  }
}
