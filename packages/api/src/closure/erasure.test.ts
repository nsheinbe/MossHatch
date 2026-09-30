import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { connect, tx, withUser } from "@mosshatch/db";
import { mintToken } from "../util/token.ts";
import { sha256 } from "../util/bytes.ts";
import { verifyChain } from "../audit.ts";
import { createSession } from "../http/session.ts";
import { storeRegistrant } from "../orders/registrant.ts";
import { prepare } from "../stepup/testkit.ts";
import { MemoryAnchorSink } from "../ops/anchor.ts";
import { restoreDrill } from "../ops/restore.ts";
import type { AppContext } from "../ports.ts";
import { closureSweep } from "./closure.ts";
import { replayErasures } from "./purge.ts";
import { COOLING_OFF_MS } from "./common.ts";
import { addDomain, call, gated, makeClosureKit, makePerson, q, runJobs, stepUp, type ClosureKit, type Person } from "./testkit.ts";

/**
 * Erasure (design section 2 and 3, test plan items 2 to 4; C-19, C-48; ST-143 and ST-152 extended to the closure residue).
 *
 * Item 2: after erasure no table outside the money and audit tables contains the address, name or any contact field of the erased
 * person. The scan below is stricter: it reads EVERY text, JSON, array and bytea column of EVERY table, the money and audit tables
 * included, for every seeded value, and expects none.
 */

