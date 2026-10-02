import crypto from "node:crypto";
import { withNoUser, withUser, type PoolClient } from "@mosshatch/db";
import { deriveCreatureSpec, normalizeDomain, sanitizeSpec, defaultPalette, type CreatureSpec } from "@mosshatch/core";
import { briefFromToolInput, cleanText, revisionFromToolInput, type Brief } from "@mosshatch/core/brief";
import type Anthropic from "@anthropic-ai/sdk";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { hit } from "../ratelimit.ts";
import { appendAudit } from "../audit.ts";
import type { LauncherConfig } from "./config.ts";
import { priceWithMarkup } from "./config.ts";
import { CreatureError, echoable, type CreaturePort, type TurnResult } from "./claude.ts";
import { buildPersona, OPENING_TURN } from "./persona.ts";
import { SlateError, type SlateBuild, type SlatePort } from "./slate.ts";
import { balance, buildsOn, charge, lockAccount, lockGlobal, refund, settle, spendOn } from "./credits.ts";
import { screenBrief } from "./screen.ts";
import type { FakeSlate } from "./slate-fake.ts";

/**
 * The launcher service (docs/LAUNCHER.md): conversations with the creature, quotes, confirmed builds on Slate, the credits they cost
 * and the refunds when Slate fails. Every route runs `requireLauncher` first (flag, configuration, invite); every money move happens
 * inside one transaction with the account's advisory lock.
 */

export interface LauncherServices {
  config: LauncherConfig;
  creature: CreaturePort;
  slate: SlatePort;
  /** Present with MH_FAKE_LAUNCHER=1: the dev server serves its preview pages. */
  fakeSlate?: FakeSlate;
  /** The origin preview pages come from (Slate's, or the dev server's for the fake), and the path they all start with. */
  previewOrigin: string;
  previewPath: string;
  /** Whether the deployed CSP lets the page frame that origin (vercel.json `frame-src`); otherwise the page links out. */
  previewFraming: boolean;
}

export const launcherOf = (ctx: AppContext) => (ctx.services as { launcher?: LauncherServices }).launcher;

export const MAX_OWNER_TEXT = 1000;
/** Tool calls answered with an error and retried inside one owner turn, at most. */
const MAX_INNER_ROUNDS = 3;
const LEASE_MS = 120_000;
const DAY = 86_400;

// ---- gating -------------------------------------------------------------------------------------------------------------------

export type Access = { ok: true; svc: LauncherServices } | { ok: false; code: "launcher_not_configured" | "launcher_disabled" | "invite_required" | "unauthorized" };

/** The flag, the configuration, then the invite: everyone else gets the teaser and never reaches the model. */
export async function launcherAccess(ctx: AppContext, userId: string | undefined): Promise<Access> {
  const svc = launcherOf(ctx);
  if (!svc) return { ok: false, code: "launcher_not_configured" };
  let on = false;
  try { on = (await ctx.cron.query("select value from flags where name = 'launcher_enabled'")).rows[0]?.value === true; } catch { on = false; }
  if (!on) return { ok: false, code: "launcher_disabled" };
  if (!userId) return { ok: false, code: "unauthorized" };
  if (svc.config.inviteOnly) {
    let invited = false;
    try { invited = (await withNoUser(ctx.runtime, (c) => c.query("select user_live_access($1) as ok", [userId]))).rows[0]?.ok === true; } catch { invited = false; }
    if (!invited) return { ok: false, code: "invite_required" };
  }
  return { ok: true, svc };
}

export async function requireLauncher(ctx: AppContext, userId: string | undefined): Promise<LauncherServices> {
  const a = await launcherAccess(ctx, userId);
  if (a.ok) return a.svc;
  throw new HttpError(a.code === "unauthorized" ? 401 : a.code === "launcher_not_configured" ? 503 : 403, a.code);
}

// ---- conversations ------------------------------------------------------------------------------------------------------------

export interface Proposal {
  id: string;
  kind: "brief" | "revision";
  tool_use_id: string;
  brief?: Brief;
  instruction?: string;
  base_build_id?: string;
  state: "proposed" | "quoted" | "building" | "built" | "failed" | "refused" | "superseded";
  build_id?: string;
  version?: number;
  refused_reason?: string;
  created_at: string;
}
export interface TranscriptEntry { who: "owner" | "creature"; text: string; at: string; proposal_id?: string; refusal?: true }
interface Pending { tool_use_id: string; proposal_id?: string }

