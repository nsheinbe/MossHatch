/**
 * Site mode. `demo` (the public preview): no account, no purchase entry point, every price and availability labelled as simulated,
 * a permanent preview banner and a waitlist. `live`: only when the build says so and the API is connected. Nothing is removed in
 * demo mode; the live features switch on by configuration (VITE_API_ENABLED=1, and VITE_SITE_MODE not "demo").
 * The same rule runs at build time in scripts/site-mode.mjs (the static banner, titles and pages).
 */
export type SiteMode = "demo" | "live";
export const buildSiteMode: SiteMode = import.meta.env.VITE_SITE_MODE !== "demo" && import.meta.env.VITE_API_ENABLED === "1" ? "live" : "demo";

/** Demo when built as demo, or when a live build finds no API behind it (apiReady false: the practice place). */
export const isDemo = (apiReady: boolean | null): boolean => buildSiteMode === "demo" || apiReady === false;
