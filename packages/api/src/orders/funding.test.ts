import { afterEach, describe, expect, it } from "vitest";
import { tx } from "@mosshatch/db";
import { RegistrarError } from "@mosshatch/registrar/port";
import { fundingAdmissionControl, withFundingAdmissionControl } from "../registrar-rpc/funding-control.ts";
import { MemoryPaidOperationLock, serializePaidOperations } from "../registrar-rpc/paid-operation.ts";
import { advance, machine } from "./machine.ts";
import { reserveFunding } from "./funding.ts";
import { buyAndPay, makeBuyer, makeHarness, orderRow, type OrdersHarness } from "./testkit.ts";
import { loadOrder } from "./support.ts";
import { makeDomainsHarness, makeOwner, buyDomain, autoRenewOn, termRow, at, hygiene, renewOrders, type DomainsHarness } from "../domains/testkit.ts";
import { runRenewalScheduler } from "../domains/renewals.ts";
import { runTick } from "../jobs/engine.ts";

const opened: OrdersHarness[] = [];
afterEach(async () => { while (opened.length) await opened.pop()!.app.drop(); });
async function harness() {
  const h = await makeHarness({ funding: 1_000_000n });
  opened.push(h);
  const lock = new MemoryPaidOperationLock(h.app.clock);
  h.svc.registrar = withFundingAdmissionControl(serializePaidOperations(h.registrar, lock), fundingAdmissionControl(h.registrar, lock, h.app.clock));
  h.app.ctx.services.fundedAdmission = true;
  return h;
}
const reserve = (h: OrdersHarness) => h.app.db.owner.query("select coalesce(sum(funding_reserved_minor),0)::text as total from orders").then((r) => BigInt(r.rows[0].total));

