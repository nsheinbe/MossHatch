import { describe, expect, it } from "vitest";
import { RegistrarError, type DnsRecord, type DsRecord, type RegisterRequest, type RegistrarPort } from "./port.ts";
import { zoneHash } from "./dns.ts";
import { claimRegistration, registrantFingerprint } from "./claim.ts";
import { DeathSignal, MockRegistrarPort } from "./mock-port.ts";

/**
 * Reusable adapter behaviour suite (plan 4.3b, "MockRegistrar rules" 4 to 6). Each test carries a tag:
 *  - `both`: must hold for the mock and for the OpenSRS Horizon sandbox adapter;
 *  - `mock-only`: needs fault injection or seeded state the sandbox cannot give;
 *  - `replay`: needs fault injection or out-of-band changes, which the mock and the Horizon adapter over its documented-fixture fake (FakeHorizonTransport,
 *    backed by a MockRegistrarPort) both give; a real Horizon cannot. Uses `subject.mock` only to inject, never to call the port;
 *  - `sandbox-only`: needs the real provider (recorded responses, real funding).
 * `docs/registrar-parity.md` lists what the mock cannot model. Run it with `tags: ["both","mock-only"]` for the mock.
 */
export type ContractTag = "both" | "replay" | "mock-only" | "sandbox-only";

export interface ContractSubject {
  adapter: RegistrarPort;
  /** Present for the mock, and for the replay subject as the state behind the fake: fault injection, clock and state inspection. */
  mock?: MockRegistrarPort;
  /** A name that is available right now and unique to this call (sandbox: random label, 1-year term). */
  freshName(tld: string): string;
}

const REGISTRANT = { name: "Test Person", email: "person@example.test", phone: "+1.5555550100", street: "1 Test St", city: "Portland", region: "OR", postalCode: "97201", country: "US" };
let seq = 0;
export function makeRegisterRequest(fqdn: string, years = 1, over: Partial<RegisterRequest> = {}): RegisterRequest {
  seq++;
  return { fqdn, years, regUsername: `mhu${String(seq).padStart(6, "0")}${Math.floor(Math.random() * 1e6)}`.slice(0, 20), regPassword: `pw-${Math.random().toString(36).slice(2)}xxxxxxxxxx`.slice(0, 20), registrant: { ...REGISTRANT }, ...over };
}

