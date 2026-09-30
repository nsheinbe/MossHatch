import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintToken } from "../util/token.ts";
import { RELEASE_CAUSES, releaseDomain, runReleaseSweep, type ReleaseCause } from "./release.ts";
import { syncDomain } from "./sync.ts";
import { at, autoRenewOn, buyDomain, days, domainRow, harnessPerTest, mailOf, makeOwner, relogin, settle, type DomainsHarness, type Owner } from "./testkit.ts";

const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); });

/** Stand-ins for the tables later modules own (cards, the Nest, connections), with the column names of PLAN 4.4 that release touches. */
async function standIns(h: DomainsHarness) {
  await h.app.db.owner.query(`
    create table if not exists cards (id uuid primary key default uuidv7(), domain_id uuid not null, slug text, published_at timestamptz, unpublished_at timestamptz);
    create table if not exists secrets (id uuid primary key default uuidv7(), domain_id uuid not null, env text not null, name text not null);
    create table if not exists secret_versions (id uuid primary key default uuidv7(), secret_id uuid not null, version int not null default 1, ciphertext bytea, wrapped_dek bytea, destroyed_at timestamptz);
    create table if not exists connections (id uuid primary key default uuidv7(), domain_id uuid not null, service text, status text default 'active', ended_at timestamptz);
    create table if not exists connection_credentials (id uuid primary key default uuidv7(), connection_id uuid not null, revoked_at timestamptz);
    grant all on cards, secrets, secret_versions, connections, connection_credentials to mh_cron;
    grant select on secrets to mh_runtime;`);
}

/** Everything that hangs off a domain and must not outlive it. */
async function attach(h: DomainsHarness, o: Owner, domainId: string) {
  const q = (sql: string, p: unknown[]) => h.app.db.owner.query(sql, p);
  const tok = mintToken("live");
  await q("insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, expires_at) values ($1,'agent','scoped',$2,$3,$4, now() + interval '400 days')",
    [o.userId, tok.prefix, tok.hash, JSON.stringify([{ capability: "mandate.off", domain_id: domainId }, { capability: "secrets.read", domain_id: domainId, env: "prod" }])]);
  const sec = (await q("insert into secrets (domain_id, env, name) values ($1,'prod','DATABASE_URL') returning id", [domainId])).rows[0].id;
  await q("insert into secret_versions (secret_id, ciphertext, wrapped_dek) values ($1, '\\xdeadbeef', '\\xcafebabe')", [sec]);
  await q("insert into cards (domain_id, slug, published_at) values ($1,$2,now())", [domainId, "card-" + domainId.slice(0, 8)]);
  const con = (await q("insert into connections (domain_id, service) values ($1,'vercel') returning id", [domainId])).rows[0].id;
  await q("insert into connection_credentials (connection_id) values ($1)", [con]);
  return { token: tok.token };
}

const counts = async (h: DomainsHarness, domainId: string) => {
  const q = async (sql: string) => (await h.app.db.owner.query(sql, [domainId])).rows[0];
  return {
    cards: (await q("select count(*)::int n from cards where domain_id = $1")).n, secrets: (await q("select count(*)::int n from secrets where domain_id = $1")).n,
    connections: (await q("select count(*)::int n from connections where domain_id = $1")).n,
    liveBindings: (await q("select count(*)::int n from bindings where revoked_at is null and position($1 in scopes::text) > 0")).n,
  };
};

let h: DomainsHarness; let ada: Owner;
beforeEach(async () => { h = await per.make(); await standIns(h); ada = await makeOwner(h, "release@example.com"); });

