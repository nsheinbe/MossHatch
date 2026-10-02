import type { Brief } from "@mosshatch/core/brief";
import { api, ApiError } from "./api";

/** The launcher's client (docs/LAUNCHER.md). Same-origin JSON plus one streamed route; the server decides every price and permission. */

export interface Proposal {
  id: string; kind: "brief" | "revision"; brief?: Brief; instruction?: string; base_build_id?: string;
  state: "proposed" | "quoted" | "building" | "built" | "failed" | "refused" | "superseded"; build_id?: string; version?: number; refused_reason?: string;
}
export interface Step { id: string; label: string; state: "pending" | "active" | "done" | "failed" }
export interface Build {
  id: string; kind: "website" | "revision"; proposal_id: string; version: number | null;
  status: "quoted" | "expired" | "queued" | "building" | "ready" | "failed" | "refunded" | "canceled";
  steps: Step[]; title?: string | null; summary?: string | null; preview_url?: string | null; price_minor: number; currency: string;
  instruction?: string | null; base_build_id?: string | null; error_code?: string | null; brief: Brief;
}
export interface Line { who: "owner" | "creature"; text: string; at: string; proposal_id?: string; refusal?: true }
export interface Conversation {
  id: string; domain: string; source: "owned" | "practice"; species: string; species_name: string;
  transcript: Line[]; proposals: Proposal[]; builds: Build[]; started: boolean;
}
export type Status =
  | { access: false; reason: string }
  | { access: true; balance_minor: number; markup_bps: number; builds_today: number; daily_builds: number; preview_framing: boolean; preview_origin: string; fake: boolean };
export interface Quote { quote: { id: string; kind: string; price_minor: number; currency: string; expires_at: string }; balance_minor: number; enough: boolean }

export const launcherStatus = () => api<Status>("GET", "/api/v1/launcher/status");
export const openConversation = (domain: string, source: "owned" | "practice") =>
  api<{ conversation: Conversation }>("POST", "/api/v1/launcher/conversations", { domain, source }).then((r) => r.conversation);
export const getConversation = (id: string) => api<{ conversation: Conversation }>("GET", `/api/v1/launcher/conversations/${id}`).then((r) => r.conversation);
export const quote = (proposalId: string, baseBuildId?: string) => api<Quote>("POST", "/api/v1/launcher/quotes", { proposal_id: proposalId, ...(baseBuildId ? { base_build_id: baseBuildId } : {}) });
export const confirmBuild = (quoteId: string, key: string) =>
  api<{ build: Build; balance_minor: number }>("POST", "/api/v1/launcher/builds", { quote_id: quoteId, idempotency_key: key, confirm: true });
export const pollBuild = (id: string) => api<{ build: Build; balance_minor: number }>("GET", `/api/v1/launcher/builds/${id}`);
export const cancelBuild = (id: string) => api<{ build: Build; balance_minor: number }>("POST", `/api/v1/launcher/builds/${id}/cancel`, {});
export const exportUrl = (id: string) => `/api/v1/launcher/builds/${encodeURIComponent(id)}/export`;

/** A fresh idempotency key for one confirmation (a retry of the same press reuses it). */
export function newKey(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type TurnEvent =
  | { type: "text"; d: string }
  | { type: "brief"; proposal: Proposal }
  | { type: "revision"; proposal: Proposal }
  | { type: "refusal"; line: string }
  | { type: "error"; code: string }
  | { type: "done"; transcript: Line[] };

const EVENTS = new Set(["text", "brief", "revision", "refusal", "error", "done"]);

/** Parse Server-Sent Events from text chunks; returns the complete events and the unfinished tail. Unknown events are ignored. */
export function parseSse(buffer: string): { events: TurnEvent[]; rest: string } {
  const events: TurnEvent[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    let name = "message", data = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice(7).trim();
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!EVENTS.has(name)) continue;
    try { events.push({ type: name, ...JSON.parse(data) } as TurnEvent); } catch { /* a broken frame is skipped */ }
  }
  return { events, rest };
}

/**
 * One creature turn: POST the owner's words and read the streamed reply. `fetch` with a stream reader (not EventSource, which cannot
 * POST or send our CSRF header); same origin, so CSP connect-src 'self' covers it. Errors before the stream opens are ApiErrors.
 */
export async function talk(convId: string, text: string, on: (e: TurnEvent) => void, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/launcher/conversations/${encodeURIComponent(convId)}/turn`, {
      method: "POST", credentials: "same-origin", signal,
      headers: { "Content-Type": "application/json", "X-MH-Client": "web", Accept: "text/event-stream" },
      body: JSON.stringify({ text }),
    });
  } catch { throw new ApiError(0, "network"); }
  if (!res.ok || !res.body) {
    let code = "error";
    try { code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? code; } catch { /* not JSON */ }
    throw new ApiError(res.status, code);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const out = parseSse(buf + value);
    buf = out.rest;
    for (const e of out.events) on(e);
  }
}

/** Credits are US cents: "270 credits ($2.70)". */
export function credits(minor: number): string {
  return `${minor.toLocaleString("en-US")} credit${minor === 1 ? "" : "s"} ($${(minor / 100).toFixed(2)})`;
}

/** Plain words for the codes a person can hit here. Never echoes server text. */
export function explainLauncher(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Try again.";
  switch (e.code) {
    case "insufficient_credits": return "You don't have enough credits for this build. Nothing was charged.";
    case "daily_build_cap": return "That's the most builds for one day. Nothing was charged. Try again tomorrow.";
    case "launcher_spend_cap": case "launcher_busy": case "builder_busy": return "The builder is resting for today. Nothing was charged. Try again later.";
    case "daily_turn_cap": return "Your creature needs a rest. You can talk again tomorrow.";
    case "conversation_full": return "This conversation is full. Your versions are kept.";
    case "quote_expired": return "That price has expired. Ask for a new one; nothing was charged.";
    case "quote_used": case "proposal_not_open": return "That price was already used. Ask for a new one.";
    case "brief_refused": return "Mosshatch can't build this one: it looks like it imitates a brand or asks people for passwords or payment details.";
    case "already_dispatched": return "The builder has already started, so it can't be stopped now. If it fails, the credits come back.";
    case "turn_in_progress": return "Your creature is still answering in another tab.";
    case "builder_unavailable": case "builder_refused": return "The builder didn't answer. Nothing new was charged. Try again in a moment.";
    case "invite_required": case "launcher_disabled": case "launcher_not_configured": return "Talking to creatures isn't open for this account yet.";
    case "network": return "The connection failed. Check your network.";
    case "rate_limited": return "Too many tries. Wait a little, then try again.";
    default: return "That didn't work. Try again.";
  }
}

/** The in-character line for a model failure mid-turn (the code is ours; never the API's text). */
export function creatureTrouble(name: string, code: string): string {
  if (code === "model_rate_limited" || code === "model_overloaded") return `${name} is catching its breath. Say that again in a moment?`;
  if (code === "creature_cut_off" || code === "creature_confused") return `${name} lost its thread. Could you say that a little more simply?`;
  return `${name} can't hear you right now. Try again in a moment.`;
}
