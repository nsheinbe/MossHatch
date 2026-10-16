// In-memory first-touch labels. No cookies, localStorage, click IDs or full URLs.
const campaign: Record<string, string> = {};
if (typeof location !== "undefined") {
  const query = new URLSearchParams(location.search);
  for (const key of ["utm_source", "utm_medium", "utm_campaign"]) {
    const value = query.get(key);
    if (value && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)) campaign[key] = value.toLowerCase();
  }
}
/** Opening the waitlist form from anywhere (the banner, the hatch card, the sign-up screen). The form itself is a lazy chunk. */
export interface WaitlistOpen { name?: string; email?: string; source?: "app" | "fallback" | "signup" }
const EVT = "mh:waitlist";
export const openWaitlist = (o: WaitlistOpen = {}) => window.dispatchEvent(new CustomEvent<WaitlistOpen>(EVT, { detail: o }));
export const onOpenWaitlist = (fn: (o: WaitlistOpen) => void) => {
  const h = (e: Event) => fn((e as CustomEvent<WaitlistOpen>).detail ?? {});
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
};

/** POST /api/waitlist. The same answer whether or not the address is already on the list. */
export async function joinWaitlist(body: { email: string; name?: string; answer?: string; consent: boolean; website: string; source: string }): Promise<void> {
  let res: Response;
  try { res = await fetch("/api/waitlist", { method: "POST", credentials: "omit", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ ...body, attribution: campaign }) }); }
  catch { throw new Error("network"); }
  if (res.status === 202) return;
  let code = "error";
  try { code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? "error"; } catch { /* not JSON */ }
  throw new Error(code);
}

/**
 * The invite from /invite?t=… is kept in memory only (never stored: it is a secret) and the URL is cleaned at once.
 */
let invite: string | null = null;
export function takeInviteFromUrl(): boolean {
  if (location.pathname !== "/invite") return false;
  const t = new URLSearchParams(location.search).get("t") ?? "";
  history.replaceState(null, "", "/");
  if (/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(t)) { invite = t; return true; }
  return false;
}
export const currentInvite = () => invite;