interface ConvRow {
  id: string; user_id: string; domain: string; source: "owned" | "practice"; spec: CreatureSpec; persona: string; model: string;
  api_messages: Anthropic.Beta.BetaMessageParam[]; transcript: TranscriptEntry[]; pending: Pending[]; proposals: Proposal[]; owner_turns: number;
  usage: Record<string, number>;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export async function openConversation(ctx: AppContext, svc: LauncherServices, userId: string, input: { domain: unknown; source: unknown }) {
  const domain = typeof input.domain === "string" ? normalizeDomain(input.domain) : "";
  if (!DOMAIN_RE.test(domain) || domain.length > 253) throw new HttpError(400, "invalid_domain");
  const source = input.source === "owned" ? "owned" : input.source === "practice" ? "practice" : null;
  if (!source) throw new HttpError(400, "invalid_source");
  return withUser(ctx.runtime, userId, async (c) => {
    const own = !!(await c.query("select 1 from domains where user_id = $1 and fqdn_ascii = $2 and released_at is null", [userId, domain])).rowCount;
    if (source === "owned" && !own) throw new HttpError(404, "domain_not_found");
    const existing = (await c.query("select * from launcher_conversations where user_id = $1 and domain = $2 and archived_at is null", [userId, domain])).rows[0] as ConvRow | undefined;
    if (existing) return view(c, existing);
    // The creature is the name's own (the same spec the grove and the card draw); never one the page sends.
    const spec = sanitizeSpec(deriveCreatureSpec(domain));
    const persona = buildPersona(spec, domain);
    const row = (await c.query(
      "insert into launcher_conversations (user_id, domain, source, spec, persona, model) values ($1,$2,$3,$4,$5,$6) returning *",
      [userId, domain, own ? "owned" : "practice", spec, persona, svc.config.model])).rows[0] as ConvRow;
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "launcher.conversation.open", resourceKind: "launcher_conversation", resourceId: row.id, detail: { source } });
    return view(c, row);
  });
}

export async function getConversation(ctx: AppContext, userId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "not_found");
  return withUser(ctx.runtime, userId, async (c) => {
    const row = (await c.query("select * from launcher_conversations where id = $1 and user_id = $2", [id, userId])).rows[0] as ConvRow | undefined;
    if (!row) throw new HttpError(404, "not_found");
    return view(c, row);
  });
}

/** What the page sees: the transcript (captions), the proposals, the builds. Never the model history, the persona or usage. */
async function view(c: PoolClient, row: ConvRow) {
  const builds = (await c.query("select * from launcher_builds where conversation_id = $1 order by created_at", [row.id])).rows.map(buildView);
  return {
    id: row.id, domain: row.domain, source: row.source, species: row.spec.species, species_name: row.spec.speciesName,
    transcript: row.transcript, proposals: row.proposals.map(proposalView), builds, started: row.api_messages.length > 0,
  };
}
const proposalView = (p: Proposal) => ({ id: p.id, kind: p.kind, brief: p.brief, instruction: p.instruction, base_build_id: p.base_build_id, state: p.state, build_id: p.build_id, version: p.version, refused_reason: p.refused_reason });

// ---- one owner turn, streamed -------------------------------------------------------------------------------------------------

export type TurnEvent =
  | { type: "text"; d: string }
  | { type: "brief"; proposal: ReturnType<typeof proposalView> }
  | { type: "revision"; proposal: ReturnType<typeof proposalView> }
  | { type: "refusal"; line: string }
  | { type: "error"; code: string }
  | { type: "done"; transcript: TranscriptEntry[] };

/** Owner text: control characters removed and our operator-note marker defused (only Mosshatch writes "[Mosshatch:"). */
export function ownerText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return cleanText(raw).replace(/\[\s*mosshatch\s*:/gi, "(Mosshatch:").slice(0, MAX_OWNER_TEXT);
}

/** Validate and reserve a turn. Throws before any stream opens; returns the work to run inside the stream. */
export async function beginTurn(ctx: AppContext, svc: LauncherServices, userId: string, convId: string, rawText: unknown) {
  if (!/^[0-9a-f-]{36}$/i.test(convId)) throw new HttpError(404, "not_found");
  if (typeof rawText === "string" && rawText.length > MAX_OWNER_TEXT * 4) throw new HttpError(413, "too_long");
  const text = ownerText(rawText);
  const now = ctx.clock.now();
  const row = await withUser(ctx.runtime, userId, async (c) => {
    const r = (await c.query("select * from launcher_conversations where id = $1 and user_id = $2 and archived_at is null", [convId, userId])).rows[0] as ConvRow | undefined;
    if (!r) throw new HttpError(404, "not_found");
    if (!text && r.api_messages.length > 0) throw new HttpError(400, "empty_message");
    if (text && r.api_messages.length === 0) throw new HttpError(409, "not_started");
    if (r.owner_turns >= svc.config.turnsPerConversation) throw new HttpError(429, "conversation_full");
    // The model bill's fuses: per account and for everyone, per UTC day. The greeting counts too.
    const mine = await hit(ctx, c, `launcher.turn:${userId}`, { bucket: "launcher.turn.user", max: svc.config.dailyTurnsPerUser, windowSeconds: DAY });
    if (!mine.allowed) throw new HttpError(429, "daily_turn_cap", undefined, { "Retry-After": String(mine.retryAfterSeconds) });
    const all = await hit(ctx, c, "launcher.turn:global", { bucket: "launcher.turn.global", max: svc.config.dailyTurnsGlobal, windowSeconds: DAY });
    if (!all.allowed) throw new HttpError(503, "launcher_busy", undefined, { "Retry-After": String(all.retryAfterSeconds) });
    // One turn at a time per conversation: the history is append-only, so two tabs must not interleave.
    const leased = (await c.query("update launcher_conversations set turn_lease_until = $2 where id = $1 and (turn_lease_until is null or turn_lease_until < $3) returning id",
      [convId, new Date(now.getTime() + LEASE_MS), now])).rowCount;
    if (!leased) throw new HttpError(409, "turn_in_progress");
    return r;
  });
  return { row, text };
}

