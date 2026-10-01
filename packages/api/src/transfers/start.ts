import crypto from "node:crypto";
import { withUser, type PoolClient } from "@mosshatch/db";
import { RegistrarError } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { hit } from "../ratelimit.ts";
import { appendAudit } from "../audit.ts";
import { sendMail } from "../email.ts";
import { buildMail } from "../mail/templates.ts";
import { base32, base62, hashOf, randomBytes, safeEqual } from "../util/bytes.ts";
import { buildQuote, PricingError, quoteToJson } from "../pricing/index.ts";
import { parseFqdn } from "../search/labels.ts";
import { ordersSvc, loadOrder, rowToOrder } from "../orders/support.ts";
import { modeProblem } from "../orders/wiring.ts";
import { ensureSession } from "../orders/create.ts";
import { machine, move } from "../orders/machine.ts";
import { SESSION_TTL_MS, type OrderRow } from "../orders/types.ts";
import { sellGate } from "../domains/gate.ts";
import { checkEligibility } from "./eligibility.ts";
import {
  CONFIRM_MAX_ATTEMPTS, CONFIRM_TTL_MS, DAY_MS, LIVE_STATES, NEW_ACCOUNT_DAILY_TRANSFERS, transferPolicy,
} from "./policy.ts";
import { logTransfer, rowToTransfer, UUID_RE, type TransferRow } from "./store.ts";

export const PAUSED_MESSAGE = "Transfers are paused for a short while. Nothing was charged.";
const RETAIN_CONSENT_MS = 7 * 365 * DAY_MS;
/** EPP authInfo is printable ASCII; registries use 6 to 32 characters (.com 6-16), some up to 48. Anything else is refused unread. */
export const AUTH_CODE_RE = /^[\x21-\x7e]{6,64}$/;

const confirmHash = (transferId: string, code: string) => crypto.createHash("sha256").update(`${transferId}:${code}`).digest();
const emailHashOf = (e: string) => crypto.createHash("sha256").update(e.trim().toLowerCase()).digest("hex");
const newConfirmCode = () => base32(randomBytes(10)).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8).padEnd(8, "7");

export interface StartInput {
  userId: string; fqdn: unknown; years: unknown; authCode: unknown; idempotencyKey: string; ipPrefix: string; uaFamily: string; accept?: unknown;
}
export interface StartResult { transfer: TransferRow; replay: boolean }

async function replayOf(ctx: AppContext, userId: string, key: string, requestHash: Buffer): Promise<StartResult | null> {
  const row = (await withUser(ctx.runtime, userId, (c) => c.query("select * from transfers_in where user_id = $1 and idempotency_key = $2", [userId, key]))).rows[0];
  if (!row) return null;
  if (!Buffer.from(row.request_hash).equals(requestHash)) throw new HttpError(409, "idempotency_key_reuse");
  return { transfer: rowToTransfer(row), replay: true };
}

/**
 * POST /transfers (Rescue, ST-126). Order of checks: input, account gates and rate limits, the pre-transfer check with plain reasons,
 * price guard, screening and velocity, the sell gate, the contact and the documents. Only then is anything written: a `transfer_in`
 * order in `draft`, the transfer row holding the code as a PII envelope, and a confirmation code sent to the registrant email. Payment
 * comes after the confirmation; no card is stored and nothing is charged here.
 */
