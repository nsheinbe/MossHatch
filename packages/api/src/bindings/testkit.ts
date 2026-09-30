import { expect } from "vitest";
import type { TestApp } from "../testing/app.ts";
import { commit, prepare, type TestUser } from "../stepup/testkit.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import type { Person, VaultKit } from "../vault/testkit.ts";

/** Helpers for the device flow and bindings tests. Requests from the CLI carry no browser headers (`browser: false`). */

export const cli = (app: TestApp, method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) =>
  app.call(method, path, { body, browser: false, authorization: token ? `Bearer ${token}` : undefined, headers: { "x-forwarded-for": "203.0.113.9", ...headers } });

export const web = (app: TestApp, u: TestUser, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.call(method, path, { cookie: u.cookie, body: body === undefined && method !== "GET" ? {} : body, headers: { "x-forwarded-for": "198.51.100.7", ...headers } });

export async function deviceCode(app: TestApp, o: { scope?: string; client_name?: string } = {}) {
  const r = await cli(app, "POST", "/api/v1/oauth/device/code", { client_id: "mosshatch-cli", ...o });
  expect(r.status, r.text).toBe(200);
  return r.json as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
}

export const poll = (app: TestApp, deviceCodeValue: string) =>
  cli(app, "POST", "/api/v1/oauth/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCodeValue, client_id: "mosshatch-cli" });

/** Look up, prepare, commit and approve with the person's passkey. Returns the lookup answer and the committed action id. */
export async function approveDevice(k: VaultKit, p: Person, userCode: string, input: { envs?: string[]; prod_domains?: string[] } = {}) {
  const look = await web(k.app, p.user, "POST", "/api/v1/oauth/device/lookup", { user_code: userCode });
  expect(look.status, look.text).toBe(200);
  const prep = await prepare(k.app, p.user, { type: "device.approve", target_id: look.json.request_id, user_input: { user_code: userCode, ...input } });
  expect(prep.status, prep.text).toBe(200);
  const done = await commit(k.app, p.user, prep.json.action_id, p.key.auth.get(prep.json.webauthn_options));
  expect(done.status, done.text).toBe(200);
  const ok = await web(k.app, p.user, "POST", "/api/v1/oauth/device/approve", {}, { [ACTION_HEADER]: prep.json.action_id });
  expect(ok.status, ok.text).toBe(200);
  return { lookup: look.json, actionId: prep.json.action_id as string, summary: prep.json.summary as string, approved: ok.json };
}

/** The whole login: device code, approval, one poll after the interval. */
export async function login(k: VaultKit, p: Person, o: { scope?: string; envs?: string[]; prod_domains?: string[] } = {}) {
  const dc = await deviceCode(k.app, { scope: o.scope });
  const a = await approveDevice(k, p, dc.user_code, { envs: o.envs, prod_domains: o.prod_domains });
  k.app.clock.advance(dc.interval * 1000);
  const t = await poll(k.app, dc.device_code);
  expect(t.status, t.text).toBe(200);
  return { ...a, dc, access: t.json.access_token as string, refresh: t.json.refresh_token as string, scope: t.json.scope as string };
}

/** Clear rate counters and wrong-code counters between tests. */
export const resetCounters = (app: TestApp) => app.db.owner.query("delete from rate_counters");