/** The tool results owed to the model for its last tool calls, from server state only (never the owner's words). */
function pendingResults(row: ConvRow, builds: Map<string, { status: string; version: number | null }>): Anthropic.Beta.BetaToolResultBlockParam[] {
  return row.pending.map((p) => {
    const prop = row.proposals.find((x) => x.id === p.proposal_id);
    const b = prop?.build_id ? builds.get(prop.build_id) : undefined;
    let note = "The owner has not acted on this yet.";
    if (!prop) note = "This could not be shown to the owner.";
    else if (prop.state === "refused") note = "Mosshatch could not accept this: it looked like it imitates a brand or collects credentials. Do not propose it again; offer to help with something honest.";
    else if (b?.status === "ready") note = `The owner approved it, and it was built as version ${b.version}.`;
    else if (b && (b.status === "queued" || b.status === "building")) note = "The owner approved it, and it is being built now.";
    else if (b && (b.status === "failed" || b.status === "refunded")) note = "The owner approved it, but the build failed and they were refunded. They may ask to try again.";
    else if (prop.state === "quoted") note = "The owner saw the price but has not confirmed it.";
    if (row.pending.length && prop?.state === "proposed") note += " Their reply follows; if they asked for changes, propose again with the changes.";
    return { type: "tool_result", tool_use_id: p.tool_use_id, content: note };
  });
}

/**
 * Run the turn: the model streams, tool calls become proposals (or error results the model retries, at most twice), and the history,
 * transcript and pending list are saved in one write at the end. A refusal, an API failure or a cut-off tool call saves nothing to
 * the history (so the next turn's prefix is unchanged), and only the transcript shows what happened.
 */