export async function startTransfer(ctx: AppContext, input: StartInput): Promise<StartResult> {
  const svc = ordersSvc(ctx);
  if (modeProblem(ctx, svc)) throw new HttpError(503, "mode_inconsistent");
  if (!/^[\x21-\x7e]{1,200}$/.test(input.idempotencyKey)) throw new HttpError(400, "idempotency_key_required");
  const parsed = typeof input.fqdn === "string" ? parseFqdn(input.fqdn) : null;
  if (!parsed) throw new HttpError(422, "invalid_fqdn");
  const fqdn = `${parsed.label}.${parsed.tld}`;
  const policy = await transferPolicy(ctx.cron, parsed.tld);
  if (!policy) throw new HttpError(422, "unsupported_tld");
  if (typeof input.years !== "number" || input.years !== policy.addYears) throw new HttpError(422, "invalid_term", `A .${parsed.tld} transfer adds ${policy.addYears} ${policy.addYears === 1 ? "year" : "years"}.`, undefined, { years: policy.addYears });
  // The code is validated for shape only and never echoed, logged or hashed into anything stored.
  if (typeof input.authCode !== "string" || !AUTH_CODE_RE.test(input.authCode)) throw new HttpError(422, "invalid_auth_code_format", "Enter the transfer code exactly as your current registrar gave it.");
  const authCode = input.authCode;
  const years = policy.addYears;
  const requestHash = hashOf({ fqdn, years, kind: "transfer_in" });
  const early = await replayOf(ctx, input.userId, input.idempotencyKey, requestHash);
  if (early) return early;

  const now = ctx.clock.now();
  await withUser(ctx.runtime, input.userId, async (c) => {
    const u = (await c.query("select status, email_verified_at, frozen_at from users where id = $1", [input.userId])).rows[0];
    if (!u || u.status !== "active") throw new HttpError(403, "account_inactive");
    if (!u.email_verified_at) throw new HttpError(403, "email_unverified");
    if (u.frozen_at) throw new HttpError(403, "account_frozen");
    if ((await c.query("select value from flags where name = 'orders_paused'")).rows[0]?.value === true) throw new HttpError(503, "orders_paused", PAUSED_MESSAGE);
    const perUser = await hit(ctx, c, `transfers:user:${input.userId}`, { bucket: "transfers_create_user", max: 20, windowSeconds: 3600 });
    const perIp = await hit(ctx, c, `transfers:ip:${input.ipPrefix}`, { bucket: "transfers_create_ip", max: 30, windowSeconds: 3600 });
    if (!perUser.allowed || !perIp.allowed) throw new HttpError(429, "rate_limited", "rate_limited", { "Retry-After": String(Math.max(perUser.retryAfterSeconds, perIp.retryAfterSeconds)) });
  });

  // The pre-transfer check, with a plain reason and, for the 60-day rules, the date they lift.
  const elig = await checkEligibility(ctx, input.userId, fqdn, years);
  if (!elig.ok) throw new HttpError(409, "not_transferable", elig.message, undefined, { reason: elig.reason, transferable_from: elig.transferableFrom?.toISOString() ?? null });

  // Price: our transfer price, and the registrar's own transfer quote must match it and must not be registry-premium (D-031).
  let priced;
  try { priced = await withUser(ctx.runtime, input.userId, (c) => buildQuote(c, { fqdn, years, kind: "transfer" }, now)); }
  catch (e) { if (e instanceof PricingError) throw new HttpError(e.code === "no_price" ? 503 : 422, e.code === "no_price" ? "orders_paused" : e.code); throw e; }
  try {
    const rq = await svc.registrar.quote(fqdn, years, "transfer");
    if (rq.isRegistryPremium || rq.wholesale.minor !== priced.wholesaleMinor) throw new HttpError(422, "price_not_standard");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof RegistrarError && e.code === "premium_refused") throw new HttpError(422, "price_not_standard");
    if (e instanceof RegistrarError) throw new HttpError(503, "registrar_unavailable", PAUSED_MESSAGE);
    throw e;
  }
  if (ctx.config.livemode && svc.registrar.capabilities().mode !== "live") throw new HttpError(503, "mode_inconsistent");

  // Screening and velocity (the registration limits), plus a daily cap on transfers-in for new accounts.
  await withUser(ctx.runtime, input.userId, async (c) => {
    const verdict = await svc.compliance.check(ctx, c, { userId: input.userId, fqdn, wholesaleMinor: priced.wholesaleMinor, subtotalMinor: priced.subtotalMinor });
    if (!verdict.ok) throw new HttpError(verdict.status, verdict.code, verdict.status === 503 ? PAUSED_MESSAGE : undefined);
    const created = (await c.query("select created_at from users where id = $1", [input.userId])).rows[0]?.created_at;
    if (created && now.getTime() - new Date(created).getTime() < 30 * DAY_MS) {
      const capRaw = (await c.query("select value from flags where name = 'limits.new_account_daily_transfers'")).rows[0]?.value;
      const cap = typeof capRaw === "number" ? capRaw : NEW_ACCOUNT_DAILY_TRANSFERS;
      const n = (await c.query("select count(*)::int n from transfers_in where user_id = $1 and created_at >= $2", [input.userId, new Date(now.getTime() - DAY_MS)])).rows[0].n as number;
      if (n + 1 > cap) throw new HttpError(429, "new_account_daily_transfers");
    }
  });
  // Sell gate: the transfer's wholesale joins what is already promised to renewals, registrations and other live transfers.
  const reservedTransfers = BigInt((await ctx.cron.query(
    "select coalesce(sum((o.quote->>'wholesale_minor')::bigint),0)::text s from transfers_in t join orders o on o.id = t.order_id where t.state = any($1) and o.state not in ('captured','voided','refunded')", [[...LIVE_STATES]])).rows[0].s as string);
  const gate = await sellGate(ctx, "register", priced.wholesaleMinor + reservedTransfers);
  if (!gate.ok) throw new HttpError(503, gate.reason === "registrar_unavailable" ? "registrar_unavailable" : "sell_gate", PAUSED_MESSAGE);
  const registrant = await svc.registrant(ctx, input.userId);
  if (!registrant) throw new HttpError(422, "contact_required");

  const code = newConfirmCode();
  const created = await withUser(ctx.runtime, input.userId, async (c) => {
    const docs = (await c.query(
      `select distinct on (kind) kind, version_hash from document_versions where kind = any($1) and effective_at <= $2 and (retired_at is null or retired_at > $2) order by kind, effective_at desc`,
      [["terms", "registration_agreement"], now])).rows;
    const terms = docs.find((d) => d.kind === "terms"), agreement = docs.find((d) => d.kind === "registration_agreement");
    if (!terms || !agreement) throw new HttpError(503, "documents_unavailable");
    const a = (input.accept && typeof input.accept === "object" ? input.accept : {}) as Record<string, unknown>;
    if (a.terms !== terms.version_hash || a.registration_agreement !== agreement.version_hash) throw new HttpError(422, "terms_not_accepted");

    const orderId = (await c.query("select uuidv7() as id")).rows[0].id as string;
    const tid = (await c.query("select uuidv7() as id")).rows[0].id as string;
    const regUsername = "mh" + base32(randomBytes(9)).toLowerCase().slice(0, 14);
    const regPassword = base62(18);
    const ipEnc = await ctx.pii.encrypt(input.ipPrefix, `order_ip:${orderId}`);
    const ins = await c.query(
      `insert into orders (id, user_id, kind, fqdn_ascii, years, state, idempotency_key, request_hash, quote, subtotal_minor, tax_ceiling_minor, total_minor, attempt, reg_username, checkout_ip_enc, livemode, created_at)
       values ($1,$2,'transfer_in',$3,$4,'draft',$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$14) on conflict (user_id, idempotency_key) do nothing returning *`,
      [orderId, input.userId, fqdn, years, `transfer:${input.idempotencyKey}`, requestHash, quoteToJson(priced), priced.subtotalMinor, priced.taxCeilingMinor, priced.totalMinor, regUsername, ipEnc, ctx.config.livemode, now]);
    if (ins.rowCount === 0) return null;
    await c.query("insert into registrar_profiles (order_id, username, password_enc) values ($1,$2,$3)", [orderId, regUsername, await ctx.pii.encrypt(regPassword, `registrar_profile:${orderId}`)]);
    for (const [kind, doc] of [["terms", terms], ["registration_agreement", agreement]] as const) {
      await c.query(
        "insert into consents (user_id, kind, document_hash, version, accepted_at, ip_enc, ua_family, order_id, actor_kind, retain_until) values ($1,$2,$3,$4,$5,$6,$7,$8,'user',$9)",
        [input.userId, kind, doc.version_hash, doc.version_hash.slice(0, 12), now, ipEnc, input.uaFamily, orderId, new Date(now.getTime() + RETAIN_CONSENT_MS)]);
    }
    await c.query("insert into order_events (order_id, from_state, to_state, cause, detail, at) values ($1,null,'draft','user',$2,$3)", [orderId, { years, kind: "transfer_in" }, now]);
    const env = await ctx.pii.encrypt(authCode, `transfer_auth:${tid}`);
    const eligibility = { transferable: true, created_at: elig.check.createdAt?.toISOString() ?? null, expires_at: elig.check.expiresAt?.toISOString() ?? null };
    const t = await c.query(
      `insert into transfers_in (id, user_id, order_id, fqdn_ascii, tld, years, state, idempotency_key, request_hash, auth_code_enc, confirm_code_hash, confirm_expires_at, confirm_sends, eligibility, dnssec_checked, created_at)
       values ($1,$2,$3,$4,$5,$6,'awaiting_confirmation',$7,$8,$9,$10,$11,1,$12,$13,$14) on conflict (user_id, idempotency_key) do nothing returning *`,
      [tid, input.userId, orderId, fqdn, parsed.tld, years, input.idempotencyKey, requestHash, env, confirmHash(tid, code), new Date(now.getTime() + CONFIRM_TTL_MS), eligibility, elig.dnssecChecked, now]);
    if (t.rowCount === 0) throw new HttpError(409, "request_in_progress");
    await appendAudit(ctx, c, { chainId: input.userId, actorKind: "user", actorId: input.userId, action: "transfer_in.created", resourceKind: "transfer", resourceId: tid, detail: { order: orderId, years } });
    await logTransfer(ctx, c, { userId: input.userId, direction: "in", event: "created", actor: "user", transferId: tid, detail: { dnssec_checked: elig.dnssecChecked } });
    // C-08 (inbound) and ST-126: the registrant email confirms the transfer before any payment.
    await sendMail(c, ctx.email, buildMail("transfer_confirm_code", { code, fqdn, ttlMinutes: CONFIRM_TTL_MS / 60_000 }, { to: [registrant.email], dedupeKey: `transfer.confirm:${tid}:1`, userId: input.userId, origin: ctx.config.origin }));
    return rowToTransfer(t.rows[0]);
  });
  if (!created) {
    const again = await replayOf(ctx, input.userId, input.idempotencyKey, requestHash);
    if (again) return again;
    throw new HttpError(409, "request_in_progress");
  }
  return { transfer: created, replay: false };
}

