import { expect } from "vitest";
import { withUser } from "@mosshatch/db";
import { buildRouter } from "../routes.ts";
import { makeHarness, REGISTRANT, type OrdersHarness } from "../orders/testkit.ts";
import { addPasskey, commit, makeUser, prepare, type TestUser } from "../stepup/testkit.ts";
import { storeRegistrant } from "../orders/registrant.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { MemoryErasureLedger } from "../ops/erasure.ts";
import { completeJob, runTick } from "../jobs/engine.ts";
import { getJobDef } from "../jobs/registry.ts";
import { FakeStripeCustomers, installClosure } from "./services.ts";
import { registerClosureJobs } from "./routes.ts";

export interface ClosureKit {
  h: OrdersHarness;
  ledger: MemoryErasureLedger;
  stripeCustomers: FakeStripeCustomers;
  deleted: string[];
  drop(): Promise<void>;
}

/** The full route table on the orders harness (fake Stripe, mock registrar), an in-memory erasure ledger and the fake Stripe eraser. */
export async function makeClosureKit(): Promise<ClosureKit> {
  const h = await makeHarness();
  h.app.router = buildRouter();
  registerClosureJobs();
  const ledger = new MemoryErasureLedger();
  const stripeCustomers = new FakeStripeCustomers();
  Object.assign(h.app.ctx.services, { erasureLedger: ledger });
  installClosure(h.app.ctx, { stripeCustomers });
  const deleted: string[] = [];
  h.svc.deleteDomain = async (fqdn: string) => { deleted.push(fqdn); };
  return { h, ledger, stripeCustomers, deleted, drop: () => h.app.drop() };
}

export type Key = Awaited<ReturnType<typeof addPasskey>>;
export interface Person { user: TestUser; key: Key; email: string; second: string }

let n = 0;
/** A signed-in person with a passkey, two verified addresses and a registrant contact. */
export async function makePerson(k: ClosureKit, tag: string): Promise<Person> {
  const email = `${tag}-${++n}-${Date.now().toString(36)}@example.org`;
  const second = `${tag}-second-${n}@example.net`;
  const user = await makeUser(k.h.app, email);
  const key = await addPasskey(k.h.app, user, { label: `${tag} laptop key` });
  await k.h.app.db.owner.query("insert into notification_addresses (user_id, address, kind, verified_at) values ($1,$2,'login',now()),($1,$3,'second',now())", [user.userId, email, second]);
  await withUser(k.h.app.ctx.runtime, user.userId, (c) => storeRegistrant(k.h.app.ctx, c, user.userId, { ...REGISTRANT, email }));
  return { user, key, email, second };
}

export async function addDomain(k: ClosureKit, p: Person, fqdn: string): Promise<string> {
  const r = await k.h.app.db.owner.query(
    "insert into domains (user_id, fqdn_ascii, tld, registrar, state, locked, nameservers, livemode, expires_at, registered_at) values ($1,$2,$3,'opensrs','registered',true,'{ns1.systemdns.com}',false, now() + interval '300 days', now() - interval '60 days') returning id",
    [p.user.userId, fqdn, fqdn.split(".").pop()]);
  return r.rows[0].id as string;
}

export const call = (k: ClosureKit, p: Person, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  k.h.app.call(method, path, { cookie: p.user.cookie, body: body === undefined && method !== "GET" ? {} : body, headers });

/** Prepare and commit a step-up with the person's virtual passkey; returns the prepare answer and the committed action id. */
export async function stepUp(k: ClosureKit, p: Person, type: "account.close" | "account.export", userInput: unknown = {}): Promise<{ actionId: string; summary: string }> {
  const prep = await prepare(k.h.app, p.user, { type, target_id: p.user.userId, user_input: userInput });
  expect(prep.status, JSON.stringify(prep.json)).toBe(200);
  const done = await commit(k.h.app, p.user, prep.json.action_id, p.key.auth.get(prep.json.webauthn_options));
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  return { actionId: prep.json.action_id as string, summary: prep.json.summary as string };
}

export const gated = (actionId: string) => ({ [ACTION_HEADER]: actionId });

/** Run queued jobs through the real engine until none are due. */
export async function drain(k: ClosureKit, rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const r = await runTick(k.h.app.ctx, { heartbeat: false, budgetMs: 10_000 });
    if (r.claimed === 0) return;
  }
}

/**
 * Run only the queued jobs of these kinds, with a real lease (the handlers' `withLease` checks it), the way the engine would. The full
 * route table registers every module's recurring jobs; this keeps a test to the jobs it is about.
 */
export async function runJobs(k: ClosureKit, kinds: string[]): Promise<number> {
  const { ctx } = k.h.app;
  let n = 0;
  for (let round = 0; round < 10; round++) {
    const now = ctx.clock.now();
    const r = await ctx.cron.query(
      `update jobs set state = 'running', attempt_id = gen_random_uuid(), attempts = attempts + 1, locked_until = $1::timestamptz + interval '10 minutes'
        where id in (select id from jobs where state = 'queued' and kind = any($2::text[]) and run_at <= $1 order by run_at, id limit 20 for update skip locked)
        returning id, kind, attempt_id, attempts, max_attempts, payload, user_id`, [now, kinds]);
    if (!r.rowCount) return n;
    for (const j of r.rows) {
      await getJobDef(j.kind)!.handler(ctx, j);
      await completeJob(ctx.cron, j.id, j.attempt_id, ctx.clock.now());
      n++;
    }
  }
  return n;
}

export const q = <T = any>(k: ClosureKit, sql: string, p: unknown[] = []) => k.h.app.db.owner.query(sql, p).then((r) => r.rows as T[]);