export async function runTurn(ctx: AppContext, svc: LauncherServices, userId: string, row: ConvRow, text: string, emit: (e: TurnEvent) => void): Promise<void> {
  const nowIso = () => ctx.clock.now().toISOString();
  const transcript: TranscriptEntry[] = [];
  if (text) transcript.push({ who: "owner", text, at: nowIso() });
  try {
    const builds = await withUser(ctx.runtime, userId, async (c) => new Map((await c.query("select id, status, version from launcher_builds where conversation_id = $1", [row.id])).rows.map((b) => [b.id as string, { status: b.status as string, version: b.version as number | null }])));
    const first: Anthropic.Beta.BetaContentBlockParam[] = [...pendingResults(row, builds), { type: "text", text: text || OPENING_TURN }];
    const added: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: first }];
    const proposals: Proposal[] = [];
    const pending: Pending[] = [];
    let said = "";
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let refused = false, failed: string | null = null;
    for (let round = 0; round < MAX_INNER_ROUNDS; round++) {
      let r: TurnResult;
      try {
        r = await svc.creature.turn({ model: row.model, persona: row.persona, messages: [...row.api_messages, ...added] }, (d) => { said += d; emit({ type: "text", d }); });
      } catch (e) { failed = e instanceof CreatureError ? e.code : "model_unavailable"; break; }
      usage.input += r.usage.input; usage.output += r.usage.output; usage.cacheRead += r.usage.cacheRead; usage.cacheWrite += r.usage.cacheWrite;
      if (r.stopReason === "refusal") { refused = true; break; }
      const uses = r.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (r.stopReason === "max_tokens" && uses.length) { failed = "creature_cut_off"; break; }
      added.push({ role: "assistant", content: echoable(r.content) });
      if (!uses.length) break;
      // Answer every tool call: a valid one becomes a proposal the owner acts on (its result is owed at their next turn); an invalid
      // one is answered now with what to fix, and the model gets another round.
      const errors: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        const out = handleTool(row, u, [...row.proposals, ...proposals], builds, nowIso());
        if (out.ok) { proposals.push(out.proposal); pending.push({ tool_use_id: u.id, proposal_id: out.proposal.id }); emit({ type: out.proposal.kind === "brief" ? "brief" : "revision", proposal: proposalView(out.proposal) }); }
        else errors.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: out.error });
      }
      if (!errors.length) break;
      // One tool call per reply (disable_parallel_tool_use), so a failed call is never mixed with a good one: answer it and retry.
      added.push({ role: "user", content: errors });
      if (round === MAX_INNER_ROUNDS - 1) failed = "creature_confused";
    }

    if (refused) {
      // The refused turn is never saved to the history (the next prefix stays byte-identical); the transcript shows a kind line.
      const line = refusalLine(row.spec);
      transcript.push({ who: "creature", text: line, at: nowIso(), refusal: true });
      emit({ type: "refusal", line });
      await save(ctx, userId, row, { transcript, usage });
    } else if (failed && added.length === 1) {
      await save(ctx, userId, row, { transcript, usage });
      emit({ type: "error", code: failed });
    } else {
      // A turn whose last message is the model's tool call with an error result still owed would leave the history invalid; the
      // inner loop only exits with errors answered, so the history always ends with an assistant turn or answered tool results.
      const visible = said.trim();
      if (visible || proposals.length) transcript.push({ who: "creature", text: visible, at: nowIso(), ...(proposals[0] ? { proposal_id: proposals[0].id } : {}) });
      await save(ctx, userId, row, { transcript, usage, added, proposals, pending, ownerTurn: !!text });
      if (failed) emit({ type: "error", code: failed });
    }
    emit({ type: "done", transcript: [...row.transcript, ...transcript] });
  } finally {
    await withUser(ctx.runtime, userId, (c) => c.query("update launcher_conversations set turn_lease_until = null where id = $1", [row.id])).catch(() => undefined);
  }
}

function handleTool(row: ConvRow, u: Anthropic.Beta.BetaToolUseBlock, all: Proposal[], builds: Map<string, { status: string; version: number | null }>, at: string):
  { ok: true; proposal: Proposal } | { ok: false; error: string } {
  if (u.name === "propose_brief") {
    const r = briefFromToolInput(u.input, { domain: row.domain, creature: { species: row.spec.species, speciesName: row.spec.speciesName }, palette: defaultPalette(row.spec) });
    if (!r.ok) return { ok: false, error: `The brief was not shown. Fix and call propose_brief again: ${r.problems.join("; ")}.` };
    return { ok: true, proposal: { id: crypto.randomUUID(), kind: "brief", tool_use_id: u.id, brief: r.brief, state: "proposed", created_at: at } };
  }
  if (u.name === "revise_site") {
    const r = revisionFromToolInput(u.input);
    if (!r.ok) return { ok: false, error: `Not shown. ${r.problems.join("; ")}.` };
    const built = all.filter((p) => p.build_id && builds.get(p.build_id)?.status === "ready");
    const base = built[built.length - 1];
    if (!base) return { ok: false, error: "No version has been built yet. Propose a brief first, and wait for the owner to build it." };
    return { ok: true, proposal: { id: crypto.randomUUID(), kind: "revision", tool_use_id: u.id, instruction: r.instruction, base_build_id: base.build_id, brief: base.brief, state: "proposed", created_at: at } };
  }
  return { ok: false, error: "Unknown tool." };
}

async function save(ctx: AppContext, userId: string, row: ConvRow, p: { transcript: TranscriptEntry[]; usage: Record<string, number>; added?: Anthropic.Beta.BetaMessageParam[]; proposals?: Proposal[]; pending?: Pending[]; ownerTurn?: boolean }) {
  await withUser(ctx.runtime, userId, async (c) => {
    const cur = (await c.query("select usage from launcher_conversations where id = $1 for update", [row.id])).rows[0];
    const u = { ...(cur?.usage ?? {}) } as Record<string, number>;
    for (const [k, v] of Object.entries(p.usage)) u[k] = (u[k] ?? 0) + v;
    if (p.added) {
      // Appended in SQL (jsonb ||), never rewritten: earlier bytes of the history are left as they were.
      await c.query(
        `update launcher_conversations set api_messages = api_messages || $2::jsonb, transcript = transcript || $3::jsonb, proposals = proposals || $4::jsonb,
           pending = $5::jsonb, owner_turns = owner_turns + $6, usage = $7::jsonb, updated_at = $8 where id = $1`,
        [row.id, JSON.stringify(p.added), JSON.stringify(p.transcript), JSON.stringify(p.proposals ?? []), JSON.stringify(p.pending ?? []), p.ownerTurn ? 1 : 0, u, ctx.clock.now()]);
    } else {
      await c.query("update launcher_conversations set transcript = transcript || $2::jsonb, usage = $3::jsonb, updated_at = $4 where id = $1", [row.id, JSON.stringify(p.transcript), u, ctx.clock.now()]);
    }
  });
}

