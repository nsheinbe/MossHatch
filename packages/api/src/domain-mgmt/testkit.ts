import { expect } from "vitest";
import { MockRegistrarPort, type DnsOverwriteMode } from "@mosshatch/registrar/mock-port";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { buildRouter } from "../routes.ts";
import { addPasskey, commit, makeUser, newSession, prepare, type TestUser } from "../stepup/testkit.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { runTick } from "../jobs/engine.ts";
import { REGISTRANT } from "../orders/testkit.ts";
import { storeRegistrant } from "../orders/registrant.ts";
import { withUser } from "@mosshatch/db";

export { REGISTRANT };
export type Key = Awaited<ReturnType<typeof addPasskey>>;
export interface Kit { app: TestApp; registrar: MockRegistrarPort }

export async function makeKit(o: { dnsOverwrite?: DnsOverwriteMode } = {}): Promise<Kit> {
  const app = await createTestApp(buildRouter());
  app.clock.set(new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000));   // a minute ahead of the database, so due jobs are due
  const registrar = new MockRegistrarPort({ clock: app.clock, dnsOverwrite: o.dnsOverwrite });
  (app.ctx.services as Record<string, unknown>).domainMgmt = { registrar };
  return { app, registrar };
}

export interface Person { user: TestUser; key: Key; login: string; second: string; registrantAddr: string }

/** A person with a passkey and three notification addresses: login, second and registrant. */
export async function makePerson(k: Kit, tag: string, o: { second?: boolean; registrantKind?: boolean; contactEmail?: string } = {}): Promise<Person> {
  const email = `${tag}-login@example.org`;
  const user = await makeUser(k.app, email);
  const key = await addPasskey(k.app, user);
  const second = `${tag}-second@example.org`, registrantAddr = `${tag}-registrant@example.org`;
  await k.app.db.owner.query("insert into notification_addresses (user_id, address, kind, verified_at) values ($1,$2,'login',now())", [user.userId, email]);
  if (o.second !== false) await k.app.db.owner.query("insert into notification_addresses (user_id, address, kind, verified_at) values ($1,$2,'second',now())", [user.userId, second]);
  if (o.registrantKind !== false) await k.app.db.owner.query("insert into notification_addresses (user_id, address, kind, verified_at) values ($1,$2,'registrant',now())", [user.userId, registrantAddr]);
  // The contact given at checkout: what the registrar holds for the person's domains until a change of registrant.
  await withUser(k.app.ctx.runtime, user.userId, (c) => storeRegistrant(k.app.ctx, c, user.userId, { ...REGISTRANT, email: o.contactEmail ?? registrantAddr }));
  return { user, key, login: email, second, registrantAddr };
}

/** Register the name at the mock registrar and record it as the person's domain (`registrar` is the `domains.registrar` value, 'mock' by default). */
export async function makeDomain(k: Kit, p: Person, fqdn: string, o: { registrantEmail?: string; registrar?: string } = {}): Promise<{ id: string; fqdn: string }> {
  const reg = { ...REGISTRANT, email: o.registrantEmail ?? p.registrantAddr };
  k.registrar.setKind(fqdn, "available");
  await k.registrar.register({ fqdn, years: 1, regUsername: "u" + Math.random().toString(36).slice(2, 10), regPassword: "pw" + Math.random().toString(36).slice(2, 16), registrant: reg });
  const st = (await k.registrar.getDomain(fqdn))!;
  const row = (await k.app.db.owner.query(
    `insert into domains (user_id, fqdn_ascii, tld, registrar, state, registered_at, registry_created_at, expires_at, locked, nameservers, dns_hosted_here, livemode)
     values ($1,$2,$3,$8,'registered',$4,$4,$5,$6,$7,true,false) returning id`,
    [p.user.userId, fqdn, fqdn.slice(fqdn.indexOf(".") + 1), k.app.clock.now(), st.expiresAt, st.locked, st.nameservers, o.registrar ?? "mock"])).rows[0];
  return { id: row.id, fqdn };
}

/** Prepare and commit a step-up with a virtual passkey. Returns the action id to send in the header. */
export async function stepUp(k: Kit, p: Person, type: string, target: string, userInput: unknown = {}): Promise<string> {
  const prep = await prepare(k.app, p.user, { type, target_id: target, user_input: userInput });
  expect(prep.status, JSON.stringify(prep.json)).toBe(200);
  const done = await commit(k.app, p.user, prep.json.action_id, p.key.auth.get(prep.json.webauthn_options));
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  return prep.json.action_id as string;
}

export const call = (k: Kit, p: Person, method: string, path: string, body?: unknown, actionId?: string, headers: Record<string, string> = {}) =>
  k.app.call(method, path, { cookie: p.user.cookie, body: body === undefined && method !== "GET" ? {} : body, headers: { ...(actionId ? { [ACTION_HEADER]: actionId } : {}), ...headers } });

/** Clear the route-level fuse counters (each test starts inside a fresh hour). */
export const resetFuse = async (k: Kit) => {
  await k.app.db.owner.query("delete from rate_counters where bucket like 'fuse.%' or bucket = 'stepup_prepare'");
  // The tick's auto-safe mode pauses registrar writes when an S1 page goes unacknowledged for 30 minutes: real behaviour, unwanted between tests.
  await k.app.db.owner.query("update flags set value = 'false' where name = 'registrar_writes_paused'");
};

export const tick = (k: Kit) => runTick(k.app.ctx, { heartbeat: false, budgetMs: 5_000 });

/** Everything a canary could hide in, as one string: every table that stores payloads, columns, logs and mail. */
export async function everythingStored(k: Kit, o: { mail?: boolean } = {}): Promise<string> {
  const tables = ["audit_log", "jobs", "domain_security", "domains", "domain_tickets", "domain_transfers_away", "alerts", "email_log", "actions", "contact_changes", "dns_snapshots", "order_events"];
  const out: string[] = [];
  for (const t of tables) out.push(JSON.stringify((await k.app.db.owner.query(`select * from ${t}`)).rows));
  if (o.mail !== false) out.push(JSON.stringify(k.app.email.sent));
  return out.join("\n");
}

/** After the test clock moved far enough to expire the session: sign the person in again (a new session cookie). */
export async function refreshSession(k: Kit, p: Person): Promise<void> { p.user = await newSession(k.app, p.user); }
export const resetPrepareLimit = (k: Kit) => k.app.db.owner.query("delete from rate_counters where bucket = 'stepup_prepare'");

/** Let the 5-minute schedule come round once (the tick enqueues one recurring job per bucket), then run the tick. */
export const poll = async (k: Kit) => { k.app.clock.advance(5 * 60_000); return tick(k); };