describe("atomic funded admission in native PostgreSQL", () => {
  it("a burst of verified card authorizations reserves only the available wholesale; unpaid Checkout reserves zero", async () => {
    const h = await harness();
    h.registrar.setBalance(28_400n); // USD250 cushion plus two USD17 wholesale orders.
    const orders = [];
    for (let i = 0; i < 8; i++) {
      const buyer = await makeBuyer(h, `funded-burst-${i}@example.test`);
      orders.push(await buyAndPay(h, buyer, `free-funded-burst-${i}.dev`));
    }
    expect(await reserve(h)).toBe(0n);
    // Separate workers race for the same shared vendor boundary; busy work is retried without any vendor write.
    const raced = await Promise.allSettled(orders.map((o) => advance(machine(h.app.ctx), o.id, { maxSteps: 1 })));
    for (const result of raced) if (result.status === "rejected")
      expect(result.reason).toBeInstanceOf(RegistrarError);
    for (const o of orders) if ((await orderRow(h, o.id)).state === "checkout_open")
      await advance(machine(h.app.ctx), o.id, { maxSteps: 1 });
    const rows = (await h.app.db.owner.query("select state, funding_reserved_minor from orders")).rows;
    expect(rows.filter((r) => r.state === "authorized")).toHaveLength(2);
    expect(rows.filter((r) => r.state === "canceling")).toHaveLength(6);
    expect(await reserve(h)).toBe(3_400n);
    expect(h.registrar.orders).toHaveLength(0);
    expect(h.stripe.created.captures).toBe(0);
  });
  it("the PostgreSQL boundary makes two independent reservation transactions compete for one available wholesale slot", async () => {
    const h = await harness();
    const buyer = await makeBuyer(h, "funded-atomic@example.test");
    const one = await buyAndPay(h, buyer, "free-funding-atomic-a.dev", { key: "a" });
    const two = await buyAndPay(h, buyer, "free-funding-atomic-b.dev", { key: "b" });
    const rows = await Promise.all([loadOrder(h.app.ctx.cron, one.id), loadOrder(h.app.ctx.cron, two.id)]);
    const lease = { token: "00000000-0000-4000-8000-000000000000", available: { minor: 26_700n, currency: "usd" as const, source: "sample" as const }, expiresAt: new Date(h.app.clock.now().getTime() + 900_000) };
    const results = await Promise.all(rows.map((o) => tx(h.app.ctx.cron, async (c) => {
      await c.query("select id from orders where id=$1 for update", [o!.id]);
      return reserveFunding(h.app.ctx, c, o!, lease);
    })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await reserve(h)).toBe(1_700n);
  });
  it("a known vendor debit releases only its reservation; another pending order still protects the cash cushion", async () => {
    const h = await harness();
    h.registrar.setBalance(28_400n);
    const buyers = await Promise.all([makeBuyer(h, "funded-debit-a@example.test"), makeBuyer(h, "funded-debit-b@example.test")]);
    const one = await buyAndPay(h, buyers[0]!, "free-funded-debit-a.dev");
    const two = await buyAndPay(h, buyers[1]!, "free-funded-debit-b.dev");
    for (const o of [one, two]) await advance(machine(h.app.ctx), o.id, { maxSteps: 1 });
    await advance(machine(h.app.ctx), one.id);
    expect((await orderRow(h, one.id)).funding_reserved_minor).toBe("0");
    expect((await orderRow(h, two.id)).funding_reserved_minor).toBe("1700");
    expect((await h.registrar.getFundingStatus()) as object).toMatchObject({ minor: 26_700n });
    h.registrar.topUp(1_700n);
    const third = await buyAndPay(h, buyers[0]!, "free-funded-debit-c.dev", { key: "third" });
    await advance(machine(h.app.ctx), third.id, { maxSteps: 1 });
    expect(await reserve(h)).toBe(3_400n);
  });
  it("reservations for every paid operation kind stay counted across pending and early-captured states", async () => {
    const h = await harness();
    const kinds = ["register", "renew", "transfer_in", "restore"] as const;
    const states = ["outcome_unknown", "renewing_upstream", "captured", "paid_before_registration"];
    for (let i = 0; i < kinds.length; i++) {
      const buyer = await makeBuyer(h, `funded-kind-${i}@example.test`);
      const o = await buyAndPay(h, buyer, `free-funded-kind-${i}.dev`);
      await h.app.db.owner.query("update orders set kind=$2,state=$3,funding_reserved_minor=2000 where id=$1", [o.id, kinds[i], states[i]]);
    }
    const buyer = await makeBuyer(h, "funded-kinds-target@example.test");
    const target = await buyAndPay(h, buyer, "free-funded-kinds-target.dev");
    const o = (await loadOrder(h.app.ctx.cron, target.id))!;
    const testReserve = (minor: bigint) => tx(h.app.ctx.cron, async (c) => {
      await c.query("select id from orders where id=$1 for update", [o.id]);
      return reserveFunding(h.app.ctx, c, o, { token: "unit-test", available: { minor, currency: "usd", source: "sample" }, expiresAt: new Date(h.app.clock.now().getTime() + 900_000) });
    });
    expect(await testReserve(34_699n)).toBe(false);
    expect(await testReserve(34_700n)).toBe(true);
    expect(await reserve(h)).toBe(9_700n);
  });
  it("off-session renewals reserve before Stripe and retain funding after an unanswered payment", async () => {
    const h = await makeDomainsHarness({ funding: 1_000_000n });
    opened.push(h);
    const owner = await makeOwner(h, "funded-renew@example.test");
    const domain = await buyDomain(h, owner, "free-funded-renew.dev");
    await autoRenewOn(h, owner, domain.id);
    const lock = new MemoryPaidOperationLock(h.app.clock);
    h.svc.registrar = withFundingAdmissionControl(serializePaidOperations(h.registrar, lock), fundingAdmissionControl(h.registrar, lock, h.app.clock));
    h.app.ctx.services.fundedAdmission = true;
    const term = await termRow(h, domain.id);
    at(h, new Date(new Date(term.charge_at).getTime() + 60_000));
    h.registrar.setBalance(26_700n);
    let seenReserve = 0n;
    const original = h.stripe.createOffSessionPaymentIntent.bind(h.stripe);
    h.stripe.createOffSessionPaymentIntent = async (input, key) => {
      seenReserve = BigInt((await h.app.db.owner.query("select funding_reserved_minor from orders where id=$1", [input.metadata.order_id])).rows[0].funding_reserved_minor);
      return original(input, key);
    };
    h.stripe.fail("createOffSessionPaymentIntent", { kind: "timeout" });
    await hygiene(h);
    await runRenewalScheduler(h.app.ctx);
    await runTick(h.app.ctx, { heartbeat: false, budgetMs: 5_000, concurrency: 1 });
    expect(seenReserve).toBe(1_700n);
    expect((await renewOrders(h, domain.id))[0].state).toBe("draft");
    expect(await reserve(h)).toBe(1_700n);
    expect(h.registrar.calls.renew ?? 0).toBe(0);
    void (h as DomainsHarness);
  });
});
