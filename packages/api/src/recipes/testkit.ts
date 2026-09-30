import { expect } from "vitest";
import { MockRegistrarPort } from "@mosshatch/registrar/mock-port";
import type { DnsRecord } from "@mosshatch/registrar/port";
import { makeVaultKit, makePerson as makeVaultPerson, type Person, type VaultKit } from "../vault/testkit.ts";
import { commit, prepare } from "../stepup/testkit.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { runTick } from "../jobs/engine.ts";
import { REGISTRANT } from "../orders/testkit.ts";
import { installRecipeProviders } from "./providers.ts";
import { makeFakes, type Fakes } from "./fakes.ts";

export interface RecipeKit extends VaultKit { registrar: MockRegistrarPort; fakes: Fakes }

export async function makeRecipeKit(): Promise<RecipeKit> {
  const v = await makeVaultKit();
  const registrar = new MockRegistrarPort({ clock: v.app.clock });
  (v.app.ctx.services as Record<string, unknown>).domainMgmt = { registrar };
  const fakes = makeFakes();
  installRecipeProviders(v.app.ctx, fakes);
  return { ...v, registrar, fakes };
}

let n = 0;
/** A person with a passkey and a domain registered at the mock registrar, DNS hosted there. */
export async function makePerson(k: RecipeKit, tag: string): Promise<Person> {
  const fqdn = `${tag}-${++n}-wire.com`;
  k.registrar.setKind(fqdn, "available");
  await k.registrar.register({ fqdn, years: 1, regUsername: `u${n}${tag}`.slice(0, 20), regPassword: `pw-${Math.random().toString(36).slice(2, 14)}`, registrant: REGISTRANT } as never);
  return makeVaultPerson(k, tag, fqdn);
}

export const web = (k: RecipeKit, p: Person, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  k.app.call(method, path, { cookie: p.user.cookie, body: body === undefined && method !== "GET" ? {} : body, headers });
export const bearer = (k: RecipeKit, token: string, method: string, path: string, body?: unknown) =>
  k.app.call(method, path, { authorization: `Bearer ${token}`, body, browser: false });

export const tick = async (k: RecipeKit) => { for (let i = 0; i < 4; i++) { const r = await runTick(k.app.ctx, { heartbeat: false, budgetMs: 5000 }); if (r.claimed === 0) break; } };

/** Connect a service with a pasted credential and run its check, so the plan has provider facts. */
export async function connect(k: RecipeKit, p: Person, service: "vercel" | "neon" | "resend", credential: string, externalRef?: string) {
  const r = await web(k, p, "PUT", `/api/v1/domains/${p.domain.fqdn}/connections/${service}`, { kind: "pasted_token", credential, ...(externalRef ? { external_ref: externalRef } : {}) });
  expect(r.status, r.text).toBe(201);
  const c = await web(k, p, "POST", `/api/v1/domains/${p.domain.fqdn}/connections/${service}/check`);
  expect(c.status, c.text).toBe(202);
  await tick(k);
  return r.json.connection_id as string;
}

export async function zone(k: RecipeKit, fqdn: string): Promise<DnsRecord[]> { return (await k.registrar.getDns(fqdn)).records; }
export async function seedZone(k: RecipeKit, fqdn: string, records: DnsRecord[]) { await k.registrar.replaceZone(fqdn, records); }

export const plan = (k: RecipeKit, p: Person, recipe: string, input: unknown = {}) => web(k, p, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/${recipe}/plan`, { input });
export const applyReq = (k: RecipeKit, p: Person, recipe: string, applicationId: string, planHash: string) =>
  web(k, p, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/${recipe}/apply`, { application_id: applicationId, plan_hash: planHash });

/** The one plan-hash approval: prepare, passkey, commit, then the gated approve route. Returns the summary signed. */
export async function approvePlan(k: RecipeKit, p: Person, applicationId: string): Promise<{ summary: string; actionId: string }> {
  const prep = await prepare(k.app, p.user, { type: "dns.sensitive.approve", target_id: applicationId, user_input: {} });
  expect(prep.status, prep.text).toBe(200);
  const done = await commit(k.app, p.user, prep.json.action_id, p.key.auth.get(prep.json.webauthn_options));
  expect(done.status, done.text).toBe(200);
  const r = await web(k, p, "POST", `/api/v1/recipe-applications/${applicationId}/approve`, {}, { [ACTION_HEADER]: prep.json.action_id });
  expect(r.status, r.text).toBe(200);
  return { summary: prep.json.summary, actionId: prep.json.action_id };
}

export const appRow = async (k: RecipeKit, id: string) => (await k.app.db.owner.query("select * from recipe_applications where id = $1", [id])).rows[0];
