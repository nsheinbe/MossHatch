import crypto from "node:crypto";

export const sha256 = (data: string | Uint8Array): Buffer => crypto.createHash("sha256").update(data).digest();
export const randomBytes = (n: number): Buffer => crypto.randomBytes(n);
export const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
export const fromB64u = (s: string): Buffer => Buffer.from(s, "base64url");

/** Constant-time equality for equal-length buffers; unequal lengths compare false without leaking where they differ. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(buf: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function base62(n: number): string {
  // Rejection sampling: 248 = 62 * 4, so bytes >= 248 are discarded to avoid modulo bias.
  let out = "";
  while (out.length < n) for (const b of crypto.randomBytes(n * 2)) { if (b < 248 && out.length < n) out += B62[b % 62]; }
  return out;
}

/** RFC 8785 style canonical JSON for the subset we use (objects, arrays, strings, finite numbers, booleans, null). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("canonicalJson: non-finite number"); return JSON.stringify(v); }
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
  }
  throw new Error("canonicalJson: unsupported value");
}
export const hashOf = (v: unknown): Buffer => sha256(canonicalJson(v));
