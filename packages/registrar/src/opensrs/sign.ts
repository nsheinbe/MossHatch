import { createHash } from "node:crypto";

/** X-Signature = md5(md5(xml + api_key) + api_key), lower-case hex (docs/research/reg-opensrs.md 4, "Auth"; S9, S10, K18). MD5 is the provider's scheme, not our choice. */
export function opsSignature(xml: string, apiKey: string): string {
  const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
  return md5(md5(xml + apiKey) + apiKey);
}
