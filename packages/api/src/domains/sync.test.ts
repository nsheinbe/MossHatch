import { afterEach, describe, expect, it } from "vitest";
import { RegistrarError } from "@mosshatch/registrar/port";
import { commit, prepare } from "../stepup/testkit.ts";
import { buyAndPay, deliverAll, drain } from "../orders/testkit.ts";
import { syncDomain } from "./sync.ts";
import { at, buyDomain, days, domainRow, findings, harnessPerTest, makeOwner, relogin, type DomainsHarness, type Owner } from "./testkit.ts";

const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); });

const grove = async (h: DomainsHarness, o: Owner) => (await h.app.call("GET", "/api/v1/domains", { cookie: (await relogin(h, o)).cookie })).json as { domains: any[]; eggs: any[] };
const viewOf = async (h: DomainsHarness, o: Owner, id: string) => (await grove(h, o)).domains.find((d) => d.id === id);

describe("domain.sync: adapter truth into domains", () => {
  it("copies what the registrar says and stamps synced_at; the derived state carries asOf and source", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "sync1@example.com");
    const d = await buyDomain(h, o, "free-sync1.dev");
    h.registrar.oob.setNameservers(d.fqdn, ["ns1.hosted.example", "ns2.hosted.example"]);
    h.app.clock.advance(120_000);
    expect(await syncDomain(h.app.ctx, d.id)).toBe("synced");
    const row = await domainRow(h, d.id);
    const st = (await h.registrar.getDomain(d.fqdn))!;
    expect(row.state).toBe("active");
    expect(row.nameservers).toEqual(["ns1.hosted.example", "ns2.hosted.example"]);
    expect(new Date(row.expires_at).getTime()).toBe(st.expiresAt!.getTime());
    expect(row.locked).toBe(true); expect(row.ds_present).toBe(false); expect(row.privacy_status).toBe("redacted_default");
    expect(row.owner_email_hash).toBe(st.ownerEmailHash);
    expect(new Date(row.synced_at).getTime()).toBe(h.app.clock.now().getTime());
    expect(row.sync_error).toBeNull();
    const v = await viewOf(h, o, d.id);
    expect(v).toMatchObject({ source: "adapter", confirmed: true, fqdn: "free-sync1.dev", tld: "dev" });
    expect(new Date(v.as_of).getTime()).toBe(h.app.clock.now().getTime());
  });

  it("every creature state is reachable from adapter facts", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "states@example.com");

    // egg: an order paid and waiting on the registrar has no domain row yet, only an egg.
    h.registrar.faults.set("insufficientFunds", { times: 1 });
    const eggOrder = await buyAndPay(h, o, "free-egg.dev");
    await deliverAll(h); await drain(h);
    const g0 = await grove(h, o);
    expect(g0.eggs.map((e) => [e.fqdn, e.state])).toEqual([["free-egg.dev", "egg"]]);
    h.registrar.topUp(5_000_000n); void eggOrder;

    const d = await buyDomain(h, o, "free-states.dev");
    const E = new Date((await domainRow(h, d.id)).expires_at);
    await syncDomain(h.app.ctx, d.id);
    // armored: locked, far from expiry.
    expect(await viewOf(h, o, d.id)).toMatchObject({ state: "armored", armored: true, state_text: "Transfer lock on" });
    // thriving: unlocked, far from expiry.
    h.registrar.oob.setLock(d.fqdn, false); await syncDomain(h.app.ctx, d.id);
    expect(await viewOf(h, o, d.id)).toMatchObject({ state: "thriving", armored: false });
    h.registrar.oob.setLock(d.fqdn, true); await syncDomain(h.app.ctx, d.id);

    // shedding: a DNS write accepted but not visible yet (the DNS module's intents table).
    await h.app.db.owner.query("create table if not exists dns_write_intents (id uuid primary key default uuidv7(), domain_id uuid not null, state text not null); grant all on dns_write_intents to mh_cron; grant select on dns_write_intents to mh_runtime;");
    await h.app.db.owner.query("insert into dns_write_intents (domain_id, state) values ($1,'submitted')", [d.id]);
    expect((await viewOf(h, o, d.id)).state).toBe("shedding");
    await h.app.db.owner.query("update dns_write_intents set state = 'visible_at_authoritative'");

    // drowsy: inside the renewal window with nothing blocking.
    at(h, new Date(E.getTime() - days(20))); await syncDomain(h.app.ctx, d.id);
    expect(await viewOf(h, o, d.id)).toMatchObject({ state: "drowsy", state_text: "Renews in 20 days", days_to_expiry: 20 });

    // attention: a sync error older than 15 minutes ("We cannot confirm this domain's state right now"), shown as unconfirmed.
    const realGet = h.registrar.getDomain.bind(h.registrar);
    h.registrar.getDomain = async () => { throw new RegistrarError("unavailable", "registrar is down", { retryable: true, outcomeUnknown: false, code: "503" }); };
    expect(await syncDomain(h.app.ctx, d.id)).toBe("error");
    expect((await viewOf(h, o, d.id)).state).toBe("drowsy");            // not yet: the error is younger than 15 minutes
    at(h, new Date(h.app.clock.now().getTime() + 16 * 60_000));
    expect(await syncDomain(h.app.ctx, d.id)).toBe("error");
    const bad = await viewOf(h, o, d.id);
    expect(bad).toMatchObject({ state: "attention", confirmed: false });
    expect(bad.state_text).toBe("We cannot confirm this domain's state right now.");
    h.registrar.getDomain = realGet;
    await syncDomain(h.app.ctx, d.id);
    expect((await domainRow(h, d.id)).sync_error).toBeNull();

    // sleeping: expired (grace), then redemption.
    at(h, new Date(E.getTime() + days(5))); await syncDomain(h.app.ctx, d.id);
    let v = await viewOf(h, o, d.id);
    expect(v.state).toBe("sleeping"); expect(v.state_text).toContain("Expired");
    at(h, new Date(E.getTime() + days(45))); await syncDomain(h.app.ctx, d.id);
    v = await viewOf(h, o, d.id);
    expect(v.state).toBe("sleeping"); expect(v.state_text).toContain("redemption");
    expect(v.adapter_state).toBe("redemption");
  });

  it("a pending transfer away nobody asked for is needs-attention; one the person started with a passkey is traveling", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "travel@example.com");
    const stray = await buyDomain(h, o, "free-stray.dev");
    const mine = await buyDomain(h, o, "free-mine.dev");
    await syncDomain(h.app.ctx, stray.id); await syncDomain(h.app.ctx, mine.id);
    h.registrar.oob.startTransferAway(stray.fqdn, { gainingRegistrar: "Elsewhere Ltd" });
    await syncDomain(h.app.ctx, stray.id);
    const sv = await viewOf(h, o, stray.id);
    expect(sv.state).toBe("attention"); expect(sv.state_text).toContain("You did not ask for it");
    expect((await findings(h, "unexplained_change")).some((f) => f.domain_id === stray.id && (f.fields as string[]).includes("transfer"))).toBe(true);

    // The person's own transfer: unlock, then the code-issue action (the passkey commits), then the registrar shows the transfer.
    const oo = await relogin(h, o);
    h.registrar.oob.setLock(mine.fqdn, false); await syncDomain(h.app.ctx, mine.id);
    const prep = await prepare(h.app, oo.user, { type: "domain.transfer_out", target_id: mine.fqdn, user_input: {} });
    expect(prep.status, JSON.stringify(prep.json)).toBe(200);
    expect((await commit(h.app, oo.user, prep.json.action_id, oo.key.auth.get(prep.json.webauthn_options))).status).toBe(200);
    h.registrar.oob.startTransferAway(mine.fqdn, { gainingRegistrar: "Chosen Registrar" });
    await syncDomain(h.app.ctx, mine.id);
    const mv = await viewOf(h, o, mine.id);
    expect(mv.state).toBe("traveling");
    expect((await findings(h, "unexplained_change")).filter((f) => f.domain_id === mine.id)).toHaveLength(1);   // only the unlock we did it with, not the transfer
  });
});
