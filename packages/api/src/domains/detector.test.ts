import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashOf, sha256 } from "../util/bytes.ts";
import { commit, prepare } from "../stepup/testkit.ts";
import { deliverAll, drain, buyAndPay, REGISTRANT } from "../orders/testkit.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { runReconcile } from "./reconcile.ts";
import { syncDomain } from "./sync.ts";
import { alertRows, at, autoRenewOn, buyDomain, domainRow, findings, hygiene, makeDomainsHarness, makeOwner, relogin, renewOrders, settle, type DomainsHarness, type Owner } from "./testkit.ts";

let h: DomainsHarness; let ada: Owner;
beforeAll(async () => { h = await makeDomainsHarness(); ada = await makeOwner(h, "detector@example.com"); }, 120_000);
afterAll(async () => { await h?.app.drop(); });

const HOUR = 3600_000;
const step = async (ms: number) => { at(h, new Date(h.app.clock.now().getTime() + ms)); await settle(h); };
const findingsOf = async (domainId: string, fqdn?: string) => (await findings(h)).filter((f) => f.domain_id === domainId || (fqdn && f.fqdn_ascii === fqdn));
const fieldsOf = async (domainId: string) => (await findings(h)).filter((f) => f.domain_id === domainId).flatMap((f) => f.fields as string[]);

/** Pre-upgrade committed actions are synthetic historical evidence, never minted by the new mutation gate. */
async function historicalDelegationAction(domain: { id: string; fqdn: string }, input: Record<string, unknown>) {
  const params = { ...input, domain_id: domain.id, fqdn: domain.fqdn };
  return (await h.app.db.owner.query("insert into actions (user_id, session_id_hash, type, params, params_hash, state, expires_at, committed_at, credential_id, uv, be, bs, client_data_json, authenticator_data, signature, resource_id) values ($1,$2,'domain.nameservers.change',$3,$4,'committed',$5,$6,'historical-fixture',true,false,false,'fixture','fixture','fixture',$7) returning id", [ada.user.userId, sha256(Buffer.from(ada.user.cookie.split("=")[1]!, "base64url")), params, hashOf(params), new Date(h.app.clock.now().getTime() + 120_000), h.app.clock.now(), domain.id])).rows[0].id;
}