const REFUSALS = [
  "tucks its head down and goes quiet. \"That isn't a nest I can help build. Tell me about something honest you'd like to make?\"",
  "dims for a moment. \"I can't help make that one. Is there something else this name could be?\"",
];
/** The in-character refusal (fixed text: the model's partial words are not shown). */
export function refusalLine(spec: CreatureSpec): string {
  return `${spec.speciesName} ${REFUSALS[spec.seed % REFUSALS.length]}`;
}

// ---- quotes, builds, credits --------------------------------------------------------------------------------------------------

const QUOTE_TTL_MS = 15 * 60_000;

/** Ask Slate for a price for a proposal and record it as a `quoted` build. Nothing is charged here. */
export async function quoteProposal(ctx: AppContext, svc: LauncherServices, userId: string, input: { proposal_id: unknown; base_build_id?: unknown }) {
  const pid = typeof input.proposal_id === "string" ? input.proposal_id : "";
  const conv = await withUser(ctx.runtime, userId, async (c) => (await c.query("select * from launcher_conversations where user_id = $1 and archived_at is null and proposals @> $2::jsonb", [userId, JSON.stringify([{ id: pid }])])).rows[0] as ConvRow | undefined);
  const prop = conv?.proposals.find((p) => p.id === pid);
  if (!conv || !prop || !prop.brief) throw new HttpError(404, "not_found");
  // A failed build may be tried again from the same proposal (a new quote, a new confirmation).
  if (prop.state !== "proposed" && prop.state !== "quoted" && prop.state !== "failed") throw new HttpError(409, "proposal_not_open");
  // Undo: a revision may start from any earlier ready version of this conversation.
  let baseId = prop.base_build_id;
  if (prop.kind === "revision" && typeof input.base_build_id === "string" && input.base_build_id !== baseId) baseId = input.base_build_id;
  let base: { id: string; slate_build_id: string; brief: Brief } | undefined;
  if (prop.kind === "revision") {
    base = await withUser(ctx.runtime, userId, async (c) => (await c.query("select id, slate_build_id, brief from launcher_builds where id = $1 and conversation_id = $2 and status = 'ready'", [baseId, conv.id])).rows[0]);
    if (!base) throw new HttpError(409, "no_base_version");
  }
  const brief = base?.brief ?? prop.brief;
  const screen = screenBrief(brief);
  if (!screen.ok) {
    await setProposal(ctx, userId, conv.id, pid, { state: "refused", refused_reason: screen.reason });
    throw new HttpError(422, "brief_refused", undefined, undefined, { reason: screen.reason });
  }
  let q;
  try {
    q = await svc.slate.quote(userId, { kind: "website", brief, ...(base ? { base_build_id: base.slate_build_id, instruction: prop.instruction } : {}) });
  } catch (e) { throw slateHttp(e); }
  if (q.currency !== "usd") throw new HttpError(502, "slate_currency_unsupported");
  const now = ctx.clock.now();
  const expires = new Date(Math.min(new Date(q.expires_at).getTime(), now.getTime() + QUOTE_TTL_MS));
  if (expires <= now) throw new HttpError(502, "slate_quote_expired");
  const price = priceWithMarkup(q.price_minor, svc.config.markupBps);
  return withUser(ctx.runtime, userId, async (c) => {
    // A newer quote for the same proposal replaces an unconfirmed older one.
    await c.query("update launcher_builds set status = 'expired', updated_at = $3 where proposal_id = $1 and user_id = $2 and status = 'quoted'", [pid, userId, now]);
    const b = (await c.query(
      `insert into launcher_builds (user_id, conversation_id, proposal_id, kind, brief, instruction, base_build_id, slate_quote_id, slate_model, slate_price_minor, price_minor, currency, quote_expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'usd',$12) returning *`,
      [userId, conv.id, pid, prop.kind === "brief" ? "website" : "revision", brief, prop.instruction ?? null, base?.id ?? null, q.quote_id, q.model, q.price_minor, price, expires])).rows[0];
    await setProposalIn(c, conv.id, pid, { state: "quoted", build_id: b.id, ...(base ? { base_build_id: base.id } : {}) });
    const bal = await balance(c, userId);
    return { quote: { id: b.id, kind: b.kind, price_minor: price, currency: "usd", expires_at: expires.toISOString() }, balance_minor: bal, enough: bal >= price };
  });
}

