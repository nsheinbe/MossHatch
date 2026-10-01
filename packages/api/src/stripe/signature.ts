import crypto from "node:crypto";

/**
 * Stripe's webhook signature scheme: header `t=<unix>,v1=<hex>[,v1=<hex>...]`, where each v1 is
 * HMAC-SHA256(secret, `${t}.${rawBody}`). During a secret roll Stripe signs with both the old and the new secret for
 * up to 24 hours, so the receiver holds two secrets and accepts a match against either.
 */
export const DEFAULT_TOLERANCE_SEC = 300;

export function signPayload(rawBody: string, secret: string, t: number): string {
  return crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
}

/** Build a header the way Stripe does: one v1 per signing secret. */
export function signHeader(rawBody: string, secrets: string | string[], t: number): string {
  const list = Array.isArray(secrets) ? secrets : [secrets];
  return [`t=${t}`, ...list.map((s) => `v1=${signPayload(rawBody, s, t)}`)].join(",");
}

export type SignatureResult =
  | { ok: true; timestamp: number; secretIndex: number }
  | { ok: false; reason: "missing" | "malformed" | "no_secret" | "stale" | "future" | "mismatch" };

export function verifySignature(rawBody: string, header: string | null | undefined, secrets: string[], now: Date, toleranceSec = DEFAULT_TOLERANCE_SEC): SignatureResult {
  if (!header) return { ok: false, reason: "missing" };
  const live = secrets.filter((s) => s && s.length > 0);
  if (live.length === 0) return { ok: false, reason: "no_secret" };
  let t: number | null = null;
  const v1: Buffer[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim(); const v = part.slice(i + 1).trim();
    if (k === "t") { if (!/^\d{1,12}$/.test(v)) return { ok: false, reason: "malformed" }; t = Number(v); }
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) v1.push(Buffer.from(v, "hex"));
  }
  if (t === null || v1.length === 0) return { ok: false, reason: "malformed" };
  // Check the signature before the clock so the caller cannot learn the tolerance from an unsigned probe.
  let matched = -1;
  live.forEach((secret, idx) => {
    const want = Buffer.from(signPayload(rawBody, secret, t!), "hex");
    for (const got of v1) if (got.length === want.length && crypto.timingSafeEqual(got, want)) matched = matched === -1 ? idx : matched;
  });
  if (matched === -1) return { ok: false, reason: "mismatch" };
  const skew = Math.floor(now.getTime() / 1000) - t;
  if (skew > toleranceSec) return { ok: false, reason: "stale" };
  if (skew < -toleranceSec) return { ok: false, reason: "future" };
  return { ok: true, timestamp: t, secretIndex: matched };
}
