import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Headers of a signed web -> registrar call. */
export const RPC_HEADERS = { timestamp: "x-mh-timestamp", nonce: "x-mh-nonce", signature: "x-mh-signature" } as const;
export const RPC_PATH_PREFIX = "/rpc/v1/";

export interface SignedParts { method: string; path: string; body: string; timestamp: string; nonce: string }

/**
 * The signed string: a version label, the method, the path, SHA-256 of the body, the Unix-seconds timestamp and the nonce, newline separated.
 * The body is hashed (not concatenated) so field boundaries cannot be shifted; the label separates this HMAC from any other use of the secret.
 */
export function canonicalString(p: SignedParts): string {
  return ["mh-rpc-v1", p.method.toUpperCase(), p.path, createHash("sha256").update(p.body, "utf8").digest("hex"), p.timestamp, p.nonce].join("\n");
}
export function sign(secret: string, p: SignedParts): string {
  return createHmac("sha256", secret).update(canonicalString(p), "utf8").digest("hex");
}
export function verifySignature(secret: string, p: SignedParts, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(sign(secret, p), "hex"), Buffer.from(signature, "hex"));
}

/** JSON with bigint and Date carried as tagged values, so Money and dates survive the trip. */
export function encodeJson(v: unknown): string {
  return JSON.stringify(v, function (this: Record<string, unknown>, k, x) {
    const raw = this[k];
    if (typeof raw === "bigint") return { $bigint: raw.toString() };
    if (raw instanceof Date) return { $date: raw.toISOString() };
    return x;
  });
}
export function decodeJson(s: string): unknown {
  return JSON.parse(s, (_k, x) => {
    if (x && typeof x === "object" && !Array.isArray(x)) {
      const keys = Object.keys(x);
      if (keys.length === 1 && keys[0] === "$bigint" && typeof x.$bigint === "string" && /^-?\d{1,30}$/.test(x.$bigint)) return BigInt(x.$bigint);
      if (keys.length === 1 && keys[0] === "$date" && typeof x.$date === "string") { const d = new Date(x.$date); if (!Number.isNaN(d.getTime())) return d; }
    }
    return x;
  });
}