let k: ClosureKit;
let z: Person, bob: Person;
let tmp = "";
const V = {
  name: "Zephyrine Quillfeather", street: "77 Obscure Lane", phone: "+1.5557771234", city: "Wintervale", postal: "99887",
  passkey: "Zephyrine phone", bot: "Zephyrine helper bot", network: "203.0.113",
};
let seeded: string[] = [];
let customer = "", exportId = "";

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-closure-"));
  k = await makeClosureKit();
  z = await makePerson(k, "zephyrine");
  bob = await makePerson(k, "bob-keeps");
  const { ctx } = k.h.app;
  // The registrant contact with distinctive values (encrypted at rest, so it must be deleted, not just unreadable).
  await withUser(ctx.runtime, z.user.userId, (c) => storeRegistrant(ctx, c, z.user.userId, { name: V.name, email: z.email, phone: V.phone, street: V.street, city: V.city, region: "OR", postalCode: V.postal, country: "US" }));
  // A session seen from a network, a queued security notice, an emailed code.
  await createSession(ctx, z.user.userId, { ipPrefix: `${V.network}.0/24`, uaFamily: "firefox" });
  await q(k, "insert into security_notice_queue (user_id, kind, created_at) values ($1,'passkey.added', now())", [z.user.userId]);
  await q(k, "insert into email_codes (purpose, email, user_id, code_hash, expires_at) values ('recovery',$1,$2,'\\x01', now() + interval '1 hour')", [z.email, z.user.userId]);
  // What the person typed into a step-up (a passkey label) and a token they named.
  expect((await prepare(k.h.app, z.user, { type: "passkey.add", target_id: z.user.userId, user_input: { label: V.passkey } })).status).toBe(200);
  const t = mintToken("live");
  const b = (await q(k, "insert into bindings (user_id, kind, name, token_prefix, token_hash, expires_at) values ($1,'agent',$2,$3,$4, now() + interval '30 days') returning id", [z.user.userId, V.bot, t.prefix, t.hash]))[0].id;
  await q(k, "insert into agent_requests (user_id, binding_id, kind, request_hash, params, ip_prefix, created_at, expires_at) values ($1,$2,'scope',$3,'{}',$4, now(), now() + interval '1 hour')", [z.user.userId, b, sha256("r"), `${V.network}.0/24`]);
  // A name whose registrant email hash is cached, and money: an order, its payment, the Stripe customer and Stripe's webhook copy.
  const d = await addDomain(k, z, `zephyrine-${Date.now().toString(36)}.com`);
  await q(k, "update domains set owner_email_hash = $2 where id = $1", [d, sha256(z.email.toLowerCase()).toString("hex")]);
  customer = `cus_zeph${Math.random().toString(36).slice(2, 10)}`;
  const cs = `cs_zeph${Math.random().toString(36).slice(2, 10)}`;
  const pi = `pi_zeph${Math.random().toString(36).slice(2, 10)}`;
  const o = (await q(k, `insert into orders (user_id, kind, fqdn_ascii, domain_id, years, state, idempotency_key, request_hash, quote, subtotal_minor, tax_ceiling_minor, total_minor, livemode, stripe_customer_id, stripe_checkout_session_id, stripe_payment_intent_id)
    values ($1,'register',(select fqdn_ascii from domains where id = $2),$2,1,'captured','zk','\\x00','{}',1000,0,1000,false,$3,$4,$5) returning id`, [z.user.userId, d, customer, cs, pi]))[0].id;
  await q(k, "insert into payments (order_id, user_id, stripe_payment_intent_id, amount_minor, currency, status, livemode, billing_state) values ($1,$2,$3,1000,'usd','succeeded',false,'OR')", [o, z.user.userId, pi]);
  await q(k, "insert into webhook_events (provider, event_id, type, payload) values ('stripe',$1,'checkout.session.completed',$2)",
    [`evt_${Math.random().toString(36).slice(2)}`, { data: { object: { id: cs, customer, payment_intent: pi, customer_details: { email: z.email, name: V.name, address: { line1: V.street, city: V.city, postal_code: V.postal } } } } }]);
  // Bob's own copy of a Stripe event stays: erasure touches only Zephyrine's objects.
  await q(k, "insert into webhook_events (provider, event_id, type, payload) values ('stripe',$1,'checkout.session.completed',$2)", [`evt_bob_${Math.random().toString(36).slice(2)}`, { data: { object: { id: "cs_bob_keep", customer_details: { email: bob.email } } } }]);
  // A ready export (a full copy of the data), then the closure itself.
  const e = await stepUp(k, z, "account.export");
  expect((await call(k, z, "POST", "/api/v1/account/export", {}, gated(e.actionId))).status).toBe(202);
  await runJobs(k, ["account.export"]);
  exportId = (await q(k, "select id from account_exports where user_id = $1", [z.user.userId]))[0].id;
  seeded = [z.email, z.second, V.name, V.street, V.phone, V.city, V.postal, V.passkey, V.bot, V.network, sha256(z.email.toLowerCase()).toString("hex"), "zephyrine laptop key"];
}, 180_000);
afterAll(async () => { await k?.drop(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** Every text-like column of every base table, and the seeded values found in it. */
async function scan(pool: Pick<pg.Pool, "query">, values: string[]): Promise<string[]> {
  const cols = (await pool.query(
    `select c.table_name, c.column_name, c.data_type from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
        and (c.data_type in ('text','character varying','character','jsonb','json','ARRAY','bytea') or c.udt_name = 'citext')`)).rows;
  expect(cols.length).toBeGreaterThan(100);
  const pats = values.map((v) => `%${v.replace(/[\\%_]/g, (m) => "\\" + m)}%`);
  const hits: string[] = [];
  for (const c of cols) {
    const expr = c.data_type === "bytea" ? `encode("${c.column_name}", 'escape')` : `"${c.column_name}"::text`;
    const r = await pool.query(`select ${expr} as v from "${c.table_name}" where ${expr} ilike any($1::text[]) limit 1`, [pats]);
    if (r.rowCount) hits.push(`${c.table_name}.${c.column_name}: ${values.find((v) => String(r.rows[0].v).toLowerCase().includes(v.toLowerCase()))}`);
  }
  return hits;
}

describe("design test 2 (C-19, C-48): after erasure no table holds the person's address, name or any contact field", () => {
  it("the scan finds the seeded values before the closure (it is not vacuous)", async () => {
    const hits = await scan(k.h.app.db.owner, seeded);
    for (const t of ["users.email", "notification_addresses.address", "bindings.name", "webhook_events.payload", "passkeys.label", "actions.user_input", "sessions.ip_prefix", "domains.owner_email_hash", "email_codes.email"]) {
      expect(hits.some((h) => h.startsWith(t)), `${t} seeded`).toBe(true);
    }
  });

  it("close, wait out the cooling-off, sweep: purged, and the scan finds nothing anywhere", async () => {
    const s = await stepUp(k, z, "account.close", { delete_domains: true });
    expect((await call(k, z, "POST", "/api/v1/account/close", {}, gated(s.actionId))).status).toBe(202);
    k.h.app.clock.advance(COOLING_OFF_MS + 1000);
    await closureSweep(k.h.app.ctx);
    expect((await q(k, "select status from users where id = $1", [z.user.userId]))[0].status).toBe("purged");
    expect(await scan(k.h.app.db.owner, seeded)).toEqual([]);
    // Encrypted copies are gone too, not just unreadable: contacts, the export file and its tickets.
    for (const [t, col] of [["contacts", "user_id"], ["account_export_files", "user_id"], ["account_export_tickets", "user_id"], ["passkeys", "user_id"], ["sessions", "user_id"]] as const) {
      expect((await q(k, `select count(*)::int as n from ${t} where ${col} = $1`, [z.user.userId]))[0].n, t).toBe(0);
    }
    expect((await q(k, "select storage_ref, state from account_exports where id = $1", [exportId]))[0]).toEqual({ storage_ref: null, state: "expired" });
    // The tombstone and the money records stay (C-19), and the audit chain is intact and holds no personal data (design section 2).
    expect((await q(k, "select email::text as e from users where id = $1", [z.user.userId]))[0].e).toBe(`erased-${z.user.userId}@erased.invalid`);
    expect((await q(k, "select count(*)::int as n from orders where user_id = $1", [z.user.userId]))[0].n).toBe(1);
    expect((await q(k, "select count(*)::int as n from audit_log where chain_id = $1 and pii is not null", [z.user.userId]))[0].n).toBe(0);
    expect(await tx(k.h.app.ctx.cron, (c) => verifyChain(k.h.app.ctx, c, z.user.userId))).toMatchObject({ ok: true });
    expect(k.stripeCustomers.deleted.has(customer)).toBe(true);
  });

  it("nobody else is touched: Bob's rows, addresses, contact and Stripe copy are all still there", async () => {
    expect((await q(k, "select status from users where id = $1", [bob.user.userId]))[0].status).toBe("active");
    expect((await q(k, "select count(*)::int as n from contacts where user_id = $1", [bob.user.userId]))[0].n).toBe(1);
    expect((await scan(k.h.app.db.owner, [bob.email])).length).toBeGreaterThan(0);
    expect((await q(k, "select count(*)::int as n from webhook_events where payload::text like '%cs_bob_keep%'"))[0].n).toBe(1);
  });
});

describe("ST-143 and ST-152 with the closure residue: a restore to before the erasure, then the replay", () => {
  it("restores last night's backup (Zephyrine alive, export file present, Stripe customer not deleted), and the replay erases her again", async () => {
    // A person erased after the backup, with everything the residue covers.
    const r = await makePerson(k, "restored");
    await withUser(k.h.app.ctx.runtime, r.user.userId, (c) => storeRegistrant(k.h.app.ctx, c, r.user.userId, { name: "Restorina Backupwell", email: r.email, phone: "+1.5550001111", street: "5 Snapshot Row", city: "Rewind", region: "OR", postalCode: "12345", country: "US" }));
    const tok = mintToken("live");
    await q(k, "insert into bindings (user_id, kind, name, token_prefix, token_hash, expires_at) values ($1,'agent','Restorina bot',$2,$3, now() + interval '30 days')", [r.user.userId, tok.prefix, tok.hash]);
    const rc = `cus_rest${Math.random().toString(36).slice(2, 10)}`;
    await q(k, "insert into stripe_customers (user_id, stripe_customer_id, livemode) values ($1,$2,false)", [r.user.userId, rc]);
    await q(k, "delete from rate_counters");
    const e = await stepUp(k, r, "account.export");
    expect((await call(k, r, "POST", "/api/v1/account/export", {}, gated(e.actionId))).status).toBe(202);
    await runJobs(k, ["account.export"]);
    const dump = path.join(tmp, "nightly.dump");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { DEFAULT_PG_BIN } = await import("../ops/restore.ts");
    await promisify(execFile)(path.join(DEFAULT_PG_BIN, "pg_dump"), ["--format=custom", "--no-owner", "--file", dump, k.h.app.db.urlFor("owner")]);
    const backupTakenAt = k.h.app.clock.now();

    // After the backup: the closure runs to the end (ledger entry, eraseUser, residue, Stripe deletion).
    const s = await stepUp(k, r, "account.close", {});
    expect((await call(k, r, "POST", "/api/v1/account/close", {}, gated(s.actionId))).status).toBe(202);
    k.h.app.clock.advance(COOLING_OFF_MS + 1000);
    await closureSweep(k.h.app.ctx);
    expect((await q(k, "select status from users where id = $1", [r.user.userId]))[0].status).toBe("purged");
    expect(k.stripeCustomers.deleted.has(rc)).toBe(true);
    const callsBefore = k.stripeCustomers.calls.length;

    // The restore: the ops drill replays the ledger (eraseUser) into a scratch copy of the backup ...
    const drill = await restoreDrill({ sourceUrl: k.h.app.db.urlFor("owner"), ledger: k.ledger, sink: new MemoryAnchorSink(), kms: k.h.app.ctx.kms, clock: k.h.app.clock, workDir: tmp, dumpFile: dump, backupTakenAt, keepScratch: true, label: "closure" });
    const scratchUrl = new URL(k.h.app.db.urlFor("owner")); scratchUrl.pathname = "/" + drill.scratchDb;
    const scratch = connect(scratchUrl.toString(), { max: 2 });
    try {
      expect(drill.resurrected).toBe(0);
      expect((await scratch.query("select status from users where id = $1", [r.user.userId])).rows[0].status).toBe("purged");
      // ... but the residue came back with the backup: the export file, the token's name, the live Stripe customer row.
      expect((await scratch.query("select count(*)::int as n from account_export_files where user_id = $1", [r.user.userId])).rows[0].n).toBe(1);
      expect((await scratch.query("select name from bindings where user_id = $1", [r.user.userId])).rows[0].name).toBe("Restorina bot");
      expect((await scratch.query("select deleted_at from stripe_customers where user_id = $1", [r.user.userId])).rows[0].deleted_at).toBeNull();
      // The closure replay on the restored copy (what account.closure runs every hour) erases it again.
      const sctx: AppContext = { ...k.h.app.ctx, cron: scratch, runtime: scratch };
      const rep = await replayErasures(sctx, k.ledger);
      expect(rep.residue).toBeGreaterThanOrEqual(1);
      expect((await scratch.query("select count(*)::int as n from account_export_files where user_id = $1", [r.user.userId])).rows[0].n).toBe(0);
      expect((await scratch.query("select name from bindings where user_id = $1", [r.user.userId])).rows[0].name).toBe("erased");
      // Stripe is asked again, answers that the customer is already gone, and the row records it.
      expect(k.stripeCustomers.calls.length).toBeGreaterThan(callsBefore);
      expect((await scratch.query("select deleted_at from stripe_customers where user_id = $1", [r.user.userId])).rows[0].deleted_at).not.toBeNull();
      expect(await scan(scratch, [r.email, r.second, "Restorina", "Snapshot Row"])).toEqual([]);
      // A second replay finds nothing left to do.
      expect((await replayErasures(sctx, k.ledger)).residue).toBe(0);
    } finally {
      await scratch.end();
      const a = new pg.Client({ connectionString: k.h.app.db.urlFor("owner") }); await a.connect();
      await a.query(`drop database if exists "${drill.scratchDb}" with (force)`); await a.end();
    }
  }, 180_000);
});
