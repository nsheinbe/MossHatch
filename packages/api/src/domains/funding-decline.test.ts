import { afterEach, describe, expect, it } from "vitest";
import type { PoolClient } from "@mosshatch/db";
import { machine } from "../orders/machine.ts";
import { fundingAdmissionControl, withFundingAdmissionControl } from "../registrar-rpc/funding-control.ts";
import { MemoryPaidOperationLock, serializePaidOperations } from "../registrar-rpc/paid-operation.ts";
import { StripeError } from "../stripe/port.ts";
import { advanceRenewal, runRenewalScheduler } from "./renewals.ts";
import { at, autoRenewOn, buyDomain, hygiene, makeDomainsHarness, makeOwner, renewOrders, termRow, type DomainsHarness } from "./testkit.ts";

const opened: DomainsHarness[] = [];
afterEach(async () => { while (opened.length) await opened.pop()!.app.drop(); });

function barrier() {
  let release = () => {};
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
}

async function fundedRenewal(tag: string) {
  const h = await makeDomainsHarness({ funding: 1_000_000n });
  opened.push(h);
  const owner = await makeOwner(h, `funded-decline-${tag}@example.test`);
  const domain = await buyDomain(h, owner, `free-funded-decline-${tag}.dev`);
  await autoRenewOn(h, owner, domain.id);
  const lock = new MemoryPaidOperationLock(h.app.clock);
  h.svc.registrar = withFundingAdmissionControl(serializePaidOperations(h.registrar, lock), fundingAdmissionControl(h.registrar, lock, h.app.clock));
  h.app.ctx.services.fundedAdmission = true;
  const term = await termRow(h, domain.id);
  at(h, new Date(new Date(term.charge_at).getTime() + 60_000));
  h.registrar.setBalance(26_700n); // Cash floor plus one USD17 renewal.
  await hygiene(h);
  await runRenewalScheduler(h.app.ctx);
  const order = (await renewOrders(h, domain.id))[0]!;
  return { h, id: order.id as string };
}

async function funding(h: DomainsHarness, id: string) {
  return BigInt((await h.app.db.owner.query("select funding_reserved_minor from orders where id=$1", [id])).rows[0].funding_reserved_minor);
}

describe("renewal decline funding fences on native PostgreSQL", () => {
  it("commits the decline and its release together before a newer unknown charge starts", async () => {
    const { h, id } = await fundedRenewal("commit");
    let payments = 0;
    h.stripe.createOffSessionPaymentIntent = async () => {
      payments++;
      throw payments === 1 ? new StripeError("card_error", 402, "card_declined") : new StripeError("timeout", null);
    };
    const declinedCommit = barrier(), letOldWorkerReturn = barrier();
    const originalPool = h.app.ctx.cron;
    let intercepted = false, fundingAtCommit: bigint | undefined;
    // Pause AFTER the real COMMIT. Independent connections can then start the next
    // attempt while the first caller has not returned from its database operation.
    h.app.ctx.cron = new Proxy(originalPool, {
      get(target, prop, recv) {
        if (prop === "connect") return async () => {
          const client = await target.connect();
          let resolvesDecline = false;
          return new Proxy(client, {
            get(c, key, receiver) {
              if (key === "query") return async (sql: string, values?: unknown[]) => {
                const result = await c.query(sql, values);
                if (sql.startsWith("update order_operations set state = 'resolved'") && values?.[1] === "declined") resolvesDecline = true;
                if (sql.trim().toLowerCase() === "commit" && resolvesDecline && !intercepted) {
                  intercepted = true;
                  fundingAtCommit = await funding(h, id);
                  declinedCommit.release();
                  await letOldWorkerReturn.reached;
                }
                return result;
              };
              const value = Reflect.get(c, key, receiver);
              return typeof value === "function" ? value.bind(c) : value;
            },
          }) as PoolClient;
        };
        const value = Reflect.get(target, prop, recv);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const first = advanceRenewal(machine(h.app.ctx), id, { manual: true, maxSteps: 1 });
    try {
      await Promise.race([declinedCommit.reached, first.then(() => { throw new Error("decline commit was not intercepted"); })]);
      await advanceRenewal(machine(h.app.ctx), id, { manual: true, maxSteps: 1 });
      expect(await funding(h, id)).toBe(1_700n);
      letOldWorkerReturn.release();
      await first;
      expect(fundingAtCommit).toBe(0n);
      expect(await funding(h, id)).toBe(1_700n);
      expect(payments).toBe(2);
      const ops = (await h.app.db.owner.query("select seq,state,response_code from order_operations where order_id=$1 and kind='renew_charge' order by seq", [id])).rows;
      expect(ops).toMatchObject([{ seq: 1, state: "resolved", response_code: "declined" }, { seq: 2, state: "sent" }]);
      const row = (await h.app.db.owner.query("select state,next_check_at from orders where id=$1", [id])).rows[0];
      expect(row.state).toBe("draft");
      expect(new Date(row.next_check_at).getTime()).toBe(h.app.clock.now().getTime() + 60_000);
      expect(h.registrar.calls.renew ?? 0).toBe(0);
    } finally {
      letOldWorkerReturn.release();
      await first.catch(() => undefined);
      h.app.ctx.cron = originalPool;
    }
  });

  it("ignores a delayed decline from an older replay after a newer charge becomes unknown", async () => {
    const { h, id } = await fundedRenewal("replay");
    const oldRequest = barrier(), oldReply = barrier();
    let calls = 0;
    h.stripe.createOffSessionPaymentIntent = async () => {
      const call = ++calls;
      if (call === 1) { oldRequest.release(); await oldReply.reached; }
      if (call <= 2) throw new StripeError("card_error", 402, "card_declined");
      throw new StripeError("timeout", null);
    };
    const old = advanceRenewal(machine(h.app.ctx), id, { manual: true, maxSteps: 1 });
    try {
      await Promise.race([oldRequest.reached, old.then(() => { throw new Error("old charge did not start"); })]);
      await advanceRenewal(machine(h.app.ctx), id, { manual: true, maxSteps: 1 }); // Same first key, definitive decline.
      expect(await funding(h, id)).toBe(0n);
      await advanceRenewal(machine(h.app.ctx), id, { manual: true, maxSteps: 1 }); // New key, unanswered.
      expect(await funding(h, id)).toBe(1_700n);
      oldReply.release();
      await old;
      expect(await funding(h, id)).toBe(1_700n);
      expect(calls).toBe(3);
      const ops = (await h.app.db.owner.query("select seq,state from order_operations where order_id=$1 and kind='renew_charge' order by seq", [id])).rows;
      expect(ops).toMatchObject([{ seq: 1, state: "resolved" }, { seq: 2, state: "sent" }]);
    } finally {
      oldReply.release();
      await old.catch(() => undefined);
    }
  });

  it("a processing payment response retains the unresolved operation and funding", async () => {
    const { h, id } = await fundedRenewal("processing");
    const original = h.stripe.createOffSessionPaymentIntent.bind(h.stripe);
    h.stripe.createOffSessionPaymentIntent = async (input, key) => ({ ...await original(input, key), status: "processing" });
    await advanceRenewal(machine(h.app.ctx), id, { manual: true, maxSteps: 1 });
    expect(await funding(h, id)).toBe(1_700n);
    const op = (await h.app.db.owner.query("select state,response_code from order_operations where order_id=$1 and kind='renew_charge' order by seq desc limit 1", [id])).rows[0];
    expect(op).toMatchObject({ state: "sent", response_code: null });
    expect(h.registrar.calls.renew ?? 0).toBe(0);
  });
});
