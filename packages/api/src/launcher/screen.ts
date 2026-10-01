import type { Brief } from "@mosshatch/core/brief";
import { BRANDS, skeleton } from "../publish/screen.ts";

/**
 * The brief screen before anything is built (docs/LAUNCHER.md "Threat model"). A floor, in-house and offline: a brief whose words
 * pair a well-known brand with a sign-in or payment lure, or that asks for credentials or card details, is refused before Slate is
 * asked for a quote. It is NOT the content screening a published site needs before strangers can launch (that must look at the
 * built pages, and is listed as required work); it only stops the most obvious phishing brief cheaply. Returns a reason code only.
 */

const LURE = /\b(log ?in|sign ?in|verify|verification|password|passcode|2fa|one[- ]time code|seed phrase|recovery phrase|wallet connect|card number|cvv|ssn|social security|bank details|account (?:suspended|locked)|unlock your account)\b/i;
const COLLECT = /\b(collect|capture|ask for|enter|submit|confirm|harvest)\b[^.]{0,60}\b(passwords?|credentials|card numbers?|cvv|seed phrases?|logins?|bank details)\b/i;

export type BriefScreen = { ok: true } | { ok: false; reason: "brand_impersonation" | "credential_collection" };

export function screenBrief(b: Brief): BriefScreen {
  const all = [b.name, b.oneLiner, b.audience, b.goal, b.tone, b.notes ?? "", ...(b.pages ?? []), ...(b.sections ?? [])].join(" \n ");
  if (COLLECT.test(all)) return { ok: false, reason: "credential_collection" };
  const words = all.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const skel = new Set(words.map(skeleton));
  // Our own names are refused outright in a brief (D-033); other brands only together with a lure.
  const brand = BRANDS.find((x) => skel.has(x) || words.some((w) => w.length > 4 && skeleton(w).includes(x) && x.length >= 5));
  if (brand && (brand === "mosshatch" || brand === "hatchkind" || LURE.test(all))) return { ok: false, reason: "brand_impersonation" };
  return { ok: true };
}