/** The caller's transfer by id. Unowned, malformed and nonexistent all leave through this one 404. */
export async function ownedTransfer(c: PoolClient, userId: string, id: string, lock = false): Promise<TransferRow> {
  const row = UUID_RE.test(id) ? (await c.query(`select * from transfers_in where id = $1 and user_id = $2${lock ? " for update" : ""}`, [id, userId])).rows[0] : undefined;
  if (!row) throw new HttpError(404, "not_found");
  return rowToTransfer(row);
}

type ConfirmOutcome = { kind: "ok"; order: OrderRow } | { kind: "wrong"; left: number } | { kind: "expired" } | { kind: "replay"; order: OrderRow };

/** POST /transfers/:id/confirm. A right code moves the order to checkout; a wrong one costs a try; five wrong tries or a stale code end it. */
export async function confirmTransfer(ctx: AppContext, userId: string, id: string, body: unknown): Promise<{ transfer: TransferRow; checkoutUrl: string | null }> {
  const svc = ordersSvc(ctx);
  const now = ctx.clock.now();
  const out: ConfirmOutcome = await withUser(ctx.runtime, userId, async (c) => {
    const t = await ownedTransfer(c, userId, id, true);
    const code = body && typeof body === "object" && typeof (body as Record<string, unknown>).code === "string" ? String((body as Record<string, unknown>).code).trim().toUpperCase() : "";
    if (t.state === "awaiting_payment") return { kind: "replay", order: rowToOrder((await c.query("select * from orders where id = $1", [t.orderId])).rows[0]) } as const;
    if (t.state !== "awaiting_confirmation") throw new HttpError(409, "not_awaiting_confirmation");
    if (!/^[A-Z0-9]{8}$/.test(code)) throw new HttpError(422, "invalid_code");
    if (!t.confirmExpiresAt || t.confirmExpiresAt <= now || t.confirmAttempts >= CONFIRM_MAX_ATTEMPTS) {
      await expireUnconfirmed(ctx, c, t, "code_expired");
      return { kind: "expired" } as const;
    }
    const stored = (await c.query("select confirm_code_hash from transfers_in where id = $1", [t.id])).rows[0]?.confirm_code_hash as Buffer | null;
    if (!stored || !safeEqual(stored, confirmHash(t.id, code))) {
      const n = (await c.query("update transfers_in set confirm_attempts = confirm_attempts + 1 where id = $1 returning confirm_attempts", [t.id])).rows[0].confirm_attempts as number;
      if (n >= CONFIRM_MAX_ATTEMPTS) { await expireUnconfirmed(ctx, c, t, "too_many_attempts"); return { kind: "expired" } as const; }
      return { kind: "wrong", left: CONFIRM_MAX_ATTEMPTS - n } as const;
    }
    const reg = await svc.registrant(ctx, userId);
    await c.query("savepoint confirm");
    try {
      const u = await c.query(
        "update transfers_in set state = 'awaiting_payment', confirmed_at = $2, confirm_email_hash = $3, confirm_code_hash = null where id = $1 and state = 'awaiting_confirmation'",
        [t.id, now, reg ? emailHashOf(reg.email) : null]);
      if (u.rowCount !== 1) throw new HttpError(409, "not_awaiting_confirmation");
      await c.query("release savepoint confirm");
    } catch (e) {
      if ((e as { code?: string }).code === "23505") { await c.query("rollback to savepoint confirm"); throw new HttpError(409, "not_transferable", "A transfer of this name is already in progress.", undefined, { reason: "pending_transfer" }); }
      throw e;
    }
    const m = machine(ctx);
    const order = await move(m, c, t.orderId, "draft", "checkout_open", {}, { cause: "user", detail: { confirmed: true } });
    if (!order) throw new HttpError(409, "not_awaiting_confirmation");
    const expiresAt = Math.floor((now.getTime() + SESSION_TTL_MS) / 1000);
    await c.query("insert into order_operations (order_id, kind, seq, request_hash, state, detail) values ($1,'checkout_session',1,$2,'intent',$3) on conflict do nothing", [t.orderId, hashOf({ order: t.orderId, attempt: 1 }), { expires_at: expiresAt }]);
    await logTransfer(ctx, c, { userId, direction: "in", event: "confirmed", actor: "user", transferId: t.id });
    return { kind: "ok", order } as const;
  });
  if (out.kind === "wrong") throw new HttpError(422, "invalid_code", undefined, undefined, { attempts_left: out.left });
  if (out.kind === "expired") throw new HttpError(409, "code_expired", "The code expired. Start the transfer again.");
  const fresh = (await loadOrder(ctx.cron, out.order.id)) ?? out.order;
  const url = fresh.state === "checkout_open" ? (await ensureSession(ctx, svc, fresh)).url : null;
  const t = await withUser(ctx.runtime, userId, (c) => ownedTransfer(c, userId, id));
  return { transfer: t, checkoutUrl: url };
}

/** An unconfirmed transfer ends: the code is wiped and the draft order is voided (nothing was charged). */
export async function expireUnconfirmed(ctx: AppContext, c: PoolClient, t: TransferRow, why: string): Promise<boolean> {
  const u = await c.query(
    "update transfers_in set state = 'expired', failure = 'unconfirmed', ended_at = $2, auth_code_enc = null, auth_code_wiped_at = coalesce(auth_code_wiped_at, $2), confirm_code_hash = null where id = $1 and state = 'awaiting_confirmation'",
    [t.id, ctx.clock.now()]);
  if (u.rowCount !== 1) return false;
  await move(machine(ctx), c, t.orderId, "draft", "voided", { void_reason: "customer_cancel" }, { cause: "system", detail: { transfer: "unconfirmed" } });
  await logTransfer(ctx, c, { userId: t.userId, direction: "in", event: "expired", actor: "system", transferId: t.id, detail: { why } });
  return true;
}

