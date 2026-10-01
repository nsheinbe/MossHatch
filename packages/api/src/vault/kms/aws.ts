import crypto from "node:crypto";
import { KmsError, type KmsErrorCode, type VaultEncryptionContext, type VaultKekClass, type VaultKmsPort, type VaultRole } from "./types.ts";

/**
 * AWS KMS adapter over the JSON protocol (`X-Amz-Target: TrentService.<Op>`, `application/x-amz-json-1.1`) with a
 * Signature Version 4 signer written here, because `@aws-sdk/client-kms` is not a dependency and adding one needs a
 * reason the lead has not approved. NEVER CALLED in this repository: no AWS account or credentials exist. Request and
 * response shapes follow the KMS API reference (GenerateDataKey, Decrypt, ReEncrypt) and are unverified against a live
 * endpoint; the signer is checked against the AWS SigV4 test-suite vector `get-vanilla` only.
 */

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
/** One credential set per role: `vault-prod` and `vault-nonprod` by OIDC federation, `operator` from the incident identity. */
export type CredentialProvider = (role: VaultRole) => Promise<AwsCredentials>;
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

const sha256hex = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (k: Buffer | string, s: string) => crypto.createHmac("sha256", k).update(s).digest();

export interface SignInput {
  method: string;
  host: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  amzDate: string;          // YYYYMMDDTHHMMSSZ
  credentials: AwsCredentials;
}

/** SigV4 over the given headers (lower-cased, trimmed, sorted). Returns the Authorization header value. */
export function signV4(i: SignInput): { authorization: string; signedHeaders: string; canonicalRequest: string } {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...i.headers, host: i.host, "x-amz-date": i.amzDate, ...(i.credentials.sessionToken ? { "x-amz-security-token": i.credentials.sessionToken } : {}) })) {
    headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  }
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [i.method, i.path, i.query ?? "", names.map((n) => `${n}:${headers[n]}\n`).join(""), signedHeaders, sha256hex(i.body)].join("\n");
  const date = i.amzDate.slice(0, 8);
  const scope = `${date}/${i.region}/${i.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", i.amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac("AWS4" + i.credentials.secretAccessKey, date);
  const kSigning = hmac(hmac(hmac(kDate, i.region), i.service), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(toSign).digest("hex");
  return { authorization: `AWS4-HMAC-SHA256 Credential=${i.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, signedHeaders, canonicalRequest };
}

const KNOWN: KmsErrorCode[] = ["AccessDeniedException", "InvalidCiphertextException", "IncorrectKeyException", "DisabledException", "KMSInvalidStateException", "NotFoundException", "ThrottlingException", "KMSInternalException"];

export interface AwsVaultKmsOptions {
  /** Pinned explicitly: Vercel notes AWS_REGION can change under failover (PLAN 4.3b). */
  region: string;
  keks: Record<VaultKekClass, string>;
  credentials: CredentialProvider;
  fetch: FetchLike;
  timeoutMs?: number;
  clock?: { now(): Date };
}

export class AwsVaultKms implements VaultKmsPort {
  readonly mode = "aws" as const;
  constructor(private o: AwsVaultKmsOptions) {
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(o.region)) throw new Error("aws kms: region must be pinned");
  }
  currentKek(cls: VaultKekClass): string { return this.o.keks[cls]; }

  /** One signed POST, 3-second deadline, no retry loop (PLAN 4.3b). Errors carry the KMS error name only. */
  async call(role: VaultRole, op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const host = `kms.${this.o.region}.amazonaws.com`;
    const body = JSON.stringify(payload);
    const now = (this.o.clock ?? { now: () => new Date() }).now();
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const headers: Record<string, string> = { "content-type": "application/x-amz-json-1.1", "x-amz-target": `TrentService.${op}` };
    let creds: AwsCredentials;
    try { creds = await this.o.credentials(role); } catch { throw new KmsError("AccessDeniedException"); }
    const { authorization } = signV4({ method: "POST", host, path: "/", headers, body, region: this.o.region, service: "kms", amzDate, credentials: creds });
    const all = { ...headers, host, "x-amz-date": amzDate, authorization, ...(creds.sessionToken ? { "x-amz-security-token": creds.sessionToken } : {}) };
    let res: { status: number; text(): Promise<string> };
    try { res = await this.o.fetch(`https://${host}/`, { method: "POST", headers: all, body, signal: AbortSignal.timeout(this.o.timeoutMs ?? 3000) }); }
    catch (e) { throw new KmsError((e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError" ? "Timeout" : "Unavailable"); }
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(await res.text()); } catch { parsed = {}; }
    if (res.status !== 200) {
      const t = String(parsed.__type ?? "").split("#").pop() as KmsErrorCode;
      throw new KmsError(KNOWN.includes(t) ? t : res.status >= 500 ? "KMSInternalException" : "AccessDeniedException");
    }
    return parsed;
  }

  async generateDataKey(role: VaultRole, keyId: string, context: VaultEncryptionContext) {
    const r = await this.call(role, "GenerateDataKey", { KeyId: keyId, KeySpec: "AES_256", EncryptionContext: context });
    return { plaintext: Buffer.from(String(r.Plaintext), "base64"), ciphertextBlob: Buffer.from(String(r.CiphertextBlob), "base64"), keyId: String(r.KeyId) };
  }
  async decrypt(role: VaultRole, keyId: string, ciphertextBlob: Buffer, context: VaultEncryptionContext) {
    const r = await this.call(role, "Decrypt", { KeyId: keyId, CiphertextBlob: ciphertextBlob.toString("base64"), EncryptionContext: context });
    if (String(r.KeyId) !== keyId) throw new KmsError("IncorrectKeyException");
    return Buffer.from(String(r.Plaintext), "base64");
  }
  async reEncrypt(role: VaultRole, i: { ciphertextBlob: Buffer; sourceKeyId: string; sourceContext: VaultEncryptionContext; destinationKeyId: string; destinationContext: VaultEncryptionContext }) {
    const r = await this.call(role, "ReEncrypt", {
      CiphertextBlob: i.ciphertextBlob.toString("base64"), SourceKeyId: i.sourceKeyId, SourceEncryptionContext: i.sourceContext,
      DestinationKeyId: i.destinationKeyId, DestinationEncryptionContext: i.destinationContext,
    });
    return { ciphertextBlob: Buffer.from(String(r.CiphertextBlob), "base64"), keyId: String(r.KeyId) };
  }
}
