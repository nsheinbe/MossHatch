import { afterEach, describe, expect, it } from "vitest";
import { TRANSFER_REVIEW_MS } from "@mosshatch/registrar/mock-port";
import { harnessPerTest, mailOf, relogin } from "../domains/testkit.ts";
import { orderRow, states } from "../orders/testkit.ts";
import { CODE, cancel, confirm, confirmCodeOf, getTransfer, makeOwner, pass, rescueAndPay, startRescue, transferRow, type TH } from "./testkit.ts";

const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); });
const HOUR = 3_600_000, DAY = 24 * HOUR;
const make = async () => per.make() as Promise<TH>;

describe("Phase 5 exit: no transfer is shown as complete before the adapter confirms, and the payment is captured only after", () => {
  it("authorize, submit, pending, then completed only when the registrar reports it and the name reads back as ours; capture follows", async () => {
    const h = await make();
    let o = await makeOwner(h, "rescue-happy@example.org");
    const f = "moving-fern.com";
    h.registrar.transferIn.seedForeign(f, { authCode: CODE });
    const { id, orderId } = await rescueAndPay(h, o, f);

    // Submitted and pending: nothing looks finished, nothing is captured, no domain row, and the name was never registered.
    let t = await transferRow(h, id);
    expect(t.state).toBe("pending_registry");
    expect(t.auth_code_enc).toBeNull();
    expect(t.auth_code_wiped_at).not.toBeNull();
    expect((await orderRow(h, orderId)).state).toBe("registering");
    let v = await getTransfer(h, o, id);
    expect(v.status).toBe(200);
    expect(v.json).toMatchObject({ state: "pending_registry", completed: false, domain_id: null, code_stored: false });
    expect(h.stripe.created.captures).toBe(0);
    expect((await h.app.db.owner.query("select count(*)::int n from domains where fqdn_ascii = $1", [f])).rows[0].n).toBe(0);
    expect(h.registrar.calls.register).toBe(0);
    expect(h.registrar.calls.startTransferIn).toBe(1);

    // The registry has the request (after the provider's review) but the losing registrar has not answered: still pending.
    await pass(h, TRANSFER_REVIEW_MS);
    t = await transferRow(h, id);
    expect(t.state).toBe("pending_registry");
    expect(t.registry_deadline_at).not.toBeNull();
    expect(mailOf(h, "transfer_submitted")).toHaveLength(1);
    o = await relogin(h, o);
    expect((await getTransfer(h, o, id)).json.completed).toBe(false);
    expect(h.stripe.created.captures).toBe(0);

    // The losing registrar acknowledges: the adapter says completed, the name reads back as ours, and only now the payment is captured.
    h.registrar.transferIn.losingAck(f);
    await pass(h);
    t = await transferRow(h, id);
    expect(t.state).toBe("completed");
    const ord = await orderRow(h, orderId);
    expect(ord.state).toBe("captured");
    expect(h.stripe.created.captures).toBe(1);
    const evs = await states(h, orderId);
    const iReg = evs.indexOf("registering>registered"), iCap = evs.indexOf("capturing>captured");
    expect(iReg).toBeGreaterThan(-1);
    expect(iCap).toBeGreaterThan(iReg);
    const dom = (await h.app.db.owner.query("select * from domains where fqdn_ascii = $1 and released_at is null", [f])).rows[0];
    expect(dom).toMatchObject({ user_id: o.userId, locked: true, state: "active" });
    // C-06: 60 days after a transfer the name cannot move again.
    const sec = (await h.app.db.owner.query("select transfer_lock_until, transfer_lock_reason from domain_security where domain_id = $1", [dom.id])).rows[0];
    expect(sec.transfer_lock_reason).toBe("transfer_in");
    expect(new Date(sec.transfer_lock_until).getTime()).toBeGreaterThan(h.app.clock.now().getTime() + 59 * DAY);
    v = await getTransfer(h, o, id);
    expect(v.json).toMatchObject({ state: "completed", completed: true, domain_id: dom.id, payment: { order_state: "captured", charged_before_completion: false } });
    expect(mailOf(h, "transfer_completed")).toHaveLength(1);
    expect(mailOf(h, "receipt")).toHaveLength(1);
    expect(h.registrar.calls.register).toBe(0);
    expect(h.registrar.calls.startTransferIn).toBe(1);
    // C-09: the transfer log holds who, when and how, as codes.
    const log = (await h.app.db.owner.query("select event, actor_kind from transfer_log where transfer_in_id = $1 order by at, id", [id])).rows.map((r) => r.event);
    expect(log).toEqual(expect.arrayContaining(["created", "confirmed", "submitted", "completed"]));
  });

  it("the card hold ends first: the payment is taken while the transfer is still pending, it is still not shown complete, and a NACK refunds it in full", async () => {
    const h = await make();
    let o = await makeOwner(h, "rescue-early@example.org");
    const f = "slow-registrar.com";
    h.registrar.transferIn.seedForeign(f, { authCode: CODE });
    const { id, orderId } = await rescueAndPay(h, o, f);
    await pass(h, TRANSFER_REVIEW_MS);
    // Move to within 48 hours of the hold's end (the hold is seven days).
    for (let i = 0; i < 4; i++) await pass(h, DAY);
    await pass(h, 2 * HOUR);
    expect((await orderRow(h, orderId)).state).toBe("captured");
    expect(h.stripe.created.captures).toBe(1);
    const t = await transferRow(h, id);
    expect(t.state).toBe("pending_registry");
    expect(t.early_capture_at).not.toBeNull();
    o = await relogin(h, o);
    const v = await getTransfer(h, o, id);
    expect(v.json).toMatchObject({ state: "pending_registry", completed: false, domain_id: null, payment: { charged_before_completion: true } });
    expect(v.json.payment.note).toMatch(/refund it in full/);
    expect((await h.app.db.owner.query("select count(*)::int n from domains where fqdn_ascii = $1", [f])).rows[0].n).toBe(0);

    h.registrar.transferIn.losingNack(f, "fraud");
    await pass(h);
    expect((await transferRow(h, id))).toMatchObject({ state: "nacked", failure: "nack", nack_reason: "fraud" });
    const ord = await orderRow(h, orderId);
    expect(ord.state).toBe("refunded");
    expect(h.stripe.created.refunds).toBe(1);
    const fail = mailOf(h, "transfer_failed");
    expect(fail).toHaveLength(1);
    expect(fail[0]!.text).toMatch(/refused the transfer\. It reported evidence of fraud\./);
    expect(fail[0]!.text).toMatch(/refunding your payment in full/);
    expect((await getTransfer(h, o, id)).json.failure).toMatchObject({ code: "nack", nack_reason: "fraud" });
  });

  it("the payment taken early is kept when the registry's silence completes the transfer", async () => {
    const h = await make();
    const o = await makeOwner(h, "rescue-autoack@example.org");
    const f = "silence-acks.com";
    h.registrar.transferIn.seedForeign(f, { authCode: CODE });
    const { id, orderId } = await rescueAndPay(h, o, f);
    await pass(h, TRANSFER_REVIEW_MS);
    for (let i = 0; i < 5; i++) await pass(h, DAY);
    await pass(h, 2 * HOUR);
    expect((await transferRow(h, id)).state).toBe("completed");
    expect((await orderRow(h, orderId)).state).toBe("captured");
    expect(h.stripe.created.captures).toBe(1);
    expect(h.stripe.created.refunds).toBe(0);
    expect((await h.app.db.owner.query("select count(*)::int n from domains where fqdn_ascii = $1 and released_at is null", [f])).rows[0].n).toBe(1);
  });

  it("a failure before completion releases the hold: a wrong code fails at the registry, nothing is charged, and the name stays where it was", async () => {
    const h = await make();
    const o = await makeOwner(h, "rescue-badcode@example.org");
    const f = "wrong-code.dev";
    h.registrar.transferIn.seedForeign(f, { authCode: "TheRealCode123" });
    const { id, orderId } = await rescueAndPay(h, o, f);
    expect((await transferRow(h, id)).state).toBe("pending_registry");
    await pass(h, TRANSFER_REVIEW_MS);
    expect(await transferRow(h, id)).toMatchObject({ state: "failed", failure: "invalid_auth_code" });
    expect((await orderRow(h, orderId)).state).toBe("voided");
    expect(h.stripe.created.captures).toBe(0);
    expect([...h.stripe.paymentIntents.values()].filter((p) => p.metadata.order_id === orderId).every((p) => p.status === "canceled")).toBe(true);
    const m = mailOf(h, "transfer_failed");
    expect(m).toHaveLength(1);
    expect(m[0]!.text).toMatch(/did not accept the transfer code/);
    expect(m[0]!.text).toMatch(/Nothing was charged/);
    expect(mailOf(h, "order.voided")).toHaveLength(0);          // one plain message, not two
    expect((await h.app.db.owner.query("select count(*)::int n from domains where fqdn_ascii = $1", [f])).rows[0].n).toBe(0);
  });

  it("C-08: when the provider emails the owner, the stage mail says so with the deadline, and a decline there voids the hold", async () => {
    const h = await make();
    const o = await makeOwner(h, "rescue-owner@example.org");
    const f = "owner-says-no.studio";
    h.registrar.transferOwnerStep = "always_email";
    h.registrar.transferIn.seedForeign(f, { authCode: CODE, owner: "silent" });
    const { id, orderId } = await rescueAndPay(h, o, f);
    const t = await transferRow(h, id);
    expect(t.state).toBe("pending_owner_approval");
    expect(t.owner_deadline_at).not.toBeNull();
    const stage = mailOf(h, "transfer_submitted");
    expect(stage).toHaveLength(1);
    expect(stage[0]!.text).toMatch(/emailed the owner of owner-says-no\.studio to confirm the transfer/);
    expect(h.registrar.ownerApprovalEmails).toHaveLength(1);
    h.registrar.transferIn.ownerDecline(f);
    await pass(h);
    expect(await transferRow(h, id)).toMatchObject({ state: "failed", failure: "owner_declined" });
    expect((await orderRow(h, orderId)).state).toBe("voided");
    expect(h.stripe.created.captures).toBe(0);
  });
});

