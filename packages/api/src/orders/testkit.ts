import { withUser } from "@mosshatch/db";
import { MockRegistrarPort } from "@mosshatch/registrar/mock-port";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { Router } from "../http/router.ts";
import { createSession } from "../http/session.ts";
import { runTick } from "../jobs/engine.ts";
import { FakeStripe } from "../stripe/fake.ts";
import type { StripeEvent } from "../stripe/port.ts";
import { registerOrderRoutes } from "./routes.ts";
import { registerOrderJobs } from "./jobs.ts";
import { installOrders } from "./wiring.ts";
import { storeRegistrant } from "./registrant.ts";
import { advance, machine } from "./machine.ts";
import type { OrdersServices } from "./types.ts";
import type { Config } from "../ports.ts";

export const WEBHOOK_SECRET = "whsec_test_primary_0123456789abcdef";
export const REGISTRANT = { name: "Ada Moss", email: "ada@example.org", phone: "+1.5555550100", street: "1 Fern Lane", city: "Portland", region: "OR", postalCode: "97201", country: "US" };

export interface OrdersHarness {
  app: TestApp;
  stripe: FakeStripe;
  registrar: MockRegistrarPort;
  resetRegistrar(): void;
  svc: OrdersServices;
  waited: Promise<unknown>[];
  secrets: string[];
  /** Expected subtotal for a term at the price table in force (wholesale plus the D-003 fee band). */
  subtotal(tld: string, years?: number): bigint;
}
export interface Buyer { userId: string; cookie: string; email: string }

export async function makeHarness(opts: { config?: Partial<Config>; taxBps?: number; funding?: bigint; registrarPresentsAs?: "live" | "sandbox" } = {}): Promise<OrdersHarness> {
  const router = new Router();
  registerOrderRoutes(router);
  const app = await createTestApp(router, opts.config);
  // The clock starts at the database's own time (job and alert timestamps default to it), and the mock registrar is priced from the
  // same effective-dated table, so the pricing module's price guard sees one price on both sides.
  app.clock.set(new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000));   // a minute ahead, so jobs enqueued with the database's now() are already due
  const rows = (await app.db.owner.query("select distinct on (tld) tld, amount_minor from wholesale_prices where registrar = 'opensrs' and kind = 'register' and effective_from <= $1::date order by tld, effective_from desc", [app.clock.now().toISOString()])).rows;
  const wholesale = Object.fromEntries(rows.map((r) => [r.tld as string, BigInt(r.amount_minor)]));
  const stripe = new FakeStripe(app.clock, { livemode: !!opts.config?.livemode, taxBps: opts.taxBps ?? 800 });
  const mkRegistrar = () => new MockRegistrarPort({ clock: app.clock, funding: opts.funding, wholesalePerYear: wholesale });
  const presented = (r: MockRegistrarPort) => { if (opts.registrarPresentsAs) { const caps = r.capabilities.bind(r); r.capabilities = () => ({ ...caps(), mode: opts.registrarPresentsAs! }); } return r; };
  const registrar = presented(mkRegistrar());
  const waited: Promise<unknown>[] = [];
  const secrets = [WEBHOOK_SECRET];
  const svc = installOrders(app.ctx, { stripe, registrar, webhookSecrets: () => secrets, waitUntil: (p) => { waited.push(p); }, tick: () => undefined });
  registerOrderJobs();
  await app.db.owner.query(
    "insert into document_versions (kind, version_hash, effective_at) values ('terms','termshash0123456789abcdef','2026-01-01'),('registration_agreement','agreementhash0123456789','2026-01-01')");
  const subtotal = (tld: string, years = 1) => (wholesale[tld]! + (wholesale[tld]! < 5000n ? 400n : wholesale[tld]! < 10000n ? 900n : 1000n)) * BigInt(years);
  const h: OrdersHarness = {
    app, stripe, registrar, svc, waited, secrets, subtotal,
    // A fresh registrar (no faults, no maintenance windows, no domains): the mock has no way to end a long window early.
    resetRegistrar() { h.registrar = presented(mkRegistrar()); svc.registrar = h.registrar; },
  };
  return h;
}