describe("ST-114: the detector fires within its cadence on an out-of-band change", () => {
  const cases: [string, string, (f: string) => void][] = [
    ["lock", "lock", (f) => h.registrar.oob.setLock(f, false)],
    ["nameservers", "nameservers", (f) => h.registrar.oob.setNameservers(f, ["ns1.attacker.example", "ns2.attacker.example"])],
    ["DS record", "ds", (f) => h.registrar.oob.addDs(f, { keyTag: 4242, algorithm: 13, digestType: 2, digest: "ab".repeat(32) })],
    ["contact email hash", "contact_email_hash", (f) => h.registrar.oob.changeOwnerEmail(f, "thief@example.net")],
    ["auto_renew", "auto_renew", (f) => h.registrar.oob.setAutoRenew(f, true)],
    ["let_expire", "let_expire", (f) => h.registrar.oob.letExpire(f, true)],
    ["privacy state", "privacy", (f) => h.registrar.oob.setPrivacy(f, "exposed")],
    ["a pending transfer away", "transfer", (f) => h.registrar.oob.startTransferAway(f, { gainingRegistrar: "Somewhere Else Ltd" })],
  ];

  it("every field of the diff produces a finding and a page within the hourly sweep, and a quiet domain produces none", async () => {
    // Mid-day UTC, so the steps below never cross midnight into the nightly posture job (which records its own fixes).
    const t = h.app.clock.now();
    at(h, new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1, 10, 5)));
    ada = await relogin(h, ada);
    const doms: { label: string; field: string; id: string; fqdn: string }[] = [];
    for (const [i, [label, field]] of cases.entries()) {
      const d = await buyDomain(h, ada, `free-det${i}.dev`);
      await syncDomain(h.app.ctx, d.id);                       // the baseline reading
      doms.push({ label, field, id: d.id, fqdn: d.fqdn });
    }
    const quiet = await buyDomain(h, ada, "free-detquiet.dev");
    await syncDomain(h.app.ctx, quiet.id);
    expect((await findings(h))).toHaveLength(0);
    expect(await alertRows(h, "unattributed_change")).toHaveLength(0);

    cases.forEach(([, , apply], i) => apply(doms[i]!.fqdn));
    // Inside the cadence: the next hourly sweep. Nothing waits for the daily reconcile.
    await step(61 * 60_000);
    for (const d of doms) expect(await fieldsOf(d.id), d.label).toContain(d.field);
    expect(await fieldsOf(quiet.id)).toEqual([]);
    const alerts = await alertRows(h, "unattributed_change");
    expect(alerts.map((a) => a.subject).sort()).toEqual(doms.map((d) => d.id).sort());
    for (const a of alerts) { expect(a.severity).toBe("page"); expect(JSON.stringify(a.detail)).not.toMatch(/attacker|thief|@|Somewhere/); }
    // The finding records field names and counts only.
    for (const f of await findings(h, "unexplained_change")) expect(JSON.stringify(f.detail)).not.toMatch(/attacker|thief|@|Somewhere/);
    // The same reading an hour later does not open the same finding twice.
    const n = (await findings(h)).length;
    await step(HOUR);
    expect((await findings(h)).length).toBe(n);
    // The audit chain of the owner carries the event by id, without values.
    const audit = (await h.app.db.owner.query("select detail from audit_log where chain_id = $1 and action = 'domain.unexplained_change'", [ada.userId])).rows;
    expect(audit.length).toBeGreaterThanOrEqual(cases.length);
    expect(JSON.stringify(audit)).not.toMatch(/attacker|thief|@/);
  }, 120_000);

  it("registrar.reconcile: a name the registrar holds that we do not is an extra_domain, a live row it does not list is a missing_domain", async () => {
    await h.registrar.register({ fqdn: "free-stranger.dev", years: 1, regUsername: "stranger01", regPassword: "passw0rd-long-enough", registrant: { name: "S", email: "s@example.net", phone: "+1.5555550100", street: "1 A St", city: "X", region: "OR", postalCode: "97201", country: "US" } });
    await h.app.db.owner.query("insert into domains (user_id, fqdn_ascii, tld, registrar, state, expires_at, livemode) values ($1,'ghost-row.dev','dev','opensrs','active', now() + interval '200 days', false)", [ada.userId]);
    const r = await runReconcile(h.app.ctx);
    expect(r.extra).toBe(1); expect(r.missing).toBe(1);
    const extra = (await findings(h, "extra_domain"))[0];
    expect(extra.fqdn_ascii).toBe("free-stranger.dev");
    expect((await findings(h, "missing_domain")).some((f) => f.domain_id)).toBe(true);
    // A second run does not repeat them, and the daily job is on the tick.
    const again = await runReconcile(h.app.ctx);
    expect(again.extra + again.missing).toBe(0);
    const runs = (await h.app.db.owner.query("select kind, finished_at from reconciliation_runs where kind = 'inventory'")).rows;
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.every((x) => x.finished_at)).toBe(true);
  });

  it("a change the detector already paged for is put right by the nightly posture job without a second page", async () => {
    // Pin the clock to 22:30 UTC: the 23:00 hourly sweep pages, then the steps cross midnight and the daily posture job runs.
    const now = h.app.clock.now();
    at(h, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 22, 30)));
    ada = await relogin(h, ada);
    const d = await buyDomain(h, ada, "free-detmidnight.dev");
    await syncDomain(h.app.ctx, d.id);
    h.registrar.oob.setAutoRenew(d.fqdn, true);
    await step(40 * 60_000);                                  // 23:10: the hourly sweep, still before midnight
    const kindOf = async (kind: string) => (await findings(h, kind)).filter((f) => f.domain_id === d.id).flatMap((f) => f.fields as string[]);
    expect(await kindOf("unexplained_change")).toEqual(["auto_renew"]);
    const pages = async () => (await alertRows(h)).filter((a) => a.subject === d.id || (a.detail as any)?.domain_id === d.id).length;
    const pagesBefore = await pages();
    expect(pagesBefore).toBeGreaterThanOrEqual(1);
    await step(HOUR);                                         // 00:10: posture turns auto-renew off again and records it
    expect((await h.registrar.getDomain(d.fqdn))!.autoRenew).toBe(false);
    expect(await kindOf("unexplained_change")).toEqual(["auto_renew"]);
    expect(await kindOf("mismatch")).toEqual(["auto_renew"]);
    expect(await pages()).toBe(pagesBefore);                  // one out-of-band change, one page
  });
});

