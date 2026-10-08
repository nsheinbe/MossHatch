import { afterEach, describe, expect, it } from "vitest";
import { at, autoRenewOn, buyDomain, days, domainRow, harnessPerTest, mailOf, makeOwner, renewOrders, settle, type DomainsHarness } from "./testkit.ts";

const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); });

const notices = async (h: DomainsHarness, domainId: string) => (await h.app.db.owner.query("select kind, stage, term_key, email_log_id from notices where domain_id = $1 order by sent_at, kind", [domainId])).rows;

/** Move the staging clock to `t`, let the jobs table run, then again an hour later (so a job that needed the first pass's sync sees its result). */
async function goto(h: DomainsHarness, t: Date) {
  at(h, t); await settle(h);
  at(h, new Date(t.getTime() + 3600_000)); await settle(h);
}

describe("renewal notices at E-43, E-32, C-8 and E+1 are sent from the jobs table in a simulated staging clock (D-008, C-26, C-32)", () => {
  it("reminder mode (auto-renew off): E-43, E-32, C-8 = E-18, the ICANN notice at E-7, E+1, then the last-chance notices at E+7, E+21 and E+35, each once", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "reminder@example.com");
    const dom = await buyDomain(h, o, "free-reminder.dev");
    const E = new Date((await domainRow(h, dom.id)).expires_at);
    const count = (kind: string) => mailOf(h, kind).length;

    await goto(h, new Date(E.getTime() - days(50)));
    expect(count("renewal_notice")).toBe(0);

    await goto(h, new Date(E.getTime() - days(43)));
    expect(count("renewal_notice")).toBe(1);
    const e43 = mailOf(h, "renewal_notice")[0]!;
    expect(e43.subject).toContain("expires on");
    expect(e43.text).toContain("Auto-renew is off");
    expect(e43.text).toContain("USD 20.00");                       // .dev renewal: 17.00 wholesale + 3.00 fee
    expect(e43.to).toEqual(["reminder@example.com"]);

    await goto(h, new Date(E.getTime() - days(32)));
    expect(count("renewal_notice")).toBe(2);
    await goto(h, new Date(E.getTime() - days(18)));
    expect(count("renewal_notice")).toBe(3);
    await goto(h, new Date(E.getTime() - days(7)));
    expect(count("renewal_notice")).toBe(3);
    expect(count("expiry_notice")).toBe(1);
    expect(mailOf(h, "expiry_notice")[0]!.text).toContain("whether or not auto-renew is on");

    await goto(h, new Date(E.getTime() + days(1)));
    expect(count("renewal_notice")).toBe(4);
    expect(mailOf(h, "renewal_notice")[3]!.subject).toContain("expired");
    expect((await domainRow(h, dom.id)).state).toBe("expired");
    expect(count("expiry_lastchance")).toBe(0);

    await goto(h, new Date(E.getTime() + days(7)));
    expect(count("expiry_lastchance")).toBe(1);
    await goto(h, new Date(E.getTime() + days(21)));
    expect(count("expiry_lastchance")).toBe(2);
    await goto(h, new Date(E.getTime() + days(35)));
    expect(count("expiry_lastchance")).toBe(3);
    expect(mailOf(h, "expiry_lastchance")[2]!.text).toContain("expired 35 days ago");

    // Nothing was sent twice, and every notice has a ledger row that points at its email log row.
    const rows = (await notices(h, dom.id)).filter((r) => /^(renewal|expiry)\./.test(r.kind));
    expect(rows.map((r) => r.kind)).toEqual([
      "renewal.e43", "renewal.e32", "renewal.c8", "expiry.e7", "renewal.e_plus_1", "expiry.lastchance.e7", "expiry.lastchance.e21", "expiry.lastchance.e35",
    ]);
    for (const r of rows) expect(r.email_log_id).toBeTruthy();
    const before = h.app.email.sent.length;
    await goto(h, new Date(E.getTime() + days(35)));
    expect(h.app.email.sent.length).toBe(before);
    expect(await renewOrders(h, dom.id)).toHaveLength(0);          // reminder mode never charges
    // The mail carries no address of anyone else and no link other than the site.
    for (const m of h.app.email.sent) expect(m.text).not.toMatch(/https?:\/\/(?!mosshatch\.test)/);
  }, 120_000);

  it("auto-renew on: the pre-charge notice at C-8 carries the one-click turn-off link, the charge renews at E-10, and the ICANN E-7 notice says the name was renewed", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "auto@example.com");
    const dom = await buyDomain(h, o, "free-auto.dev");
    await autoRenewOn(h, o, dom.id);
    const E = new Date((await domainRow(h, dom.id)).expires_at);

    await goto(h, new Date(E.getTime() - days(43)));
    const e43 = mailOf(h, "renewal_notice")[0]!;
    expect(e43.text).toContain("auto-renew is on");
    expect(e43.text).toMatch(/Turn auto-renew off with one click: https:\/\/mosshatch\.test\/api\/v1\/email-actions\/[A-Za-z0-9_-]{43}/);
    await goto(h, new Date(E.getTime() - days(32)));
    await goto(h, new Date(E.getTime() - days(18)));
    const c8 = mailOf(h, "renewal_notice")[2]!;
    expect(c8.text).toContain("In 8 days");
    expect(c8.text).toContain("we charge USD 20.00 to your saved card");
    expect(await renewOrders(h, dom.id)).toHaveLength(0);          // eight days before the charge, nothing has been charged yet

    await goto(h, new Date(E.getTime() - days(10)));
    const orders = await renewOrders(h, dom.id);
    expect(orders.map((r) => r.state)).toEqual(["renewed"]);
    // The notice at C-8 preceded the charge by eight days, and E-7 still goes out, saying the name was renewed.
    await goto(h, new Date(E.getTime() - days(7)));
    const e7 = mailOf(h, "expiry_notice");
    expect(e7).toHaveLength(1);
    expect(e7[0]!.subject).toContain("was renewed");
    expect(e7[0]!.text).toContain("it now runs to");
    // Renewed: no post-expiry notice, no last-chance notice.
    await goto(h, new Date(E.getTime() + days(1)));
    await goto(h, new Date(E.getTime() + days(7)));
    expect(mailOf(h, "expiry_lastchance")).toHaveLength(0);
    expect(mailOf(h, "renewal_notice").filter((m) => m.subject.includes("expired"))).toHaveLength(0);
    expect(mailOf(h, "receipt").length).toBeGreaterThanOrEqual(1);           // the registration
    // C-33, C-34: the renewal receipt keeps the authorisation terms (ceiling) and the one-click turn-off link.
    const rr = mailOf(h, "renewal_receipt");
    expect(rr).toHaveLength(1);
    expect(rr[0]!.text).toMatch(/up to USD \d+\.\d\d for one year/);
    expect(rr[0]!.text).toMatch(/\/api\/v1\/email-actions\/[A-Za-z0-9_-]{43}/);
  }, 120_000);
});
