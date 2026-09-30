import { describe, expect, it, vi } from "vitest";
import { RegistrarError, type TransferInRequest } from "./port.ts";
import { ManualClock, MockRegistrarPort, TRANSFER_REGISTRY_WINDOW_MS, TRANSFER_REVIEW_MS } from "./mock-port.ts";
import { OpenSrsAdapter, type HttpRequest, type HttpTransport } from "./opensrs/adapter.ts";
import { FakeHorizonTransport, opsReply } from "./opensrs/fake-horizon.ts";
import { MemoryCredentials, MemoryKillSwitch } from "./opensrs/guards.ts";
import { decodeOps, obj, str } from "./opensrs/xml.ts";

/**
 * Transfer-in (Phase 5) at the port. Horizon cannot run a transfer ("You cannot transfer domains in Horizon", KB 201000063316), so:
 *  - the lifecycle is proven against MockRegistrarPort (profile mock:opensrs), which models the documented OpenSRS flow;
 *  - the OpenSRS adapter is proven only for the request it builds and for how it reads documented-shape replies (source: "documented").
 * Nothing here has met a real OpenSRS response.
 */
const DAY = 86_400_000;
const CODE = "Xfer-Code-9Q7w";
const REGISTRANT = { name: "Ada Moss", email: "ada@example.org", phone: "+1.5555550100", street: "1 Fern Lane", city: "Portland", region: "OR", postalCode: "97201", country: "US" };
const req = (fqdn: string, o: Partial<TransferInRequest> = {}): TransferInRequest => ({ fqdn, years: fqdn.endsWith(".ai") ? 2 : 1, authCode: CODE, regUsername: "mhxfer" + fqdn.length, regPassword: "p".repeat(14), registrant: REGISTRANT, ...o });
const setup = () => { const clock = new ManualClock(); const mock = new MockRegistrarPort({ clock }); return { mock, clock }; };