describe("ST-95: each release cause sets released_at and revokes, cancels and unpublishes at once, and destroys after the hold; export works during it", () => {
  for (const cause of RELEASE_CAUSES.filter((c) => c !== "lapsed") as ReleaseCause[]) {
    it(`cause ${cause}`, async () => {
      const d = await buyDomain(h, ada, `free-rel-${cause.replace("_", "")}.dev`);
      await autoRenewOn(h, ada, d.id);
      const { token } = await attach(h, ada, d.id);
      expect((await h.app.call("GET", "/api/v1/domains", { cookie: ada.cookie })).json.domains.map((x: { id: string }) => x.id)).toContain(d.id);

      const res = await releaseDomain(h.app.ctx, d.id, cause);
      expect(res.released).toBe(true);
      const row = await domainRow(h, d.id);
      expect(row.released_at).toBeTruthy();
      expect(row.release_reason).toBe(cause);
      expect(row.auto_renew).toBe(false);
      const holdMs = new Date(row.release_hold_until).getTime() - new Date(row.released_at).getTime();
      expect(holdMs).toBe(30 * 86_400_000);
      const rel = (await h.app.db.owner.query("select * from domain_releases where domain_id = $1", [d.id])).rows[0];
      expect(rel).toMatchObject({ cause, bindings_revoked: 1, mandates_revoked: 1 });
      expect(rel.steps_done_at).toBeTruthy(); expect(rel.destroyed_at).toBeNull();

      // Revoked at once: the token is dead, the mandate is off, the card is unpublished, the connection has ended.
      const bearer = await h.app.call("DELETE", `/api/v1/domains/${d.id}/auto-renew`, { authorization: `Bearer ${token}`, browser: false });
      expect(bearer.status).toBe(401);
      expect((await h.app.db.owner.query("select revoked_by from renewal_mandates where domain_id = $1", [d.id])).rows[0].revoked_by).toBe("release");
      expect((await h.app.db.owner.query("select unpublished_at from cards where domain_id = $1", [d.id])).rows[0].unpublished_at).toBeTruthy();
      const con = (await h.app.db.owner.query("select status, ended_at from connections where domain_id = $1", [d.id])).rows[0];
      expect(con.status).toBe("ended"); expect(con.ended_at).toBeTruthy();
      expect((await counts(h, d.id)).liveBindings).toBe(0);

      // Held, not destroyed: the ciphertext is still there and the former owner can read and export the record.
      expect((await h.app.db.owner.query("select ciphertext is not null as has from secret_versions")).rows[0].has).toBe(true);
      const cookie = (await relogin(h, ada)).cookie;
      const exp = await h.app.call("GET", `/api/v1/domains/${d.id}/export`, { cookie });
      expect(exp.status, JSON.stringify(exp.json)).toBe(200);
      expect(exp.json.domain).toMatchObject({ id: d.id, release_reason: cause });
      expect(exp.json.secret_names).toEqual([{ name: "DATABASE_URL", env: "prod" }]);
      expect(JSON.stringify(exp.json)).not.toMatch(/deadbeef|cafebabe/);
      const ov = await h.app.call("GET", `/api/v1/domains/${d.id}`, { cookie });
      expect(ov.status).toBe(200); expect(ov.json.released).toMatchObject({ reason: cause, export_available: true });
      expect((await h.app.call("GET", "/api/v1/domains", { cookie })).json.domains.map((x: { id: string }) => x.id)).not.toContain(d.id);
      const mail = mailOf(h, "domain_released").at(-1)!;
      expect(mail.text).toContain("You can export its record until");

      // Twice is a no-op.
      expect((await releaseDomain(h.app.ctx, d.id, cause)).released).toBe(false);

      // After the hold the secrets are destroyed, the connection credentials revoked, and the export is gone.
      at(h, new Date(new Date(row.release_hold_until).getTime() + 3600_000)); await settle(h);
      const v = (await h.app.db.owner.query("select ciphertext, wrapped_dek, destroyed_at from secret_versions")).rows[0];
      expect(v.ciphertext).toBeNull(); expect(v.wrapped_dek).toBeNull(); expect(v.destroyed_at).toBeTruthy();
      expect((await h.app.db.owner.query("select revoked_at from connection_credentials")).rows[0].revoked_at).toBeTruthy();
      expect((await h.app.db.owner.query("select destroyed_at from domain_releases where domain_id = $1", [d.id])).rows[0].destroyed_at).toBeTruthy();
      const later = (await relogin(h, ada)).cookie;
      expect((await h.app.call("GET", `/api/v1/domains/${d.id}/export`, { cookie: later })).status).toBe(404);
      expect((await h.app.call("GET", `/api/v1/domains/${d.id}`, { cookie: later })).status).toBe(404);
    });
  }

  it("a release another module started (the capture-failed ladder sets released_at for `unpaid`) is completed by the sweep", async () => {
    const d = await buyDomain(h, ada, "free-relunpaid.dev");
    await attach(h, ada, d.id);
    await h.app.db.owner.query("update domains set released_at = now(), release_reason = 'unpaid' where id = $1", [d.id]);
    const r = await runReleaseSweep(h.app.ctx);
    expect(r.completed).toBe(1);
    expect((await h.app.db.owner.query("select cause, steps_done_at from domain_releases where domain_id = $1", [d.id])).rows[0]).toMatchObject({ cause: "unpaid" });
    expect((await counts(h, d.id)).liveBindings).toBe(0);
    expect((await h.app.db.owner.query("select unpublished_at from cards where domain_id = $1", [d.id])).rows[0].unpublished_at).toBeTruthy();
  });

  it("nothing is released while the name is restorable: grace and redemption keep it in the account, and it goes only when the registry has deleted it", async () => {
    const d = await buyDomain(h, ada, "free-relgrace.dev");
    await attach(h, ada, d.id);
    const E = new Date((await domainRow(h, d.id)).expires_at);
    expect(await releaseDomain(h.app.ctx, d.id, "lapsed")).toEqual({ released: false, reason: "restorable" });
    // Ten days past expiry: the auto-renew grace period. The name is sleeping, not released.
    at(h, new Date(E.getTime() + days(10)));
    expect(await syncDomain(h.app.ctx, d.id)).toBe("synced");
    expect((await domainRow(h, d.id)).state).toBe("expired");
    expect((await domainRow(h, d.id)).released_at).toBeNull();
    // Fifty days past: the registry deleted it into redemption, where it can still be restored.
    at(h, new Date(E.getTime() + days(50)));
    expect(await syncDomain(h.app.ctx, d.id)).toBe("redemption");
    expect((await domainRow(h, d.id)).state).toBe("redemption");
    expect((await domainRow(h, d.id)).released_at).toBeNull();
    expect(await releaseDomain(h.app.ctx, d.id, "lapsed")).toEqual({ released: false, reason: "restorable" });
    const cookie = (await relogin(h, ada)).cookie;
    const grove = (await h.app.call("GET", "/api/v1/domains", { cookie })).json.domains.find((x: { id: string }) => x.id === d.id);
    expect(grove.state).toBe("sleeping"); expect(grove.state_text).toContain("redemption");
    expect((await counts(h, d.id)).liveBindings).toBe(1);
    // Seventy-one days past: redemption is over, the name is gone, and only now does the release happen.
    at(h, new Date(E.getTime() + days(71)));
    expect(await syncDomain(h.app.ctx, d.id)).toBe("released");
    expect((await domainRow(h, d.id)).release_reason).toBe("lapsed");
    expect((await counts(h, d.id)).liveBindings).toBe(0);
  });
});