describe("ST-60: crash recovery and ordering leave the detector quiet after reconciliation", () => {
  beforeEach(async () => { ada = await relogin(h, ada); });   // the test clock moves; sessions expire
  it("a process killed between the registrar succeeding and the order finishing: the name is upstream, our row is not, and reconcile stays quiet until the order catches up", async () => {
    h.registrar.faults.set("workerDeath", { fqdn: "free-crash.dev", times: 1 });
    const paid = await buyAndPay(h, ada, "free-crash.dev");
    await deliverAll(h);
    await drain(h);                                            // the fulfil job dies after the registrar accepted
    expect(h.registrar.domainRecord("free-crash.dev")).toBeTruthy();
    expect((await h.app.db.owner.query("select 1 from domains where fqdn_ascii = 'free-crash.dev'")).rowCount).toBe(0);
    const during = await runReconcile(h.app.ctx);
    expect(during.extra).toBe(0);
    await step(5 * 60_000);
    await step(5 * 60_000);
    const dom = (await h.app.db.owner.query("select id from domains where fqdn_ascii = 'free-crash.dev'")).rows[0];
    expect(dom, "the order resolved the unknown outcome and wrote the row").toBeTruthy();
    expect((await h.app.db.owner.query("select state from orders where id = $1", [paid.id])).rows[0].state).toBe("captured");
    const after = await runReconcile(h.app.ctx);
    expect(after.extra + after.missing).toBe(0);
    await syncDomain(h.app.ctx, dom.id);
    expect(await findingsOf(dom.id, "free-crash.dev")).toHaveLength(0);
    expect(h.registrar.upstream.registerApplied).toBeGreaterThanOrEqual(1);
  });

  it("a renewal whose worker died right after the registrar renewed is reconciled by polling, never renewed twice, and the detector stays quiet", async () => {
    const d = await buyDomain(h, ada, "free-crash2.dev");
    await autoRenewOn(h, ada, d.id);
    await syncDomain(h.app.ctx, d.id);
    const t0 = new Date(new Date((await h.app.db.owner.query("select charge_at from renewal_terms where domain_id = $1", [d.id])).rows[0].charge_at).getTime() + 60_000);
    at(h, t0);
    const renewsBefore = h.registrar.calls.renew;
    h.registrar.faults.set("workerDeath", { fqdn: d.fqdn, times: 1 });
    await settle(h);                                           // charge, renew applied upstream, the worker dies; the follow-up job polls
    await step(20 * 60_000);
    await step(20 * 60_000);
    const order = (await renewOrders(h, d.id))[0];
    expect(order.state).toBe("renewed");
    expect(h.registrar.calls.renew - renewsBefore).toBe(1);   // polled, not re-sent
    expect(h.registrar.upstream.renewApplied).toBeGreaterThanOrEqual(1);
    expect(h.stripe.created.refunds).toBe(0);
    await syncDomain(h.app.ctx, d.id);
    expect(await findingsOf(d.id, d.fqdn)).toHaveLength(0);
  });

  it("a renewal committed with no job left behind (killed after commit, before the job ran) is picked up by the scheduler's safety net", async () => {
    const d = await buyDomain(h, ada, "free-crash3.dev");
    await autoRenewOn(h, ada, d.id);
    await syncDomain(h.app.ctx, d.id);
    const t0 = new Date(new Date((await h.app.db.owner.query("select charge_at from renewal_terms where domain_id = $1", [d.id])).rows[0].charge_at).getTime() + 60_000);
    at(h, t0);
    await h.app.db.owner.query("update flags set value = 'true', updated_by = 'test' where name = 'registrar_writes_paused'");
    await settle(h);                                           // charged; the registrar write is paused, so it waits
    const order = (await renewOrders(h, d.id))[0];
    expect(order.state).toBe("renewing_upstream");
    await h.app.db.owner.query("delete from jobs where kind = 'renewal.charge'");    // the process died: every job row of this order is gone
    await h.app.db.owner.query("update flags set value = 'false', updated_by = 'test' where name = 'registrar_writes_paused'");
    await step(16 * 60_000);
    expect((await renewOrders(h, d.id))[0].state).toBe("renewed");
  });

  it("two actions queued for one domain: any prefix of the committed sequence is explained, in commit order, and a state no prefix produces is a finding", async () => {
    const d = await buyDomain(h, ada, "free-order60.dev");
    await syncDomain(h.app.ctx, d.id);
    // Historical actions remain relevant to the detector even though new delegation writes are now gated.
    const commitNs = (ns: string[]) => historicalDelegationAction(d, { op: "nameservers", nameservers: ns });
    const A = ["ns1.first-host.example", "ns2.first-host.example"], B = ["ns1.second-host.example", "ns2.second-host.example"];
    await commitNs(A);
    await commitNs(B);
    // Only the first has reached the registrar: quiet. Then the second: quiet.
    h.registrar.oob.setNameservers(d.fqdn, A);
    await syncDomain(h.app.ctx, d.id);
    expect(await fieldsOf(d.id)).toEqual([]);
    h.registrar.oob.setNameservers(d.fqdn, B);
    await syncDomain(h.app.ctx, d.id);
    expect(await fieldsOf(d.id)).toEqual([]);
    // A state that neither action produces is unattributed.
    h.registrar.oob.setNameservers(d.fqdn, ["ns1.somewhere-else.example", "ns2.somewhere-else.example"]);
    await syncDomain(h.app.ctx, d.id);
    expect(await fieldsOf(d.id)).toEqual(["nameservers"]);
    // The cache follows the registrar, so the domain row now holds what the registrar has.
    expect((await domainRow(h, d.id)).nameservers).toEqual(["ns1.somewhere-else.example", "ns2.somewhere-else.example"]);
  });

  it("review: a committed contact change explains only the registrant email it sets, and a DS change only the presence it sets", async () => {
    ada = await relogin(h, ada);
    const d = await buyDomain(h, ada, "free-contact60.dev");
    await syncDomain(h.app.ctx, d.id);
    const base = (await domainRow(h, d.id)).owner_email_hash as string;
    expect(base).toBeTruthy();
    const submit = async (fields: Record<string, string>) => {
      await hygiene(h);                                          // the pages this test opens would otherwise pause registrar writes
      const dr = await h.app.call("POST", `/api/v1/domains/${d.fqdn}/contact-drafts`, { cookie: ada.cookie, body: { ...REGISTRANT, email: ada.email, ...fields } });
      expect(dr.status, JSON.stringify(dr.json)).toBe(201);
      const prep = await prepare(h.app, ada.user, { type: "domain.contact.change", target_id: dr.json.id, user_input: {} });
      expect(prep.status, JSON.stringify(prep.json)).toBe(200);
      expect((await commit(h.app, ada.user, prep.json.action_id, ada.key.auth.get(prep.json.webauthn_options))).status).toBe(200);
      const res = await h.app.call("POST", `/api/v1/domains/${d.fqdn}/contact`, { cookie: ada.cookie, body: {}, headers: { [ACTION_HEADER]: prep.json.action_id } });
      expect([200, 202], JSON.stringify(res.json)).toContain(res.status);
      return dr.json as { registrant_change: boolean };
    };
    // A phone-only change through the passkey flow: the registrant email stays as it was.
    expect((await submit({ phone: "+1.5555550199" })).registrant_change).toBe(false);
    await syncDomain(h.app.ctx, d.id);
    expect(await fieldsOf(d.id)).toEqual([]);
    // Days later the registrant email is changed at the registrar by someone else (end-user interface or support): a finding.
    h.registrar.oob.changeOwnerEmail(d.fqdn, "thief@example.net");
    await syncDomain(h.app.ctx, d.id);
    expect(await fieldsOf(d.id)).toEqual(["contact_email_hash"]);

    // A committed change of registrant email explains that email once the upstream applies it, and nothing else.
    const e = await buyDomain(h, ada, "free-contact61.dev");
    await syncDomain(h.app.ctx, e.id);
    await hygiene(h);
    const dr = await h.app.call("POST", `/api/v1/domains/${e.fqdn}/contact-drafts`, { cookie: ada.cookie, body: { ...REGISTRANT, email: "new-registrant@example.org" } });
    expect(dr.json.registrant_change).toBe(true);
    const prep = await prepare(h.app, ada.user, { type: "domain.contact.change", target_id: dr.json.id, user_input: {} });
    expect((await commit(h.app, ada.user, prep.json.action_id, ada.key.auth.get(prep.json.webauthn_options))).status).toBe(200);
    expect((await h.app.call("POST", `/api/v1/domains/${e.fqdn}/contact`, { cookie: ada.cookie, body: {}, headers: { [ACTION_HEADER]: prep.json.action_id } })).status).toBe(202);
    h.registrar.approveContactChange(e.fqdn);
    await syncDomain(h.app.ctx, e.id);
    expect(await fieldsOf(e.id)).toEqual([]);
    h.registrar.oob.changeOwnerEmail(e.fqdn, "thief2@example.net");
    await syncDomain(h.app.ctx, e.id);
    expect(await fieldsOf(e.id)).toEqual(["contact_email_hash"]);

    // DS: an add explains a DS appearing, not one disappearing.
    const f = await buyDomain(h, ada, "free-ds60.dev");
    await syncDomain(h.app.ctx, f.id);
    const ds = { keyTag: 4242, algorithm: 13, digestType: 2, digest: "ab".repeat(32) };
    await historicalDelegationAction(f, { op: "ds_add", ds });
    h.registrar.oob.addDs(f.fqdn, ds);                           // what the action did at the registrar
    await syncDomain(h.app.ctx, f.id);
    expect(await fieldsOf(f.id)).toEqual([]);
    await h.registrar.removeDs(f.fqdn, ds);                      // nobody asked for this
    await syncDomain(h.app.ctx, f.id);
    expect(await fieldsOf(f.id)).toEqual(["ds"]);
  });

  it("an unlock we committed explains the lock change and its re-lock; a lock change with no action does not", async () => {
    const d = await buyDomain(h, ada, "free-unlock60.dev");
    const other = await buyDomain(h, ada, "free-nolock60.dev");
    await syncDomain(h.app.ctx, d.id); await syncDomain(h.app.ctx, other.id);
    const prep = await prepare(h.app, ada.user, { type: "domain.unlock", target_id: d.fqdn, user_input: {} });
    expect(prep.status, JSON.stringify(prep.json)).toBe(200);
    expect((await commit(h.app, ada.user, prep.json.action_id, ada.key.auth.get(prep.json.webauthn_options))).status).toBe(200);
    h.registrar.oob.setLock(d.fqdn, false);                    // what the action's job did at the registrar
    h.registrar.oob.setLock(other.fqdn, false);                // nobody asked for this one
    await syncDomain(h.app.ctx, d.id); await syncDomain(h.app.ctx, other.id);
    expect(await fieldsOf(d.id)).toEqual([]);
    expect(await fieldsOf(other.id)).toEqual(["lock"]);
    h.registrar.oob.setLock(d.fqdn, true);                     // the re-lock
    await syncDomain(h.app.ctx, d.id);
    expect(await fieldsOf(d.id)).toEqual([]);
  });
});
