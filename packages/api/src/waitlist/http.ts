import crypto from "node:crypto";
import { connect } from "@mosshatch/db";
import type { EmailPort } from "../ports.ts";
import { ResendTransport } from "../mail/transport.ts";
import { MAX_BODY_BYTES, NET_LIMIT, TOKEN_LIMIT, WaitlistError, confirm, join, limitNetwork, tokenLive, unsubscribe, type Answer, type Source, type WaitlistDeps } from "./service.ts";
import { FROM_DEFAULT, homeLink, page, para, tokenForm } from "./text.ts";

/**
 * The waitlist endpoints, served by api/index.ts before (and independently of) the full API boot, so they work while the full API
 * refuses to start in production:
 *   POST /api/waitlist                 join (JSON from the app, or a plain form post from the no-JS page)
 *   GET  /api/waitlist/confirm?t=      a page with a Confirm button (a GET never changes anything: mail scanners follow links)
 *   POST /api/waitlist/confirm         confirm once; shows the place in line
 *   GET  /api/waitlist/unsubscribe?t=  a page with a Leave button
 *   POST /api/waitlist/unsubscribe     leave (also RFC 8058 one-click: the token in the query, `List-Unsubscribe=One-Click` in the body)
 * Needs DATABASE_URL; RESEND_API_KEY is optional (without it nothing is sent and nothing is logged).
 */
export const WAITLIST_PREFIX = "/api/waitlist";

/** A mail port that sends nothing and records nothing: the waitlist's transport when no Resend key is configured. */
export class NullEmail implements EmailPort {
  async send() { return { id: "none" }; }
}

export function depsFromEnv(env: Record<string, string | undefined>): WaitlistDeps | null {
  if (!env.DATABASE_URL) return null;
  const origin = (env.WAITLIST_ORIGIN ?? env.MH_ORIGIN ?? "https://mosshatch.com").replace(/\/$/, "");
  // The hash key: WAITLIST_SECRET when set, otherwise derived from the database URL (a secret this deployment already holds).
  const secret = crypto.createHash("sha256").update("mosshatch-waitlist\0" + (env.WAITLIST_SECRET ?? env.DATABASE_URL)).digest();
  const email: EmailPort = env.RESEND_API_KEY ? new ResendTransport({ apiKey: env.RESEND_API_KEY, from: env.WAITLIST_FROM ?? FROM_DEFAULT }) : new NullEmail();
  return { pool: connect(env.DATABASE_URL, { max: 3 }), clock: { now: () => new Date() }, email, secret, origin, warn: (l) => console.warn(l) };
}

let cached: { url: string; deps: WaitlistDeps | null } | undefined;

/** api/index.ts: answer /api/waitlist* here, or return null to let the full API (or its 503) answer. */
export async function handleWaitlist(request: Request, env: Record<string, string | undefined>): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== WAITLIST_PREFIX && !path.startsWith(WAITLIST_PREFIX + "/")) return null;
  if (!cached || cached.url !== env.DATABASE_URL) cached = { url: env.DATABASE_URL ?? "", deps: depsFromEnv(env) };
  if (!cached.deps) return jsonRes(503, { error: { code: "not_configured", reason: "database_not_configured" } });
  return waitlistFetch(cached.deps, request);
}