describe("Transfer-in writes are at most once and reconciled, never resent", () => {
  it("a timeout after the registrar accepted: outcome unknown, then found by polling; one order upstream, one request sent", async () => {
    const h = await make();
    const o = await makeOwner(h, "rescue-timeout@example.org");
    const f = "lost-answer.com";
    h.registrar.transferIn.seedForeign(f, { authCode: CODE });
    h.registrar.faults.set("timeoutAfterAccept", { times: 1, fqdn: f });
    const { id, orderId } = await rescueAndPay(h, o, f);
    expect((await orderRow(h, orderId)).state).toBe("outcome_unknown");
    expect((await transferRow(h, id)).state).toBe("submitted");
    expect((await transferRow(h, id)).auth_code_enc).toBeNull();
    await pass(h, 2 * 60_000);
    expect((await orderRow(h, orderId)).state).toBe("registering");
    expect((await transferRow(h, id)).state).toBe("pending_registry");
    expect(h.registrar.calls.startTransferIn).toBe(1);
    expect(h.registrar.orders.filter((u) => u.fqdn === f && u.type === "transfer")).toHaveLength(1);
    await pass(h, TRANSFER_REVIEW_MS);
    h.registrar.transferIn.losingAck(f);
    await pass(h);
    expect((await transferRow(h, id)).state).toBe("completed");
    expect((await orderRow(h, orderId)).state).toBe("captured");
  });

  it("a refusal with no effect upstream (insufficient funds) keeps the code for the retry, pages, and the retry sends once", async () => {
    const h = await make();
    const o = await makeOwner(h, "rescue-funds@example.org");
    const f = "funds-low.com";
    h.registrar.transferIn.seedForeign(f, { authCode: CODE });
    h.registrar.faults.set("insufficientFunds", { times: 1, fqdn: f });
    const { id, orderId } = await rescueAndPay(h, o, f);
    expect((await orderRow(h, orderId)).state).toBe("registrar_unavailable");
    const t = await transferRow(h, id);
    expect(t.state).toBe("submitting");
    expect(t.auth_code_enc).not.toBeNull();                          // an envelope, never the code
    expect(JSON.stringify(t.auth_code_enc)).not.toContain(CODE);
    expect((await h.app.db.owner.query("select 1 from alerts where kind = 'registrar_funds'")).rowCount).toBe(1);
    await pass(h, 10 * 60_000);
    expect((await transferRow(h, id)).state).toBe("pending_registry");
    expect((await transferRow(h, id)).auth_code_enc).toBeNull();
    expect(h.registrar.calls.startTransferIn).toBe(2);
    expect(h.registrar.orders.filter((u) => u.fqdn === f && u.type === "transfer")).toHaveLength(1);
  });
});

