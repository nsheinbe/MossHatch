import { withUser, type PoolClient } from "@mosshatch/db";
import { deriveTraits, registrarOfRecord } from "@mosshatch/core";
import { HttpError } from "../http/router.ts";
import type { AppContext } from "../ports.ts";
import { DAY_MS, UUID_RE, iso, rowToDomain, tableExists, type DomainRow } from "./common.ts";
import { activeMandate } from "./mandate.ts";
import { deriveDomainState } from "./state.ts";
import { renewalQuote, rowToTerm, type TermRow } from "./terms.ts";
import { exportOpen } from "./release.ts";

/**
 * Read models for the web app: the Grove list, one domain's overview and the Ledger. Every query runs as the caller through
 * `withUser` (row-level security) AND filters `user_id`, so an unowned id and a nonexistent one leave through the same 404 (ST-91).
 * Money is decimal strings of minor units. Nothing here holds a token, a payment method or a raw upstream value.
 */
const EGG_STATES = ["review_hold", "authorized", "registering", "outcome_unknown", "registrar_unavailable", "paid_before_registration", "registered", "capturing", "capture_failed"];

async function ownerStartedTransfer(c: PoolClient, d: DomainRow, now: Date): Promise<boolean> {
  const r = await c.query(
    `select 1 from actions where user_id = $1 and type = 'domain.transfer_out' and state in ('committed','dispatching','executed','outcome_unknown') and committed_at >= $2
        and (resource_id = $3 or target_id = $3 or target_id = $4) limit 1`, [d.userId, new Date(now.getTime() - 7 * DAY_MS), d.id, d.fqdn]);
  return (r.rowCount ?? 0) > 0;
}

/** A DNS write the registrar has taken but the authoritative nameservers do not show yet (the DNS module's `dns_write_intents`), when that table exists. */
async function dnsWriteInFlight(c: PoolClient, d: DomainRow): Promise<boolean> {
  if (!(await tableExists(c, "dns_write_intents"))) return false;
  try {
    await c.query("savepoint dw");
    const r = await c.query("select 1 from dns_write_intents where domain_id = $1 and state in ('submitted','applied') limit 1", [d.id]);
    await c.query("release savepoint dw");
    return (r.rowCount ?? 0) > 0;
  } catch { await c.query("rollback to savepoint dw"); return false; }
}

async function stateOf(c: PoolClient, d: DomainRow, term: TermRow | null, now: Date) {
  const view = deriveDomainState({
    d, now, ownerStartedTransfer: d.transferAway ? await ownerStartedTransfer(c, d, now) : false,
    renewalPaymentFailed: term?.state === "payment_failed", dnsWriteInFlight: await dnsWriteInFlight(c, d),
  });
  return view;
}

async function renewalBlock(c: PoolClient, d: DomainRow, term: TermRow | null, now: Date) {
  const q = await renewalQuote(c, d.fqdn, now);
  const mandate = await activeMandate(c, d.id);
  return {
    price_minor: (q?.subtotalMinor ?? term?.currentPriceMinor ?? null)?.toString() ?? null,
    wholesale_minor: q?.wholesaleMinor.toString() ?? null, fee_minor: q?.feeMinor.toString() ?? null, years: q?.years ?? null, currency: "usd", tax: "excluded",
    charge_at: iso(term?.chargeAt), state: term?.state ?? null, held_reason: term?.heldReason ?? null,
    auto_renew: d.autoRenew && !!mandate, price_ceiling_minor: mandate ? mandate.priceCeilingMinor.toString() : null,
  };
}

export async function domainView(c: PoolClient, d: DomainRow, now: Date) {
  const term = d.expiresAt ? (await c.query("select * from renewal_terms where domain_id = $1 and term_end = $2", [d.id, d.expiresAt])).rows[0] : undefined;
  const t = term ? rowToTerm(term) : null;
  const s = await stateOf(c, d, t, now);
  const ageDays = s.facts.ageDays;
  return {
    id: d.id, fqdn: d.fqdn, tld: d.tld, state: s.state, state_text: s.text, armored: s.locked, adapter_state: d.state,
    locked: d.locked, expires_at: iso(d.expiresAt), days_to_expiry: d.expiresAt ? s.facts.daysToExpiry : null, auto_renew: d.autoRenew,
    renewal: await renewalBlock(c, d, t, now),
    registered_at: iso(d.registeredAt), registry_created_at: iso(d.registryCreatedAt), age_days: ageDays,
    traits_inputs: { domain: d.fqdn, age_days: ageDays, registry_created_at: iso(d.registryCreatedAt) }, traits: deriveTraits(d.fqdn),
    as_of: iso(s.asOf), source: s.source, confirmed: s.confirmed,
    // The accredited registrar that holds the registration (D-024 row 12; docs/AUDIT-2026-10-07.md O3), shown on the Overview.
    registrar: (({ name, short, ianaId }) => ({ name, short, iana_id: ianaId }))(registrarOfRecord(d.registrar)),
  };
}