export function runRegistrarContract(makeAdapter: () => ContractSubject | Promise<ContractSubject>, opts: { tags: ContractTag[]; label?: string }): void {
  const want = new Set<ContractTag>(opts.tags);
  const t = (tag: ContractTag, name: string, fn: (s: ContractSubject) => Promise<void>) => {
    if (!want.has(tag)) { it.skip(`[${tag}] ${name}`, () => undefined); return; }
    it(`[${tag}] ${name}`, async () => { await fn(await makeAdapter()); });
  };
  const needMock = (s: ContractSubject): MockRegistrarPort => { if (!s.mock) throw new Error("mock-only test needs subject.mock"); return s.mock; };

  describe(`registrar contract: ${opts.label ?? "adapter"}`, () => {
    t("both", "register returns registered and the domain is ours upstream", async ({ adapter, freshName, mock }) => {
      const fqdn = freshName("com"); const req = makeRegisterRequest(fqdn);
      const sentAt = mock?.clock.now() ?? new Date();
      const r = await adapter.register(req);
      expect(r.status).toBe("registered");
      const dom = await adapter.getDomain(fqdn);
      expect(dom?.state).toBe("active");
      expect(dom?.profileUsername).toBe(req.regUsername);
      expect(dom?.locked).toBe(true);
      const orders = await adapter.getOrdersByDomain(fqdn);
      expect(orders.filter((o) => o.type === "new" && o.status === "completed")).toHaveLength(1);
      const claim = await claimRegistration(adapter, { fqdn, regUsername: req.regUsername, sentAt, registrantFingerprint: registrantFingerprint(req.registrant) });
      expect(claim).toMatchObject({ ours: true, state: "registered" });
    });

    t("both", "a second register for a taken domain is rejected (register is not idempotent)", async ({ adapter, freshName }) => {
      const fqdn = freshName("dev");
      await adapter.register(makeRegisterRequest(fqdn));
      await expect(adapter.register(makeRegisterRequest(fqdn))).rejects.toMatchObject({ kind: "rejected", outcomeUnknown: false });
      expect((await adapter.getOrdersByDomain(fqdn)).filter((o) => o.type === "new")).toHaveLength(1);
    });

    t("both", "a registered name reads as taken on the authoritative check", async ({ adapter, freshName }) => {
      const fqdn = freshName("app");
      await adapter.register(makeRegisterRequest(fqdn));
      expect((await adapter.checkAvailability(fqdn, { noCache: true })).kind).toBe("taken");
    });

    t("both", "capabilities say what OpenSRS cannot do", async ({ adapter }) => {
      const c = adapter.capabilities();
      expect(c.idempotentRegister).toBe(false);
      expect(c.restore).toMatchObject({ com: true, dev: true, studio: true, ai: false, io: false, app: false });
    });

    t("both", "an unsupported extension is rejected, not guessed", async ({ adapter }) => {
      await expect(adapter.checkAvailability("nothing.xyz")).rejects.toBeInstanceOf(RegistrarError);
    });

    t("mock-only", ".ai has a two-year minimum: a one-year register is rejected, two years registers and debits both years", async (s) => {
      const m = needMock(s);
      const fqdn = s.freshName("ai");
      await expect(m.register(makeRegisterRequest(fqdn, 1))).rejects.toMatchObject({ kind: "rejected", code: "invalid_period" });
      await expect(m.quote(fqdn, 1)).rejects.toMatchObject({ code: "invalid_period" });
      const before = (await m.getFundingStatus()) as { minor: bigint };
      const q = await m.quote(fqdn, 2);
      expect((await m.register(makeRegisterRequest(fqdn, 2))).status).toBe("registered");
      const after = (await m.getFundingStatus()) as { minor: bigint };
      expect(before.minor - after.minor).toBe(q.wholesale.minor);
    });

    t("mock-only", "every Money and Availability is labelled sample", async (s) => {
      const m = needMock(s);
      const fqdn = s.freshName("com");
      expect((await m.checkAvailability(fqdn)).source).toBe("sample");
      const q = await m.quote(fqdn, 1);
      expect([q.wholesale.source, q.renewalWholesale.source]).toEqual(["sample", "sample"]);
      const f = await m.getFundingStatus();
      expect(f.source).toBe("sample");
      expect(typeof q.wholesale.minor).toBe("bigint");
    });

    t("mock-only", "the seeded table includes taken, reserved, premium and unknown names", async (s) => {
      const m = needMock(s);
      const kinds = new Set<string>();
      for (let i = 0; i < 400; i++) kinds.add((await m.checkAvailability(`probe${i}.com`, { noCache: true })).kind);
      expect([...kinds].sort()).toEqual(["available", "premium", "reserved", "taken", "unknown"]);
    });

    t("mock-only", "accepted_pending (insufficient funds) is never treated as registered; a top-up completes it", async (s) => {
      const m = needMock(s);
      const fqdn = s.freshName("com");
      m.faults.set("insufficientFunds");
      const r = await m.register(makeRegisterRequest(fqdn));
      expect(r).toMatchObject({ status: "accepted_pending", reason: "forced_pending" });
      expect(await m.getDomain(fqdn)).toBeNull();
      expect((await m.getOrdersByDomain(fqdn))[0]).toMatchObject({ type: "new", status: "pending" });
      m.topUp(0n);
      expect((await m.getDomain(fqdn))?.state).toBe("active");
      expect((await m.getOrdersByDomain(fqdn))[0]?.status).toBe("completed");
    });

    t("mock-only", "a real shortfall also forces pending, and a funded balance is not debited until completion", async (s) => {
      const m = needMock(s);
      m.setBalance(100n);
      const fqdn = s.freshName("com");
      expect((await m.register(makeRegisterRequest(fqdn))).status).toBe("accepted_pending");
      expect((await m.getFundingStatus() as { minor: bigint }).minor).toBe(100n);
      m.topUp(10_000n);
      expect((await m.getDomain(fqdn))?.state).toBe("active");
    });

    t("mock-only", "async250 stays waiting until the clock passes, then completes once", async (s) => {
      const m = needMock(s);
      const fqdn = s.freshName("io");
      m.faults.set("async250");
      expect(await m.register(makeRegisterRequest(fqdn))).toMatchObject({ status: "accepted_pending", reason: "async" });
      expect(await m.getDomain(fqdn)).toBeNull();
      m.advance(30_000);
      expect(await m.getDomain(fqdn)).toBeNull();
      m.advance(31_000);
      expect((await m.getDomain(fqdn))?.state).toBe("active");
      expect(m.debits).toHaveLength(1);
    });

    t("mock-only", "an outcomeUnknown timeout is resolved by getDomain and getOrdersByDomain, never by a resend", async (s) => {
      const m = needMock(s);
      const fqdn = s.freshName("com"); const req = makeRegisterRequest(fqdn);
      m.faults.set("timeoutAfterAccept", { times: 1 });
      const sentAt = m.clock.now();
      const err = await m.register(req).catch((e) => e);
      expect(err).toBeInstanceOf(RegistrarError);
      expect((err as RegistrarError).outcomeUnknown).toBe(true);
      expect((err as RegistrarError).retryable).toBe(false);
      const claim = await claimRegistration(m, { fqdn, regUsername: req.regUsername, sentAt, registrantFingerprint: registrantFingerprint(req.registrant) });
      expect(claim).toMatchObject({ ours: true, state: "registered" });
      expect(m.calls.register).toBe(1);
      expect(m.orders.filter((o) => o.fqdn === fqdn)).toHaveLength(1);
    });

    t("mock-only", "an outcomeUnknown timeout where the upstream never applied resolves to no_order (safe to retry after the window)", async (s) => {
      const m = needMock(s);
      const fqdn = s.freshName("com"); const req = makeRegisterRequest(fqdn);
      const claim = await claimRegistration(m, { fqdn, regUsername: req.regUsername, sentAt: m.clock.now(), registrantFingerprint: registrantFingerprint(req.registrant) });
      expect(claim).toEqual({ ours: false, reason: "no_order" });
    });

    t("mock-only", "workerDeath applies the request then throws DeathSignal; reconciliation finds it", async (s) => {
      const m = needMock(s);
      const fqdn = s.freshName("dev"); const req = makeRegisterRequest(fqdn);
      m.faults.set("workerDeath", { times: 1 });
      const sentAt = m.clock.now();
      await expect(m.register(req)).rejects.toBeInstanceOf(DeathSignal);
      const claim = await claimRegistration(m, { fqdn, regUsername: req.regUsername, sentAt, registrantFingerprint: registrantFingerprint(req.registrant) });
      expect(claim).toMatchObject({ ours: true, state: "registered" });
    });

    t("mock-only", "claim rule: a domain under another profile is not ours; stale orders and other registrants are not ours", async (s) => {
      const m = needMock(s);
      const fqdn = s.freshName("com"); const req = makeRegisterRequest(fqdn);
      m.faults.set("sameNameTwoUsers", { times: 1 });
      const sentAt = m.clock.now();
      await expect(m.register(req)).rejects.toMatchObject({ kind: "rejected" });
      expect((await m.getDomain(fqdn))?.profileUsername).not.toBe(req.regUsername);
      expect(await claimRegistration(m, { fqdn, regUsername: req.regUsername, sentAt, registrantFingerprint: registrantFingerprint(req.registrant) })).toEqual({ ours: false, reason: "other_profile" });
      // Same profile but the order is older than sentAt - 5 s.
      const f2 = s.freshName("com"); const r2 = makeRegisterRequest(f2);
      await m.register(r2);
      m.advance(60_000);
      expect(await claimRegistration(m, { fqdn: f2, regUsername: r2.regUsername, sentAt: m.clock.now(), registrantFingerprint: registrantFingerprint(r2.registrant) })).toEqual({ ours: false, reason: "stale_order" });
      // Right profile, wrong registrant.
      expect(await claimRegistration(m, { fqdn: f2, regUsername: r2.regUsername, sentAt: new Date(m.clock.now().getTime() - 120_000), registrantFingerprint: "someone else|x" })).toEqual({ ours: false, reason: "registrant_mismatch" });
    });

    t("mock-only", "duplicateSubmit reaches the upstream twice but yields one order and one debit", async (s) => {
      const m = needMock(s);
      const fqdn = s.freshName("com");
      m.faults.set("duplicateSubmit", { times: 1 });
      expect((await m.register(makeRegisterRequest(fqdn))).status).toBe("registered");
      expect(m.calls.register).toBe(1);
      expect(m.upstream).toMatchObject({ registerSubmissions: 2, registerApplied: 1, duplicateRejected: 1 });
      expect(m.orders.filter((o) => o.fqdn === fqdn)).toHaveLength(1);
      expect(m.debits).toHaveLength(1);
    });

    t("mock-only", "defaultPeriod2: an ignored period bills and extends two years, and the debit exposes it", async (s) => {
      const m = needMock(s);
      const fqdn = s.freshName("com");
      const q = await m.quote(fqdn, 1);
      m.faults.set("defaultPeriod2", { times: 1 });
      await m.register(makeRegisterRequest(fqdn, 1));
      expect(m.debits[0]!.minor).toBe(q.wholesale.minor * 2n);
      const dom = await m.getDomain(fqdn);
      expect(dom!.expiresAt!.getUTCFullYear()).toBe(m.clock.now().getUTCFullYear() + 2);
      expect(m.debits[0]!.minor).not.toBe(q.wholesale.minor); // the post-order debit comparison (plan 4.3b rule 4) catches this
    });

    t("mock-only", "cancelPendingOrder cancels a pending order once, frees the name and refuses a completed order", async (s) => {
      const m = needMock(s);
      const fqdn = s.freshName("studio");
      m.faults.set("insufficientFunds", { times: 1 });
      const r = await m.register(makeRegisterRequest(fqdn));
      if (r.status !== "accepted_pending") throw new Error("expected pending");
      await expect(m.register(makeRegisterRequest(fqdn))).rejects.toMatchObject({ code: "order_exists" });
      expect(await m.cancelPendingOrder(r.registrarOrderId)).toEqual({ cancelled: true });
      expect(await m.cancelPendingOrder(r.registrarOrderId)).toEqual({ cancelled: false });
      m.topUp(1_000_000n);
      expect(await m.getDomain(fqdn)).toBeNull(); // the cancelled order does not complete
      const ok = await m.register(makeRegisterRequest(fqdn));
      expect(ok.status).toBe("registered");
      expect(await m.cancelPendingOrder(ok.registrarOrderId)).toEqual({ cancelled: false });
    });

    t("mock-only", "funding: getFundingStatus tracks debits exactly and equals the quote", async (s) => {
      const m = needMock(s);
      const start = (await m.getFundingStatus() as { minor: bigint }).minor;
      const a = s.freshName("com"), b = s.freshName("io");
      const qa = await m.quote(a, 3), qb = await m.quote(b, 1);
      await m.register(makeRegisterRequest(a, 3)); await m.register(makeRegisterRequest(b, 1));
      const end = (await m.getFundingStatus() as { minor: bigint }).minor;
      expect(start - end).toBe(qa.wholesale.minor + qb.wholesale.minor);
    });

    t("mock-only", "premium names are quoted as registry-premium and register is refused (D-031)", async (s) => {
      const m = needMock(s);
      const fqdn = "premium-abc.com";
      expect((await m.checkAvailability(fqdn)).kind).toBe("premium");
      expect((await m.quote(fqdn, 1)).isRegistryPremium).toBe(true);
      await expect(m.register(makeRegisterRequest(fqdn))).rejects.toMatchObject({ kind: "rejected", code: "premium_refused" });
      expect(m.orders.filter((o) => o.fqdn === fqdn)).toHaveLength(0);
    });

    t("mock-only", "renew: wrong or repeated expiry year is rejected; renewDraft blocks until the draft is cancelled", async (s) => {
      const m = needMock(s);
      const fqdn = s.freshName("com");
      await m.register(makeRegisterRequest(fqdn, 1));
      const y = (await m.getDomain(fqdn))!.expiresAt!.getUTCFullYear();
      m.faults.set("renewDraft", { times: 1 });
      await expect(m.renew(fqdn, 1, y)).rejects.toMatchObject({ code: "renew_failed" });
      await expect(m.renew(fqdn, 1, y)).rejects.toMatchObject({ code: "draft_exists" });
      const draft = (await m.getOrdersByDomain(fqdn)).find((o) => o.type === "renew")!;
      expect(await m.cancelPendingOrder(draft.registrarOrderId)).toEqual({ cancelled: true });
      expect((await m.renew(fqdn, 1, y)).status).toBe("renewed");
      expect((await m.getDomain(fqdn))!.expiresAt!.getUTCFullYear()).toBe(y + 1);
      await expect(m.renew(fqdn, 1, y)).rejects.toMatchObject({ kind: "rejected" }); // a retry after success fails (555)
    });

    t("mock-only", "registryMaintenance and rateLimited stop the call before any side effect and are retryable", async (s) => {
      const m = needMock(s);
      const fqdn = s.freshName("com");
      m.faults.set("registryMaintenance");
      expect((await m.health()).status).toBe("maintenance");
      const e1 = await m.register(makeRegisterRequest(fqdn)).catch((e) => e);
      expect(e1).toMatchObject({ kind: "maintenance" }); expect(e1.retryable).toBe(true); expect(e1.outcomeUnknown).toBe(false);
      expect(m.orders).toHaveLength(0);
      m.advance(31 * 60_000);
      expect((await m.health()).status).toBe("ok");
      m.faults.set("rateLimited", { times: 1 });
      const e2 = await m.register(makeRegisterRequest(fqdn)).catch((e) => e);
      expect(e2).toMatchObject({ kind: "rate_limited" }); expect(m.orders).toHaveLength(0);
      expect((await m.register(makeRegisterRequest(fqdn))).status).toBe("registered");
    });

    t("mock-only", "unknownAvailability yields kind unknown; the lookup cache is stale until noCache", async (s) => {
      const m = needMock(s);
      const fqdn = s.freshName("com");
      m.faults.set("unknownAvailability", { times: 1 });
      expect((await m.checkAvailability(fqdn, { noCache: true })).kind).toBe("unknown");
      expect((await m.checkAvailability(fqdn, { noCache: true })).kind).toBe("available");
      await m.checkAvailability(fqdn); // cached as available
      m.registerAsOther(fqdn);
      expect((await m.checkAvailability(fqdn)).kind).toBe("available"); // stale cache, as OpenSRS LOOKUP
      expect((await m.checkAvailability(fqdn, { noCache: true })).kind).toBe("taken");
      m.advance(6 * 60_000);
      expect((await m.checkAvailability(fqdn)).kind).toBe("taken");
    });

    t("mock-only", "an existing profile with a different password is refused", async (s) => {
      const m = needMock(s);
      const a = makeRegisterRequest(s.freshName("com"));
      await m.register(a);
      await expect(m.register({ ...makeRegisterRequest(s.freshName("com")), regUsername: a.regUsername })).rejects.toMatchObject({ code: "profile_exists" });
    });


    // ---- Phase 3 additions ------------------------------------------------------------------------------------------
    const reg = async (s: ContractSubject, tld = "com") => { const fqdn = s.freshName(tld); const req = makeRegisterRequest(fqdn); await s.adapter.register(req); return { fqdn, req }; };
    const rec = (type: DnsRecord["type"], name: string, value: string, extra: Partial<DnsRecord> = {}): DnsRecord => ({ type, name, value, ...extra });
    const DS: DsRecord = { keyTag: 12345, algorithm: 13, digestType: 2, digest: "ab".repeat(32) };

    t("both", "setLock round-trips and getDomain reports it", async (s) => {
      const { fqdn } = await reg(s);
      await s.adapter.setLock(fqdn, false);
      expect((await s.adapter.getDomain(fqdn))?.locked).toBe(false);
      await s.adapter.setLock(fqdn, true);
      expect((await s.adapter.getDomain(fqdn))?.locked).toBe(true);
      await expect(s.adapter.setLock(s.freshName("com"), false)).rejects.toMatchObject({ kind: "rejected" }); // not ours
    });

    t("both", "setNameservers changes them, and refuses a signed domain moving to unsigned DNS", async (s) => {
      const { fqdn } = await reg(s);
      await s.adapter.setNameservers(fqdn, ["ns1.example-dns.net", "ns2.example-dns.net"]);
      expect((await s.adapter.getDomain(fqdn))?.nameservers).toEqual(["ns1.example-dns.net", "ns2.example-dns.net"]);
      await expect(s.adapter.setNameservers(fqdn, ["ns1.a.net"])).rejects.toMatchObject({ kind: "rejected" });
      await s.adapter.addDs(fqdn, DS);
      expect((await s.adapter.getDomain(fqdn))?.dsPresent).toBe(true);
      await expect(s.adapter.setNameservers(fqdn, ["ns1.other-dns.net", "ns2.other-dns.net"])).rejects.toMatchObject({ kind: "rejected", code: "dnssec_would_break" });
      await s.adapter.setNameservers(fqdn, ["ns1.other-dns.net", "ns2.other-dns.net"], { targetSigned: true });
    });

    t("both", "DS records add (idempotently) and remove; .io has no DNSSEC", async (s) => {
      const { fqdn } = await reg(s);
      await s.adapter.addDs(fqdn, DS); await s.adapter.addDs(fqdn, DS);
      expect(await s.adapter.getDs(fqdn)).toEqual([DS]);
      await s.adapter.removeDs(fqdn, DS);
      expect(await s.adapter.getDs(fqdn)).toEqual([]);
      expect((await s.adapter.getDomain(fqdn))?.dsPresent).toBe(false);
      const io = await reg(s, "io");
      await expect(s.adapter.addDs(io.fqdn, DS)).rejects.toMatchObject({ kind: "rejected", code: "dnssec_unsupported" });
    });

    t("both", "issueAuthCode returns a fresh code each time; rerandomize invalidates it; .io codes come from a person", async (s) => {
      const { fqdn } = await reg(s);
      const a = await s.adapter.issueAuthCode(fqdn); const b = await s.adapter.issueAuthCode(fqdn);
      expect(a.code).toMatch(/^[A-Za-z0-9]{20}$/); expect(b.code).not.toBe(a.code);
      if (s.mock) { expect(s.mock.authCodeMatches(fqdn, a.code)).toBe(false); expect(s.mock.authCodeMatches(fqdn, b.code)).toBe(true); }
      expect(await s.adapter.rerandomizeAuthCode(fqdn)).toBeUndefined();
      if (s.mock) expect(s.mock.authCodeMatches(fqdn, b.code)).toBe(false);
      const io = await reg(s, "io");
      await expect(s.adapter.issueAuthCode(io.fqdn)).rejects.toMatchObject({ kind: "rejected", code: "code_by_support" });
    });

    t("both", "replaceZone replaces everything: removed records and whole types disappear, an empty list clears the zone, the hash is stable", async (s) => {
      const { fqdn } = await reg(s);
      const full = [rec("A", "", "192.0.2.1"), rec("A", "www", "192.0.2.2"), rec("MX", "", "mail.example.net", { priority: 10 }), rec("TXT", "", "v=spf1 -all"), rec("CNAME", "app", "target.example.net")];
      const r1 = await s.adapter.replaceZone(fqdn, full);
      expect(r1.hash).toBe(zoneHash(full));
      expect((await s.adapter.getDns(fqdn)).records).toHaveLength(5);
      const r2 = await s.adapter.replaceZone(fqdn, [rec("A", "", "192.0.2.9")]);
      const z = await s.adapter.getDns(fqdn);
      expect(z.hosted).toBe(true);
      expect(z.records).toEqual([rec("A", "", "192.0.2.9")]);
      expect(r2.hash).toBe(zoneHash(z.records));
      await s.adapter.replaceZone(fqdn, []);
      expect((await s.adapter.getDns(fqdn)).records).toEqual([]);
    });

    t("both", "replaceZone refuses unsupported types, over-long TXT and a zone that is not hosted here", async (s) => {
      const { fqdn } = await reg(s);
      await expect(s.adapter.replaceZone(fqdn, [{ type: "CAA" as never, name: "", value: "0 issue x" }])).rejects.toMatchObject({ code: "unsupported_record_type" });
      await expect(s.adapter.replaceZone(fqdn, [rec("TXT", "", "x".repeat(255))])).rejects.toMatchObject({ code: "txt_too_long" });
      await s.adapter.setNameservers(fqdn, ["ns1.elsewhere.net", "ns2.elsewhere.net"]);
      expect(await s.adapter.getDns(fqdn)).toEqual({ hosted: false, records: [] });
      await expect(s.adapter.replaceZone(fqdn, [rec("A", "", "192.0.2.1")])).rejects.toMatchObject({ code: "dns_not_hosted" });
    });

    t("both", "setAutoRenew toggles auto_renew; getBalance is Money and equals the funding status", async (s) => {
      const { fqdn } = await reg(s);
      expect((await s.adapter.getDomain(fqdn))?.autoRenew).toBe(false);
      await s.adapter.setAutoRenew(fqdn, true);
      expect((await s.adapter.getDomain(fqdn))?.autoRenew).toBe(true);
      await s.adapter.setAutoRenew(fqdn, false);
      expect((await s.adapter.getDomain(fqdn))?.autoRenew).toBe(false);
      const b = await s.adapter.getBalance();
      expect(typeof b.balance.minor).toBe("bigint");
      expect(b.available.minor).toBe(b.balance.minor - b.held.minor);
      expect((await s.adapter.getFundingStatus() as { minor: bigint }).minor).toBe(b.available.minor);
    });

    t("both", "listDomains pages through the inventory", async (s) => {
      const made = [await reg(s), await reg(s), await reg(s)].map((x) => x.fqdn);
      const seen: string[] = []; let cursor: string | undefined; let pages = 0;
      do { const r = await s.adapter.listDomains({ ...(cursor ? { cursor } : {}), limit: 2 }); seen.push(...r.rows.map((x) => x.fqdn)); cursor = r.next; pages++; } while (cursor && pages < 20);
      for (const f of made) expect(seen).toContain(f);
      expect(new Set(seen).size).toBe(seen.length);
      expect(pages).toBeGreaterThanOrEqual(2);
    });

    t("both", "updateContact reports a registrant change and does not apply it at once; other edits apply", async (s) => {
      const { fqdn, req } = await reg(s);
      const before = (await s.adapter.getDomain(fqdn))?.ownerEmailHash;
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      const same = await s.adapter.updateContact(fqdn, { ...req.registrant, phone: "+1.5555550199" });
      expect(same).toEqual({ status: "applied", registrantChange: false, verificationRequired: false, transferLock60d: false });
      const chg = await s.adapter.updateContact(fqdn, { ...req.registrant, email: "new-owner@example.test" });
      expect(chg).toEqual({ status: "pending_approval", registrantChange: true, verificationRequired: true, transferLock60d: true });
      expect((await s.adapter.getDomain(fqdn))?.ownerEmailHash).toBe(before);
    });

    t("both", "cancelTransfer with nothing to cancel says so; cancelTransferAway is not offered", async (s) => {
      const { fqdn } = await reg(s);
      expect(await s.adapter.cancelTransfer(fqdn)).toEqual({ cancelled: false });
      expect(s.adapter.capabilities().cancelTransferAway).toBe(false);
    });

    t("replay", "out-of-band changes show up in getDomain (the detector's inputs): lock, nameservers, DS, owner email hash, auto_renew, let_expire, privacy service", async (s) => {
      const m = needMock(s); const { fqdn } = await reg(s);
      const base = (await s.adapter.getDomain(fqdn))!;
      m.oob.setLock(fqdn, false); m.oob.setNameservers(fqdn, ["ns1.evil.net", "ns2.evil.net"]); m.oob.addDs(fqdn, DS);
      m.oob.changeOwnerEmail(fqdn, "thief@example.test"); m.oob.setAutoRenew(fqdn, true); m.oob.letExpire(fqdn, true); m.oob.setPrivacyService(fqdn, true);
      const now = (await s.adapter.getDomain(fqdn))!;
      expect(now.locked).toBe(false); expect(base.locked).toBe(true);
      expect(now.nameservers).toEqual(["ns1.evil.net", "ns2.evil.net"]);
      expect(now.dsPresent).toBe(true); expect(base.dsPresent).toBe(false);
      expect(now.ownerEmailHash).not.toBe(base.ownerEmailHash);
      expect(now.autoRenew).toBe(true); expect(now.letExpire).toBe(true); expect(base.letExpire).toBe(false);
      expect(now.privacyServiceEnabled).toBe(true); expect(base.privacyServiceEnabled).toBe(false);
    });

    t("replay", "a transfer away shows in getTransfersAway and getDomain; Stop re-locks and re-randomises but the transfer remains", async (s) => {
      const m = needMock(s); const { fqdn } = await reg(s);
      await s.adapter.setLock(fqdn, false);
      const code = (await s.adapter.issueAuthCode(fqdn)).code;
      m.oob.startTransferAway(fqdn, { status: "pending_owner", gainingRegistrar: "other" });
      const away = await s.adapter.getTransfersAway({ statuses: ["pending_owner"] });
      expect(away.map((x) => x.fqdn)).toContain(fqdn);
      expect(await s.adapter.getTransfersAway({ statuses: ["pending_registry"] })).toEqual([]);
      const dom = await s.adapter.getDomain(fqdn);
      expect(dom).toMatchObject({ state: "transferring_out", transferAwayInProgress: true });
      const stop = await s.adapter.stopTransferAway(fqdn);
      expect(stop).toEqual({ relocked: true, codeRerandomized: true, pendingTransferRemains: true });
      expect((await s.adapter.getDomain(fqdn))?.locked).toBe(true);
      expect(m.authCodeMatches(fqdn, code)).toBe(false);
    });

    t("replay", "forced_pending is accepted_pending, never registered; releasing the order completes it", async (s) => {
      const m = needMock(s); const fqdn = s.freshName("com");
      m.faults.set("forcedPending", { times: 1 });
      const r = await s.adapter.register(makeRegisterRequest(fqdn));
      expect(r).toMatchObject({ status: "accepted_pending", reason: "forced_pending" });
      expect(await s.adapter.getDomain(fqdn)).toBeNull();
      expect(m.releasePending(r.registrarOrderId)).toBe(true);
      expect((await s.adapter.getDomain(fqdn))?.state).toBe("active");
    });

    t("replay", "async250 completes on the clock", async (s) => {
      const m = needMock(s); const fqdn = s.freshName("dev");
      m.faults.set("async250", { times: 1 });
      expect(await s.adapter.register(makeRegisterRequest(fqdn))).toMatchObject({ status: "accepted_pending", reason: "async" });
      expect(await s.adapter.getDomain(fqdn)).toBeNull();
      m.advance(61_000);
      expect((await s.adapter.getDomain(fqdn))?.state).toBe("active");
    });

    t("replay", "dnsWriteIgnored (the write is accepted and dropped) is caught by the read-back", async (s) => {
      const m = needMock(s); const { fqdn } = await reg(s);
      await s.adapter.replaceZone(fqdn, [rec("A", "", "192.0.2.1")]);
      m.faults.set("dnsWriteIgnored", { times: 1 });
      await expect(s.adapter.replaceZone(fqdn, [rec("A", "", "192.0.2.77")])).rejects.toMatchObject({ kind: "rejected", code: "dns_readback_mismatch" });
      expect((await s.adapter.getDns(fqdn)).records).toEqual([rec("A", "", "192.0.2.1")]); // unchanged: the caller's snapshot is still the truth
    });

    t("replay", "expiry, deletion into redemption, and restore for .com/.dev/.studio only", async (s) => {
      const m = needMock(s); const a = await reg(s, "com"); const b = await reg(s, "app");
      m.advance(366 * 86_400_000 + 1000);
      expect((await s.adapter.getDomain(a.fqdn))?.state).toBe("expired");
      m.advance(40 * 86_400_000);
      expect(await s.adapter.getDomain(a.fqdn)).toBeNull(); // GET returns nothing during redemption (S17)
      const del = await s.adapter.getDeletedDomains();
      expect(del.map((x) => x.fqdn)).toEqual(expect.arrayContaining([a.fqdn, b.fqdn]));
      await expect(s.adapter.restore(b.fqdn)).rejects.toMatchObject({ kind: "rejected", code: "restore_unsupported" });
      expect(await s.adapter.restore(a.fqdn)).toMatchObject({ status: "restored" });
      expect((await s.adapter.getDomain(a.fqdn))?.state).toBe("active");
      await expect(s.adapter.restore(a.fqdn)).rejects.toMatchObject({ kind: "rejected" });
    });

    t("mock-only", "per-type overwrite leaves stale types after a naive write; whole-zone does not (why replaceZone sends every type)", async (s) => {
      const m = needMock(s); const { fqdn } = await reg(s);
      await m.replaceZone(fqdn, [rec("A", "", "192.0.2.1"), rec("MX", "", "mail.example.net", { priority: 10 })]);
      m.rawSetZone(fqdn, { A: [rec("A", "", "192.0.2.5")] }); // a payload that names only A
      const kinds = (await m.getDns(fqdn)).records.map((r) => r.type);
      expect(kinds.includes("MX")).toBe(m.dnsOverwrite === "per_type");
    });

    t("sandbox-only", "Horizon rejects registering the same name twice, even across resellers", async ({ adapter, freshName }) => {
      const fqdn = freshName("com");
      await adapter.register(makeRegisterRequest(fqdn));
      await expect(adapter.register(makeRegisterRequest(fqdn))).rejects.toBeInstanceOf(RegistrarError);
    });
  });
}
