import { expect } from "vitest";
import { runTick } from "../jobs/engine.ts";
import { createSession } from "../http/session.ts";
import { buildRouter } from "../routes.ts";
import { addPasskey, commit, prepare, type TestUser } from "../stepup/testkit.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { buyAndPay, deliverAll, drain, makeBuyer, makeHarness, type Buyer, type OrdersHarness } from "../orders/testkit.ts";
import { FakeEndUserProbe, installDomains } from "./wiring.ts";
import { registerMandateSpec } from "./mandate.ts";
import { DAY_MS } from "./common.ts";

export interface DomainsHarness extends OrdersHarness { probe: FakeEndUserProbe }
export const AUTH_TEXT_HASH = "autorenewtexthash0123456789abcdef";

/** The orders harness (real Postgres, FakeStripe, MockRegistrarPort on the shared clock) with the whole route table and the domains services. */
export async function makeDomainsHarness(opts: Parameters<typeof makeHarness>[0] = {}): Promise<DomainsHarness> {
  const h = await makeHarness(opts) as DomainsHarness;
  h.app.router = buildRouter();
  registerMandateSpec();
  h.probe = new FakeEndUserProbe();
  installDomains(h.app.ctx, { endUserProbe: h.probe, probeProfile: "horizon-test-profile" });
  await h.app.db.owner.query("insert into document_versions (kind, version_hash, effective_at) values ('auto_renew_authorisation',$1,'2026-01-01') on conflict do nothing", [AUTH_TEXT_HASH]);
  return h;
}

export interface Owner extends Buyer { key: Awaited<ReturnType<typeof addPasskey>>; user: TestUser }
/** A buyer who also holds a virtual passkey, so step-up actions can be committed. */
export async function makeOwner(h: DomainsHarness, email: string, o: Parameters<typeof makeBuyer>[2] = {}): Promise<Owner> {
  const b = await makeBuyer(h, email, o);
  const handle = (await h.app.db.owner.query("select webauthn_user_handle from users where id = $1", [b.userId])).rows[0].webauthn_user_handle as Buffer;
  const user: TestUser = { userId: b.userId, handle, cookie: b.cookie, sessionHash: Buffer.alloc(0), email };
  const key = await addPasskey(h.app, user);
  return { ...b, key, user };
}

export interface Bought { id: string; fqdn: string; orderId: string }
/**
 * Buy and register a name through the real order flow. The domain row exists when this returns. By default the buyer ticks the
 * auto-renew box at checkout (the card is saved for off-session renewals, C-31); pass `autoRenew: false` for a one-time card.
 */
export async function buyDomain(h: DomainsHarness, who: Buyer, fqdn: string, o: Parameters<typeof buyAndPay>[3] = {}): Promise<Bought> {
  const r = await buyAndPay(h, who, fqdn, { autoRenew: true, ...o });
  await deliverAll(h);
  await hygiene(h);
  await drain(h);
  const d = (await h.app.db.owner.query("select id from domains where fqdn_ascii = $1 and released_at is null", [fqdn])).rows[0];
  expect(d, `domain ${fqdn} registered`).toBeTruthy();
  return { id: d.id, fqdn, orderId: r.id };
}

export const domainRow = async (h: DomainsHarness, id: string) => (await h.app.db.owner.query("select * from domains where id = $1", [id])).rows[0];
export const termRow = async (h: DomainsHarness, domainId: string) => (await h.app.db.owner.query("select * from renewal_terms where domain_id = $1 order by term_end desc limit 1", [domainId])).rows[0];
export const renewOrders = async (h: DomainsHarness, domainId: string) => (await h.app.db.owner.query("select * from orders where domain_id = $1 and kind = 'renew' order by created_at", [domainId])).rows;
export const findings = async (h: DomainsHarness, kind?: string) => (await h.app.db.owner.query("select * from reconciliation_findings where ($1::text is null or kind = $1) order by found_at, id", [kind ?? null])).rows;
export const alertRows = async (h: DomainsHarness, kind?: string) => (await h.app.db.owner.query("select * from alerts where ($1::text is null or kind = $1) and state = 'open'", [kind ?? null])).rows;

/** Move the shared clock to a time (the mock registrar and the app read it). */
export const at = (h: DomainsHarness, t: Date) => { h.app.clock.set(new Date(t)); };
export const days = (n: number) => n * DAY_MS;

/** See `settle`: acknowledge pages and undo the auto-safe pause the decoupled test clock would otherwise trigger. */
export async function hygiene(h: DomainsHarness) {
  await h.app.db.owner.query("update alerts set acked_at = now(), acked_by = 'test' where severity = 'page' and acked_at is null");
  await h.app.db.owner.query("update flags set value = 'false' where name = 'registrar_writes_paused' and updated_by = 'auto-safe'");
}

/** Run the real engine until nothing is due. */
export async function settle(h: DomainsHarness, rounds = 10) {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    // The test clock runs months ahead of the database clock that stamps alerts, so the engine's auto-safe mode (an unacknowledged page older than
    // 30 minutes pauses registrar writes) would engage at once. Pages are acknowledged and the flag left as it was; alerts stay `open` for assertions.
    await hygiene(h);
    const r = await runTick(h.app.ctx, { heartbeat: false, budgetMs: 20_000 });
    total += r.claimed;
    if (r.claimed === 0) break;
  }
  return total;
}

/** A committed `mandate.sign` action for a domain, then the route call that turns auto-renew on. */
export async function signMandate(h: DomainsHarness, o: Owner, domainId: string, consent: string = AUTH_TEXT_HASH) {
  const prep = await prepare(h.app, o.user, { type: "mandate.sign", target_id: domainId, user_input: {} });
  if (prep.status !== 200) return { prep, done: null, res: null };
  const done = await commit(h.app, o.user, prep.json.action_id, o.key.auth.get(prep.json.webauthn_options));
  const res = await h.app.call("POST", `/api/v1/domains/${domainId}/auto-renew`, { cookie: o.cookie, body: { consent_hash: consent }, headers: { [ACTION_HEADER]: prep.json.action_id } });
  return { prep, done, res };
}

/** Turn auto-renew on, expecting success. */
export async function autoRenewOn(h: DomainsHarness, o: Owner, domainId: string) {
  const r = await signMandate(h, o, domainId);
  expect(r.res?.status, JSON.stringify(r.res?.json ?? r.prep.json)).toBe(200);
  return r;
}

/** Sent mail of one kind. */
export const mailOf = (h: DomainsHarness, kind: string) => h.app.email.sent.filter((m) => m.kind === kind);

/** A new session for the person at the current test time (sessions expire when the test clock jumps months ahead). */
export async function relogin(h: DomainsHarness, o: Owner): Promise<Owner> {
  const s = await createSession(h.app.ctx, o.userId, {});
  const cookie = s.cookie.split(";")[0]!;
  return { ...o, cookie, user: { ...o.user, cookie, sessionHash: s.idHash } };
}

/** One harness per test that moves the clock: months of test time must not leak into the next test. */
export function harnessPerTest() {
  const open: DomainsHarness[] = [];
  return {
    async make(opts: Parameters<typeof makeDomainsHarness>[0] = {}): Promise<DomainsHarness> { const h = await makeDomainsHarness(opts); open.push(h); return h; },
    async dropAll() { while (open.length) await open.pop()!.app.drop(); },
  };
}