describe("Cancel", () => {
  it("before confirmation, while pending upstream (CANCEL_TRANSFER first, then the hold), and never after completion", async () => {
    const h = await make();
    const o = await makeOwner(h, "rescue-cancel@example.org");
    h.registrar.transferIn.seedForeign("early-stop.com", { authCode: CODE });
    h.registrar.transferIn.seedForeign("late-stop.com", { authCode: CODE });
    const s = await startRescue(h, o, "early-stop.com");
    const c1 = await cancel(h, o, s.json.transfer_id);
    expect(c1.status, c1.text).toBe(200);
    expect(c1.json).toMatchObject({ state: "cancelled", can_cancel: false, code_stored: false });
    expect((await orderRow(h, s.json.order_id)).state).toBe("voided");
    expect(h.stripe.created.sessions).toBe(0);

    const { id, orderId } = await rescueAndPay(h, o, "late-stop.com");
    const c2 = await cancel(h, o, id);
    expect(c2.status, c2.text).toBe(200);
    expect(h.registrar.calls.cancelTransferIn).toBe(1);
    expect(await h.registrar.getTransferInStatus("late-stop.com")).toMatchObject({ status: "cancelled", failure: "cancelled_by_us" });
    expect(await transferRow(h, id)).toMatchObject({ state: "cancelled", failure: "cancelled_by_us" });
    expect((await orderRow(h, orderId)).state).toBe("voided");
    expect(h.stripe.created.captures).toBe(0);
    expect(mailOf(h, "transfer_failed").at(-1)!.text).toMatch(/You cancelled the transfer/);
    expect((await cancel(h, o, id)).status).toBe(409);
  });
});

