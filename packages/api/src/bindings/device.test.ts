import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makePerson, makeVaultKit, putSecret, type Person, type VaultKit } from "../vault/testkit.ts";
import { commit, prepare } from "../stepup/testkit.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { sha256 } from "../util/bytes.ts";
import { approveDevice, cli, deviceCode, login, poll, resetCounters, web } from "./testkit.ts";
import { normalizeUserCode, newUserCode, USER_CODE_ALPHABET } from "./device.ts";

let k: VaultKit;
beforeAll(async () => { k = await makeVaultKit(); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await resetCounters(k.app); });

const read = (fqdn: string, env: string, token: string) => cli(k.app, "POST", `/api/v1/domains/${fqdn}/secrets/${env}/read`, {}, token);

describe("device flow: codes and the happy path", () => {
  it("issues a 256-bit device code and an XXXX-XXXX user code from the 20-letter alphabet; no complete URI", async () => {
    const dc = await deviceCode(k.app);
    expect(Buffer.from(dc.device_code, "base64url").length).toBe(32);
    expect(dc.user_code).toMatch(new RegExp(`^[${USER_CODE_ALPHABET}]{4}-[${USER_CODE_ALPHABET}]{4}$`));
    expect(dc.expires_in).toBe(600); expect(dc.interval).toBe(5);
    expect(dc.verification_uri).toBe(`${k.app.ctx.config.origin}/device`);
    expect(JSON.stringify(dc)).not.toContain("verification_uri_complete");
    // Stored as hashes only.
    const rows = JSON.stringify((await k.app.db.owner.query("select * from device_requests")).rows);
    expect(rows).not.toContain(dc.device_code); expect(rows).not.toContain(dc.user_code); expect(rows).not.toContain(dc.user_code.replace("-", ""));
    expect((await k.app.db.owner.query("select 1 from device_requests where device_code_hash = $1", [sha256(dc.device_code)])).rowCount).toBe(1);
    for (let i = 0; i < 200; i++) expect(normalizeUserCode(newUserCode())).not.toBeNull();
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDFGHJK"); expect(normalizeUserCode("AEIO-UBCD")).toBeNull();
  });

  it("login end to end: the approved CLI reads dev with its access token and nothing else", async () => {
    const p = await makePerson(k, "happy");
    await putSecret(k, p, "dev", "API_URL", "https://dev.example");
    const s = await login(k, p);
    expect(s.access).toMatch(/^mh_cli_/); expect(s.refresh).toMatch(/^mh_clr_/);
    const who = await cli(k.app, "GET", "/api/v1/whoami", undefined, s.access);
    expect(who.status, who.text).toBe(200);
    expect(who.json.binding.kind).toBe("cli");
    const r = await read(p.domain.fqdn, "dev", s.access);
    expect(r.status, r.text).toBe(200);
    expect(r.json.secrets).toEqual([{ name: "API_URL", version: 1, value: "https://dev.example" }]);
  });
});

describe("ST-31: a CLI login grant is capped to dev and preview", () => {
  it("a requested secrets.read:*:prod (and any prod or unknown scope) is refused at the device endpoint", async () => {
    for (const scope of ["secrets.read:*:prod", "secrets.read:*:*", "secrets.write:*:prod", "dns.write:*", "recipes.apply:*:dev", "SECRETS.READ:*:dev", "secrets.read:*"]) {
      const r = await cli(k.app, "POST", "/api/v1/oauth/device/code", { client_id: "mosshatch-cli", scope });
      expect(r.status, scope).toBe(400); expect(r.json.error.code, scope).toBe("invalid_scope");
    }
    expect((await cli(k.app, "POST", "/api/v1/oauth/device/code", { client_id: "someone-else" })).status).toBe(400);
  });

  it("the default grant is domains.read, nest.names, secrets.read and secrets.write on dev and preview; prod reads are 403", async () => {
    const p = await makePerson(k, "st31");
    await putSecret(k, p, "prod", "PROD_KEY", "prod-value"); await putSecret(k, p, "preview", "PV", "pv");
    const s = await login(k, p);
    expect(s.scope.split(" ").sort()).toEqual(["domains.read:*", "nest.names:*:dev", "nest.names:*:preview", "secrets.read:*:dev", "secrets.read:*:preview", "secrets.write:*:dev", "secrets.write:*:preview"]);
    expect((await read(p.domain.fqdn, "preview", s.access)).status).toBe(200);
    const pr = await read(p.domain.fqdn, "prod", s.access);
    expect(pr.status).toBe(403); expect(pr.json.error.code).toBe("scope_missing");
  });

  it("a dev-only request defaults the page to dev; prod appears only when the page names a domain", async () => {
    const p = await makePerson(k, "st31b");
    await putSecret(k, p, "prod", "PROD_KEY", "prod-value");
    const s = await login(k, p, { scope: "secrets.read:*:dev nest.names:*:dev" });
    expect(s.lookup.default_envs).toEqual(["dev"]);
    const named = await login(k, p, { prod_domains: [p.domain.fqdn] });
    expect(named.scope).toContain(`secrets.read:${p.domain.fqdn}:prod`);
    expect(named.scope).not.toContain("secrets.read:*:prod");
    expect((await read(p.domain.fqdn, "prod", named.access)).status).toBe(200);
    // A domain that is not the approver's cannot be named.
    const other = await makePerson(k, "st31c");
    const dc = await deviceCode(k.app);
    const look = await web(k.app, p.user, "POST", "/api/v1/oauth/device/lookup", { user_code: dc.user_code });
    const prep = await prepare(k.app, p.user, { type: "device.approve", target_id: look.json.request_id, user_input: { user_code: dc.user_code, prod_domains: [other.domain.fqdn] } });
    expect(prep.status).toBe(422);
  });
});

describe("ST-72: approved scopes equal the scopes shown; the grant is audited and mailed; the kill switches", () => {
  it("the scopes on the page, in the signed summary, in the token response and on the binding are the same list", async () => {
    const p = await makePerson(k, "st72");
    const s = await login(k, p);
    const who = await cli(k.app, "GET", "/api/v1/whoami", undefined, s.access);
    expect(who.json.binding.scopes.sort()).toEqual([...s.lookup.grant].sort());
    expect(s.scope.split(" ").sort()).toEqual([...s.lookup.grant].sort());
    for (const g of s.lookup.grant as string[]) expect(s.summary).toContain(g);
    const row = (await k.app.db.owner.query("select b.created_by_action_id, a.type, a.state from bindings b join actions a on a.id = b.created_by_action_id where b.id = $1", [who.json.binding.id])).rows[0];
    expect(row.type).toBe("device.approve"); expect(row.state).toBe("executed");
  });

  it("every notification address gets the grant mail with a revoke link; an audit row records the grant; the link revokes", async () => {
    const p = await makePerson(k, "st72m");
    const s = await login(k, p);
    const mails = k.app.email.sent.filter((m) => m.kind.startsWith("binding.granted") && m.userId === p.user.userId);
    const to = mails.flatMap((m) => m.to).sort();
    expect(to).toEqual([p.login, `st72m-second@example.net`].sort());
    const audit = (await k.app.db.owner.query("select action, detail from audit_log where chain_id = $1 and action = 'binding.granted'", [p.user.userId])).rows;
    expect(audit.length).toBe(1); expect(JSON.stringify(audit)).not.toContain(s.access);
    const link = /\/api\/v1\/binding-revoke\/([A-Za-z0-9_-]{43})/.exec(mails[0]!.text)![1]!;
    const page = await k.app.call("GET", `/api/v1/binding-revoke/${link}`);
    expect(page.status).toBe(200); expect(page.text).toContain("Revoke a command-line sign-in");
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, s.access)).status).toBe(200);   // GET changed nothing
    const bad = await k.app.call("POST", `/api/v1/binding-revoke/${link}`, { body: { confirm: true }, browser: false });
    expect(bad.status).toBe(403);
    const go = await k.app.call("POST", `/api/v1/binding-revoke/${link}`, { body: { confirm: true } });
    expect(go.status, go.text).toBe(200);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, s.access)).status).toBe(401);
    expect((await k.app.call("POST", `/api/v1/binding-revoke/${link}`, { body: { confirm: true } })).status).toBe(404);
  });

  it("with device login turned off for the account, lookup and approval refuse; with the global switch, /oauth/device/code refuses", async () => {
    const p = await makePerson(k, "st72off");
    expect((await web(k.app, p.user, "PUT", "/api/v1/bindings/device-login", { enabled: false })).status).toBe(200);
    const dc = await deviceCode(k.app);
    const look = await web(k.app, p.user, "POST", "/api/v1/oauth/device/lookup", { user_code: dc.user_code });
    expect(look.status).toBe(403); expect(look.json.error.code).toBe("device_login_disabled");
    await web(k.app, p.user, "PUT", "/api/v1/bindings/device-login", { enabled: true });
    const look2 = await web(k.app, p.user, "POST", "/api/v1/oauth/device/lookup", { user_code: dc.user_code });
    const prep = await prepare(k.app, p.user, { type: "device.approve", target_id: look2.json.request_id, user_input: { user_code: dc.user_code } });
    expect(prep.status).toBe(200);
    await web(k.app, p.user, "PUT", "/api/v1/bindings/device-login", { enabled: false });
    const done = await commit(k.app, p.user, prep.json.action_id, p.key.auth.get(prep.json.webauthn_options));
    expect(done.status).toBe(403);
    await k.app.db.owner.query("update flags set value = 'true' where name = 'device_login_paused'");
    try {
      const r = await cli(k.app, "POST", "/api/v1/oauth/device/code", { client_id: "mosshatch-cli" });
      expect(r.status).toBe(403); expect(r.json.error.code).toBe("device_login_disabled");
    } finally { await k.app.db.owner.query("update flags set value = 'false' where name = 'device_login_paused'"); }
  });
});

describe("ST-69: wrong user-code entries are limited per account and per address", () => {
  it("after five wrong entries by an account, the sixth attempt is refused even with the right code", async () => {
    const p = await makePerson(k, "st69a");
    const dc = await deviceCode(k.app);
    for (let i = 0; i < 5; i++) expect((await web(k.app, p.user, "POST", "/api/v1/oauth/device/lookup", { user_code: "BBBB-BBBB" }, { "x-forwarded-for": `192.0.${i}.1` })).status).toBe(404);
    const right = await web(k.app, p.user, "POST", "/api/v1/oauth/device/lookup", { user_code: dc.user_code }, { "x-forwarded-for": "192.0.99.1" });
    expect(right.status).toBe(429); expect(right.json.error.code).toBe("device_code_locked");
    // Approval through the step-up is locked for the account too.
    const row = (await k.app.db.owner.query("select id from device_requests where device_code_hash = $1", [sha256(dc.device_code)])).rows[0];
    const prep = await prepare(k.app, p.user, { type: "device.approve", target_id: row.id, user_input: { user_code: dc.user_code } });
    expect(prep.status).toBe(429);
  });

  it("five wrong entries from one address lock that address for another account too", async () => {
    const a = await makePerson(k, "st69b"), b = await makePerson(k, "st69c");
    const dc = await deviceCode(k.app);
    for (let i = 0; i < 5; i++) expect((await web(k.app, a.user, "POST", "/api/v1/oauth/device/lookup", { user_code: "CCCC-CCCC" }, { "x-forwarded-for": "192.0.2.55" })).status).toBe(404);
    expect((await web(k.app, b.user, "POST", "/api/v1/oauth/device/lookup", { user_code: dc.user_code }, { "x-forwarded-for": "192.0.2.77" })).status).toBe(429);
    expect((await web(k.app, b.user, "POST", "/api/v1/oauth/device/lookup", { user_code: dc.user_code }, { "x-forwarded-for": "198.18.0.1" })).status).toBe(200);
  });

  it("wrong codes at prepare count against the account", async () => {
    const p = await makePerson(k, "st69d");
    const dc = await deviceCode(k.app);
    const row = (await k.app.db.owner.query("select id from device_requests where device_code_hash = $1", [sha256(dc.device_code)])).rows[0];
    for (let i = 0; i < 5; i++) expect((await prepare(k.app, p.user, { type: "device.approve", target_id: row.id, user_input: { user_code: "DDDD-DDDD" } })).status).toBe(404);
    expect((await prepare(k.app, p.user, { type: "device.approve", target_id: row.id, user_input: { user_code: dc.user_code } })).status).toBe(429);
  });
});

describe("ST-70: approval needs the typed code", () => {
  it("prepare without a code, or with another request's code, fails; the approve route without a committed action fails", async () => {
    const p = await makePerson(k, "st70");
    const one = await deviceCode(k.app), two = await deviceCode(k.app);
    const row = (await k.app.db.owner.query("select id from device_requests where device_code_hash = $1", [sha256(one.device_code)])).rows[0];
    expect((await prepare(k.app, p.user, { type: "device.approve", target_id: row.id, user_input: {} })).status).toBe(400);
    expect((await prepare(k.app, p.user, { type: "device.approve", target_id: row.id, user_input: { user_code: two.user_code } })).status).toBe(404);
    const noAction = await web(k.app, p.user, "POST", "/api/v1/oauth/device/approve", { request_id: row.id, user_code: one.user_code });
    expect(noAction.status).toBe(403); expect(noAction.json.error.code).toBe("step_up_required");
    k.app.clock.advance(5000);
    expect((await poll(k.app, one.device_code)).json.error.code).toBe("authorization_pending");
  });

  it("the lookup takes the code only from the typed body: a code in the query string is ignored", async () => {
    const p = await makePerson(k, "st70q");
    const dc = await deviceCode(k.app);
    const r = await web(k.app, p.user, "POST", `/api/v1/oauth/device/lookup?user_code=${dc.user_code}`, {});
    expect(r.status).toBe(400);
  });
});

describe("device flow: polling, expiry, one-time use and replay", () => {
  it("polling faster than the interval gets slow_down and the interval grows by 5 s and stays", async () => {
    const dc = await deviceCode(k.app);
    expect((await poll(k.app, dc.device_code)).json.error.code).toBe("authorization_pending");
    const fast = await poll(k.app, dc.device_code);
    expect(fast.status).toBe(400); expect(fast.json.error.code).toBe("slow_down"); expect(fast.json.error.interval).toBe(10);
    k.app.clock.advance(6000);
    expect((await poll(k.app, dc.device_code)).json.error.code).toBe("slow_down");
    k.app.clock.advance(15_000);
    expect((await poll(k.app, dc.device_code)).json.error.code).toBe("authorization_pending");
  });

  it("an unapproved request expires after 600 s; its code no longer looks up", async () => {
    const p = await makePerson(k, "exp");
    const dc = await deviceCode(k.app);
    k.app.clock.advance(601_000);
    expect((await poll(k.app, dc.device_code)).json.error.code).toBe("expired_token");
    expect((await web(k.app, p.user, "POST", "/api/v1/oauth/device/lookup", { user_code: dc.user_code })).status).toBe(404);
  });

  it("replay: the device code yields tokens once; a second poll, a second approval and a replayed assertion all fail", async () => {
    const p = await makePerson(k, "replay");
    const dc = await deviceCode(k.app);
    const a = await approveDevice(k, p, dc.user_code);
    k.app.clock.advance(5000);
    const first = await poll(k.app, dc.device_code);
    expect(first.status).toBe(200);
    k.app.clock.advance(5000);
    const again = await poll(k.app, dc.device_code);
    expect(again.status).toBe(400); expect(again.json.error.code).toBe("invalid_grant");
    expect(again.text).not.toContain("mh_cli_");
    const reuse = await web(k.app, p.user, "POST", "/api/v1/oauth/device/approve", {}, { [ACTION_HEADER]: a.actionId });
    expect(reuse.status).toBe(403);
    expect((await k.app.db.owner.query("select count(*)::int n from bindings where device_request_id is not null and user_id = $1", [p.user.userId])).rows[0].n).toBe(1);
  });

  it("review: an approved device code cannot be redeemed after its 600 s lifetime", async () => {
    const p = await makePerson(k, "lateredeem");
    const dc = await deviceCode(k.app);
    await approveDevice(k, p, dc.user_code);
    k.app.email.clear();
    k.app.clock.advance(7 * 86_400_000);
    const late = await poll(k.app, dc.device_code);
    expect(late.status).toBe(400); expect(late.json.error.code).toBe("expired_token");
    expect(late.text).not.toContain("mh_cli_");
    expect((await k.app.db.owner.query("select count(*)::int n from bindings where user_id = $1", [p.user.userId])).rows[0].n).toBe(0);
    expect((await k.app.db.owner.query("select state from device_requests where device_code_hash = $1", [sha256(dc.device_code)])).rows[0].state).toBe("expired");
    expect(k.app.email.sent.filter((m) => m.userId === p.user.userId)).toEqual([]);
    k.app.clock.advance(10_000);
    expect((await poll(k.app, dc.device_code)).json.error.code).toBe("expired_token");
  });

  it("a denied request answers access_denied and never yields a token", async () => {
    const p = await makePerson(k, "deny");
    const dc = await deviceCode(k.app);
    const look = await web(k.app, p.user, "POST", "/api/v1/oauth/device/lookup", { user_code: dc.user_code });
    expect((await web(k.app, p.user, "POST", "/api/v1/oauth/device/deny", { request_id: look.json.request_id, user_code: dc.user_code })).status).toBe(200);
    k.app.clock.advance(5000);
    expect((await poll(k.app, dc.device_code)).json.error.code).toBe("access_denied");
  });

  it("phishing-resistant display: observed facts are separate from what the device reports, and the signed summary uses only observed facts", async () => {
    const p = await makePerson(k, "phish");
    const bad = await cli(k.app, "POST", "/api/v1/oauth/device/code", { client_id: "mosshatch-cli", client_name: "<b>Mosshatch Support</b>" });
    expect(bad.status).toBe(400);
    const r = await cli(k.app, "POST", "/api/v1/oauth/device/code", { client_id: "mosshatch-cli", client_name: "Official Mosshatch Support", client_version: "9.9.9" }, undefined, { "x-forwarded-for": "203.0.113.200" });
    const look = await web(k.app, p.user, "POST", "/api/v1/oauth/device/lookup", { user_code: r.json.user_code });
    expect(look.json.observed.address).toBe("203.0.113.0/24");
    expect(look.json.reported.client_name).toBe("Official Mosshatch Support");
    expect(Object.keys(look.json.observed).sort()).toEqual(["address", "expires_at", "requested_at"]);
    const prep = await prepare(k.app, p.user, { type: "device.approve", target_id: look.json.request_id, user_input: { user_code: r.json.user_code } });
    expect(prep.json.summary).toContain("203.0.113.0/24");
    expect(prep.json.summary).not.toContain("Official");
  });
});

describe("ST-71: refresh rotation, reuse and revoke", () => {
  const refresh = (t: string) => cli(k.app, "POST", "/api/v1/oauth/token", { grant_type: "refresh_token", refresh_token: t, client_id: "mosshatch-cli" });

  it("a refresh rotates both tokens; the old access token dies; reuse of a rotated refresh token revokes the family", async () => {
    const p = await makePerson(k, "st71");
    const s = await login(k, p);
    const r1 = await refresh(s.refresh);
    expect(r1.status, r1.text).toBe(200);
    expect(r1.json.refresh_token).not.toBe(s.refresh);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, s.access)).status).toBe(401);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, r1.json.access_token)).status).toBe(200);
    const reuse = await refresh(s.refresh);
    expect(reuse.status).toBe(400); expect(reuse.json.error.code).toBe("invalid_grant");
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, r1.json.access_token)).status).toBe(401);
    expect((await refresh(r1.json.refresh_token)).status).toBe(400);
  });

  it("after /oauth/revoke the access token fails on the next request (a bearer can revoke itself)", async () => {
    const p = await makePerson(k, "st71r");
    const s = await login(k, p);
    const r = await cli(k.app, "POST", "/api/v1/oauth/revoke", { token: s.access }, s.access);
    expect(r.status).toBe(200);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, s.access)).status).toBe(401);
    expect((await refresh(s.refresh)).status).toBe(400);
    // Revoking by the refresh token works too, and an unknown token is still 200 (RFC 7009).
    const s2 = await login(k, p);
    expect((await cli(k.app, "POST", "/api/v1/oauth/revoke", { token: s2.refresh })).status).toBe(200);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, s2.access)).status).toBe(401);
    expect((await cli(k.app, "POST", "/api/v1/oauth/revoke", { token: "mh_cli_nothing" })).status).toBe(200);
  });

  it("the access token lasts 60 minutes; the refresh token idles out after 30 days", async () => {
    const p = await makePerson(k, "st71t");
    const s = await login(k, p);
    k.app.clock.advance(61 * 60_000);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, s.access)).status).toBe(401);
    const r = await refresh(s.refresh);
    expect(r.status).toBe(200);
    k.app.clock.advance(31 * 86_400_000);
    expect((await refresh(r.json.refresh_token)).status).toBe(400);
  });
});
