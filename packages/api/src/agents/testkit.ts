import crypto from "node:crypto";
import { expect } from "vitest";
import { withUser, type Pool } from "@mosshatch/db";
import { buildRouter } from "../routes.ts";
import { makeHarness, REGISTRANT, type OrdersHarness } from "../orders/testkit.ts";
import { storeRegistrant } from "../orders/registrant.ts";
import { addPasskey, commit, makeUser, prepare, type TestUser } from "../stepup/testkit.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { LocalVaultKms } from "../vault/kms/local.ts";
import { installVault } from "../vault/context.ts";
import { registerVaultJobs } from "../vault/jobs.ts";
import { vaultPoolFor } from "../vault/testkit.ts";
import type { TestApp } from "../testing/app.ts";
import type { GitHubKey, GitHubKeysPort } from "./scanning.ts";
import type { ClientMetadataPort } from "../oauth/clients.ts";

/** Helpers for the agent-surface tests: the full router, Fake Stripe, the mock registrar and a real vault on one database. */

export interface AgentKit { h: OrdersHarness; app: TestApp; kms: LocalVaultKms; vaultPool: Pool; github: FakeGitHubKeys; cimd: FakeMetadata; drop(): Promise<void> }

/** GitHub's key document, served from a key pair made here (the real endpoint is never called in tests). */
export class FakeGitHubKeys implements GitHubKeysPort {
  readonly pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  readonly id = "90a421169f0a406205f1563a953312f0be898d3c7b6c06b681aa86a874555f4a";
  calls = 0;
  async fetchKeys(): Promise<GitHubKey[]> { this.calls++; return [{ id: this.id, pem: this.pair.publicKey.export({ type: "spki", format: "pem" }).toString(), current: true }]; }
  sign(body: string, key = this.pair.privateKey): string { return crypto.sign("sha256", Buffer.from(body), { key, dsaEncoding: "der" }).toString("base64"); }
}

/** Client ID Metadata Documents by URL (no network). */
export class FakeMetadata implements ClientMetadataPort {
  docs = new Map<string, unknown>();
  fetched: string[] = [];
  async fetch(url: string) { this.fetched.push(url); if (!this.docs.has(url)) throw new Error("not_found"); return this.docs.get(url); }
}

export async function makeAgentKit(o: { taxBps?: number } = {}): Promise<AgentKit> {
  const h = await makeHarness({ taxBps: o.taxBps ?? 800 });
  h.app.router = buildRouter();
  const kms = new LocalVaultKms({ clock: h.app.clock });
  const vaultPool = await vaultPoolFor(h.app);
  installVault(h.app.ctx, { pool: vaultPool, kms, admin: kms, timeoutMs: 3000 });
  registerVaultJobs();
  const github = new FakeGitHubKeys();
  const cimd = new FakeMetadata();
  Object.assign(h.app.ctx.services, { githubKeys: github, clientMetadata: cimd, registrar: h.registrar });
  return { h, app: h.app, kms, vaultPool, github, cimd, drop: async () => { await vaultPool.end(); await h.app.drop(); } };
}

export interface Owner { user: TestUser; key: Awaited<ReturnType<typeof addPasskey>>; login: string }

let seq = 0;
export async function makeOwner(k: AgentKit, tag: string): Promise<Owner> {
  const login = `${tag}-${++seq}-login@example.org`;
  const user = await makeUser(k.app, login);
  await k.app.db.owner.query("update users set created_at = '2026-01-01' where id = $1", [user.userId]);
  const key = await addPasskey(k.app, user);
  await k.app.db.owner.query("insert into notification_addresses (user_id, address, kind, verified_at) values ($1,$2,'login',now()),($1,$3,'second',now())", [user.userId, login, `${tag}-${seq}-second@example.net`]);
  await withUser(k.app.ctx.runtime, user.userId, (c) => storeRegistrant(k.app.ctx, c, user.userId, { ...REGISTRANT, email: login }));
  return { user, key, login };
}

