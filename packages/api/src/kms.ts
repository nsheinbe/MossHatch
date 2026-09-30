import crypto from "node:crypto";
import type { Envelope, KmsPort, PiiPort } from "./ports.ts";

/** Development and test KMS: HMAC-SHA256 with per-purpose keys derived from one root. Never used when livemode is true. */
export class LocalKms implements KmsPort {
  readonly mode = "local" as const;
  constructor(private root: Buffer = Buffer.from("mosshatch-local-kms-root-key-not-secret")) {}
  async hmac(keyId: string, data: Uint8Array): Promise<Buffer> {
    const key = crypto.createHmac("sha256", this.root).update("key:" + keyId).digest();
    return crypto.createHmac("sha256", key).update(data).digest();
  }
}

export class LocalPii implements PiiPort {
  private key: Buffer;
  constructor(root: Buffer = Buffer.from("mosshatch-local-pii-root-key-not-secret")) {
    this.key = crypto.createHash("sha256").update(root).update("pii").digest();
  }
  async encrypt(plaintext: string, aad: string): Promise<Envelope> {
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.key, nonce);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return { v: 1, alg: "A256GCM", nonce: nonce.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64"), kek: "local" };
  }
  async decrypt(env: Envelope, aad: string): Promise<string> {
    const d = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(env.nonce, "base64"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(env.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(env.ct, "base64")), d.final()]).toString("utf8");
  }
}
