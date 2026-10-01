import { expect } from "vitest";
import { connect, type Pool } from "@mosshatch/db";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { buildRouter } from "../routes.ts";
import { addPasskey, commit, makeUser, prepare, type TestUser } from "../stepup/testkit.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { mintToken } from "../util/token.ts";
import { LocalVaultKms } from "./kms/local.ts";
import { installVault } from "./context.ts";
import { registerVaultJobs } from "./jobs.ts";

export interface VaultKit { app: TestApp; kms: LocalVaultKms; vaultPool: Pool; drop(): Promise<void> }

/** A login role in the vault group, like the deployment's `DATABASE_URL_VAULT` user. */
export async function vaultPoolFor(app: TestApp): Promise<Pool> {
  try {
    await app.db.owner.query("do $$ begin if not exists (select 1 from pg_roles where rolname = 'mh_vault_login') then create role mh_vault_login login nobypassrls password 'mh_test_pw'; end if; end $$");
  } catch { /* created concurrently by another worker */ }
  try { await app.db.owner.query("grant mh_vault to mh_vault_login"); } catch { /* concurrent grant */ }
  const u = new URL(app.db.urlFor("runtime"));
  u.username = "mh_vault_login";
  return connect(u.toString(), { max: 10 });
}

export async function makeVaultKit(o: { timeoutMs?: number } = {}): Promise<VaultKit> {
  const app = await createTestApp(buildRouter());
  app.clock.set(new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000));
  const kms = new LocalVaultKms({ clock: app.clock });
  const vaultPool = await vaultPoolFor(app);
  installVault(app.ctx, { pool: vaultPool, kms, admin: kms, timeoutMs: o.timeoutMs ?? 3000 });
  registerVaultJobs();
  return { app, kms, vaultPool, drop: async () => { await vaultPool.end(); await app.drop(); } };
}

export type Key = Awaited<ReturnType<typeof addPasskey>>;
export interface Person { user: TestUser; key: Key; login: string; domain: { id: string; fqdn: string } }

let seq = 0;
export async function makePerson(k: VaultKit, tag: string, fqdn = `${tag}-${++seq}-nest.com`): Promise<Person> {
  const login = `${tag}-login@example.org`;
  const user = await makeUser(k.app, login);
  const key = await addPasskey(k.app, user);
  await k.app.db.owner.query("insert into notification_addresses (user_id, address, kind, verified_at) values ($1,$2,'login',now()),($1,$3,'second',now())", [user.userId, login, `${tag}-second@example.net`]);
  const d = (await k.app.db.owner.query(
    "insert into domains (user_id, fqdn_ascii, tld, registrar, state, locked, nameservers, livemode) values ($1,$2,'com','mock','registered',true,'{ns1.systemdns.com}',false) returning id", [user.userId, fqdn])).rows[0];
  return { user, key, login, domain: { id: d.id, fqdn } };
}

export const call = (k: VaultKit, p: Person, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  k.app.call(method, path, { cookie: p.user.cookie, body: body === undefined && method !== "GET" ? {} : body, headers });

export async function putSecret(k: VaultKit, p: Person, env: string, name: string, value: string) {
  return call(k, p, "PUT", `/api/v1/domains/${p.domain.fqdn}/secrets/${env}/${name}`, { value });
}

/** Prepare and commit a `secret.reveal` with the person's virtual passkey; returns the action id. */
export async function activateReveal(k: VaultKit, p: Person, secretId: string): Promise<string> {
  const prep = await prepare(k.app, p.user, { type: "secret.reveal", target_id: secretId, user_input: {} });
  expect(prep.status, JSON.stringify(prep.json)).toBe(200);
  const done = await commit(k.app, p.user, prep.json.action_id, p.key.auth.get(prep.json.webauthn_options));
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  return prep.json.action_id as string;
}

export const reveal = (k: VaultKit, p: Person, secretId: string, actionId?: string) =>
  call(k, p, "POST", `/api/v1/secrets/${secretId}/reveal`, {}, actionId ? { [ACTION_HEADER]: actionId } : {});

/** A binding row for the person (the tokens module creates these through a step-up; here the fixture inserts it). */
export async function makeBinding(k: VaultKit, p: Person, scopes: unknown, kind: "agent" | "cli" = "agent"): Promise<{ id: string; token: string }> {
  const m = mintToken(kind === "cli" ? "cli" : "live");
  const r = await k.app.db.owner.query("insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, expires_at) values ($1,$2,'t',$3,$4,$5, now() + interval '30 days') returning id",
    [p.user.userId, kind, m.prefix, m.hash, JSON.stringify(scopes)]);
  return { id: r.rows[0].id, token: m.token };
}

export const bearerRead = (k: VaultKit, fqdn: string, env: string, token: string, body: unknown = {}) =>
  k.app.call("POST", `/api/v1/domains/${fqdn}/secrets/${env}/read`, { authorization: `Bearer ${token}`, body, browser: false });

/** Every place a canary could hide on the server side: tables that hold payloads, logs or mail, plus the fake mail transport. */
export async function everySink(k: VaultKit): Promise<string> {
  const tables = ["audit_log", "jobs", "alerts", "email_log", "actions", "secrets", "connections", "rate_counters", "security_notice_queue", "webhook_events"];
  const out: string[] = [];
  for (const t of tables) out.push(JSON.stringify((await k.app.db.owner.query(`select * from ${t}`)).rows));
  out.push(JSON.stringify(k.app.email.sent));
  out.push(JSON.stringify(k.kms.events));
  return out.join("\n");
}

/** Ciphertext columns as text, to prove no plaintext is stored beside them. */
export async function ciphertextColumns(k: VaultKit): Promise<string> {
  const a = (await k.app.db.owner.query("select encode(coalesce(ciphertext,'\\x'),'escape') as c from secret_versions union all select encode(coalesce(ciphertext,'\\x'),'escape') from connection_credentials")).rows;
  return a.map((r) => r.c).join("\n");
}