/** The owner pressed "Build for N credits": caps, balance, the charge, then Slate. Idempotent on the page's key. */
export async function confirmBuild(ctx: AppContext, svc: LauncherServices, userId: string, input: { quote_id: unknown; idempotency_key: unknown; confirm: unknown }) {
  if (input.confirm !== true) throw new HttpError(400, "confirmation_required");
  const qid = typeof input.quote_id === "string" && /^[0-9a-f-]{36}$/i.test(input.quote_id) ? input.quote_id : null;
  const key = typeof input.idempotency_key === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(input.idempotency_key) ? input.idempotency_key : null;
  if (!qid || !key) throw new HttpError(400, "invalid_request");
  const now = ctx.clock.now();
  const res = await withUser(ctx.runtime, userId, async (c) => {
    await lockAccount(c, userId);
    await lockGlobal(c);
    const b = (await c.query("select * from launcher_builds where id = $1 and user_id = $2 for update", [qid, userId])).rows[0];
    if (!b) throw new HttpError(404, "not_found");
    if (b.status !== "quoted") {
      if (b.idempotency_key === key) return { again: true, b };
      throw new HttpError(409, "quote_used");
    }
    if (new Date(b.quote_expires_at) <= now) {
      await c.query("update launcher_builds set status = 'expired', updated_at = $2 where id = $1", [qid, now]);
      throw new HttpError(410, "quote_expired");
    }
    if ((await buildsOn(c, userId, now)) >= svc.config.dailyBuildsPerUser) throw new HttpError(429, "daily_build_cap");
    const price = Number(b.price_minor);
    if ((await spendOn(c, now)) + price > svc.config.dailySpendMinor) throw new HttpError(503, "launcher_spend_cap");
    if ((await balance(c, userId)) < price) throw new HttpError(402, "insufficient_credits");
    await c.query("update launcher_builds set status = 'queued', confirmed_at = $2, idempotency_key = $3, charged_minor = $4, updated_at = $2 where id = $1", [qid, now, key, price]);
    if (price > 0) await charge(c, userId, qid, price);
    await setProposalIn(c, b.conversation_id, b.proposal_id, { state: "building" });
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "launcher.build.confirm", resourceKind: "launcher_build", resourceId: qid, detail: { price_minor: price, kind: b.kind } });
    return { again: false, b: { ...b, status: "queued", idempotency_key: key } };
  });
  if (!res.again) await submitToSlate(ctx, svc, userId, res.b);
  return refreshBuild(ctx, svc, userId, qid, { poll: false });
}

/** Send a confirmed build to Slate. A refusal Slate certainly did not act on is refunded at once; anything unclear is retried by polls. */
async function submitToSlate(ctx: AppContext, svc: LauncherServices, userId: string, b: { id: string; slate_quote_id: string; idempotency_key: string }) {
  try {
    const r = await svc.slate.createBuild(userId, { quote_id: b.slate_quote_id, idempotency_key: b.idempotency_key });
    await withUser(ctx.runtime, userId, (c) => c.query("update launcher_builds set slate_build_id = $2, status = $3, error_code = null, updated_at = $4 where id = $1", [b.id, r.build_id, r.status === "building" ? "building" : "queued", ctx.clock.now()]));
  } catch (e) {
    const code = e instanceof SlateError ? e.code : "slate_unreachable";
    if (e instanceof SlateError && e.definite) await failBuild(ctx, userId, b.id, code);
    else await withUser(ctx.runtime, userId, (c) => c.query("update launcher_builds set error_code = $2, updated_at = $3 where id = $1", [b.id, code, ctx.clock.now()]));
  }
}

async function failBuild(ctx: AppContext, userId: string, id: string, code: string, status: "failed" | "refunded" | "canceled" = "failed") {
  await withUser(ctx.runtime, userId, async (c) => {
    await lockAccount(c, userId);
    const b = (await c.query("select * from launcher_builds where id = $1 and user_id = $2 for update", [id, userId])).rows[0];
    if (!b || ["failed", "refunded", "canceled", "ready"].includes(b.status)) return;
    const back = await refund(c, userId, id, code);
    await c.query("update launcher_builds set status = $2, error_code = $3, finished_at = $4, updated_at = $4 where id = $1", [id, status, code, ctx.clock.now()]);
    await setProposalIn(c, b.conversation_id, b.proposal_id, { state: "failed" });
    await appendAudit(ctx, c, { chainId: userId, actorKind: "system", action: "launcher.build.refund", resourceKind: "launcher_build", resourceId: id, detail: { refunded_minor: back, code } });
  });
}

