import crypto from "node:crypto";
import type { Envelope, KmsPort, PiiPort } from "../ports.ts";
import { KmsError } from "../vault/kms/types.ts";
import { assertPinnedRegion, kmsCall, type AwsCallOptions } from "./http.ts";

/**
 * The app's two non-vault production keys (PLAN 4.3b Loss radius, item 6): an HMAC key for the audit chain, secret pointers,
 * rate-limit subjects and email codes, and a PII key for registrant contacts and other field-encrypted values.
 */

const KEY_ARN = /^arn:aws:kms:[a-z]{2}-[a-z]+-\d:\d{12}:key\/(?:mrk-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** Key ARNs only (an alias would make the returned KeyId differ from the configured one, and aliases can be re-pointed). */
export const isKmsKeyArn = (s: string | undefined): s is string => !!s && KEY_ARN.test(s);
const regionOfArn = (arn: string) => arn.split(":")[3];

export type MacPurpose = Parameters<KmsPort["hmac"]>[0];

/**
 * `ctx.kms` on AWS: `GenerateMac` with an HMAC_256 key (`HMAC_SHA_256`). One KMS key serves every purpose; the purposes are
 * kept apart by a domain-separated message, `mh-mac-v1 \0 purpose \0 SHA-256(data)`. Pre-hashing keeps the message inside
 * KMS's 4,096-byte limit whatever the caller passes (an audit row can be longer). The MAC key never leaves KMS.
 */
export class AwsKms implements KmsPort {
  readonly mode = "aws" as const;
  constructor(private o: AwsCallOptions & { macKeyArn: string }) {
    assertPinnedRegion(o.region);
    if (!isKmsKeyArn(o.macKeyArn) || regionOfArn(o.macKeyArn) !== o.region) throw new Error("aws kms: mac key must be a key ARN in the pinned region");
  }
  static message(purpose: MacPurpose, data: Uint8Array): Buffer {
    return Buffer.concat([Buffer.from(`mh-mac-v1\0${purpose}\0`), crypto.createHash("sha256").update(data).digest()]);
  }
  async hmac(purpose: MacPurpose, data: Uint8Array): Promise<Buffer> {
    const r = await kmsCall(this.o, "GenerateMac", { KeyId: this.o.macKeyArn, MacAlgorithm: "HMAC_SHA_256", Message: AwsKms.message(purpose, data).toString("base64") });
    const mac = Buffer.from(String(r.Mac ?? ""), "base64");
    if (mac.length !== 32) throw new KmsError("KMSInternalException");
    return mac;
  }
  /** `VerifyMac`: KMS compares in constant time and answers `MacValid`; an invalid MAC is `false`, not an exception. */
  async verify(purpose: MacPurpose, data: Uint8Array, mac: Buffer): Promise<boolean> {
    try {
      const r = await kmsCall(this.o, "VerifyMac", { KeyId: this.o.macKeyArn, MacAlgorithm: "HMAC_SHA_256", Message: AwsKms.message(purpose, data).toString("base64"), Mac: mac.toString("base64") });
      return r.MacValid === true;
    } catch (e) {
      if (e instanceof KmsError && e.code === "KMSInvalidMacException") return false;
      throw e;
    }
  }
}

export const PII_APP = "mosshatch";

/** The encryption context of a PII data key. CloudTrail logs it in plaintext, so the AAD goes in as a hash, never as itself. */
export function piiContext(aad: string): Record<string, string> {
  return { app: PII_APP, purpose: "pii", aad_sha256: crypto.createHash("sha256").update(aad).digest("base64url") };
}

/**
 * `ctx.pii` on AWS: envelope encryption. Each value gets a fresh AES-256 data key from `GenerateDataKey`, is sealed locally
 * with AES-256-GCM under the caller's AAD, and the wrapped key travels in the envelope (`wk`). The data key's encryption
 * context binds the AAD (as a hash), so KMS refuses to unwrap a key for a different field or row, and GCM refuses too.
 * Nothing is cached; the plaintext data key is zeroed after use. A `local` envelope is refused, never decrypted with a local key.
 */
export class AwsPii implements PiiPort {
  constructor(private o: AwsCallOptions & { piiKeyArn: string }) {
    assertPinnedRegion(o.region);
    if (!isKmsKeyArn(o.piiKeyArn) || regionOfArn(o.piiKeyArn) !== o.region) throw new Error("aws pii: key must be a key ARN in the pinned region");
  }
  async encrypt(plaintext: string, aad: string): Promise<Envelope> {
    const r = await kmsCall(this.o, "GenerateDataKey", { KeyId: this.o.piiKeyArn, KeySpec: "AES_256", EncryptionContext: piiContext(aad) });
    if (String(r.KeyId) !== this.o.piiKeyArn) throw new KmsError("IncorrectKeyException");
    const key = Buffer.from(String(r.Plaintext ?? ""), "base64");
    try {
      if (key.length !== 32) throw new KmsError("KMSInternalException");
      const nonce = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      c.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      return { v: 1, alg: "A256GCM", nonce: nonce.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64"), kek: this.o.piiKeyArn, wk: String(r.CiphertextBlob) };
    } finally { key.fill(0); }
  }
  async decrypt(env: Envelope, aad: string): Promise<string> {
    if (env.kek !== this.o.piiKeyArn || !env.wk) throw new KmsError("IncorrectKeyException");
    const r = await kmsCall(this.o, "Decrypt", { KeyId: this.o.piiKeyArn, CiphertextBlob: env.wk, EncryptionContext: piiContext(aad) });
    if (String(r.KeyId) !== this.o.piiKeyArn) throw new KmsError("IncorrectKeyException");
    const key = Buffer.from(String(r.Plaintext ?? ""), "base64");
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(env.nonce, "base64"), { authTagLength: 16 });
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(Buffer.from(env.tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(env.ct, "base64")), d.final()]).toString("utf8");
    } finally { key.fill(0); }
  }
}
