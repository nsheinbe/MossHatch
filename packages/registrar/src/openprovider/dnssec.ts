import { createHash } from "node:crypto";
import type { DsRecord } from "../port.ts";

/**
 * Openprovider takes DNSSEC material as DNSKEY records (`dnssec_keys: [{flags, protocol, alg, pub_key}]` on `PUT /domains/{id}`), not as DS
 * records, and the registry derives the DS. The port speaks DS, so reads compute the DS a registry would publish (RFC 4034 5.1.4 and appendix B),
 * and a removal by DS finds the key whose computed DS matches. Adding by DS alone is impossible (a DS cannot be turned back into a key).
 */
export interface Dnskey { flags: number; protocol: number; algorithm: number; publicKey: string }

function ownerWire(fqdn: string): Buffer {
  const labels = fqdn.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  return Buffer.concat([...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, "ascii")])), Buffer.from([0])]);
}
function rdata(k: Dnskey): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(k.flags, 0); head.writeUInt8(k.protocol, 2); head.writeUInt8(k.algorithm, 3);
  return Buffer.concat([head, Buffer.from(k.publicKey.replace(/\s+/g, ""), "base64")]);
}
/** RFC 4034 appendix B (algorithm 1 is obsolete and not handled). */
export function keyTag(k: Dnskey): number {
  const b = rdata(k); let ac = 0;
  for (let i = 0; i < b.length; i++) ac += i & 1 ? b[i]! : b[i]! << 8;
  ac += (ac >> 16) & 0xffff;
  return ac & 0xffff;
}
export function dsFromDnskey(fqdn: string, k: Dnskey, digestType: 1 | 2 = 2): DsRecord {
  const h = createHash(digestType === 1 ? "sha1" : "sha256").update(Buffer.concat([ownerWire(fqdn), rdata(k)])).digest("hex");
  return { keyTag: keyTag(k), algorithm: k.algorithm, digestType, digest: h };
}
export function dsMatchesKey(fqdn: string, ds: DsRecord, k: Dnskey): boolean {
  if (ds.digestType !== 1 && ds.digestType !== 2) return false;
  const c = dsFromDnskey(fqdn, k, ds.digestType);
  return c.keyTag === ds.keyTag && c.algorithm === ds.algorithm && c.digest === ds.digest.toLowerCase();
}