/** Read a build, asking Slate for news while it is in flight. Ready builds get the next version number. */
export async function refreshBuild(ctx: AppContext, svc: LauncherServices, userId: string, id: string, opts: { poll: boolean } = { poll: true }) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "not_found");
  const load = () => withUser(ctx.runtime, userId, async (c) => (await c.query("select * from launcher_builds where id = $1 and user_id = $2", [id, userId])).rows[0]);
  let b = await load();
  if (!b) throw new HttpError(404, "not_found");
  // Slate's preview URLs are signed for 10 minutes: a ready build re-reads its URL from Slate when the one we hold is 8 minutes old.
  const stale = b.status === "ready" && b.slate_build_id && (!b.preview_fetched_at || ctx.clock.now().getTime() - new Date(b.preview_fetched_at).getTime() > PREVIEW_REFRESH_MS);
  if (opts.poll && stale) {
    let s: SlateBuild | null = null;
    try { s = await svc.slate.getBuild(userId, b.slate_build_id); } catch { s = null; }
    if (s?.status === "ready" && s.preview_url && safePreview(s.preview_url, svc.previewOrigin, svc.previewPath)) {
      await withUser(ctx.runtime, userId, (c) => c.query("update launcher_builds set preview_url = $2, preview_fetched_at = $3 where id = $1", [id, s!.preview_url, ctx.clock.now()]));
      b = await load();
    }
  }
  if (opts.poll && (b.status === "queued" || b.status === "building")) {
    if (!b.slate_build_id) {
      // Slate's answer to the create was lost (timeout, 5xx): the same idempotency key makes a retry safe. Give up when the quote is long gone.
      if (new Date(b.quote_expires_at).getTime() + 30 * 60_000 < ctx.clock.now().getTime()) await failBuild(ctx, userId, id, "slate_unconfirmed");
      else await submitToSlate(ctx, svc, userId, b);
    } else {
      let s: SlateBuild | null = null;
      try { s = await svc.slate.getBuild(userId, b.slate_build_id); } catch { s = null; }
      if (s) await applySlate(ctx, svc, userId, b, s);
    }
    b = await load();
  }
  return { build: buildView(b), balance_minor: await withUser(ctx.runtime, userId, (c) => balance(c, userId)) };
}

const PREVIEW_REFRESH_MS = 8 * 60_000;

async function applySlate(ctx: AppContext, svc: LauncherServices, userId: string, b: { id: string; conversation_id: string; proposal_id: string; slate_price_minor: string | number; charged_minor: string | number | null }, s: SlateBuild) {
  const steps = s.steps.map((x) => ({ id: x.id.slice(0, 64), label: cleanText(x.label).slice(0, 120), state: x.state }));
  if (s.status === "failed" || s.status === "refunded") {
    await withUser(ctx.runtime, userId, (c) => c.query("update launcher_builds set steps = $2 where id = $1", [b.id, JSON.stringify(steps)]));
    await failBuild(ctx, userId, b.id, s.error ?? "build_failed", s.status);
    return;
  }
  const preview = s.preview_url && safePreview(s.preview_url, svc.previewOrigin, svc.previewPath) ? s.preview_url : null;
  await withUser(ctx.runtime, userId, async (c) => {
    if (s.status === "ready") {
      await lockAccount(c, userId);
      // Slate charges at most its quote: when it charged less, the owner gets the difference back (same markup), once.
      const charged = Number(b.charged_minor ?? 0);
      const final = Math.min(charged, priceWithMarkup(Math.min(s.charged_minor, Number(b.slate_price_minor)), svc.config.markupBps));
      const back = await settle(c, userId, b.id, charged, final);
      if (back) await c.query("update launcher_builds set charged_minor = $2 where id = $1", [b.id, charged - back]);
      await c.query("select 1 from launcher_conversations where id = $1 for update", [b.conversation_id]);
      const cur = (await c.query("select version from launcher_builds where id = $1", [b.id])).rows[0];
      const version = cur?.version ?? Number((await c.query("select coalesce(max(version), 0) + 1 as v from launcher_builds where conversation_id = $1", [b.conversation_id])).rows[0].v);
      await c.query(
        "update launcher_builds set status = 'ready', version = $2, steps = $3, title = $4, summary = $5, preview_url = $6, preview_fetched_at = $7, error_code = null, finished_at = coalesce(finished_at, $7), updated_at = $7 where id = $1 and status <> 'ready'",
        [b.id, version, JSON.stringify(steps), s.title ? cleanText(s.title).slice(0, 200) : null, s.summary ? cleanText(s.summary).slice(0, 1000) : null, preview, ctx.clock.now()]);
      await setProposalIn(c, b.conversation_id, b.proposal_id, { state: "built", version });
    } else {
      await c.query("update launcher_builds set status = $2, steps = $3, updated_at = $4 where id = $1", [b.id, s.status, JSON.stringify(steps), ctx.clock.now()]);
    }
  });
}