export async function makeBuyer(h: OrdersHarness, email: string, o: { contact?: boolean; status?: string } = {}): Promise<Buyer> {
  const row = (await h.app.db.owner.query("insert into users (email, status, email_verified_at, created_at) values ($1,$2,now(), '2026-01-01') returning id", [email, o.status ?? "active"])).rows[0];
  await h.app.db.owner.query("insert into notification_addresses (user_id, address, kind, verified_at) values ($1,$2,'login',now())", [row.id, email]);
  if (o.contact !== false) await withUser(h.app.ctx.runtime, row.id, (c) => storeRegistrant(h.app.ctx, c, row.id, { ...REGISTRANT, email }));
  const s = await createSession(h.app.ctx, row.id, {});
  return { userId: row.id, cookie: s.cookie.split(";")[0]!, email };
}

/** Places an order the way the web app does: the current document hashes are sent as the acceptance unless the body already has one. */
export const postOrder = async (h: OrdersHarness, b: Buyer, body: unknown, key: string | null = "key-1", extra: Record<string, string> = {}) => {
  let sent = body;
  if (body && typeof body === "object" && !Array.isArray(body) && !("accept" in body)) {
    const docs = (await h.app.db.owner.query("select kind, version_hash from document_versions where kind in ('terms','registration_agreement')")).rows;
    sent = { ...body, accept: Object.fromEntries(docs.map((d) => [d.kind, d.version_hash])) };
  }
  return h.app.call("POST", "/api/v1/orders", { cookie: b.cookie, body: sent, headers: { ...(key ? { "idempotency-key": key } : {}), ...extra } });
};

export const getOrder = (h: OrdersHarness, b: Buyer, id: string) => h.app.call("GET", `/api/v1/orders/${id}`, { cookie: b.cookie });

/** Deliver a Stripe event the way Stripe does: raw JSON body, signed header. */
export function deliver(h: OrdersHarness, ev: StripeEvent, o: { secrets?: string | string[]; t?: number; headers?: Record<string, string>; sign?: boolean } = {}) {
  const w = h.stripe.deliver(ev, o.secrets ?? h.secrets, { t: o.t });
  return h.app.call("POST", "/api/v1/webhooks/stripe", { body: JSON.parse(w.body), headers: { ...(o.sign === false ? {} : { "stripe-signature": w.headers["stripe-signature"]! }), ...(o.headers ?? {}) }, browser: false });
}

/** Deliver every event Fake Stripe has queued, in order. */
export async function deliverAll(h: OrdersHarness) {
  const out = [];
  for (const ev of h.stripe.takeEvents()) out.push(await deliver(h, ev));
  return out;
}

export const orderRow = async (h: OrdersHarness, id: string) => (await h.app.db.owner.query("select * from orders where id = $1", [id])).rows[0];
export const states = async (h: OrdersHarness, id: string) => (await h.app.db.owner.query("select from_state, to_state from order_events where order_id = $1 order by at, id", [id])).rows.map((r) => `${r.from_state ?? "-"}>${r.to_state}`);
export const alerts = async (h: OrdersHarness, kind?: string) => (await h.app.db.owner.query("select * from alerts where ($1::text is null or kind = $1)", [kind ?? null])).rows;

/** Run the order machine for one order from the given harness (a worker). */
export const work = (h: OrdersHarness, id: string) => advance(machine(h.app.ctx), id);

/** Run queued jobs through the real engine until none are due. */
export async function drain(h: OrdersHarness, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    const r = await runTick(h.app.ctx, { heartbeat: false, budgetMs: 5_000 });
    if (r.claimed === 0) return;
  }
}

/** A buyer places an order and pays on Checkout (authorization only). */
export async function buyAndPay(h: OrdersHarness, b: Buyer, fqdn: string, o: { key?: string; years?: number; pay?: Parameters<FakeStripe["payCheckout"]>[1] } = {}) {
  const res = await postOrder(h, b, { fqdn, years: o.years ?? 1 }, o.key ?? `k-${fqdn}`);
  if (res.status >= 300) throw new Error(`order failed ${res.status} ${res.text}`);
  const id = res.json.order_id as string;
  const row = await orderRow(h, id);
  h.stripe.takeEvents();
  const events = h.stripe.payCheckout(row.stripe_checkout_session_id, o.pay);
  return { id, events, sessionId: row.stripe_checkout_session_id as string };
}