describe("ST-94: after a name leaves, the old binding, secrets, cards and connections are invisible to whoever holds it next, and the name can be registered again", () => {
  it("transferred out, then registered by another person: the new domain row inherits nothing", async () => {
    const bob = await makeOwner(h, "bob-release@example.com");
    const oldD = await buyDomain(h, ada, "free-reuse.dev");
    await autoRenewOn(h, ada, oldD.id);
    const { token } = await attach(h, ada, oldD.id);
    // The transfer away is started at the registrar and completes: the name leaves our account.
    h.registrar.oob.startTransferAway(oldD.fqdn, { gainingRegistrar: "Elsewhere Ltd" });
    expect(await syncDomain(h.app.ctx, oldD.id)).toBe("synced");
    expect((await domainRow(h, oldD.id)).transfer_away).toBe(true);
    h.registrar.oob.setTransferAwayStatus(oldD.fqdn, "completed");
    expect(await syncDomain(h.app.ctx, oldD.id)).toBe("released");
    expect((await domainRow(h, oldD.id)).release_reason).toBe("transferred_out");

    // A previously used name can be registered again, by someone else.
    const newD = await buyDomain(h, bob, "free-reuse.dev");
    expect(newD.id).not.toBe(oldD.id);
    expect(await counts(h, newD.id)).toEqual({ cards: 0, secrets: 0, connections: 0, liveBindings: 0 });
    expect((await counts(h, oldD.id))).toMatchObject({ cards: 1, secrets: 1, connections: 1, liveBindings: 0 });
    const bobCookie = (await relogin(h, bob)).cookie;
    const grove = (await h.app.call("GET", "/api/v1/domains", { cookie: bobCookie })).json.domains;
    expect(grove.map((x: { id: string }) => x.id)).toEqual([newD.id]);
    // The old record is not Bob's to read: same 404 as an id that never existed.
    const a = await h.app.call("GET", `/api/v1/domains/${oldD.id}`, { cookie: bobCookie });
    const b = await h.app.call("GET", "/api/v1/domains/018f0000-0000-7000-8000-000000000000", { cookie: bobCookie });
    expect([a.status, JSON.stringify(a.json)]).toEqual([b.status, JSON.stringify(b.json)]);
    expect((await h.app.call("GET", `/api/v1/domains/${oldD.id}/export`, { cookie: bobCookie })).status).toBe(404);
    // Ada's old binding cannot touch the new domain, and the former owner cannot read the new owner's domain.
    const viaOld = await h.app.call("DELETE", `/api/v1/domains/${newD.id}/auto-renew`, { authorization: `Bearer ${token}`, browser: false });
    expect(viaOld.status).toBe(401);
    const adaCookie = (await relogin(h, ada)).cookie;
    expect((await h.app.call("GET", `/api/v1/domains/${newD.id}`, { cookie: adaCookie })).status).toBe(404);
    expect((await h.app.call("GET", `/api/v1/domains/${oldD.id}/export`, { cookie: adaCookie })).status).toBe(200);
  });
});

