import { afterEach, describe, expect, it } from "vitest";
import { buyDomain, harnessPerTest, makeOwner, type DomainsHarness, type Owner } from "./testkit.ts";

const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); });

const refund = (h: DomainsHarness, o: Owner, orderId: string, body: unknown = {}) => h.app.call("POST", `/api/v1/orders/${orderId}/refund`, { cookie: o.cookie, body });

/** `n` names bought and renewed once through Renew now; returns the renewal order ids (each `renewed`, inside the 5-day refund window). */
async function renewedOrders(h: DomainsHarness, o: Owner, tag: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = await buyDomain(h, o, `free-${tag}${i}.dev`);
    const click = await h.app.call("POST", `/api/v1/domains/${d.id}/renew`, { cookie: o.cookie, body: {} });
    expect(click.status, JSON.stringify(click.json)).toBe(200);
    ids.push(click.json.order_id as string);
  }
  const st = (await h.app.db.owner.query("select state from orders where id = any($1::uuid[])", [ids])).rows.map((r) => r.state);
  expect(st).toEqual(ids.map(() => "renewed"));
  return ids;
}

describe("ST-102: the refund cap holds for renewal refunds too (3 per account per 30 days)", () => {
  it("ST-102: parallel renewal refunds cannot pass the cap", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "cap-renew-par@example.com");
    const ids = await renewedOrders(h, o, "caprp", 4);
    const res = await Promise.all(ids.map((id) => refund(h, o, id, { confirm_delete: true })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(3);
    expect(res.filter((r) => r.status !== 200).map((r) => [r.status, r.json.error.code])).toEqual([[403, "refund_cap"]]);
    expect(h.stripe.created.refunds).toBe(3);
    expect((await h.app.db.owner.query("select count(*)::int n from refunds where user_id = $1", [o.userId])).rows[0].n).toBe(3);
  });

  it("ST-102: a renewal refund Stripe still reports as pending counts against the cap while it is in flight", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "cap-renew-pend@example.com");
    const ids = await renewedOrders(h, o, "caprn", 4);
    h.stripe.refundStatus = "pending";
    for (let i = 0; i < 3; i++) {
      const r = await refund(h, o, ids[i]!, { confirm_delete: true });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json.state).toBe("refund_pending");
    }
    const fourth = await refund(h, o, ids[3]!, { confirm_delete: true });
    expect([fourth.status, fourth.json.error?.code]).toEqual([403, "refund_cap"]);
    expect(h.stripe.created.refunds).toBe(3);
  });
});
