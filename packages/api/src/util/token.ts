import { base62, sha256 } from "./bytes.ts";

export type TokenKind = "live" | "cli" | "clr";

function crc32(s: string): number {
  let c, crc = 0xffffffff;
  for (let i = 0; i < s.length; i++) {
    c = (crc ^ s.charCodeAt(i)) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** `mh_<kind>_<32 base62>+<crc32 hex>`: recognisable to secret scanners; stored only as SHA-256; shown once. */
export function mintToken(kind: TokenKind): { token: string; prefix: string; hash: Buffer } {
  const body = `mh_${kind}_${base62(32)}`;
  const token = `${body}+${crc32(body).toString(16).padStart(8, "0")}`;
  return { token, prefix: token.slice(0, 12), hash: sha256(token) };
}

export const TOKEN_RE = /^mh_(live|cli|clr)_[A-Za-z0-9]{32}\+[0-9a-f]{8}$/;

export function parseToken(token: string): { kind: TokenKind; prefix: string; hash: Buffer } | null {
  if (!TOKEN_RE.test(token)) return null;
  const [body, crc] = token.split("+") as [string, string];
  if (crc32(body).toString(16).padStart(8, "0") !== crc) return null;
  return { kind: body.split("_")[1] as TokenKind, prefix: token.slice(0, 12), hash: sha256(token) };
}