const BASE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };
const jsonRes = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, "content-type": "application/json", ...extra } });
const htmlRes = (status: number, html: string) => new Response(html, { status, headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8" } });
const seeOther = (location: string) => new Response(null, { status: 303, headers: { ...BASE_HEADERS, location } });

function network(r: Request): string {
  const ip = (r.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split(".").slice(0, 3).join(".") + ".0/24";
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + "::/48";
  return "unknown";
}

async function readBody(r: Request): Promise<string> {
  const declared = Number(r.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new WaitlistError(413, "too_large");
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY_BYTES) { await reader.cancel().catch(() => undefined); throw new WaitlistError(413, "too_large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Cross-site posts are refused (the form and the app post same-origin). A request without these headers (curl) is allowed. */
function sameSite(d: WaitlistDeps, r: Request): boolean {
  const site = r.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = r.headers.get("origin");
  return !origin || origin === d.origin || origin === new URL(r.url).origin;
}

const EMAIL = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,24})?$/;
const ANSWERS = new Set(["yes", "no", "maybe"]);
const SOURCES = new Set(["app", "fallback", "page", "signup"]);

interface Fields { email: string; name: string | null; answer: Answer | null; consent: boolean; honeypot: boolean; source: Source }

function fields(o: Record<string, unknown>, form: boolean): Fields {
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const email = str("email").trim();
  if (!email || email.length > 254 || !EMAIL.test(email)) throw new WaitlistError(400, "invalid_email");
  const rawName = str("name").trim().toLowerCase();
  if (rawName.length > 80 || (rawName && !NAME.test(rawName))) throw new WaitlistError(400, "invalid_name");
  const a = str("answer");
  if (a && !ANSWERS.has(a)) throw new WaitlistError(400, "invalid_answer");
  const consent = form ? o.consent === "yes" : o.consent === true;
  if (!consent) throw new WaitlistError(400, "consent_required");
  const s = str("source") || (form ? "page" : "app");
  return { email, name: rawName || null, answer: (a || null) as Answer | null, consent, honeypot: str("website") !== "", source: (SOURCES.has(s) ? s : "app") as Source };
}

const MESSAGES: Record<string, string> = {
  invalid_email: "That email address does not look right. Go back and check it.",
  invalid_name: "The name should be letters, numbers and hyphens, with an optional extension such as .com.",
  invalid_answer: "Choose yes, no or maybe, or leave the question blank.",
  consent_required: "Tick the box to agree to the emails. We cannot add you without it.",
  rate_limited: "Too many sign-ups from this network. Try again in an hour.",
  busy: "Lots of people are joining right now. Try again in a few minutes.",
  too_large: "That was too much text.",
  cross_site: "This form only works from mosshatch.com.",
  unsupported_media_type: "Send the form from the Mosshatch page.",
};

export async function waitlistFetch(d: WaitlistDeps, r: Request): Promise<Response> {
  const url = new URL(r.url);
  const path = url.pathname.replace(/\/$/, "");
  const form = (r.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded");
  try {
    if (path === WAITLIST_PREFIX) {
      if (r.method !== "POST") return jsonRes(405, { error: { code: "method_not_allowed" } }, { allow: "POST" });
      if (!sameSite(d, r)) throw new WaitlistError(403, "cross_site");
      await limitNetwork(d, network(r), NET_LIMIT);
      const ct = (r.headers.get("content-type") ?? "").toLowerCase();
      if (!form && !ct.startsWith("application/json")) throw new WaitlistError(415, "unsupported_media_type");
      const raw = await readBody(r);
      let obj: Record<string, unknown>;
      if (form) obj = Object.fromEntries(new URLSearchParams(raw));
      else { try { const v = JSON.parse(raw); obj = v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { throw new WaitlistError(400, "bad_json"); } }
      const f = fields(obj, form);
      // The honeypot (a field people never see) answers exactly like a real sign-up and stores nothing.
      if (!f.honeypot) await join(d, { email: f.email, name: f.name, answer: f.answer, source: f.source, network: network(r) });
      return form ? seeOther("/waitlist-sent") : jsonRes(202, { ok: true });
    }
    if (path === WAITLIST_PREFIX + "/confirm" || path === WAITLIST_PREFIX + "/unsubscribe") {
      const purpose = path.endsWith("/confirm") ? "confirm" : "unsubscribe";
      if (r.method === "GET") {
        const t = url.searchParams.get("t") ?? "";
        if (!(await tokenLive(d, t, purpose))) return htmlRes(404, deadLink(purpose));
        return htmlRes(200, purpose === "confirm"
          ? page("Confirm your place", tokenForm(path, t, "Confirm my place", "One more step: confirm that you want to be on the Mosshatch waitlist.") + para("Joining does not reserve or register a domain name."))
          : page("Leave the waitlist", tokenForm(path, t, "Leave the waitlist", "Press the button to stop all waitlist emails to this address.")));
      }
      if (r.method !== "POST") return jsonRes(405, { error: { code: "method_not_allowed" } }, { allow: "GET, POST" });
      if (!sameSite(d, r)) throw new WaitlistError(403, "cross_site");
      await limitNetwork(d, network(r), TOKEN_LIMIT);
      const raw = await readBody(r);
      const t = new URLSearchParams(raw).get("t") ?? url.searchParams.get("t") ?? "";
      if (purpose === "confirm") {
        const place = await confirm(d, t);
        if (place === null) return htmlRes(404, deadLink("confirm"));
        return htmlRes(200, page(`You're #${place} in line`, para("Your place on the Mosshatch waitlist is confirmed. We let people in a few at a time and will email you an invite when it is your turn.") + para("Joining does not reserve or register a domain name.") + homeLink));
      }
      if (!(await unsubscribe(d, t))) return htmlRes(404, deadLink("unsubscribe"));
      return htmlRes(200, page("You're off the list", para("We will not send waitlist emails to this address again. Any invite not yet used has been cancelled.") + homeLink));
    }
    return jsonRes(404, { error: { code: "not_found" } });
  } catch (e) {
    if (!(e instanceof WaitlistError)) { d.warn?.(`waitlist.error ${(e as Error).name}`); return jsonRes(500, { error: { code: "internal" } }); }
    const extra: Record<string, string> = e.retryAfter ? { "retry-after": String(e.retryAfter) } : {};
    if (form) {
      const res = htmlRes(e.status, page("That did not work", para(MESSAGES[e.code] ?? "Something was wrong with the form.") + `<p><a href="/waitlist">Back to the form</a></p>`));
      for (const [k, v] of Object.entries(extra)) res.headers.set(k, v);
      return res;
    }
    return jsonRes(e.status, { error: { code: e.code } }, extra);
  }
}

function deadLink(purpose: "confirm" | "unsubscribe"): string {
  return purpose === "confirm"
    ? page("This link has expired", para("Confirm links work once, for 7 days. Join again from the waitlist page and we will send a fresh one.") + `<p><a href="/waitlist">Join the waitlist</a></p>`)
    : page("This link does not work", para("Use the leave link from the most recent waitlist email, or write to support@mosshatch.com.") + homeLink);
}
