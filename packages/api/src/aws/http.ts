import crypto from "node:crypto";
import { signV4, type AwsCredentials } from "../vault/kms/aws.ts";
import { KmsError, type KmsErrorCode } from "../vault/kms/types.ts";

/**
 * Shared plumbing for the production AWS adapters (PLAN 4.3b Secrets): one pinned Region, SigV4 over `fetch`, no AWS SDK.
 * The SDK v3 clients are not a dependency (bundle size and supply chain, D-013); the signer is the vault's, checked against
 * the AWS test-suite vector. Every error carries an AWS error name or a fixed code, never a request body, key or token.
 */

/** Pinned explicitly: Vercel's `AWS_REGION` follows the function's execution Region and can change under failover. */
export const PINNED_AWS_REGION = "us-east-1";

export type AwsFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/** The platform fetch, with redirects refused (an AWS endpoint never redirects a signed request anywhere we want to follow). */
export const platformFetch: AwsFetch = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal, redirect: "error" });
  return { status: res.status, text: () => res.text() };
};

export interface AwsCallOptions {
  region: string;
  credentials: () => Promise<AwsCredentials>;
  fetch: AwsFetch;
  timeoutMs?: number;
  clock?: { now(): Date };
}

export function assertPinnedRegion(region: string): void {
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new Error("aws: region must be pinned");
}

export const amzDateOf = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
export const sha256hex = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");

/** RFC 3986 encoding as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
export const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export function xmlText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? decodeXml(m[1]!) : null;
}
export function xmlAll(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => decodeXml(m[1]!));
}
function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
}
/** An AWS error name is letters and dots only; anything else is reported as a fixed code so no echoed value can ride on it. */
export const safeCode = (s: string | null | undefined, fallback: string) => (s && /^[A-Za-z.]{1,64}$/.test(s) ? s : fallback);

const KMS_KNOWN: KmsErrorCode[] = ["AccessDeniedException", "InvalidCiphertextException", "IncorrectKeyException", "DisabledException", "KMSInvalidStateException", "NotFoundException", "ThrottlingException", "KMSInternalException", "KMSInvalidMacException"];

/**
 * One signed KMS JSON 1.1 call (`X-Amz-Target: TrentService.<Op>`), 3-second deadline, no retry loop. Credential failures
 * propagate as they are (an `AwsAuthError` carries its own code); KMS failures become a `KmsError` with the KMS error name.
 */
export async function kmsCall(o: AwsCallOptions, op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const host = `kms.${o.region}.amazonaws.com`;
  const body = JSON.stringify(payload);
  const amzDate = amzDateOf((o.clock ?? { now: () => new Date() }).now());
  const headers: Record<string, string> = { "content-type": "application/x-amz-json-1.1", "x-amz-target": `TrentService.${op}` };
  const creds = await o.credentials();
  const { authorization } = signV4({ method: "POST", host, path: "/", headers, body, region: o.region, service: "kms", amzDate, credentials: creds });
  const all = { ...headers, host, "x-amz-date": amzDate, authorization, ...(creds.sessionToken ? { "x-amz-security-token": creds.sessionToken } : {}) };
  let res: { status: number; text(): Promise<string> };
  try { res = await o.fetch(`https://${host}/`, { method: "POST", headers: all, body, signal: AbortSignal.timeout(o.timeoutMs ?? 3000) }); }
  catch (e) { throw new KmsError((e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError" ? "Timeout" : "Unavailable"); }
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(await res.text()); } catch { parsed = {}; }
  if (res.status !== 200) {
    const t = String(parsed.__type ?? "").split("#").pop() as KmsErrorCode;
    throw new KmsError(KMS_KNOWN.includes(t) ? t : res.status >= 500 ? "KMSInternalException" : "AccessDeniedException");
  }
  return parsed;
}
