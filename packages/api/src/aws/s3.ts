import crypto from "node:crypto";
import { signV4 } from "../vault/kms/aws.ts";
import type { S3LikeClient } from "../ops/anchor.ts";
import { amzDateOf, assertPinnedRegion, safeCode, sha256hex, uriEncode, xmlAll, xmlText, type AwsCallOptions } from "./http.ts";

/** An S3 failure: the S3 error name (or `http_<status>`), never a key, a body or a bucket listing. */
export class S3Error extends Error {
  override name = "S3Error";
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}

/** Virtual-hosted bucket names only, and no dots (a dotted name breaks the wildcard certificate). */
export const isPlainBucketName = (s: string | undefined): s is string => !!s && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(s);

export interface ObjectLockConfiguration { enabled: boolean; mode: "COMPLIANCE" | "GOVERNANCE" | null; days: number | null; years: number | null }

/**
 * The few S3 REST calls the write-once stores need, SigV4-signed over fetch: PutObject with `If-None-Match: *` and Object Lock
 * headers, ListObjectsV2, GetObject, and GetObjectLockConfiguration for the boot probe. Region pinned, virtual-hosted style.
 */
export class AwsS3 implements S3LikeClient {
  constructor(private o: AwsCallOptions) { assertPinnedRegion(o.region); }

  private async request(bucket: string, method: "GET" | "PUT", key: string, query: Record<string, string>, extra: Record<string, string> = {}, body = ""): Promise<string> {
    if (!isPlainBucketName(bucket)) throw new S3Error("InvalidBucketName", 0);
    const host = `${bucket}.s3.${this.o.region}.amazonaws.com`;
    const path = "/" + key.split("/").map(uriEncode).join("/");
    const qs = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`).join("&");
    const amzDate = amzDateOf((this.o.clock ?? { now: () => new Date() }).now());
    const headers: Record<string, string> = { ...extra, "x-amz-content-sha256": sha256hex(body) };
    const creds = await this.o.credentials();
    const { authorization } = signV4({ method, host, path, query: qs, headers, body, region: this.o.region, service: "s3", amzDate, credentials: creds });
    const all = { ...headers, host, "x-amz-date": amzDate, authorization, ...(creds.sessionToken ? { "x-amz-security-token": creds.sessionToken } : {}) };
    let res: { status: number; text(): Promise<string> };
    try { res = await this.o.fetch(`https://${host}${path}${qs ? "?" + qs : ""}`, { method, headers: all, ...(method === "PUT" ? { body } : {}), signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000) }); }
    catch (e) { throw new S3Error((e as Error)?.name === "TimeoutError" ? "Timeout" : "Unavailable", 0); }
    const text = await res.text().catch(() => "");
    if (res.status < 200 || res.status >= 300) throw new S3Error(safeCode(xmlText(text, "Code"), `http_${res.status}`), res.status);
    return text;
  }

  async putObject(p: Parameters<S3LikeClient["putObject"]>[0]): Promise<void> {
    await this.request(p.Bucket, "PUT", p.Key, {}, {
      "content-type": p.ContentType,
      // Object Lock puts need an integrity header; Content-MD5 is the one every S3 endpoint accepts.
      "content-md5": crypto.createHash("md5").update(p.Body).digest("base64"),
      "if-none-match": p.IfNoneMatch,
      "x-amz-object-lock-mode": p.ObjectLockMode,
      "x-amz-object-lock-retain-until-date": p.ObjectLockRetainUntilDate.toISOString(),
    }, p.Body);
  }

  async listKeys(p: { Bucket: string; Prefix: string }): Promise<string[]> {
    const out: string[] = [];
    let token: string | null = null;
    for (let page = 0; page < 1000; page++) {
      const xml = await this.request(p.Bucket, "GET", "", { "list-type": "2", prefix: p.Prefix, ...(token ? { "continuation-token": token } : {}) });
      out.push(...xmlAll(xml, "Key"));
      token = xmlText(xml, "IsTruncated") === "true" ? xmlText(xml, "NextContinuationToken") : null;
      if (!token) return out;
    }
    throw new S3Error("PageLimit", 0);
  }

  getObject(p: { Bucket: string; Key: string }): Promise<string> {
    return this.request(p.Bucket, "GET", p.Key, {});
  }

  async objectLockConfiguration(bucket: string): Promise<ObjectLockConfiguration> {
    const xml = await this.request(bucket, "GET", "", { "object-lock": "" });
    const mode = xmlText(xml, "Mode");
    const n = (t: string) => { const v = xmlText(xml, t); return v === null ? null : Number(v); };
    return { enabled: xmlText(xml, "ObjectLockEnabled") === "Enabled", mode: mode === "COMPLIANCE" || mode === "GOVERNANCE" ? mode : null, days: n("Days"), years: n("Years") };
  }
}