export async function listGrove(ctx: AppContext, userId: string) {
  const now = ctx.clock.now();
  return withUser(ctx.runtime, userId, async (c) => {
    const rows = (await c.query("select * from domains where user_id = $1 and released_at is null order by expires_at nulls last, fqdn_ascii", [userId])).rows.map(rowToDomain);
    const domains = [];
    for (const d of rows) domains.push(await domainView(c, d, now));
    // Names being registered have no domain row yet: an egg per order in flight.
    const eggs = (await c.query(
      `select id, fqdn_ascii, state, created_at from orders o where user_id = $1 and kind = 'register' and state = any($2)
          and not exists (select 1 from domains d where d.fqdn_ascii = o.fqdn_ascii and d.user_id = o.user_id and d.released_at is null) order by created_at desc`,
      [userId, EGG_STATES])).rows.map((r) => ({ order_id: r.id, fqdn: r.fqdn_ascii, state: "egg", order_state: r.state, created_at: iso(new Date(r.created_at)) }));
    return { domains, eggs };
  });
}

/** One domain by id for its owner; a released domain stays readable for the export hold. Unowned and nonexistent are the same 404. */
export async function domainOverview(ctx: AppContext, userId: string, id: string) {
  const now = ctx.clock.now();
  const found = UUID_RE.test(id)
    ? await withUser(ctx.runtime, userId, async (c) => {
        const r = (await c.query("select * from domains where id = $1 and user_id = $2", [id, userId])).rows[0];
        if (!r) return null;
        const d = rowToDomain(r);
        if (!exportOpen(d, now)) return null;
        const base = await domainView(c, d, now);
        const mandate = await activeMandate(c, d.id);
        const orders = (await c.query("select id, kind, state, years, subtotal_minor, created_at from orders where domain_id = $1 and user_id = $2 order by created_at desc limit 20", [d.id, userId])).rows;
        // The owner's first DNS change or nameserver move, from their own audit chain: the getting-started checklist's "connect" step
        // (docs/AUDIT-2026-10-07.md O1) is ticked from this, the same record the funnel report counts as a first setup action (V3).
        const connected = (await c.query(
          "select min(at) as at from audit_log where chain_id = $1 and resource_kind = 'domain' and resource_id = $2 and action in ('dns.write','domain.nameservers_changed')",
          [userId, d.id])).rows[0]?.at;
        return {
          ...base,
          nameservers: d.nameservers, registry_statuses: d.registryStatuses, ds_present: d.dsPresent, privacy_status: d.privacyStatus, dns_hosted_here: d.dnsHostedHere,
          dispute_lock_state: d.disputeLockState, transfer_away: d.transferAway, synced_at: iso(d.syncedAt), sync_error: d.syncError,
          mandate: mandate ? { accepted_at: iso(mandate.acceptedAt), price_ceiling_minor: mandate.priceCeilingMinor.toString(), term_years: mandate.termYears, charge_days_before_expiry: mandate.chargeDaysBeforeExpiry } : null,
          released: d.releasedAt ? { at: iso(d.releasedAt), reason: d.releaseReason, hold_until: iso(d.releaseHoldUntil), export_available: exportOpen(d, now) } : null,
          orders: orders.map((o) => ({ id: o.id, kind: o.kind, state: o.state, years: o.years, subtotal_minor: String(o.subtotal_minor), created_at: iso(new Date(o.created_at)) })),
          connected_at: connected ? iso(new Date(connected)) : null,
        };
      })
    : null;
  if (!found) throw new HttpError(404, "not_found");
  return found;
}

