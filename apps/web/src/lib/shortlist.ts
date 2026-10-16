/**
 * The shortlist (docs/AUDIT-2026-10-07.md D3): up to six names a person is weighing, so they can compare them and keep them through
 * sign-up, a reload or a trip to Stripe and back. Kept in this browser tab only (sessionStorage, gone when the tab closes); it is never
 * sent to us and never written to our database. Only the names are kept; prices and availability are checked again when shown.
 */
export const SHORTLIST_MAX = 6;
const KEY = "mh.shortlist";
const FQDN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,24}$/;

/** Names only, valid, unique, at most six, in the order they were added. */
export function cleanShortlist(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const f = x.trim().toLowerCase();
    if (FQDN.test(f) && !out.includes(f)) out.push(f);
    if (out.length >= SHORTLIST_MAX) break;
  }
  return out;
}

export function loadShortlist(storage: Pick<Storage, "getItem"> | null = safeSession()): string[] {
  try { return cleanShortlist(JSON.parse(storage?.getItem(KEY) ?? "[]")); } catch { return []; }
}

export function saveShortlist(list: string[], storage: Pick<Storage, "setItem" | "removeItem"> | null = safeSession()): void {
  try {
    const clean = cleanShortlist(list);
    if (clean.length) storage?.setItem(KEY, JSON.stringify(clean)); else storage?.removeItem(KEY);
  } catch { /* storage can be off (private mode): the list then lasts for this page only */ }
}

/** Add or remove one name. Adding to a full list returns it unchanged with `full: true`. */
export function toggleShortlist(list: string[], fqdn: string): { list: string[]; full: boolean } {
  const f = fqdn.trim().toLowerCase();
  if (list.includes(f)) return { list: list.filter((x) => x !== f), full: false };
  if (list.length >= SHORTLIST_MAX) return { list, full: true };
  return { list: cleanShortlist([...list, f]), full: false };
}

function safeSession(): Storage | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
}