/** A domain registered at the mock registrar (DNS hosted there) and recorded as the owner's. */
export async function makeDomain(k: AgentKit, p: Owner, fqdn: string): Promise<{ id: string; fqdn: string }> {
  k.h.registrar.setKind(fqdn, "available");
  await k.h.registrar.register({ fqdn, years: 1, regUsername: "u" + crypto.randomBytes(4).toString("hex"), regPassword: "pw" + crypto.randomBytes(8).toString("hex"), registrant: { ...REGISTRANT, email: p.login } });
  const st = (await k.h.registrar.getDomain(fqdn))!;
  const row = (await k.app.db.owner.query(
    `insert into domains (user_id, fqdn_ascii, tld, registrar, state, registered_at, registry_created_at, expires_at, locked, nameservers, dns_hosted_here, livemode)
     values ($1,$2,$3,'mock','registered',$4,$4,$5,$6,$7,true,false) returning id`,
    [p.user.userId, fqdn, fqdn.slice(fqdn.indexOf(".") + 1), k.app.clock.now(), st.expiresAt, st.locked, st.nameservers])).rows[0];
  return { id: row.id, fqdn };
}

export const web = (k: AgentKit, p: Owner, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  k.app.call(method, path, { cookie: p.user.cookie, body: body === undefined && method !== "GET" ? {} : body, headers: { "x-forwarded-for": "198.51.100.7", ...headers } });
export const bearer = (k: AgentKit, token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  k.app.call(method, path, { authorization: `Bearer ${token}`, body, browser: false, headers: { "x-forwarded-for": "160.79.104.20", ...headers } });

/** Prepare and commit a step-up with the owner's passkey. */
export async function stepUp(k: AgentKit, p: Owner, type: string, target: string, input: unknown = {}) {
  const prep = await prepare(k.app, p.user, { type, target_id: target, user_input: input });
  if (prep.status !== 200) return { status: prep.status, json: prep.json, actionId: "", summary: "" };
  const done = await commit(k.app, p.user, prep.json.action_id, p.key.auth.get(prep.json.webauthn_options));
  return { status: done.status, json: done.json, actionId: prep.json.action_id as string, summary: prep.json.summary as string };
}

/** The Bindings tab's create flow: `agent.token.create` with a passkey, then POST /bindings. Returns the token (shown once). */
export async function createAgentToken(k: AgentKit, p: Owner, scopes: string[], o: { cap?: number; name?: string; days?: number } = {}) {
  const s = await stepUp(k, p, "agent.token.create", p.user.userId, { name: o.name ?? "Build bot", scopes, spend_cap_minor: o.cap ?? 0, ...(o.days ? { expires_in_days: o.days } : {}) });
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  const r = await web(k, p, "POST", "/api/v1/bindings", {}, { [ACTION_HEADER]: s.actionId });
  expect(r.status, r.text).toBe(201);
  return { id: r.json.id as string, token: r.json.token as string };
}

/** Approve a purchase request with the owner's passkey: prepare, commit, decide. */
export async function approvePurchase(k: AgentKit, p: Owner, requestId: string, typed?: string) {
  const s = await stepUp(k, p, "agent.purchase.approve", requestId, typed ? { typed_domain: typed } : {});
  if (s.status !== 200) return { status: s.status, json: s.json, text: JSON.stringify(s.json), actionId: s.actionId, headers: new Headers() };
  const r = await web(k, p, "POST", `/api/v1/approvals/${requestId}/decide`, {}, { [ACTION_HEADER]: s.actionId });
  return { ...r, actionId: s.actionId };
}

let rpcId = 0;
/** One MCP JSON-RPC call over the Streamable HTTP route. */
export async function mcp(k: AgentKit, token: string | null, method: string, params?: Record<string, unknown>, headers: Record<string, string> = {}) {
  const id = headers["x-notification"] ? undefined : ++rpcId;
  const { "x-notification": _n, ...rest } = headers;
  const res = await k.app.call("POST", "/mcp", {
    authorization: token ? `Bearer ${token}` : undefined, browser: false,
    body: { jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) },
    headers: { "x-forwarded-for": "160.79.104.20", accept: "application/json, text/event-stream", "content-type": "application/json", ...rest },
  });
  return res;
}
export const callTool = async (k: AgentKit, token: string, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
  const r = await mcp(k, token, "tools/call", { name, arguments: args }, headers);
  expect(r.status, r.text).toBe(200);
  return r.json.result as { isError: boolean; structuredContent: { data?: any; error?: { code: string } }; content: { type: string; text: string }[] };
};

export const clearCounters = (k: AgentKit) => k.app.db.owner.query("delete from rate_counters");
export const bindingRow = async (k: AgentKit, id: string) => (await k.app.db.owner.query("select * from bindings where id = $1", [id])).rows[0];
export const requestRow = async (k: AgentKit, id: string) => (await k.app.db.owner.query("select * from agent_requests where id = $1", [id])).rows[0];
