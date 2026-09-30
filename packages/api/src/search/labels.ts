/**
 * Name validation shared by search and pricing. ASCII labels only in the first release (PLAN.md 4.3b "Availability search at scale"):
 * letters, digits and hyphen, 1 to 63 characters, no leading or trailing hyphen. Internationalised names are refused outright,
 * including anything that already looks like punycode (`xn--`) and any label with hyphens in positions 3 and 4 (reserved by
 * IDNA), so a mixed-script or homograph name can never reach a cache key, a registrar call or a price.
 */
export const LAUNCH_TLDS = ["com", "dev", "app", "studio", "io", "ai"] as const;
export type LaunchTld = (typeof LAUNCH_TLDS)[number];

export type LabelResult = { ok: true; label: string } | { ok: false; code: "bad_name" };

export function normalizeLabel(input: string): LabelResult {
  const s = input.trim().toLowerCase();
  if (s.length < 1 || s.length > 63) return { ok: false, code: "bad_name" };
  if (!/^[a-z0-9-]+$/.test(s)) return { ok: false, code: "bad_name" }; // rejects non-ASCII, dots, spaces, punctuation
  if (s.startsWith("-") || s.endsWith("-")) return { ok: false, code: "bad_name" };
  if (s.length >= 4 && s[2] === "-" && s[3] === "-") return { ok: false, code: "bad_name" }; // xn-- and other reserved forms
  return { ok: true, label: s };
}

export function parseFqdn(input: string): { label: string; tld: string } | null {
  const s = input.trim().toLowerCase();
  const i = s.indexOf(".");
  if (i < 1 || s.indexOf(".", i + 1) !== -1) return null; // exactly label.tld
  const l = normalizeLabel(s.slice(0, i));
  const tld = s.slice(i + 1);
  if (!l.ok || !/^[a-z]{2,24}$/.test(tld)) return null;
  return { label: l.label, tld };
}

export type TldsResult = { ok: true; tlds: LaunchTld[] } | { ok: false; code: "bad_tlds" };
/** `tlds` is a comma-separated subset of the six launch extensions; anything longer than six entries or unknown is refused. */
export function parseTlds(raw: string | null): TldsResult {
  if (raw === null || raw === "") return { ok: true, tlds: [...LAUNCH_TLDS] };
  if (raw.length > 200) return { ok: false, code: "bad_tlds" };
  const parts = raw.split(",").map((p) => p.trim().toLowerCase().replace(/^\./, ""));
  if (parts.length > LAUNCH_TLDS.length) return { ok: false, code: "bad_tlds" };
  const out: LaunchTld[] = [];
  for (const p of parts) {
    if (!(LAUNCH_TLDS as readonly string[]).includes(p)) return { ok: false, code: "bad_tlds" };
    if (!out.includes(p as LaunchTld)) out.push(p as LaunchTld);
  }
  return { ok: true, tlds: out };
}
