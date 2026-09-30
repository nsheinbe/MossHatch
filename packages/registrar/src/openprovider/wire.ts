/**
 * Wire helpers for the Openprovider REST API (JSON over HTTPS, bearer token).
 *
 * Money arrives as JSON numbers (`"price": 11.98`, `"balance": 99884.06`, observed in the sandbox on 2026-09-30). `JSON.parse` would turn them
 * into floats, so the parser keeps the source text of every number (Node 22 passes it to the reviver as `context.source`) and money is converted
 * from that text to bigint minor units. No floating point touches an amount.
 *
 * Openprovider returns the transfer authorization code in places Mosshatch never asked for it: `GET /domains/{id}`, `GET /domains` (list) and
 * `POST /domains` all carry `auth_code` (and `internal_auth_code`), observed 2026-09-30. `stripSecrets` removes those keys immediately after
 * parsing, before anything else (logs, errors, recorder, caller) can see them. The only code the adapter ever keeps is the one it asked for with
 * `POST /domains/{id}/authcode/reset`, which is read out of the raw body by `issueAuthCode` and returned once.
 */
/** Parsed replies carry numbers as JsonNum; outgoing bodies may use plain numbers. */
export type Json = null | boolean | string | number | JsonNum | Json[] | { [k: string]: Json };
/** A JSON number kept as its source text. */
export class JsonNum { constructor(readonly text: string) {} toString() { return this.text; } }

export function parseJson(text: string): Json {
  // The third reviver argument is Node 22's JSON.parse source text access.
  return JSON.parse(text, (_k: string, v: unknown, ctx?: { source?: string }) => (typeof v === "number" ? new JsonNum(ctx?.source ?? String(v)) : v)) as Json;
}
export function encodeJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x instanceof JsonNum ? Number(x.text) : typeof x === "bigint" ? Number(x) : x));
}

/** Keys that carry a transfer authorization code or a session token anywhere in a response. */
export const SECRET_KEYS: ReadonlySet<string> = new Set(["auth_code", "internal_auth_code", "auth_info", "pw", "token", "password", "secret_key"]);
export function stripSecrets(v: Json): Json {
  if (Array.isArray(v)) return v.map(stripSecrets);
  if (v && typeof v === "object" && !(v instanceof JsonNum)) {
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v)) if (!SECRET_KEYS.has(k)) out[k] = stripSecrets(x);
    return out;
  }
  return v;
}

export const obj = (v: Json | undefined): { [k: string]: Json } | undefined => (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof JsonNum) ? v : undefined);
export const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
export const str = (v: Json | undefined): string | undefined => (typeof v === "string" ? v : v instanceof JsonNum ? v.text : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "1" : "0") : undefined);
export const num = (v: Json | undefined): number | undefined => { const s = str(v); if (s === undefined || s === "") return undefined; const n = Number(s); return Number.isFinite(n) ? n : undefined; };
export const bool = (v: Json | undefined): boolean => v === true || (typeof v === "number" && v !== 0) || (v instanceof JsonNum && v.text !== "0") || v === "1" || v === "true" || v === "on";

/**
 * "11.98" -> 1198n, "100000" -> 10000000n, "-3.5" -> -350n. Refuses exponents and more than two significant decimals.
 * Balances can be negative when a reseller has credit (UNVERIFIED for this account: not observed).
 */
export function minorFromText(s: string | undefined): bigint {
  const m = /^(-?)(\d{1,12})(?:\.(\d{1,6}))?$/.exec((s ?? "").trim());
  if (!m) throw new Error("bad_amount");
  const frac = (m[3] ?? "").padEnd(2, "0");
  if (/[1-9]/.test(frac.slice(2))) throw new Error("bad_amount");
  const v = BigInt(m[2]!) * 100n + BigInt(frac.slice(0, 2));
  return m[1] === "-" ? -v : v;
}

/**
 * Openprovider dates are "YYYY-MM-DD HH:MM:SS" with no zone. Observed 2026-09-30 on an active .com: `creation_date`, `expiration_date`,
 * `registry_expiration_date` and `renewal_date` are UTC (they matched the host clock in UTC), while `order_date`, `active_date`, `last_changed`
 * and DNS zone dates are Europe/Amsterdam local time (two hours ahead in CEST). UNVERIFIED: on a pending (REQ) .ai order `creation_date` looked
 * like local time instead; the adapter never relies on `creation_date` of a pending order.
 */
export function parseUtc(s: string | undefined): Date | undefined {
  if (!s || s.startsWith("0000")) return undefined;
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)$/.exec(s.trim());
  if (!m) return undefined;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
  return Number.isNaN(d.getTime()) ? undefined : d;
}
/** Wall-clock time in Europe/Amsterdam to an instant (DST-aware via Intl, no dependency). */
export function parseAmsterdam(s: string | undefined): Date | undefined {
  const guess = parseUtc(s);
  if (!guess) return undefined;
  const offsetAt = (d: Date) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map((p) => [p.type, p.value]));
    return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!) - d.getTime();
  };
  const first = new Date(guess.getTime() - offsetAt(guess));
  return new Date(guess.getTime() - offsetAt(first));
}