describe("MockRegistrarPort transfer-in lifecycle (mock:opensrs; C-02 to C-06, C-08)", () => {
  it("with a valid code the owner email is skipped: review, then five days of registry silence acknowledge it, and only then is the name ours", async () => {
    const { mock } = setup(); const f = "moved-here.com";
    mock.transferIn.seedForeign(f, { authCode: CODE });
    const before = mock.fundingBalance;
    expect(await mock.checkTransferIn(f)).toMatchObject({ transferable: true, dsPresent: false });
    const s = await mock.startTransferIn(req(f));
    expect(s).toMatchObject({ status: "pending_registry", ownerEmailSent: false });
    expect(mock.debits.at(-1)!.orderId).toBe(s.registrarOrderId);                // funds for the added year are taken at submit
    expect(mock.fundingBalance).toBe(before - mock.debits.at(-1)!.minor);
    expect(await mock.getDomain(f)).toBeNull();
    mock.advance(TRANSFER_REVIEW_MS);
    const pending = await mock.getTransferInStatus(f);
    expect(pending).toMatchObject({ status: "pending_registry", registrarOrderId: s.registrarOrderId });
    expect(pending!.registryDeadlineAt).toBeInstanceOf(Date);
    mock.advance(TRANSFER_REGISTRY_WINDOW_MS - 60_000);
    expect((await mock.getTransferInStatus(f))!.status).toBe("pending_registry");
    expect(await mock.getDomain(f)).toBeNull();
    mock.advance(60_000);
    const done = await mock.getTransferInStatus(f);
    expect(done).toMatchObject({ status: "completed" });
    const dom = await mock.getDomain(f);
    expect(dom).toMatchObject({ locked: true, autoRenew: false, profileUsername: req(f).regUsername });
    expect(mock.domainRecord(f)!.lastTransferAt).toBeInstanceOf(Date);
    expect(await mock.checkTransferIn(f)).toMatchObject({ transferable: false, reason: "already_here" });
  });

  it("C-08: when the provider emails the owner, five days of silence cancel it and the funds come back", async () => {
    const { mock } = setup(); const f = "silent-owner.dev";
    mock.transferOwnerStep = "always_email";
    mock.transferIn.seedForeign(f, { authCode: CODE, owner: "silent" });
    const before = mock.fundingBalance;
    const s = await mock.startTransferIn(req(f));
    expect(s).toMatchObject({ status: "pending_owner", ownerEmailSent: true });
    expect(mock.ownerApprovalEmails.map((e) => e.fqdn)).toEqual([f]);
    expect((await mock.getTransferInStatus(f))!.ownerDeadlineAt).toBeInstanceOf(Date);
    mock.advance(5 * DAY);
    expect(await mock.getTransferInStatus(f)).toMatchObject({ status: "cancelled", failure: "owner_timeout" });
    expect(mock.fundingBalance).toBe(before);
    expect(mock.credits.map((c) => c.orderId)).toEqual([s.registrarOrderId]);
  });

  it("the owner confirms or declines in the email; a decline ends it", async () => {
    const { mock } = setup();
    mock.transferOwnerStep = "always_email";
    mock.transferIn.seedForeign("yes-owner.com", { authCode: CODE, owner: "silent" });
    mock.transferIn.seedForeign("no-owner.com", { authCode: CODE, owner: "silent" });
    await mock.startTransferIn(req("yes-owner.com")); await mock.startTransferIn(req("no-owner.com"));
    mock.transferIn.ownerConfirm("yes-owner.com"); mock.transferIn.ownerDecline("no-owner.com");
    expect((await mock.getTransferInStatus("yes-owner.com"))!.status).toBe("pending_registry");
    expect(await mock.getTransferInStatus("no-owner.com")).toMatchObject({ status: "cancelled", failure: "owner_declined" });
    mock.advance(TRANSFER_REVIEW_MS); mock.transferIn.losingAck("yes-owner.com");
    expect((await mock.getTransferInStatus("yes-owner.com"))!.status).toBe("completed");
  });

  it("C-05: a NACK carries its Transfer Policy reason; a wrong code fails when the registry sees it", async () => {
    const { mock } = setup();
    mock.transferIn.seedForeign("nacked.com", { authCode: CODE, losing: { nack: "fraud" } });
    mock.transferIn.seedForeign("bad-code.com", { authCode: CODE });
    await mock.startTransferIn(req("nacked.com"));
    const bad = await mock.startTransferIn(req("bad-code.com", { authCode: "wrong-code-1" }));
    expect(bad.status).toBe("pending_registry");              // accepted by the provider; the registry has not seen it yet
    mock.advance(TRANSFER_REVIEW_MS);
    expect(await mock.getTransferInStatus("nacked.com")).toMatchObject({ status: "cancelled", failure: "nack", nackReason: "fraud" });
    expect(await mock.getTransferInStatus("bad-code.com")).toMatchObject({ status: "cancelled", failure: "invalid_auth_code" });
    expect(await mock.getDomain("bad-code.com")).toBeNull();
  });

  it("C-03, C-05, C-06: the pre-check reports the lock, the registry lock, the 60-day rules with their dates, RGP, a dispute and DNSSEC; the submit refuses the same", async () => {
    const { mock, clock } = setup(); const now = clock.now();
    mock.transferIn.seedForeign("locked.com", { authCode: CODE, locked: true });
    mock.transferIn.seedForeign("reglock.com", { authCode: CODE, registryLock: true });
    mock.transferIn.seedForeign("young.com", { authCode: CODE, createdAt: new Date(now.getTime() - 10 * DAY) });
    mock.transferIn.seedForeign("hopped.com", { authCode: CODE, createdAt: new Date(now.getTime() - 900 * DAY), lastTransferAt: new Date(now.getTime() - 20 * DAY) });
    mock.transferIn.seedForeign("rgp.com", { authCode: CODE, status: "redemption" });
    mock.transferIn.seedForeign("udrp.com", { authCode: CODE, status: "udrp" });
    mock.transferIn.seedForeign("signed.com", { authCode: CODE, dsPresent: true });
    expect(await mock.checkTransferIn("locked.com")).toMatchObject({ transferable: false, reason: "locked_at_losing", registryStatuses: ["clientTransferProhibited"] });
    expect(await mock.checkTransferIn("reglock.com")).toMatchObject({ transferable: false, reason: "registry_lock" });
    const young = await mock.checkTransferIn("young.com");
    expect(young).toMatchObject({ transferable: false, reason: "too_new" });
    expect(young.transferableAt!.getTime()).toBe(now.getTime() + 50 * DAY);
    expect(await mock.checkTransferIn("hopped.com")).toMatchObject({ transferable: false, reason: "recently_transferred" });
    expect(await mock.checkTransferIn("rgp.com")).toMatchObject({ reason: "redemption" });
    expect(await mock.checkTransferIn("udrp.com")).toMatchObject({ reason: "dispute" });
    expect(await mock.checkTransferIn("signed.com")).toMatchObject({ transferable: true, dsPresent: true });
    expect(await mock.checkTransferIn("free-nobody.com")).toMatchObject({ transferable: false, reason: "not_registered" });
    await expect(mock.startTransferIn(req("young.com"))).rejects.toMatchObject({ kind: "rejected", code: "552" });
    await expect(mock.startTransferIn(req("reglock.com"))).rejects.toMatchObject({ kind: "rejected", code: "not_transferable_registry_lock" });
    // The owner re-locks after the order was placed: the registry refuses when the request arrives.
    mock.transferIn.seedForeign("relock.com", { authCode: CODE });
    await mock.startTransferIn(req("relock.com"));
    mock.transferIn.updateForeign("relock.com", { registryLock: true });
    mock.advance(TRANSFER_REVIEW_MS);
    expect(await mock.getTransferInStatus("relock.com")).toMatchObject({ status: "cancelled", failure: "registry_lock" });
  });

  it("explicit period per TLD (.ai adds two years), cancel while pending, and no second transfer of the same name while one is pending", async () => {
    const { mock } = setup();
    mock.transferIn.seedForeign("model.ai", { authCode: CODE });
    await expect(mock.startTransferIn(req("model.ai", { years: 1 }))).rejects.toMatchObject({ code: "invalid_period" });
    await mock.startTransferIn(req("model.ai"));
    await expect(mock.startTransferIn(req("model.ai"))).rejects.toMatchObject({ code: "order_exists" });
    expect(await mock.cancelTransferIn("model.ai")).toEqual({ cancelled: true });
    expect(await mock.getTransferInStatus("model.ai")).toMatchObject({ status: "cancelled", failure: "cancelled_by_us" });
    expect(await mock.cancelTransferIn("model.ai")).toEqual({ cancelled: false });
  });

  it("a timeout after the provider accepted leaves a pending transfer to reconcile by polling, never a second order", async () => {
    const { mock } = setup(); const f = "timeout.com";
    mock.transferIn.seedForeign(f, { authCode: CODE });
    mock.faults.set("timeoutAfterAccept", { times: 1 });
    await expect(mock.startTransferIn(req(f))).rejects.toMatchObject({ outcomeUnknown: true });
    expect((await mock.getTransferInStatus(f))!.status).toBe("pending_registry");
    expect(mock.orders.filter((o) => o.fqdn === f && o.type === "transfer")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// OpenSRS adapter: request shape and reply reading only (documented-shape replies; no real response has been seen)
// ---------------------------------------------------------------------------------------------------------------------------------

const KEY = "k".repeat(32);
function scripted(replies: (string | Error)[]): HttpTransport & { requests: { action: string; attrs: Record<string, unknown> }[] } {
  const t = {
    requests: [] as { action: string; attrs: Record<string, unknown> }[],
    async post(r: HttpRequest) {
      const m = decodeOps(r.body); t.requests.push({ action: str(m.action) ?? "", attrs: obj(m.attributes) ?? {} });
      const next = replies.shift() ?? opsReply(200, {});
      if (next instanceof Error) throw next;
      return { status: 200, body: next };
    },
  };
  return t;
}
const adapterOver = (t: HttpTransport, logs: unknown[] = [], alerts: unknown[] = []) => new OpenSrsAdapter({ mode: "sandbox", deployment: "staging", credentials: new MemoryCredentials({ username: "u", apiKey: KEY }), transport: t, killSwitch: new MemoryKillSwitch(), log: (e) => logs.push(e), onAlert: (a) => alerts.push(a) });

describe("OpenSRS adapter transfer-in (adapter code only; source: documented)", () => {
  it("sends SW_REGISTER reg_type=transfer with auth_info and an explicit period, keeps the nameservers, then reads the status back", async () => {
    const price = opsReply(200, { price: "14.50", is_registry_premium: "0" });
    const t = scripted([price, price, opsReply(200, { id: "3001" }), opsReply(200, { status: "pending_registry", order_id: "3001" })]);
    const a = adapterOver(t);
    const res = await a.startTransferIn(req("move-me.com"));
    expect(res).toEqual({ status: "pending_registry", registrarOrderId: "3001", ownerEmailSent: false });
    expect(t.requests.map((r) => [r.action, r.attrs.reg_type ?? r.attrs.check_status ?? null])).toEqual([["GET_PRICE", "transfer"], ["GET_PRICE", "renewal"], ["SW_REGISTER", "transfer"], ["CHECK_TRANSFER", "1"]]);
    const sw = t.requests[2]!.attrs;
    expect(sw).toMatchObject({ period: "1", handle: "process", auto_renew: "0", f_lock_domain: "1", custom_nameservers: "0", auth_info: CODE, f_whois_privacy: "0" });
    expect(sw.nameserver_list).toBeUndefined();
  });

  it("reads CHECK_TRANSFER: pending_admin is pending_owner, undef is nothing, a cancelled reason maps to a code, a 60-day refusal to too_new", async () => {
    const a = adapterOver(scripted([
      opsReply(200, { status: "pending_admin" }), opsReply(200, { status: "undef" }), opsReply(200, { status: "cancelled", reason: "Invalid auth code" }),
      opsReply(200, { status: "cancelled", reason: "Transfer declined by losing registrar" }), opsReply(200, { transferrable: "0", reason: "Domain is less than 60 days old" }),
    ]));
    expect((await a.getTransferInStatus("x-y.com"))!.status).toBe("pending_owner");
    expect(await a.getTransferInStatus("x-y.com")).toBeNull();
    expect(await a.getTransferInStatus("x-y.com")).toMatchObject({ status: "cancelled", failure: "invalid_auth_code" });
    expect(await a.getTransferInStatus("x-y.com")).toMatchObject({ status: "cancelled", failure: "nack", nackReason: "unstated" });
    expect(await a.checkTransferIn("x-y.com")).toMatchObject({ transferable: false, reason: "too_new" });
  });

  it("ST-22 (transfer-in): the code reaches only the SW_REGISTER request; a lost connection after sending is outcome-unknown and carries no code", async () => {
    const logs: unknown[] = [], alerts: unknown[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const t = scripted([opsReply(200, { price: "14.50" }), opsReply(200, { price: "14.50" }), new Error("connection reset")]);
    const a = adapterOver(t, logs, alerts);
    let err: unknown;
    try { await a.startTransferIn(req("lost.com")); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RegistrarError);
    expect(err).toMatchObject({ kind: "unknown", outcomeUnknown: true });
    const dump = JSON.stringify({ logs, alerts, err, opts: (err as RegistrarError).opts, message: (err as Error).message, stack: (err as Error).stack, calls: spies.map((s) => s.mock.calls) });
    expect(dump).not.toContain(CODE);
    expect(t.requests.filter((r) => JSON.stringify(r.attrs).includes(CODE)).map((r) => r.action)).toEqual(["SW_REGISTER"]);
    expect(JSON.stringify(a, (k, v) => (k === "transport" ? undefined : v)), "adapter state (the injected transport is the wire)").not.toContain(CODE);
    spies.forEach((s) => s.mockRestore());
  });

  it("the fake Horizon refuses transfer commands: transfers cannot be simulated there, so nothing claims they were", async () => {
    const mock = new MockRegistrarPort(); mock.transferIn.seedForeign("horizon-x.com", { authCode: CODE });
    const a = new OpenSrsAdapter({ mode: "sandbox", deployment: "staging", credentials: new MemoryCredentials({ username: "r", apiKey: KEY }), transport: new FakeHorizonTransport(mock, { username: "r", apiKey: KEY }), killSwitch: new MemoryKillSwitch(), clock: mock.clock });
    await expect(a.checkTransferIn("horizon-x.com")).rejects.toMatchObject({ kind: "rejected" });
    await expect(a.startTransferIn(req("horizon-x.com"))).rejects.toMatchObject({ kind: "rejected" });
    expect(mock.transferIn.list()).toHaveLength(0);
  });
});
