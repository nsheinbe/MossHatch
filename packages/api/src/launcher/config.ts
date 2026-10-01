import type { Mode } from "../ports.ts";
import { DEFAULT_MODEL } from "./claude.ts";

/**
 * The launcher's settings from the environment (docs/LAUNCHER.md "Environment"). Problems come back as reason codes, never values.
 * The launcher is optional: an incomplete configuration leaves it off (the routes answer `launcher_not_configured`) and never stops
 * the rest of the app from booting.
 */
export interface LauncherConfig {
  fake: boolean;
  model: string;
  /** Markup on Slate's price, in basis points: 15000 = 1.5x. */
  markupBps: number;
  /** Builds (and revisions) one account may confirm per UTC day. */
  dailyBuildsPerUser: number;
  /** Credits (US cents) all accounts together may be charged per UTC day. */
  dailySpendMinor: number;
  /** Creature turns one account may take per UTC day (bounds the model bill). */
  dailyTurnsPerUser: number;
  /** Creature turns all accounts together may take per UTC day. */
  dailyTurnsGlobal: number;
  /** Owner messages per conversation. */
  turnsPerConversation: number;
  fallbacks: boolean;
  inviteOnly: boolean;
  anthropicKey?: string;
  slate?: { baseUrl: string; partnerId: string; secret: string; userKey: string };
  /** The origin Slate's preview pages are served from; a preview URL on any other origin is never handed to the page. */
  previewOrigin?: string;
  /** The path every preview URL starts with (Slate: `<partner base>/preview/`). */
  previewPath?: string;
}

const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = v === undefined || v.trim() === "" ? d : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};

export function launcherConfigFromEnv(env: Record<string, string | undefined>, mode: Mode): { config: LauncherConfig | null; reasons: string[] } {
  const fake = env.MH_FAKE_LAUNCHER === "1";
  const reasons: string[] = [];
  if (fake && mode === "production") reasons.push("launcher_fake_in_production");
  const inviteOnly = env.MH_LAUNCHER_INVITE_ONLY === "1" ? true : env.MH_LAUNCHER_INVITE_ONLY === "0" ? false : mode === "production" || mode === "staging";
  const base: LauncherConfig = {
    fake,
    model: (env.MH_LAUNCHER_MODEL ?? "").trim() || DEFAULT_MODEL,
    markupBps: int(env.MH_LAUNCHER_MARKUP_BPS, 15_000, 10_000, 100_000),
    dailyBuildsPerUser: int(env.MH_LAUNCHER_DAILY_BUILDS, 5, 0, 1000),
    dailySpendMinor: int(env.MH_LAUNCHER_DAILY_SPEND_MINOR, 5_000, 0, 10_000_000),
    dailyTurnsPerUser: int(env.MH_LAUNCHER_DAILY_TURNS, 60, 0, 10_000),
    dailyTurnsGlobal: int(env.MH_LAUNCHER_DAILY_TURNS_GLOBAL, 600, 0, 1_000_000),
    turnsPerConversation: int(env.MH_LAUNCHER_CONVERSATION_TURNS, 40, 1, 500),
    fallbacks: env.MH_LAUNCHER_FALLBACKS !== "off",
    inviteOnly,
  };
  if (!/^[a-z0-9][a-z0-9.-]{2,63}$/.test(base.model)) reasons.push("launcher_model_invalid");
  if (fake) return reasons.length ? { config: null, reasons } : { config: base, reasons };

  const key = env.ANTHROPIC_API_KEY ?? "";
  if (!key) reasons.push("anthropic_api_key_missing");
  const url = env.SLATE_PARTNER_URL ?? "";
  let okUrl = false;
  try { const u = new URL(url); okUrl = u.protocol === "https:" && !u.username && !u.password; } catch { okUrl = false; }
  if (!okUrl) reasons.push("slate_partner_url_missing");
  if ((env.SLATE_PARTNER_ID ?? "") !== "mosshatch") reasons.push("slate_partner_id_missing");
  if ((env.SLATE_PARTNER_SECRET ?? "").length < 32) reasons.push("slate_partner_secret_missing");
  if ((env.SLATE_PARTNER_USER_KEY ?? "").length < 32) reasons.push("slate_partner_user_key_missing");
  if (env.SLATE_PARTNER_USER_KEY && env.SLATE_PARTNER_USER_KEY === env.SLATE_PARTNER_SECRET) reasons.push("slate_partner_user_key_reused");
  // Slate serves previews as signed URLs under its partner API (`<base>/preview/:partner/:build_id?exp&sig`), so the preview origin is
  // the partner URL's unless SLATE_PREVIEW_ORIGIN names another one.
  let previewOrigin: string | undefined;
  let previewPath: string | undefined;
  try {
    const raw = env.SLATE_PREVIEW_ORIGIN ?? "";
    const p = new URL(raw || url);
    if (p.protocol === "https:" && (raw ? p.pathname === "/" && !p.search : true)) { previewOrigin = p.origin; previewPath = raw ? "/" : `${new URL(url).pathname.replace(/\/+$/, "")}/preview/`; }
  } catch { /* missing */ }
  if (!previewOrigin) reasons.push("slate_preview_origin_missing");
  if (reasons.length) return { config: null, reasons };
  return {
    config: { ...base, anthropicKey: key, slate: { baseUrl: url, partnerId: "mosshatch", secret: env.SLATE_PARTNER_SECRET!, userKey: env.SLATE_PARTNER_USER_KEY! }, previewOrigin, previewPath },
    reasons,
  };
}

/** Credits for a Slate price: price x markup, rounded up to a whole cent (never below Slate's price). */
export function priceWithMarkup(slateMinor: number, markupBps: number): number {
  return Math.ceil((slateMinor * markupBps) / 10_000);
}
