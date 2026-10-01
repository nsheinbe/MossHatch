import { afterEach, describe, expect, it } from "vitest";
import { RegistrarError } from "@mosshatch/registrar/port";
import { TRANSFER_REVIEW_MS } from "@mosshatch/registrar/mock-port";
import { harnessPerTest } from "../domains/testkit.ts";
import { advance, machine } from "../orders/machine.ts";
import { loadOrder } from "../orders/support.ts";
import { deliverAll, orderRow, states } from "../orders/testkit.ts";
import { pollTransfer } from "./driver.ts";
import { transferOfOrder } from "./store.ts";
import { CODE, confirm, confirmCodeOf, makeOwner, pass, startRescue, transferRow, type TH } from "./testkit.ts";

/**
 * Two workers on one transfer-in order, interleaved by hand (no job engine, no timing): worker A sends the request and its answer is
 * lost; worker B polls the registrar on a view of the order it read while A's request was out. Every transfer and order state write is
 * conditional on the state its worker read, so whichever commits second loses and writes nothing: the order is never `outcome_unknown`
 * while the transfer row says the registry has it.
 */

const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); });

/** Start, confirm and pay (authorization only). No job runs: the paid order waits for a worker. */
async function paid(h: TH, email: string, fqdn: string) {
  const o = await makeOwner(h, email);
  h.registrar.transferIn.seedForeign(fqdn, { authCode: CODE });
  const s = await startRescue(h, o, fqdn);
  expect(s.status, s.text).toBe(201);
  expect((await confirm(h, o, s.json.transfer_id, confirmCodeOf(h, fqdn))).status).toBe(200);
  h.stripe.takeEvents();
  h.stripe.payCheckout((await orderRow(h, s.json.order_id)).stripe_checkout_session_id);
  await deliverAll(h);
  expect(["checkout_open", "authorized"]).toContain((await orderRow(h, s.json.order_id)).state);
  return { id: s.json.transfer_id as string, orderId: s.json.order_id as string };
}

/** Worker A's registrar call: the request lands upstream, A waits at the gate, then its answer is lost (outcome unknown). */
function gateSend(h: TH) {
  const orig = h.registrar.startTransferIn.bind(h.registrar);
  let reached!: () => void, release!: () => void;
  const atGate = new Promise<void>((r) => { reached = r; });
  const gate = new Promise<void>((r) => { release = r; });
  h.registrar.startTransferIn = async (req) => {
    await orig(req);
    reached();
    await gate;
    throw new RegistrarError("unknown", "request timed out after submit", { retryable: false, outcomeUnknown: true, code: "timeout" });
  };
  return { atGate, release, restore: () => { h.registrar.startTransferIn = orig; } };
}

/** Worker B's view: the order, the transfer and the operation, read while A's request is out (the order says `registering`). */
async function viewOf(h: TH, orderId: string) {
  const o = (await loadOrder(h.app.ctx.cron, orderId))!;
  const t = (await transferOfOrder(h.app.ctx.cron, orderId))!;
  const r = (await h.app.db.owner.query("select * from order_operations where order_id = $1 and kind = 'transfer' order by seq desc limit 1", [orderId])).rows[0];
  const op = { id: r.id, seq: r.seq, state: r.state, sentAt: r.sent_at ? new Date(r.sent_at) : null, responseCode: r.response_code, registrarOrderId: r.registrar_order_id } as Parameters<typeof pollTransfer>[3];
  expect(o.state).toBe("registering");
  expect(t.state).toBe("submitted");
  return { o, t, op };
}

const PENDING = ["pending_owner_approval", "pending_registry"];
async function assertConsistent(h: TH, id: string, orderId: string) {
  const o = (await orderRow(h, orderId)).state as string, t = (await transferRow(h, id)).state as string;
  expect(o === "outcome_unknown" && PENDING.includes(t), `order ${o} with transfer ${t}`).toBe(false);
  return { o, t };
}

describe("transfer-in: two workers on one order, interleaved deterministically", () => {
  it("B's poll commits first (the registry has it): A's lost answer loses the race and never marks the order outcome_unknown", async () => {
    const h = await per.make() as TH;
    const f = "race-poll-first.com";
    const { id, orderId } = await paid(h, "race-a@example.org", f);
    const g = gateSend(h);
    try {
      const a = advance(machine(h.app.ctx), orderId);                  // worker A: authorized -> registering -> send
      await g.atGate;
      const b = await viewOf(h, orderId);
      // Worker B polls now and finds the request at the registry; the order is still registering, so B's write stands.
      await pollTransfer(machine(h.app.ctx), b.o, b.t, b.op, { force: true });
      expect((await transferRow(h, id)).state).toBe("pending_registry");
      g.release();
      await a;                                                          // worker A: its answer is lost, it acts on its own (now stale) view
    } finally { g.restore(); }
    expect(await assertConsistent(h, id, orderId)).toEqual({ o: "registering", t: "pending_registry" });
    expect(await states(h, orderId)).not.toContain("registering>outcome_unknown");
    expect(h.registrar.calls.startTransferIn).toBe(1);
    // The transfer carries on normally: the losing registrar acknowledges, the name reads back as ours, then the payment is captured.
    await pass(h, TRANSFER_REVIEW_MS);
    h.registrar.transferIn.losingAck(f);
    await pass(h);
    expect((await transferRow(h, id)).state).toBe("completed");
    expect((await orderRow(h, orderId)).state).toBe("captured");
    expect(h.registrar.calls.startTransferIn).toBe(1);
  });

  it("A's outcome_unknown commits first: B, polling on the view it read before, loses and writes nothing; the poll then reconciles", async () => {
    const h = await per.make() as TH;
    const f = "race-unknown-first.com";
    const { id, orderId } = await paid(h, "race-b@example.org", f);
    const g = gateSend(h);
    let b;
    try {
      const a = advance(machine(h.app.ctx), orderId);
      await g.atGate;
      b = await viewOf(h, orderId);                                    // B reads while A's request is out
      g.release();
      await a;                                                          // A: the answer is lost, the order is outcome_unknown
    } finally { g.restore(); }
    expect((await orderRow(h, orderId)).state).toBe("outcome_unknown");
    const logBefore = (await h.app.db.owner.query("select count(*)::int n from transfer_log where transfer_in_id = $1", [id])).rows[0].n;
    // Worker B acts on its stale view (the order was registering when it read it). It must lose: the order moved.
    const step = await pollTransfer(machine(h.app.ctx), b.o, b.t, b.op, { force: true });
    expect(step).toBe("wait");
    expect(await assertConsistent(h, id, orderId)).toEqual({ o: "outcome_unknown", t: "submitted" });
    expect((await h.app.db.owner.query("select count(*)::int n from transfer_log where transfer_in_id = $1", [id])).rows[0].n).toBe(logBefore);
    // The poll of the unknown outcome finds the request and puts both rows right, without a second send.
    await pass(h, 2 * 60_000);
    expect(await assertConsistent(h, id, orderId)).toEqual({ o: "registering", t: "pending_registry" });
    expect(h.registrar.calls.startTransferIn).toBe(1);
    expect(h.registrar.orders.filter((u) => u.fqdn === f && u.type === "transfer")).toHaveLength(1);
    await pass(h, TRANSFER_REVIEW_MS);
    h.registrar.transferIn.losingAck(f);
    await pass(h);
    expect((await transferRow(h, id)).state).toBe("completed");
    expect((await orderRow(h, orderId)).state).toBe("captured");
  });
});