describe("ST-96: an old binding stays dead when its former owner registers the same name again", () => {
  it("lapse or transfer, then the same person registers the name: the new domain has a new id and the old token is refused", async () => {
    const oldD = await buyDomain(h, ada, "free-again.dev");
    const { token } = await attach(h, ada, oldD.id);
    h.registrar.oob.startTransferAway(oldD.fqdn);
    await syncDomain(h.app.ctx, oldD.id);
    h.registrar.oob.setTransferAwayStatus(oldD.fqdn, "completed");
    expect(await syncDomain(h.app.ctx, oldD.id)).toBe("released");
    const newD = await buyDomain(h, ada, "free-again.dev", { key: "again-2" });
    expect(newD.id).not.toBe(oldD.id);
    await autoRenewOn(h, await relogin(h, ada), newD.id);
    const tokens = (await h.app.db.owner.query("select revoked_at, scopes::text as s from bindings where user_id = $1", [ada.userId])).rows;
    expect(tokens.filter((t) => !t.revoked_at)).toHaveLength(0);
    for (const t of tokens) expect(t.s).not.toContain(newD.id);
    // The old bearer is refused everywhere, for the new domain and the old one.
    for (const id of [newD.id, oldD.id]) {
      const r = await h.app.call("DELETE", `/api/v1/domains/${id}/auto-renew`, { authorization: `Bearer ${token}`, browser: false });
      expect(r.status, id).toBe(401);
    }
    expect((await domainRow(h, newD.id)).auto_renew).toBe(true);        // and the new domain was not switched off by it
    expect(await counts(h, newD.id)).toEqual({ cards: 0, secrets: 0, connections: 0, liveBindings: 0 });
  });
});
