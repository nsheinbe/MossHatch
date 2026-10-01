import { z } from "zod";
import { tx, withUser, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { appendAudit } from "../audit.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { hashOf } from "../util/bytes.ts";
import { buildQuote, loadPolicy, PricingError, type PricedQuote } from "../pricing/index.ts";
import { parseFqdn } from "../search/labels.ts";
import { checkNewAccountLimits, spendFuseOf } from "../compliance/velocity.ts";
import { allows, lintScopes, scopeString, storedScopes, type Scope } from "../bindings/scopes.ts";
import { canonical, parseForUser } from "../bindings/specs.ts";
import type { OrdersServices } from "../orders/types.ts";
import { agentState, assertAgentPurchasesOpen, displayName, iso, LIMITS, liveBinding, lockUser, notFound, REQUEST_TTL_MS, UUID, type Caller, DAY_MS, HOUR_MS } from "./common.ts";
import { requestNotice, type RequestFacts } from "./notices.ts";

/**
 * Agent requests (PLAN 4.5 "Agent purchases and the approval card", threat row 17). Agents have no capability that executes a
 * purchase: `*.propose` creates a pending request and holds a reservation against the binding's cap, and only a
 * passkey-approved human decision creates an order. A proposal is one transaction under a per-user advisory lock:
 * idempotent on (binding, request hash) while pending; `reserved + spent + quoted <= cap` or 403 `cap_exceeded`; 3 pending
 * per binding, 10 per user, 5 an hour per binding and 30 a day per user (C-24); expiry 72 hours, never after the binding.
 * Reservations are released by the database when a request leaves `pending` any way but approval, and consumed at capture.
 */

export type RequestKind = "register" | "renew" | "dns_change" | "scope";
export interface RequestRow {
  id: string; user_id: string; binding_id: string; kind: RequestKind; state: string; params: Record<string, any>; domain_id: string | null; fqdn_ascii: string | null;
  years: number | null; quoted_minor: string; reservation: string; price_hash: Buffer | null; ip_prefix: string | null; new_network: boolean; created_at: Date; expires_at: Date;
  decided_at: Date | null; decision_reason: string | null; order_id: string | null; request_hash: Buffer;
}

export interface Proposal { approval_id: string; status: "pending_human_approval"; created: boolean; expires_at: string }

// ---- pricing ---------------------------------------------------------------------------------------------------------------

export interface PricedRequest { fqdn: string; tld: string; years: number; quote: PricedQuote; renewal: PricedQuote | null; priceHash: Buffer }

/** The price fields an approval binds. A change to any of them between proposal and approval voids the request (ST-77). */
export const priceHashOf = (q: PricedQuote) => hashOf({ fqdn: q.fqdn, kind: q.kind, years: q.years, wholesale_price_id: q.wholesalePriceId, subtotal: q.subtotalMinor.toString(), tax_ceiling: q.taxCeilingMinor.toString(), total: q.totalMinor.toString(), currency: q.currency });

function pricingOf(ctx: AppContext): OrdersServices["pricing"] | null {
  return ((ctx.services as { orders?: OrdersServices }).orders?.pricing) ?? null;
}

function mapPricing(e: unknown): never {
  if (e instanceof PricingError) {
    if (e.code === "premium_refused" || e.code === "price_mismatch") throw new HttpError(422, "price_not_standard");
    if (e.code === "no_price") throw new HttpError(503, "no_price");
    throw new HttpError(422, e.code === "unsupported_tld" ? "unsupported_tld" : e.code === "invalid_term" ? "invalid_term" : "invalid_fqdn");
  }
  throw e;
}

/** A registration quote for the longer of the years asked and the extension's minimum term, with the registrar price guard when installed. */
export async function priceRegistration(ctx: AppContext, c: PoolClient, fqdn: string, yearsAsked: number | undefined): Promise<PricedRequest> {
  const parsed = parseFqdn(fqdn);
  if (!parsed) throw new HttpError(422, "invalid_fqdn");
  const name = `${parsed.label}.${parsed.tld}`;
  const policy = await loadPolicy(c, parsed.tld);
  if (!policy) throw new HttpError(422, "unsupported_tld");
  const years = Math.max(yearsAsked ?? policy.minTerm, policy.minTerm);
  if (years > policy.maxTerm) throw new HttpError(422, "invalid_term");
  const now = ctx.clock.now();
  let quote: PricedQuote, renewal: PricedQuote | null = null;
  try {
    const p = pricingOf(ctx);
    quote = p ? await p.quote(ctx, c, { fqdn: name, years }, now) : await buildQuote(c, { fqdn: name, years }, now);
  } catch (e) { mapPricing(e); }
  try { renewal = await buildQuote(c, { fqdn: name, kind: "renew" }, now); } catch { renewal = null; }
  return { fqdn: name, tld: parsed.tld, years, quote, renewal, priceHash: priceHashOf(quote) };
}

/** The renewal quote for an owned domain (the price table only; renewals run for the extension's renewal term). */
export async function priceRenewal(ctx: AppContext, c: PoolClient, fqdn: string, yearsAsked: number | undefined): Promise<PricedRequest> {
  const parsed = parseFqdn(fqdn);
  if (!parsed) throw new HttpError(422, "invalid_fqdn");
  let quote: PricedQuote;
  try { quote = await buildQuote(c, { fqdn: `${parsed.label}.${parsed.tld}`, kind: "renew" }, ctx.clock.now()); } catch (e) { mapPricing(e); }
  if (yearsAsked !== undefined && yearsAsked !== quote.years) throw new HttpError(422, "invalid_term");
  return { fqdn: quote.fqdn, tld: parsed.tld, years: quote.years, quote, renewal: quote, priceHash: priceHashOf(quote) };
}

// ---- creating a request ----------------------------------------------------------------------------------------------------

interface NewRequest { kind: RequestKind; requestHash: Buffer; params: Record<string, unknown>; domainId: string | null; fqdn: string | null; years: number | null; quotedMinor: bigint; priceHash: Buffer | null; facts: RequestFacts }

/** Record a refused proposal (audit row and an operator alert, committed) and throw the refusal after the commit. */
async function limited(ctx: AppContext, caller: Caller, reason: string, status = 429): Promise<never> {
  await withUser(ctx.runtime, caller.userId, async (c) => {
    await appendAudit(ctx, c, { chainId: caller.userId, actorKind: caller.kind, actorId: caller.bindingId, action: "agent.request.limited", resourceKind: "binding", resourceId: caller.bindingId, detail: { reason } });
    await raiseAlert(ctx, c, { severity: "info", kind: "agent.velocity", subject: caller.bindingId, detail: { reason } });
  });
  throw new HttpError(status, reason, undefined, status === 429 ? { "Retry-After": "3600" } : undefined);
}

/**
 * Insert a pending request, or return the pending twin. The limit checks, the cap arithmetic and the reservation run in one
 * transaction under the per-user lock with the binding row locked, so concurrent proposals serialize (ST-74). Limit refusals
 * are committed (their audit row and alert survive) and then raised.
 */
export async function createRequest(ctx: AppContext, caller: Caller, r: NewRequest): Promise<Proposal> {
  const out = await withUser(ctx.runtime, caller.userId, async (c) => {
    await lockUser(c, caller.userId);
    const now = ctx.clock.now();
    // This binding's requests past their expiry are expired here, whether or not the sweeper has run: an expired twin still
    // holds the pending-once index (a repeat would fail on it) and its reservation. Lock order as everywhere (see
    // `revokeAllBindings`): those requests first, by id, then the binding, which is read again when the trigger released a reservation.
    const due = (await c.query("select id from agent_requests where binding_id = $1 and user_id = $2 and state = 'pending' and expires_at <= $3 order by id for update", [caller.bindingId, caller.userId, now])).rows.map((x) => x.id as string);
    let b = await liveBinding(c, caller.userId, caller.bindingId, now, true);
    if (!b) throw new HttpError(401, "unauthorized");
    if (due.length) {
      await c.query("update agent_requests set state = 'expired', decision_reason = 'expired', decided_at = $2 where id = any($1::uuid[]) and state = 'pending'", [due, now]);
      b = (await liveBinding(c, caller.userId, caller.bindingId, now, true))!;
    }
    const twin = (await c.query("select id, expires_at from agent_requests where binding_id = $1 and request_hash = $2 and state = 'pending' and expires_at > $3", [caller.bindingId, r.requestHash, now])).rows[0];
    if (twin) return { ok: { approval_id: twin.id as string, status: "pending_human_approval" as const, created: false, expires_at: iso(twin.expires_at)! } };
    const counts = (await c.query(
      `select count(*) filter (where binding_id = $2 and state = 'pending' and expires_at > $3)::int as pb,
              count(*) filter (where state = 'pending' and expires_at > $3)::int as pu,
              count(*) filter (where binding_id = $2 and created_at > $4)::int as hb,
              count(*) filter (where created_at > $5)::int as du
         from agent_requests where user_id = $1`,
      [caller.userId, caller.bindingId, now, new Date(now.getTime() - HOUR_MS), new Date(now.getTime() - DAY_MS)])).rows[0];
    if (counts.pb >= LIMITS.pendingPerBinding || counts.pu >= LIMITS.pendingPerUser) return { refuse: "too_many_pending" };
    if (counts.hb >= LIMITS.perBindingHour || counts.du >= LIMITS.perUserDay) return { refuse: "rate_limited" };
    if (r.quotedMinor > 0n && BigInt(b.reserved_minor) + BigInt(b.spent_minor) + r.quotedMinor > BigInt(b.spend_cap_minor)) return { refuse: "cap_exceeded" };
    const expires = new Date(Math.min(now.getTime() + REQUEST_TTL_MS, new Date(b.family_expires_at ?? b.expires_at).getTime()));
    const seenNet = (await c.query("select 1 from agent_requests where binding_id = $1 and ip_prefix is not distinct from $2 limit 1", [caller.bindingId, caller.ipPrefix])).rowCount;
    const ins = (await c.query(
      `insert into agent_requests (user_id, binding_id, kind, state, request_hash, params, domain_id, fqdn_ascii, years, quoted_minor, reservation, price_hash, ip_prefix, new_network, created_at, expires_at)
       values ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [caller.userId, caller.bindingId, r.kind, r.requestHash, r.params, r.domainId, r.fqdn, r.years, r.quotedMinor.toString(), r.quotedMinor > 0n ? "held" : "none", r.priceHash, caller.ipPrefix, !seenNet, now, expires])).rows[0];
    if (r.quotedMinor > 0n) await c.query("update bindings set reserved_minor = reserved_minor + $2 where id = $1", [caller.bindingId, r.quotedMinor.toString()]);
    await appendAudit(ctx, c, { chainId: caller.userId, actorKind: caller.kind, actorId: caller.bindingId, action: "agent.request.created", resourceKind: "agent_request", resourceId: ins.id, detail: { kind: r.kind, quoted_minor: r.quotedMinor.toString() } });
    await requestNotice(ctx, c, caller.userId, ins.id, { ...r.facts, bindingName: b.name });
    return { ok: { approval_id: ins.id as string, status: "pending_human_approval" as const, created: true, expires_at: expires.toISOString() } };
  });
  if ("ok" in out && out.ok) return out.ok;
  const reason = (out as { refuse: string }).refuse;
  return limited(ctx, caller, reason, reason === "cap_exceeded" ? 403 : 429);
}

const ProposeInput = z.strictObject({
  kind: z.enum(["register", "renew"]),
  domain: z.string().min(3).max(253),
  years: z.number().int().min(1).max(10).optional(),
});

/** `register.propose` (resource `*` only) or `renew.propose` (a domain the caller owns). */
export async function propose(ctx: AppContext, caller: Caller, raw: unknown): Promise<Proposal> {
  const p = ProposeInput.safeParse(raw);
  if (!p.success) throw new HttpError(400, "invalid_request");
  if (lintScopes(caller.scopes)) throw new HttpError(403, "scope_conflict");
  await withUser(ctx.runtime, caller.userId, (c) => assertAgentPurchasesOpen(c));
  if (p.data.kind === "register") {
    if (!allows(caller.scopes, "register.propose", "*", null)) throw new HttpError(403, "scope_missing");
    const priced = await withUser(ctx.runtime, caller.userId, async (c) => {
      const pr = await priceRegistration(ctx, c, p.data.domain, p.data.years);
      // C-24 and ST-133: the new-account limits that bind a human's registrations bind an agent's proposals too, and again at order time.
      const v = await checkNewAccountLimits(c, caller.userId, { wholesaleMinor: pr.quote.wholesaleMinor }, ctx.clock.now(), spendFuseOf(ctx));
      if (!v.allowed) return { refuse: v.reasons[0]! };
      const owned = (await c.query("select 1 from domains where fqdn_ascii = $1 and released_at is null", [pr.fqdn])).rowCount;
      if (owned) return { refuse: "already_owned" };
      return { pr };
    });
    if (!("pr" in priced) || !priced.pr) {
      const reason = (priced as { refuse: string }).refuse;
      if (reason === "already_owned") throw new HttpError(409, "already_owned");
      return limited(ctx, caller, reason, reason === "global_daily_cap" || reason === "global_total_cap" ? 503 : 429);
    }
    const { pr } = priced;
    await assertAvailable(ctx, pr.fqdn);
    return createRequest(ctx, caller, {
      kind: "register", requestHash: hashOf({ kind: "register", fqdn: pr.fqdn, years: pr.years }), domainId: null, fqdn: pr.fqdn, years: pr.years,
      quotedMinor: pr.quote.totalMinor, priceHash: pr.priceHash, params: pricedParams(pr),
      facts: { bindingName: "", kind: "register", fqdn: pr.fqdn, years: pr.years, totalMinor: pr.quote.totalMinor },
    });
  }
  const d = await withUser(ctx.runtime, caller.userId, async (c) => (await c.query("select id, fqdn_ascii, state from domains where user_id = $1 and fqdn_ascii = $2 and released_at is null", [caller.userId, p.data.domain.toLowerCase()])).rows[0]);
  if (!d) throw notFound();
  if (!allows(caller.scopes, "renew.propose", d.id, null)) throw new HttpError(403, "scope_missing");
  if (["pending", "redemption", "pending_delete"].includes(d.state)) throw new HttpError(409, "not_renewable");
  const pr = await withUser(ctx.runtime, caller.userId, (c) => priceRenewal(ctx, c, d.fqdn_ascii, p.data.years));
  return createRequest(ctx, caller, {
    kind: "renew", requestHash: hashOf({ kind: "renew", domain_id: d.id, years: pr.years }), domainId: d.id, fqdn: pr.fqdn, years: pr.years,
    quotedMinor: pr.quote.totalMinor, priceHash: pr.priceHash, params: { ...pricedParams(pr), domain_id: d.id },
    facts: { bindingName: "", kind: "renew", fqdn: pr.fqdn, years: pr.years, totalMinor: pr.quote.totalMinor },
  });
}

/** The closed params schema of a priced request: server numbers and the normalized name, nothing an agent typed. */
function pricedParams(pr: PricedRequest): Record<string, unknown> {
  return {
    fqdn: pr.fqdn, years: pr.years, currency: "usd", subtotal_minor: pr.quote.subtotalMinor.toString(), tax_ceiling_minor: pr.quote.taxCeilingMinor.toString(),
    total_minor: pr.quote.totalMinor.toString(), wholesale_price_id: pr.quote.wholesalePriceId,
    renewal_minor: pr.renewal ? pr.renewal.subtotalMinor.toString() : null, renewal_years: pr.renewal ? pr.renewal.years : null,
  };
}

async function assertAvailable(ctx: AppContext, fqdn: string): Promise<void> {
  const s = ctx.services as { orders?: OrdersServices; registrar?: OrdersServices["registrar"] };
  const reg = s.orders?.registrar ?? s.registrar;
  if (!reg) return;
  let a;
  try { a = await reg.checkAvailability(fqdn, { noCache: false }); } catch { return; /* the order path checks again with no cache */ }
  if (a.kind === "taken" || a.kind === "reserved") throw new HttpError(409, "name_unavailable");
  if (a.kind === "premium") throw new HttpError(422, "price_not_standard");
}

// ---- scope requests ("a secret read beyond scope") -------------------------------------------------------------------------

const ScopeInput = z.strictObject({ scopes: z.array(z.string().max(300)).min(1).max(20) });

/** Coverage of one wanted entry by one held entry (the same rule as the widening classifier: `*` never covers `prod`). */
export const coveredBy = (s: Pick<Scope, "capability" | "domain_id" | "env">, w: Pick<Scope, "capability" | "domain_id" | "env">) =>
  s.capability === w.capability && (s.domain_id === "*" || s.domain_id === w.domain_id)
  && (s.env === w.env || (w.env !== null && s.env === "*" && w.env !== "prod" && w.env !== "*"));

/**
 * An agent asks for more access. Nothing changes until the person widens the token with `agent.token.widen` (the same
 * passkey ceremony as the Bindings tab), and the lint that refuses `secrets.read` with `dns.write` applies to the result.
 */
export async function requestScope(ctx: AppContext, caller: Caller, raw: unknown): Promise<Proposal> {
  const p = ScopeInput.safeParse(raw);
  if (!p.success) throw new HttpError(400, "invalid_request");
  const wanted = await withUser(ctx.runtime, caller.userId, (c) => parseForUser(c, caller.userId, p.data.scopes));
  const missing = wanted.filter((w) => !caller.scopes.some((s) => coveredBy(s, w)));
  if (missing.length === 0) throw new HttpError(409, "already_granted");
  const lint = lintScopes([...caller.scopes, ...missing]);
  if (lint) throw new HttpError(422, "scope_conflict", undefined, undefined, { reason: lint });
  const scopes = canonical(missing);
  return createRequest(ctx, caller, {
    kind: "scope", requestHash: hashOf({ kind: "scope", scopes: scopes.map(scopeString).sort() }), domainId: null, fqdn: null, years: null, quotedMinor: 0n, priceHash: null,
    params: { scopes }, facts: { bindingName: "", kind: "scope", fqdn: null, years: null, totalMinor: 0n, scopes: scopes.map(scopeString) },
  });
}

// ---- reading ---------------------------------------------------------------------------------------------------------------

export async function loadRequest(c: PoolClient, userId: string, id: string, lock = false): Promise<RequestRow | null> {
  if (!UUID.test(id)) return null;
  return ((await c.query(`select * from agent_requests where id = $1 and user_id = $2${lock ? " for update" : ""}`, [id, userId])).rows[0] as RequestRow | undefined) ?? null;
}

/** Mark a pending request expired in its own committed statement (the reservation is released by the trigger). */
export async function expireIfDue(ctx: AppContext, userId: string, r: RequestRow): Promise<RequestRow> {
  if (r.state !== "pending" || new Date(r.expires_at) > ctx.clock.now()) return r;
  await withUser(ctx.runtime, userId, (c) => c.query("update agent_requests set state = 'expired', decision_reason = 'expired', decided_at = $2 where id = $1 and state = 'pending'", [r.id, ctx.clock.now()]));
  return { ...r, state: "expired" };
}

/** Void a pending request in its own committed statement (a price change, a changed zone). */
export async function voidRequest(ctx: AppContext, userId: string, id: string, reason: string): Promise<void> {
  await withUser(ctx.runtime, userId, async (c) => {
    const v = await c.query("update agent_requests set state = 'void', decision_reason = $2, decided_at = $3 where id = $1 and state = 'pending'", [id, reason, ctx.clock.now()]);
    if (v.rowCount) await appendAudit(ctx, c, { chainId: userId, actorKind: "system", action: "agent.request.void", resourceKind: "agent_request", resourceId: id, detail: { reason } });
  });
}

/** What the agent may see about its own request: the state, never a URL, never a price it did not already have. */
export async function agentView(ctx: AppContext, caller: Caller, id: string) {
  const out = await withUser(ctx.runtime, caller.userId, async (c) => {
    const r = await loadRequest(c, caller.userId, id);
    if (!r || r.binding_id !== caller.bindingId) return null;
    const o = r.order_id ? (await c.query("select state from orders where id = $1 and user_id = $2", [r.order_id, caller.userId])).rows[0] : null;
    return { r, orderState: (o?.state as string | undefined) ?? null };
  });
  if (!out) throw notFound();
  const r = await expireIfDue(ctx, caller.userId, out.r);
  return { approval_id: r.id, kind: r.kind, status: agentState(r, out.orderState), expires_at: iso(r.expires_at), decided_at: iso(r.decided_at) };
}

export interface ConfirmRule { required: boolean; reasons: ("over_threshold" | "first_approval" | "new_extension")[] }

/** Typed confirmation (ST-80): above the owner's threshold, on a binding's first approval, and for an extension the account has not bought. */
export async function confirmRule(c: PoolClient, userId: string, r: Pick<RequestRow, "binding_id" | "kind" | "params" | "fqdn_ascii">): Promise<ConfirmRule> {
  if (r.kind !== "register" && r.kind !== "renew") return { required: false, reasons: [] };
  const reasons: ConfirmRule["reasons"] = [];
  const u = (await c.query("select agent_confirm_threshold_minor from users where id = $1", [userId])).rows[0];
  const first = BigInt(r.params.total_minor ?? 0), renewal = BigInt(r.params.renewal_minor ?? 0);
  if ((first > renewal ? first : renewal) > BigInt(u?.agent_confirm_threshold_minor ?? 5000)) reasons.push("over_threshold");
  const prior = (await c.query("select 1 from agent_requests where binding_id = $1 and user_id = $2 and decided_by_action_id is not null and state in ('approved','completed','failed') limit 1", [r.binding_id, userId])).rowCount;
  if (!prior) reasons.push("first_approval");
  if (r.kind === "register") {
    const tld = (r.fqdn_ascii ?? "").slice((r.fqdn_ascii ?? "").indexOf(".") + 1);
    const had = (await c.query("select 1 from domains where user_id = $1 and tld = $2 limit 1", [userId, tld])).rowCount
      || (await c.query("select 1 from orders where user_id = $1 and kind = 'register' and split_part(fqdn_ascii, '.', 2) = $2 and state in ('captured','registered','capturing') limit 1", [userId, tld])).rowCount;
    if (!had) reasons.push("new_extension");
  }
  return { required: reasons.length > 0, reasons };
}

/**
 * The approval card (threat row 18): server fields only, as plain values the page renders as text nodes. The requester label
 * is the binding name the owner chose under step-up; nothing an agent sent (client names, user agents, free text) is here.
 */
export async function cardView(ctx: AppContext, userId: string, id: string) {
  const out = await withUser(ctx.runtime, userId, async (c) => {
    const r = await loadRequest(c, userId, id);
    if (!r) return null;
    const b = (await c.query("select id, name, kind, spend_cap_minor, reserved_minor, spent_minor, expires_at, family_expires_at, revoked_at, paused_at, oauth_client_id from bindings where id = $1 and user_id = $2", [r.binding_id, userId])).rows[0];
    const o = r.order_id ? (await c.query("select state from orders where id = $1 and user_id = $2", [r.order_id, userId])).rows[0] : null;
    const confirm = await confirmRule(c, userId, r);
    return { r, b, orderState: (o?.state as string | undefined) ?? null, confirm };
  });
  if (!out) throw notFound();
  const r = await expireIfDue(ctx, userId, out.r);
  const { b } = out;
  const p = r.params;
  const now = ctx.clock.now();
  const card: Record<string, unknown> = {
    id: r.id, kind: r.kind, state: r.state, agent_state: agentState(r, out.orderState),
    requester: { binding_id: b.id, name: b.name, kind: b.kind, connected_app: !!b.oauth_client_id, token_expires_at: iso(b.family_expires_at ?? b.expires_at), live: !b.revoked_at && !b.paused_at },
    requested_at: iso(r.created_at), age_seconds: Math.max(0, Math.floor((now.getTime() - new Date(r.created_at).getTime()) / 1000)), expires_at: iso(r.expires_at),
    new_network: r.new_network, decided_at: iso(r.decided_at), decision_reason: r.decision_reason, order_id: r.order_id,
  };
  if (r.kind === "register" || r.kind === "renew") {
    Object.assign(card, {
      domain: displayName(String(p.fqdn)), years: p.years, currency: "usd",
      first_charge: { subtotal_minor: p.subtotal_minor, max_total_minor: p.total_minor, tax_ceiling_minor: p.tax_ceiling_minor },
      renewal: p.renewal_minor ? { subtotal_minor: p.renewal_minor, years: p.renewal_years } : null,
      spend: { cap_minor: String(b.spend_cap_minor), spent_minor: String(b.spent_minor), reserved_minor: String(b.reserved_minor) },
      confirm: out.confirm,
    });
  } else if (r.kind === "dns_change") {
    Object.assign(card, { domain: displayName(String(p.fqdn)), dns: { added: p.added, removed: p.removed, sensitive: p.sensitive, before_hash: p.before_hash, after_hash: p.after_hash } });
  } else {
    Object.assign(card, { scopes: (storedScopes(p.scopes) as Scope[]).map(scopeString) });
  }
  return card;
}

export async function listForUser(ctx: AppContext, userId: string, state?: string) {
  const rows = await withUser(ctx.runtime, userId, async (c) => (await c.query(
    `select r.id, r.kind, r.state, r.fqdn_ascii, r.years, r.quoted_minor, r.created_at, r.expires_at, r.binding_id, b.name as binding_name
       from agent_requests r join bindings b on b.id = r.binding_id
      where r.user_id = $1 and ($2::text is null or (r.state = $2 and ($2 <> 'pending' or r.expires_at > $3))) order by r.created_at desc limit 100`,
    [userId, state ?? null, ctx.clock.now()])).rows);
  return rows.map((r) => ({
    id: r.id, kind: r.kind, state: r.state, domain: r.fqdn_ascii ? displayName(r.fqdn_ascii) : null, years: r.years, max_total_minor: String(r.quoted_minor),
    requested_at: iso(r.created_at), expires_at: iso(r.expires_at), requester: { binding_id: r.binding_id, name: r.binding_name },
  }));
}

// ---- deciding without a passkey: decline, and resolving a scope request ------------------------------------------------------

/** Decline is free and never rate limited (it can only reduce what an agent gets). */
export async function decline(ctx: AppContext, userId: string, id: string): Promise<{ id: string; state: "declined" }> {
  const ok = await withUser(ctx.runtime, userId, async (c) => {
    const r = await loadRequest(c, userId, id, true);
    if (!r) return null;
    if (r.state !== "pending") throw new HttpError(409, "request_unavailable");
    await c.query("update agent_requests set state = 'declined', decision_reason = 'owner', decided_at = $2 where id = $1 and state = 'pending'", [id, ctx.clock.now()]);
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "agent.request.declined", resourceKind: "agent_request", resourceId: id, detail: { kind: r.kind } });
    return true;
  });
  if (!ok) throw notFound();
  return { id, state: "declined" };
}

/** A scope request is settled when the person has widened the token to cover it (through `agent.token.widen`). */
export async function resolveScope(ctx: AppContext, userId: string, id: string) {
  return withUser(ctx.runtime, userId, async (c) => {
    const r = await loadRequest(c, userId, id, true);
    if (!r || r.kind !== "scope") throw notFound();
    if (r.state !== "pending") throw new HttpError(409, "request_unavailable");
    const b = await liveBinding(c, userId, r.binding_id, ctx.clock.now());
    if (!b) throw new HttpError(409, "binding_unavailable");
    const have = storedScopes(b.scopes);
    const want = storedScopes(r.params.scopes);
    const done = want.every((w) => have.some((s) => coveredBy(s, w)));
    if (!done) throw new HttpError(409, "not_widened");
    await c.query("update agent_requests set state = 'completed', decision_reason = 'widened', decided_at = $2 where id = $1 and state = 'pending'", [id, ctx.clock.now()]);
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "agent.request.widened", resourceKind: "agent_request", resourceId: id, detail: { scopes: want.length } });
    return { id, state: "completed" as const };
  });
}

// ---- sweeps ------------------------------------------------------------------------------------------------------------------

/**
 * Expire pending requests past their time, void those of a revoked binding, and expire approvals nobody paid for (the release of a
 * held reservation happens in the trigger). Cron role. One transaction in the lock order every path uses (see `revokeAllBindings`):
 * the requests first, in id order, then their bindings, in id order, then the state changes, each a fresh statement that re-checks
 * the state under those locks. Pay now makes an order only while holding the same request row (`withApproval` in approve.ts), so an
 * approval is expired only when no order points at it, and an order is never made for one this expired (ST-74).
 */
export async function expireDue(ctx: AppContext): Promise<number> {
  const now = ctx.clock.now();
  const stale = new Date(now.getTime() - APPROVAL_TTL_MS - APPROVAL_SWEEP_GRACE_MS);
  const n = await tx(ctx.cron, async (c) => {
    const ids = (await c.query(
      `select r.id from agent_requests r join bindings b on b.id = r.binding_id
        where (r.state = 'pending' and (r.expires_at <= $1 or b.revoked_at is not null))
           or (r.state = 'approved' and r.kind in ('register','renew') and r.order_id is null and r.decided_at <= $2 and not exists (select 1 from orders o where o.agent_request_id = r.id))
        order by r.id for update of r`, [now, stale])).rows.map((x) => x.id as string);
    if (ids.length === 0) return 0;
    await c.query("select id from bindings where id in (select binding_id from agent_requests where id = any($1::uuid[])) order by id for no key update", [ids]);
    const r = await c.query("update agent_requests set state = 'expired', decision_reason = 'expired', decided_at = $2 where id = any($1::uuid[]) and state = 'pending' and expires_at <= $2", [ids, now]);
    // A binding revoked on its own (not through revoke-all) leaves its pending requests behind: they are void, never approvable.
    const v = await c.query("update agent_requests r set state = 'void', decision_reason = 'binding_revoked', decided_at = $2 from bindings b where r.id = any($1::uuid[]) and b.id = r.binding_id and r.state = 'pending' and b.revoked_at is not null", [ids, now]);
    // An approval whose order was never made (the order path failed after it, or nobody pressed Pay now) expires and gives its
    // reservation back to the cap. `decided_at` keeps the time of the approval. A purchase only: an approved DNS change is one whose
    // write is out or whose outcome is unknown, and it keeps that state. This statement's snapshot is taken after the row locks, so an
    // order a Pay now committed while holding one of them is seen here.
    const a = await c.query(
      "update agent_requests r set state = 'expired', decision_reason = 'approval_expired' where r.id = any($1::uuid[]) and r.state = 'approved' and r.kind in ('register','renew') and r.order_id is null and r.decided_at <= $2 and not exists (select 1 from orders o where o.agent_request_id = r.id)",
      [ids, stale]);
    return (r.rowCount ?? 0) + (v.rowCount ?? 0) + (a.rowCount ?? 0);
  });
  await ctx.cron.query("update oauth_authorizations set status = 'expired' where status = 'pending' and expires_at <= $1", [now]);
  return n;
}

/**
 * How long an approval waits for its order (ST-74). PLAN 4.5 gives a proposal 72 hours and names no separate expiry for an approved
 * request, so the approval TTL already in code (REQUEST_TTL_MS) is used, counted from the approval: Pay now refuses from then on.
 */
export const APPROVAL_TTL_MS = REQUEST_TTL_MS;
/**
 * Slack between Pay now's refusal and the sweeper. Correctness does not depend on it: Pay now makes an order only under the request row
 * lock after re-checking the approval, and the sweeper expires under the same lock (see `expireDue`).
 */
export const APPROVAL_SWEEP_GRACE_MS = 10 * 60_000;

/** An approved request with no order whose approval is older than APPROVAL_TTL_MS (checked again against `orders` by the caller). */
export const approvalExpired = (r: Pick<RequestRow, "state" | "order_id" | "decided_at">, now: Date) =>
  r.state === "approved" && !r.order_id && !!r.decided_at && new Date(r.decided_at).getTime() + APPROVAL_TTL_MS <= now.getTime();

/** Nightly: every binding's `reserved_minor` equals the sum of its held reservations. A difference is corrected and alerted. */
export async function reconcileReservations(ctx: AppContext): Promise<{ checked: number; corrected: number }> {
  return tx(ctx.cron, async (c) => {
    // Lock first, then sum in a fresh statement: a proposal holds the same binding row lock while it reserves.
    const ids = (await c.query("select id from bindings b where b.reserved_minor > 0 or exists (select 1 from agent_requests r where r.binding_id = b.id and r.reservation = 'held') order by id for update")).rows.map((x) => x.id as string);
    const rows = ids.length ? (await c.query(
      `select b.id, b.reserved_minor::text as have, (select coalesce(sum(r.quoted_minor), 0) from agent_requests r where r.binding_id = b.id and r.reservation = 'held')::text as want
         from bindings b where b.id = any($1::uuid[])`, [ids])).rows : [];
    let corrected = 0;
    for (const x of rows) {
      if (x.have === x.want) continue;
      corrected++;
      await c.query("update bindings set reserved_minor = $2 where id = $1", [x.id, x.want]);
      await raiseAlert(ctx, c, { severity: "warn", kind: "agent.reservation_mismatch", subject: x.id, detail: { have: x.have, want: x.want } });
    }
    return { checked: rows.length, corrected };
  });
}
