/**
 * Site mode. `demo` (the public preview): no account, no purchase entry point, every price and availability labelled as simulated,
 * a permanent preview banner and a waitlist. `live`: only when the build says so and the API is connected. Nothing is removed in
 * demo mode; the live features switch on by configuration (VITE_API_ENABLED=1, and VITE_SITE_MODE not "demo").
 * `invite` (VITE_SITE_MODE=invite with VITE_API_ENABLED=1; the invite-only dogfood, docs/GO-LIVE.md): ONE build serves both. The static
 * pages are the demo (banner, titles, practice hatch, public RDAP lookup, waitlist); at run time a signed-in account the server says may
 * buy (`/api/v1/session` live_access) gets the live shop and the banner is hidden for it. Everyone else keeps the demo.
 * The same rule runs at build time in scripts/site-mode.mjs (the static banner, titles and pages; `invite` renders as demo there).
 */
export type SiteMode = "demo" | "live" | "invite";
export const buildSiteMode: SiteMode = import.meta.env.VITE_API_ENABLED !== "1" || import.meta.env.VITE_SITE_MODE === "demo" ? "demo" : import.meta.env.VITE_SITE_MODE === "invite" ? "invite" : "live";

/**
 * Demo when built as demo, or when a live build finds no API behind it (apiReady false: the practice place). In an invite build,
 * `apiReady` is true only for a signed-in account with live access, so the demo is the default until the server says otherwise.
 */
export const isDemo = (apiReady: boolean | null): boolean => buildSiteMode === "demo" || apiReady === false || (buildSiteMode === "invite" && apiReady !== true);

/** In an invite build, whether this signed-in account gets the live shop (the server's word; anything else is the demo). */
export const liveFor = (account: { live_access?: boolean } | null): boolean => buildSiteMode !== "invite" || account?.live_access === true;

/** Invite builds show the static demo banner to visitors and hide it for an account with live access (the page's own markup, no reload). */
export function applySiteChrome(live: boolean): void {
  if (buildSiteMode !== "invite") return;
  const banner = document.getElementById("demo-banner");
  if (banner) banner.hidden = live;
  if (live) document.documentElement.removeAttribute("data-site");
  else document.documentElement.setAttribute("data-site", "demo");
}