/** The Ledger: every order, its payment and its refunds for the user. */
export async function ledger(ctx: AppContext, userId: string) {
  return withUser(ctx.runtime, userId, async (c) => {
    const orders = (await c.query(
      `select o.id, o.kind, o.fqdn_ascii, o.state, o.years, o.subtotal_minor, o.total_minor, o.void_reason, o.created_at, o.domain_id,
              p.amount_minor as paid_minor, p.tax_minor, p.refunded_minor, p.status as payment_status, p.captured_at, p.dispute_state
         from orders o left join payments p on p.order_id = o.id where o.user_id = $1 order by o.created_at desc, o.id desc limit 500`, [userId])).rows;
    const refunds = (await c.query("select id, order_id, payment_id, amount_minor, reason, created_at from refunds where user_id = $1 order by created_at desc, id desc limit 500", [userId])).rows;
    return {
      entries: orders.map((o) => ({
        order_id: o.id, kind: o.kind, fqdn: o.fqdn_ascii, state: o.state, years: o.years, subtotal_minor: String(o.subtotal_minor), total_minor: String(o.total_minor),
        charged_minor: o.paid_minor === null ? null : String(o.paid_minor), tax_minor: o.tax_minor === null ? null : String(o.tax_minor), refunded_minor: o.refunded_minor === null ? "0" : String(o.refunded_minor),
        payment_status: o.payment_status ?? null, dispute: o.dispute_state ?? null, captured_at: o.captured_at ? iso(new Date(o.captured_at)) : null, created_at: iso(new Date(o.created_at)), domain_id: o.domain_id,
      })),
      refunds: refunds.map((r) => ({ id: r.id, order_id: r.order_id, amount_minor: String(r.amount_minor), reason: r.reason, created_at: iso(new Date(r.created_at)) })),
    };
  });
}

/** The record a former owner can export during the hold (and any owner at any time): metadata, terms, orders and notices; secret names, never values. */
export async function domainExport(ctx: AppContext, userId: string, id: string) {
  const now = ctx.clock.now();
  const out = UUID_RE.test(id)
    ? await withUser(ctx.runtime, userId, async (c) => {
        const r = (await c.query("select * from domains where id = $1 and user_id = $2", [id, userId])).rows[0];
        if (!r) return null;
        const d = rowToDomain(r);
        if (!exportOpen(d, now)) return null;
        const orders = (await c.query("select id, kind, state, years, subtotal_minor, created_at from orders where domain_id = $1 and user_id = $2 order by created_at", [d.id, userId])).rows;
        const terms = (await c.query("select term_end, charge_at, state, baseline_price_minor from renewal_terms where domain_id = $1 and user_id = $2 order by term_end", [d.id, userId])).rows;
        const notices = (await c.query("select kind, sent_at from notices where domain_id = $1 and user_id = $2 order by sent_at", [d.id, userId])).rows;
        const extra: Record<string, unknown> = {};
        // Tables that later modules own: read when present and readable, skipped otherwise (a savepoint keeps a refused read from ending the request).
        for (const [key, table, sql] of [["dns_records", "dns_records", "select type, name, value from dns_records where domain_id = $1"], ["secret_names", "secrets", "select name, env from secrets where domain_id = $1 order by env, name"]] as const) {
          if (!(await tableExists(c, table))) continue;
          try { await c.query("savepoint ex"); extra[key] = (await c.query(sql, [d.id])).rows; await c.query("release savepoint ex"); }
          catch { await c.query("rollback to savepoint ex"); }
        }
        return {
          domain: { id: d.id, fqdn: d.fqdn, tld: d.tld, registered_at: iso(d.registeredAt), registry_created_at: iso(d.registryCreatedAt), expires_at: iso(d.expiresAt), nameservers: d.nameservers, released_at: iso(d.releasedAt), release_reason: d.releaseReason, hold_until: iso(d.releaseHoldUntil) },
          orders: orders.map((o) => ({ id: o.id, kind: o.kind, state: o.state, years: o.years, subtotal_minor: String(o.subtotal_minor), created_at: iso(new Date(o.created_at)) })),
          renewals: terms.map((t) => ({ term_end: iso(new Date(t.term_end)), charge_at: iso(new Date(t.charge_at)), state: t.state, price_minor: String(t.baseline_price_minor) })),
          notices: notices.map((n) => ({ kind: n.kind, sent_at: iso(new Date(n.sent_at)) })),
          ...extra,
        };
      })
    : null;
  if (!out) throw new HttpError(404, "not_found");
  return out;
}