/** A preview is shown only from the configured origin over https (or the dev server's own fake), never any other URL Slate names. */
export function safePreview(url: string, origin: string, path = "/"): boolean {
  try { const u = new URL(url); return u.origin === origin && u.pathname.startsWith(path) && (u.protocol === "https:" || /^(localhost|127\.0\.0\.1)$/.test(u.hostname)) && !u.username && !u.password; }
  catch { return false; }
}

export async function cancelBuild(ctx: AppContext, svc: LauncherServices, userId: string, id: string) {
  const b = await withUser(ctx.runtime, userId, async (c) => (await c.query("select * from launcher_builds where id = $1 and user_id = $2", [id, userId])).rows[0]);
  if (!b) throw new HttpError(404, "not_found");
  if (b.status !== "queued" && b.status !== "building") throw new HttpError(409, "not_cancellable");
  if (!b.slate_build_id) { await failBuild(ctx, userId, id, "canceled", "canceled"); return refreshBuild(ctx, svc, userId, id, { poll: false }); }
  try {
    const r = await svc.slate.cancel(userId, b.slate_build_id);
    // Slate's answer decides: a refunded or failed build is refunded here too; a build Slate kept going stays as it is.
    if (r.status === "refunded" || r.status === "failed") await failBuild(ctx, userId, id, "canceled", "canceled");
  } catch (e) {
    // Slate cancels only before it dispatches the build; after that it runs to the end (and a failure is still refunded).
    if (e instanceof SlateError && e.status === 409) throw new HttpError(409, "already_dispatched");
    throw slateHttp(e);
  }
  return refreshBuild(ctx, svc, userId, id, { poll: false });
}

export async function exportBuild(ctx: AppContext, svc: LauncherServices, userId: string, id: string) {
  const b = await withUser(ctx.runtime, userId, async (c) => (await c.query("select * from launcher_builds where id = $1 and user_id = $2", [id, userId])).rows[0]);
  if (!b || b.status !== "ready" || !b.slate_build_id) throw new HttpError(404, "not_found");
  try { return await svc.slate.exportBuild(userId, b.slate_build_id); } catch (e) { throw slateHttp(e); }
}

export async function status(ctx: AppContext, userId: string | undefined) {
  const a = await launcherAccess(ctx, userId);
  if (!a.ok) return { access: false, reason: a.code };
  const bal = await withUser(ctx.runtime, userId!, (c) => balance(c, userId!));
  const used = await withUser(ctx.runtime, userId!, (c) => buildsOn(c, userId!, ctx.clock.now()));
  return {
    access: true, balance_minor: bal, markup_bps: a.svc.config.markupBps, builds_today: used, daily_builds: a.svc.config.dailyBuildsPerUser,
    preview_framing: a.svc.previewFraming, preview_origin: a.svc.previewOrigin, fake: a.svc.config.fake,
  };
}

function buildView(b: Record<string, unknown>) {
  return {
    id: b.id, kind: b.kind, proposal_id: b.proposal_id, version: b.version, status: b.status, steps: b.steps, title: b.title, summary: b.summary,
    preview_url: b.preview_url, price_minor: Number(b.price_minor), currency: b.currency, quote_expires_at: (b.quote_expires_at as Date | null)?.toISOString?.() ?? b.quote_expires_at,
    instruction: b.instruction, base_build_id: b.base_build_id, error_code: b.error_code, brief: b.brief,
  };
}

async function setProposal(ctx: AppContext, userId: string, convId: string, pid: string, patch: Partial<Proposal>) {
  await withUser(ctx.runtime, userId, (c) => setProposalIn(c, convId, pid, patch));
}
/** Proposals are display state (not the model history), so updating one in place is fine. */
async function setProposalIn(c: PoolClient, convId: string, pid: string, patch: Partial<Proposal>) {
  const r = (await c.query("select proposals from launcher_conversations where id = $1 for update", [convId])).rows[0];
  if (!r) return;
  const next = (r.proposals as Proposal[]).map((p) => (p.id === pid ? { ...p, ...patch } : p));
  await c.query("update launcher_conversations set proposals = $2::jsonb where id = $1", [convId, JSON.stringify(next)]);
}

function slateHttp(e: unknown): HttpError {
  if (e instanceof SlateError) {
    if (e.code === "partner_cap" || e.status === 429) return new HttpError(503, "builder_busy");
    if (e.code === "partner_unfunded") return new HttpError(503, "builder_unavailable");
    if (e.status === 0 || e.status >= 500) return new HttpError(502, "builder_unavailable");
    return new HttpError(502, "builder_refused", undefined, undefined, { reason: e.code });
  }
  return new HttpError(502, "builder_unavailable");
}