describe("Start: idempotency and one live transfer per name", () => {
  it("the same key replays, other parameters with the same key are refused, and a second customer cannot race the same name", async () => {
    const h = await make();
    const a = await makeOwner(h, "rescue-a@example.org");
    const b = await makeOwner(h, "rescue-b@example.org");
    const f = "contested-name.com";
    h.registrar.transferIn.seedForeign(f, { authCode: CODE });
    const first = await startRescue(h, a, f, { key: "k1" });
    expect(first.status).toBe(201);
    const again = await startRescue(h, a, f, { key: "k1" });
    expect(again.status).toBe(200);
    expect(again.json.transfer_id).toBe(first.json.transfer_id);
    expect(mailOf(h, "transfer_confirm_code")).toHaveLength(1);
    expect((await startRescue(h, a, "other-name.com", { key: "k1" })).status).toBe(409);
    const bs = await startRescue(h, b, f, { key: "k2" });
    expect(bs.status).toBe(201);
    const bCode = confirmCodeOf(h, f);
    expect((await confirm(h, a, first.json.transfer_id, [...h.app.email.sent].find((m) => m.kind === "transfer_confirm_code")!.text.match(/: ([A-Z0-9]{8})\n/)![1]!)).status).toBe(200);
    const lost = await confirm(h, b, bs.json.transfer_id, bCode);
    expect(lost.status).toBe(409);
    expect(lost.json.error).toMatchObject({ code: "not_transferable", reason: "pending_transfer" });
    // Once A has paid and the request is out, a new start by anyone is refused at the pre-check.
    expect((await startRescue(h, b, f, { key: "k3" })).json.error).toMatchObject({ code: "not_transferable", reason: "pending_transfer" });
  });
});
