import { AsyncLocalStorage } from "node:async_hooks";
import type { AwsCredentials } from "../vault/kms/aws.ts";
import { assertPinnedRegion, safeCode, xmlText, type AwsFetch } from "./http.ts";

/**
 * AWS credentials by Vercel OIDC federation (PLAN 4.3b Secrets; https://vercel.com/docs/oidc/aws and /docs/oidc/reference,
 * accessed 2026-10-01): the function's OIDC token is exchanged with STS `AssumeRoleWithWebIdentity` for a 900-second session.
 * There are no static AWS keys anywhere.
 *
 * The token is a live two-hour credential. It is read, sent to the Vercel token exchange (custom audience) and to STS, and
 * nothing else: it is never logged, never put in an error, never forwarded. Errors carry a fixed code or an STS error name.
 *
 * Where the token comes from, in order:
 *  1. the `x-vercel-oidc-token` header of the request being served, captured by `runWithOidcToken` in api/index.ts;
 *  2. Vercel's request context (`globalThis[Symbol.for("@vercel/request-context")]`, what `@vercel/oidc` reads);
 *  3. `VERCEL_OIDC_TOKEN` (builds and `vercel env pull` local development).
 *
 * `@vercel/oidc-aws-credentials-provider` does the same, but it pulls in `@aws-sdk/credential-provider-web-identity`, the Smithy
 * stack and two Vercel CLI packages; this file is the few lines of it that we need, with tests against a fake STS.
 */

const tokenScope = new AsyncLocalStorage<{ token: string | null }>();

/** Run `fn` with the request's OIDC token available to the credential providers (and to nothing else). */
export function runWithOidcToken<T>(token: string | null | undefined, fn: () => T): T {
  return tokenScope.run({ token: token || null }, fn);
}

export type OidcTokenSource = () => string | null;

export function vercelOidcTokenSource(env: Record<string, string | undefined>): OidcTokenSource {
  return () => {
    const scoped = tokenScope.getStore()?.token;
    if (scoped) return scoped;
    const ctx = (globalThis as Record<symbol, { get?: () => { headers?: Record<string, string | undefined> } } | undefined>)[Symbol.for("@vercel/request-context")]?.get?.();
    const fromCtx = ctx?.headers?.["x-vercel-oidc-token"];
    if (typeof fromCtx === "string" && fromCtx) return fromCtx;
    return env.VERCEL_OIDC_TOKEN || null;
  };
}

/** A credential failure. `code` is one of the fixed codes below or `sts:<STS error name>`; never a token or a role ARN. */
export class AwsAuthError extends Error {
  override name = "AwsAuthError";
  constructor(public readonly code: string) { super(code); }
}

export interface WebIdentityOptions {
  roleArn: string;
  region: string;
  /** Shown in CloudTrail as the session name: an opaque deployment id, never a user value. */
  sessionName: string;
  /** Custom `aud` (PLAN: a random 32-byte value registered as the IAM provider's only audience). Absent: Vercel's default `https://vercel.com/<team>`. */
  audience?: string;
  durationSeconds?: number;
  tokenSource: OidcTokenSource;
  fetch: AwsFetch;
  clock?: { now(): Date };
  /** Overridable for tests; the Vercel token-exchange endpoint `@vercel/oidc` uses for a custom audience. */
  exchangeUrl?: string;
}

export const OIDC_EXCHANGE_URL = "https://oidc.vercel.com/~token";
export const STS_DURATION_SECONDS = 900;
/** Refresh this long before the STS session expires. */
const REFRESH_MARGIN_MS = 60_000;

export function sanitizeSessionName(s: string): string {
  const v = s.replace(/[^\w+=,.@-]/g, "-").slice(-64);
  return v.length >= 2 ? v : "mosshatch";
}

async function exchangeAudience(o: WebIdentityOptions, token: string): Promise<string> {
  let res: { status: number; text(): Promise<string> };
  try {
    res = await o.fetch(o.exchangeUrl ?? OIDC_EXCHANGE_URL, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ token, aud: o.audience }), signal: AbortSignal.timeout(5000),
    });
  } catch { throw new AwsAuthError("oidc_audience_exchange_unreachable"); }
  if (res.status !== 200) throw new AwsAuthError("oidc_audience_exchange_failed");
  let data: { token?: unknown };
  try { data = JSON.parse(await res.text()); } catch { throw new AwsAuthError("oidc_audience_exchange_failed"); }
  if (typeof data.token !== "string" || !data.token) throw new AwsAuthError("oidc_audience_exchange_failed");
  return data.token;
}

async function assumeRole(o: WebIdentityOptions): Promise<AwsCredentials & { expiresAt: number }> {
  const raw = o.tokenSource();
  if (!raw) throw new AwsAuthError("oidc_token_missing");
  const token = o.audience ? await exchangeAudience(o, raw) : raw;
  const form = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: o.roleArn, RoleSessionName: sanitizeSessionName(o.sessionName),
    WebIdentityToken: token, DurationSeconds: String(o.durationSeconds ?? STS_DURATION_SECONDS),
  });
  let res: { status: number; text(): Promise<string> };
  try {
    res = await o.fetch(`https://sts.${o.region}.amazonaws.com/`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8", accept: "application/xml" },
      body: form.toString(), signal: AbortSignal.timeout(5000),
    });
  } catch { throw new AwsAuthError("sts_unreachable"); }
  const xml = await res.text().catch(() => "");
  if (res.status !== 200) throw new AwsAuthError("sts:" + safeCode(xmlText(xml, "Code"), "Unknown"));
  const accessKeyId = xmlText(xml, "AccessKeyId"), secretAccessKey = xmlText(xml, "SecretAccessKey"), sessionToken = xmlText(xml, "SessionToken");
  const exp = Date.parse(xmlText(xml, "Expiration") ?? "");
  if (!accessKeyId || !secretAccessKey || !sessionToken || Number.isNaN(exp)) throw new AwsAuthError("sts:MalformedResponse");
  return { accessKeyId, secretAccessKey, sessionToken, expiresAt: exp };
}

/**
 * A credential provider for one role: cached until a minute before the session ends, one STS call in flight at a time.
 * A failed exchange is not cached, so the next call tries again.
 */
export function webIdentityCredentials(o: WebIdentityOptions): () => Promise<AwsCredentials> {
  assertPinnedRegion(o.region);
  if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@\/-]{1,128}$/.test(o.roleArn)) throw new AwsAuthError("role_arn_invalid");
  const d = o.durationSeconds ?? STS_DURATION_SECONDS;
  if (d < 900 || d > 3600) throw new AwsAuthError("duration_out_of_range");
  const now = () => (o.clock ?? { now: () => new Date() }).now().getTime();
  let cached: (AwsCredentials & { expiresAt: number }) | null = null;
  let inflight: Promise<AwsCredentials & { expiresAt: number }> | null = null;
  return async () => {
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return strip(cached);
    inflight ??= assumeRole(o).finally(() => { inflight = null; });
    cached = await inflight;
    return strip(cached);
  };
}
const strip = (c: AwsCredentials & { expiresAt: number }): AwsCredentials => ({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken });
