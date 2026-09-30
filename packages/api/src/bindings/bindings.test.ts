import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeBinding, makePerson, makeVaultKit, putSecret, type Person, type VaultKit } from "../vault/testkit.ts";
import { commit, prepare } from "../stepup/testkit.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { mintToken } from "../util/token.ts";
import { sha256 } from "../util/bytes.ts";
import { RESERVED_NAMES, RESERVED_PREFIXES } from "../vault/names.ts";
import { KmsError } from "../vault/kms/types.ts";
import { withUser } from "@mosshatch/db";
import { issueCliGrant } from "./tokens.ts";
import { approveDevice, cli, deviceCode, login, resetCounters, web } from "./testkit.ts";
import { isNarrowing, lintScopes, parseScope, ScopeError, type Grant, type Scope } from "./scopes.ts";

let k: VaultKit;
beforeAll(async () => { k = await makeVaultKit(); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await resetCounters(k.app); });

async function stepUp(p: Person, type: string, target: string, input: unknown) {
  const prep = await prepare(k.app, p.user, { type, target_id: target, user_input: input });
  if (prep.status !== 200) return { status: prep.status, json: prep.json, actionId: "" };
  const done = await commit(k.app, p.user, prep.json.action_id, p.key.auth.get(prep.json.webauthn_options));
  return { status: done.status, json: done.json, actionId: prep.json.action_id as string, summary: prep.json.summary as string };
}
async function createToken(p: Person, scopes: string[], extra: Record<string, unknown> = {}) {
  const s = await stepUp(p, "agent.token.create", p.user.userId, { name: "Build bot", scopes, ...extra });
  if (s.status !== 200) return { status: s.status, json: s.json };
  return web(k.app, p.user, "POST", "/api/v1/bindings", {}, { [ACTION_HEADER]: s.actionId });
}

describe("ST-63: the scope parser", () => {
  const owned = new Map([["example.com", "d-1"], ["xn--bcher-kva.com", "d-2"]]);
  const reason = (s: string) => { try { parseScope(s, owned); return "ok"; } catch (e) { return (e as ScopeError).reason; } };
  it("accepts the grammar and stores the resolved domain id, with the fqdn as a label", () => {
    expect(parseScope("secrets.read:example.com:dev", owned)).toEqual({ capability: "secrets.read", domain_id: "d-1", env: "dev", label: "example.com" });
    expect(parseScope("dns.write:example.com", owned)).toEqual({ capability: "dns.write", domain_id: "d-1", env: null, label: "example.com" });
    expect(parseScope("register.propose:*", owned).domain_id).toBe("*");
    expect(parseScope("recipes.plan:example.com", owned).env).toBeNull();
    expect(parseScope("recipes.plan:example.com:prod", owned).env).toBe("prod");
    expect(reason("secrets.read:xn--bcher-kva.com:dev")).toBe("ok");
  });
  it("rejects a missing env, a glob, * as the capability, upper case, a trailing dot, a punycode variant, an unowned domain and register.propose with a domain", () => {
    expect(reason("secrets.read:example.com")).toBe("env_missing");
    expect(reason("nest.names:*")).toBe("env_missing");
    expect(reason("secrets.read:*.example.com:dev")).toBe("glob");
    expect(reason("secrets.*:example.com:dev")).toBe("glob");
    expect(reason("*:example.com")).toBe("star_capability");
    expect(reason("Secrets.read:example.com:dev")).toBe("upper_case");
    expect(reason("secrets.read:EXAMPLE.com:dev")).toBe("upper_case");
    expect(reason("secrets.read:example.com.:dev")).toBe("trailing_dot");
    expect(reason("secrets.read:bücher.com:dev")).toBe("not_ascii");
    expect(reason("secrets.read:xn--bcher-kva-.com:dev")).not.toBe("ok");
    expect(reason("secrets.read:xn--zz.com:dev")).not.toBe("ok");
    expect(reason("secrets.read:other.com:dev")).toBe("unowned_domain");
    expect(reason("register.propose:example.com")).toBe("star_only");
    expect(reason("register.propose:d-1")).toBe("star_only");
    expect(reason("dns.write:example.com:dev")).toBe("env_forbidden");
    expect(reason("secrets.read:example.com:staging")).toBe("unknown_env");
    expect(reason("secrets.read:*:*")).toBe("secrets_read_star_prod");
    expect(reason("secrets.read:*:prod")).toBe("secrets_read_star_prod");
    expect(reason("secrets.delete:example.com:dev")).toBe("unknown_capability");
    expect(reason("secrets.read:example.com:dev:x")).toBe("malformed");
    expect(reason("")).toBe("malformed");
  });
  it("the create route answers 422 for each of them (nothing is signed)", async () => {
    const p = await makePerson(k, "st63");
    for (const s of ["secrets.read:" + p.domain.fqdn, "dns.write:*." + p.domain.fqdn, "*:" + p.domain.fqdn, "DNS.write:" + p.domain.fqdn, `dns.write:${p.domain.fqdn}.`, "dns.write:someone-else.com", "register.propose:" + p.domain.fqdn]) {
      const r = await prepare(k.app, p.user, { type: "agent.token.create", target_id: p.user.userId, user_input: { name: "x", scopes: [s] } });
      expect(r.status, s).toBe(422);
    }
  });
});

describe("ST-32: secrets.read with dns.write is refused at creation and at widening", () => {
  it("lint", () => {
    const d1 = { capability: "secrets.read", domain_id: "a", env: "dev" } as const;
    expect(lintScopes([d1, { capability: "dns.write", domain_id: "b", env: null }])).toBe("secrets_read_with_dns_write");
    expect(lintScopes([d1, { capability: "recipes.apply", domain_id: "a", env: "dev" }])).toBeNull();
  });
  it("at creation (same and different domains) and at widening; secrets.read with recipes.apply is allowed", async () => {
    const p = await makePerson(k, "st32");
    const other = (await k.app.db.owner.query("insert into domains (user_id, fqdn_ascii, tld, registrar, state, locked, nameservers, livemode) values ($1,'st32-second.com','com','mock','registered',true,'{}',false) returning id", [p.user.userId])).rows[0];
    void other;
    const both = await prepare(k.app, p.user, { type: "agent.token.create", target_id: p.user.userId, user_input: { name: "x", scopes: [`secrets.read:${p.domain.fqdn}:dev`, "dns.write:st32-second.com"] } });
    expect(both.status).toBe(422); expect(both.json.error.reason).toBe("secrets_read_with_dns_write");
    const ok = await createToken(p, [`secrets.read:${p.domain.fqdn}:dev`, `recipes.apply:${p.domain.fqdn}:dev`]);
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    const w = await prepare(k.app, p.user, { type: "agent.token.widen", target_id: ok.json.id, user_input: { scopes: [`secrets.read:${p.domain.fqdn}:dev`, `dns.write:${p.domain.fqdn}`] } });
    expect(w.status).toBe(422);
    const patch = await web(k.app, p.user, "PATCH", `/api/v1/bindings/${ok.json.id}`, { scopes: [`secrets.read:${p.domain.fqdn}:dev`, `dns.write:${p.domain.fqdn}`] });
    expect(patch.status).toBe(403);
  });
});

describe("ST-62: tokens are hashed, shown once, looked up by hash, and idle tokens fail", () => {
  it("the token is in the create response only; the row holds its SHA-256; no table holds the token", async () => {
    await putSecret(k, await makePerson(k, "st62pre"), "dev", "X", "y");
    const p = await makePerson(k, "st62");
    const r = await createToken(p, [`nest.names:${p.domain.fqdn}:dev`]);
    expect(r.status).toBe(201);
    const token = r.json.token as string;
    expect(token).toMatch(/^mh_live_[A-Za-z0-9]{32}\+[0-9a-f]{8}$/);
    const row = (await k.app.db.owner.query("select token_hash, token_prefix from bindings where id = $1", [r.json.id])).rows[0];
    expect(Buffer.from(row.token_hash).equals(sha256(token))).toBe(true);
    const everything = (await Promise.all(["bindings", "audit_log", "jobs", "email_log", "actions", "binding_refresh_tokens", "binding_revoke_links", "rate_counters"].map(async (t) => JSON.stringify((await k.app.db.owner.query(`select * from ${t}`)).rows)))).join("\n");
    expect(everything).not.toContain(token); expect(everything).not.toContain(token.slice(12));
    expect(JSON.stringify(k.app.email.sent)).not.toContain(token.slice(12));
    const list = await web(k.app, p.user, "GET", "/api/v1/bindings");
    expect(list.text).not.toContain(token.slice(12));
    // A token of the right shape with a wrong checksum, or a changed character, is not accepted.
    const flipped = token.slice(0, 20) + (token[20] === "a" ? "b" : "a") + token.slice(21);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, flipped)).status).toBe(401);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, token)).status).toBe(200);
  });

  it("a token unused for 30 days is refused, and use records last_used_at", async () => {
    const p = await makePerson(k, "st62idle");
    const b = await makeBinding(k, p, [{ capability: "nest.names", domain_id: p.domain.id, env: "dev" }]);
    await k.app.db.owner.query("update bindings set created_at = $2, expires_at = $3 where id = $1", [b.id, k.app.clock.now(), new Date(k.app.clock.now().getTime() + 80 * 86_400_000)]);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, b.token)).status).toBe(200);
    expect((await k.app.db.owner.query("select last_used_at from bindings where id = $1", [b.id])).rows[0].last_used_at).not.toBeNull();
    k.app.clock.advance(29 * 86_400_000);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, b.token)).status).toBe(200);
    k.app.clock.advance(31 * 86_400_000);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, b.token)).status).toBe(401);
    k.app.clock.set(new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000));
  });

  it("an expired, revoked or paused token is refused on the next request", async () => {
    const p = await makePerson(k, "st62rev");
    const r = await createToken(p, [`nest.names:${p.domain.fqdn}:dev`], { expires_in_days: 1 });
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, r.json.token)).status).toBe(200);
    await k.app.db.owner.query("update bindings set paused_at = now() where id = $1", [r.json.id]);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, r.json.token)).status).toBe(403);
    await k.app.db.owner.query("update bindings set paused_at = null where id = $1", [r.json.id]);
    expect((await web(k.app, p.user, "DELETE", `/api/v1/bindings/${r.json.id}`)).status).toBe(200);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, r.json.token)).status).toBe(401);
    const r2 = await createToken(p, [`nest.names:${p.domain.fqdn}:dev`], { expires_in_days: 1 });
    k.app.clock.advance(86_400_000 + 1000);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, r2.json.token)).status).toBe(401);
    k.app.clock.set(new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000));
  });
});

// A small seeded generator: no property-testing dependency.
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

describe("ST-64: the widening classifier", () => {
  const caps = ["secrets.read", "secrets.write", "nest.names", "dns.read"] as const;
  const doms = ["*", "a", "b"];
  const envs = ["dev", "preview", "prod", "*", null] as const;
  const gen = (r: () => number): Scope[] => Array.from({ length: 1 + Math.floor(r() * 4) }, () => ({ capability: caps[Math.floor(r() * caps.length)]!, domain_id: doms[Math.floor(r() * doms.length)]!, env: envs[Math.floor(r() * envs.length)]!, label: "" }));
  // Reference semantics: every concrete (capability, domain, env) the proposal grants must be granted before.
  const concrete = (s: readonly Pick<Scope, "capability" | "domain_id" | "env">[]) => {
    const out = new Set<string>();
    for (const x of s) for (const d of x.domain_id === "*" ? ["*", "a", "b", "z"] : [x.domain_id]) for (const e of x.env === null ? [null] : x.env === "*" ? ["dev", "preview", "*"] : [x.env]) out.add(`${x.capability}|${d}|${e}`);
    return out;
  };
  it("property: narrowing iff coverage holds, the cap is not higher and the expiry not later (5,000 random cases)", () => {
    const r = rng(20260930);
    let narrow = 0, wide = 0;
    for (let i = 0; i < 5000; i++) {
      const before: Grant = { scopes: gen(r), capMinor: BigInt(Math.floor(r() * 3) * 1000), expiresAt: new Date(1_800_000_000_000 + Math.floor(r() * 3) * 86_400_000) };
      const after: Grant = r() < 0.4
        ? { scopes: before.scopes.filter(() => r() < 0.7), capMinor: before.capMinor, expiresAt: before.expiresAt }
        : { scopes: gen(r), capMinor: BigInt(Math.floor(r() * 3) * 1000), expiresAt: new Date(1_800_000_000_000 + Math.floor(r() * 3) * 86_400_000) };
      const b = concrete(before.scopes), a = concrete(after.scopes);
      const expected = after.scopes.length > 0 && [...a].every((x) => b.has(x)) && after.capMinor <= before.capMinor && after.expiresAt <= before.expiresAt;
      const got = isNarrowing(before, after);
      expect(got, JSON.stringify({ before, after }, (_k, v) => typeof v === "bigint" ? String(v) : v)).toBe(expected);
      if (got) narrow++; else wide++;
    }
    expect(narrow).toBeGreaterThan(200); expect(wide).toBeGreaterThan(200);
  });
  it("any parse doubt is a widening: null, empty, bad dates", () => {
    const g: Grant = { scopes: [{ capability: "secrets.read", domain_id: "a", env: "dev" }], capMinor: 0n, expiresAt: new Date(1_800_000_000_000) };
    expect(isNarrowing(g, null)).toBe(false);
    expect(isNarrowing(g, { ...g, scopes: [] })).toBe(false);
    expect(isNarrowing(g, { ...g, expiresAt: new Date(NaN) })).toBe(false);
    expect(isNarrowing(g, { ...g, scopes: [{ capability: "secrets.read", domain_id: "a", env: "prod" }] })).toBe(false);
    expect(isNarrowing({ ...g, scopes: [{ capability: "secrets.read", domain_id: "a", env: "*" }] }, { ...g, scopes: [{ capability: "secrets.read", domain_id: "a", env: "prod" }] })).toBe(false);
    expect(isNarrowing(g, g)).toBe(true);
  });
  it("PATCH narrows for free, sends anything else to agent.token.widen, and refuses a bearer", async () => {
    const p = await makePerson(k, "st64");
    const t = await createToken(p, [`secrets.read:${p.domain.fqdn}:dev`, `secrets.read:${p.domain.fqdn}:preview`, `nest.names:${p.domain.fqdn}:dev`], { spend_cap_minor: 5000 });
    const narrow = await web(k.app, p.user, "PATCH", `/api/v1/bindings/${t.json.id}`, { scopes: [`secrets.read:${p.domain.fqdn}:dev`], spend_cap_minor: 1000 });
    expect(narrow.status, narrow.text).toBe(200);
    expect(narrow.json.binding.scopes).toEqual([`secrets.read:${p.domain.fqdn}:dev`]);
    for (const body of [{ scopes: [`secrets.read:${p.domain.fqdn}:preview`] }, { spend_cap_minor: 2000 }, { expires_in_days: 90 }, { name: "Renamed" }, { scopes: ["nonsense"] }, { scopes: [`secrets.read:${p.domain.fqdn}:prod`] }]) {
      const r = await web(k.app, p.user, "PATCH", `/api/v1/bindings/${t.json.id}`, body);
      expect(r.status, JSON.stringify(body)).toBe(403); expect(r.json.error.code).toBe("step_up_required"); expect(r.json.error.type).toBe("agent.token.widen");
    }
    const bearer = await cli(k.app, "PATCH", `/api/v1/bindings/${t.json.id}`, { scopes: [`secrets.read:${p.domain.fqdn}:dev`] }, t.json.token);
    expect(bearer.status).toBe(403);
    // The widening, with its passkey, applies exactly the signed after-state.
    const w = await stepUp(p, "agent.token.widen", t.json.id, { scopes: [`secrets.read:${p.domain.fqdn}:dev`, `secrets.read:${p.domain.fqdn}:prod`] });
    expect(w.status).toBe(200);
    const applied = await web(k.app, p.user, "POST", `/api/v1/bindings/${t.json.id}/widen`, {}, { [ACTION_HEADER]: w.actionId });
    expect(applied.status, applied.text).toBe(200);
    expect(applied.json.binding.scopes.sort()).toEqual([`secrets.read:${p.domain.fqdn}:dev`, `secrets.read:${p.domain.fqdn}:prod`]);
    // A change between prepare and apply (a narrowing here) voids the signed widening.
    const w2 = await stepUp(p, "agent.token.widen", t.json.id, { scopes: [`secrets.read:${p.domain.fqdn}:dev`, `secrets.read:${p.domain.fqdn}:preview`, `secrets.read:${p.domain.fqdn}:prod`] });
    expect((await web(k.app, p.user, "PATCH", `/api/v1/bindings/${t.json.id}`, { scopes: [`secrets.read:${p.domain.fqdn}:dev`] })).status).toBe(200);
    expect((await web(k.app, p.user, "POST", `/api/v1/bindings/${t.json.id}/widen`, {}, { [ACTION_HEADER]: w2.actionId })).status).toBe(409);
  });
});

describe("ST-66: revoke-all", () => {
  it("revokes every binding and refresh token and cancels approved device grants in one transaction", async () => {
    const p = await makePerson(k, "st66");
    const s = await login(k, p);
    const t = await createToken(p, [`nest.names:${p.domain.fqdn}:dev`]);
    const r = await web(k.app, p.user, "POST", "/api/v1/bindings/revoke-all", {});
    expect(r.status, r.text).toBe(200);
    expect(r.json.revoked).toBe(2);
    for (const tok of [s.access, t.json.token]) expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, tok)).status).toBe(401);
    expect((await cli(k.app, "POST", "/api/v1/oauth/token", { grant_type: "refresh_token", refresh_token: s.refresh, client_id: "mosshatch-cli" })).status).toBe(400);
    const times = (await k.app.db.owner.query("select distinct revoked_at from bindings where user_id = $1", [p.user.userId])).rows;
    expect(times.length).toBe(1);
  });

  it("declines pending agent requests in the same transaction, and a failure part-way revokes nothing", async () => {
    const p = await makePerson(k, "st66b");
    const t = await createToken(p, [`nest.names:${p.domain.fqdn}:dev`]);
    // Phase 5's agent_requests (migration 0950): two real pending requests of this token.
    await k.app.db.owner.query("insert into agent_requests (user_id, binding_id, kind, request_hash, params, created_at, expires_at) values ($1,$2,'scope',$3,'{}',now(),now() + interval '1 hour'),($1,$2,'scope',$4,'{}',now(),now() + interval '1 hour')",
      [p.user.userId, t.json.id, sha256("st66-a"), sha256("st66-b")]);
    await k.app.db.owner.query("create or replace function st66_fail() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$; create trigger st66_fail before update on agent_requests for each row execute function st66_fail()");
    const failed = await web(k.app, p.user, "POST", "/api/v1/bindings/revoke-all", {});
    expect(failed.status).toBe(500);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, t.json.token)).status).toBe(200);
    await k.app.db.owner.query("drop trigger st66_fail on agent_requests");
    const ok = await web(k.app, p.user, "POST", "/api/v1/bindings/revoke-all", {});
    expect(ok.status).toBe(200); expect(ok.json.requests_declined).toBe(2);
    expect((await k.app.db.owner.query("select count(*)::int n from agent_requests where user_id = $1 and state = 'declined'", [p.user.userId])).rows[0].n).toBe(2);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, t.json.token)).status).toBe(401);
  });

  it("review: a device grant being consumed while revoke-all runs is revoked too", async () => {
    const p = await makePerson(k, "st66race");
    const dc = await deviceCode(k.app);
    await approveDevice(k, p, dc.user_code);
    const req = (await k.app.db.owner.query("select id, approved_scopes, approved_by_action_id from device_requests where device_code_hash = $1", [sha256(dc.device_code)])).rows[0];
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>((r) => { release = r; }), isReady = new Promise<void>((r) => { ready = r; });
    let access = "";
    // The poll's one-time consume, held open after its binding is inserted: the window revoke-all must not miss.
    const pollTx = withUser(k.app.ctx.runtime, p.user.userId, async (c) => {
      const won = await c.query("update device_requests set state = 'consumed' where id = $1 and state = 'approved' and user_id = $2", [req.id, p.user.userId]);
      expect(won.rowCount).toBe(1);
      access = (await issueCliGrant(k.app.ctx, c, { userId: p.user.userId, deviceRequestId: req.id, actionId: req.approved_by_action_id, scopes: req.approved_scopes })).accessToken;
      ready();
      await gate;
    });
    await isReady;
    const revoking = web(k.app, p.user, "POST", "/api/v1/bindings/revoke-all", {});
    // Let revoke-all run until it waits on the poll transaction's lock.
    for (let i = 0; i < 200; i++) {
      if ((await k.app.db.owner.query("select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")).rows[0].n > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    release();
    await pollTx;
    const r = await revoking;
    expect(r.status, r.text).toBe(200);
    expect((await cli(k.app, "GET", "/api/v1/whoami", undefined, access)).status).toBe(401);
  });
});

describe("ST-88: reserved and malformed names on push", () => {
  it("every reserved name in upper, lower and mixed case is refused with 422 and an audit row; the batch writes nothing", async () => {
    const p = await makePerson(k, "st88");
    const t = await makeBinding(k, p, [{ capability: "secrets.write", domain_id: p.domain.id, env: "dev" }, { capability: "nest.names", domain_id: p.domain.id, env: "dev" }], "cli");
    const variants = (n: string) => [n.toUpperCase(), n.toLowerCase(), n.split("").map((ch, i) => (i % 2 ? ch.toLowerCase() : ch.toUpperCase())).join("")];
    const names = [...RESERVED_NAMES, ...RESERVED_PREFIXES.map((x) => `${x}EXTRA`)];
    for (const n of names) for (const v of variants(n)) {
      await resetCounters(k.app);
      const r = await cli(k.app, "POST", `/api/v1/domains/${p.domain.fqdn}/secrets/dev/write`, { secrets: { GOOD_NAME: "v", [v]: "x" } }, t.token);
      expect(r.status, v).toBe(422); expect(r.json.error.code).toBe("invalid_name");
      expect(r.text).not.toContain(v);
    }
    for (const bad of ["1ABC", "A-B", "A B", "", "A".repeat(129), "sk_live_abcdefgh"]) {
      const r = await cli(k.app, "POST", `/api/v1/domains/${p.domain.fqdn}/secrets/dev/write`, { secrets: { GOOD_NAME: "v", [bad]: "x" } }, t.token);
      expect(r.status, bad).toBe(422);
    }
    const names2 = await cli(k.app, "GET", `/api/v1/domains/${p.domain.fqdn}/nest/dev/names`, undefined, t.token);
    expect(names2.json.names).toEqual([]);
    const audits = (await k.app.db.owner.query("select count(*)::int n from audit_log where chain_id = $1 and action = 'secret.name_rejected'", [p.user.userId])).rows[0].n;
    expect(audits).toBe(names.length * 3 + 6);
    const ok = await cli(k.app, "POST", `/api/v1/domains/${p.domain.fqdn}/secrets/dev/write`, { secrets: { GOOD_NAME: "v", other_name: "w" } }, t.token);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.written.map((w: { name: string }) => w.name).sort()).toEqual(["GOOD_NAME", "OTHER_NAME"]);
    expect(ok.text).not.toContain('"v"');
  });

  it("review: push is atomic: a vault failure part-way writes nothing and leaves no versionless name", async () => {
    const p = await makePerson(k, "st88atomic");
    await putSecret(k, p, "dev", "B_TWO", "old-two");
    const t = await makeBinding(k, p, [{ capability: "secrets.write", domain_id: p.domain.id, env: "dev" }, { capability: "nest.names", domain_id: p.domain.id, env: "dev" }], "cli");
    const orig = k.kms.generateDataKey.bind(k.kms);
    let n = 0;
    k.kms.generateDataKey = (async (...a: Parameters<typeof orig>) => { if (++n === 3) throw new KmsError("Unavailable"); return orig(...a); }) as typeof orig;
    let r;
    try { r = await cli(k.app, "POST", `/api/v1/domains/${p.domain.fqdn}/secrets/dev/write`, { secrets: { A_ONE: "1", B_TWO: "2", C_THREE: "3", D_FOUR: "4" } }, t.token); }
    finally { k.kms.generateDataKey = orig; }
    expect(r.status, r.text).toBe(503); expect(r.json.error.code).toBe("vault_unavailable");
    const rows = (await k.app.db.owner.query("select name, current_version from secrets where domain_id = $1 order by name", [p.domain.id])).rows;
    expect(rows).toEqual([{ name: "B_TWO", current_version: 1 }]);
    expect((await k.app.db.owner.query("select count(*)::int n from secret_versions v join secrets s on s.id = v.secret_id where s.domain_id = $1", [p.domain.id])).rows[0].n).toBe(1);
    // The same batch goes through whole once the vault answers.
    const ok = await cli(k.app, "POST", `/api/v1/domains/${p.domain.fqdn}/secrets/dev/write`, { secrets: { A_ONE: "1", B_TWO: "2", C_THREE: "3", D_FOUR: "4" } }, t.token);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.written).toEqual([{ name: "A_ONE", version: 1 }, { name: "B_TWO", version: 2 }, { name: "C_THREE", version: 1 }, { name: "D_FOUR", version: 1 }]);
  });

  it("ST-35: an agent's push to prod emails every address at once and counts against the agent write limit", async () => {
    const p = await makePerson(k, "st35push");
    await putSecret(k, p, "prod", "DATABASE_URL", "postgres://good.example/db");
    const t = await makeBinding(k, p, [{ capability: "secrets.write", domain_id: p.domain.id, env: "prod" }, { capability: "secrets.write", domain_id: p.domain.id, env: "dev" }], "agent");
    k.app.email.clear();
    const r = await cli(k.app, "POST", `/api/v1/domains/${p.domain.fqdn}/secrets/prod/write`, { secrets: { DATABASE_URL: "postgres://attacker.example/db" } }, t.token);
    expect(r.status, r.text).toBe(200);
    const mails = k.app.email.sent.filter((m) => m.kind === "agent.prod_write");
    expect(mails.length).toBe(2);   // both notification addresses, without waiting for a job
    expect(mails[0]!.text).toContain("DATABASE_URL"); expect(mails[0]!.text).not.toContain("attacker.example");
    // A CLI grant (a person's own device) writing prod is not an agent write.
    const c = await makeBinding(k, p, [{ capability: "secrets.write", domain_id: p.domain.id, env: "prod" }], "cli");
    k.app.email.clear();
    expect((await cli(k.app, "POST", `/api/v1/domains/${p.domain.fqdn}/secrets/prod/write`, { secrets: { OTHER: "x" } }, c.token)).status).toBe(200);
    expect(k.app.email.sent.filter((m) => m.kind === "agent.prod_write")).toEqual([]);
    // An agent cannot write more values a minute through push than through its own write route.
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`MANY_${i}`, "v"]));
    const lim = await cli(k.app, "POST", `/api/v1/domains/${p.domain.fqdn}/secrets/dev/write`, { secrets: many }, t.token);
    expect(lim.status).toBe(429);
    expect((await k.app.db.owner.query("select count(*)::int n from secrets where domain_id = $1 and name like 'MANY_%'", [p.domain.id])).rows[0].n).toBe(0);
  });

  it("push needs secrets.write on that domain and env; prod needs an explicit :prod", async () => {
    const p = await makePerson(k, "st88s");
    const t = await makeBinding(k, p, [{ capability: "secrets.write", domain_id: "*", env: "*" }], "cli");
    expect((await cli(k.app, "POST", `/api/v1/domains/${p.domain.fqdn}/secrets/dev/write`, { secrets: { A: "1" } }, t.token)).status).toBe(200);
    expect((await cli(k.app, "POST", `/api/v1/domains/${p.domain.fqdn}/secrets/prod/write`, { secrets: { A: "1" } }, t.token)).status).toBe(403);
    const cookie = await web(k.app, p.user, "POST", `/api/v1/domains/${p.domain.fqdn}/secrets/dev/write`, { secrets: { A: "1" } });
    expect(cookie.status).toBe(403);
    void mintToken;
  });
});
