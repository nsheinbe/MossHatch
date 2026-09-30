import { fnv1a } from "@mosshatch/core";
import {
  RegistrarError,
  type Availability, type AvailabilityKind, type DomainStatus, type Money, type Quote, type RegisterRequest, type RegisterResult,
  type RegistrarCapabilities, type RegistrarPort, type UpstreamOrder,
} from "./port.ts";
import { registrantFingerprint } from "./claim.ts";
import { SAMPLE_WHOLESALE_CENTS } from "./mock.ts";

export { claimRegistration, registrantFingerprint, CLAIM_SKEW_MS, type ClaimResult } from "./claim.ts";

/**
 * MockRegistrarPort: the Phase 2 in-memory registrar, profile `mock:opensrs` (plan 4.3b "MockRegistrar rules").
 * It reproduces OpenSRS constraints so the app cannot lean on features the real provider lacks. Every Money and
 * Availability it returns carries `source: 'sample'`. State changes only through adapter methods and the injectable
 * clock (`advance`), never through timers. The Phase 1 `MockRegistrar` (UI sample prices) is a separate class.
 */

export const MOCK_EXTENSIONS = ["com", "ai", "dev", "io", "app", "studio"] as const;
const MIN_TERM: Record<string, number> = { ai: 2 };
const MAX_TERM = 10;
/** OpenSRS serves `LOOKUP` from its cache unless `no_cache=1`; the mock keeps a result for five minutes. */
export const LOOKUP_CACHE_MS = 5 * 60_000;
/** How long an `async250` order stays `waiting` before it completes on the clock. */
export const ASYNC_COMPLETE_MS = 60_000;

export type FaultName =
  | "timeoutAfterAccept" | "workerDeath" | "duplicateSubmit" | "sameNameTwoUsers" | "insufficientFunds" | "async250"
  | "registryMaintenance" | "renewDraft" | "defaultPeriod2" | "rateLimited" | "unknownAvailability";
export interface FaultOptions {
  /** Fire this many times, then switch off. Default: until cleared. */
  times?: number;
  /** Only for this domain (lower-case fqdn). Default: every domain. */
  fqdn?: string;
  /** `registryMaintenance`: length of the window from now (default 30 minutes). */
  durationMs?: number;
}

/** Thrown after the mock has applied a request, to simulate a worker that died right after sending. The caller (a test harness) catches it and stops. */
export class DeathSignal extends Error {
  override readonly name = "DeathSignal";
  constructor(public readonly op: "register" | "renew", public readonly fqdn: string) { super(`worker died after ${op}`); }
}

export interface MockClock { now(): Date; advance?(ms: number): void }
export class ManualClock implements MockClock {
  constructor(public t = new Date("2026-10-01T12:00:00Z")) {}
  now() { return new Date(this.t); }
  advance(ms: number) { this.t = new Date(this.t.getTime() + ms); }
}

export interface MockCapabilities extends RegistrarCapabilities {
  profile: "mock:opensrs";
  /** OpenSRS `LOOKUP` takes one name per call. */
  lookupBatchSize: 1;
  idempotencyKey: false;
  dnsMode: "replace_all";
  dnsTtl: false;
  dnsCaa: false;
  minTermYears: Record<string, number>;
  maxTermYears: number;
  outboundTransfer: "emailed_approval";
  authCodeOverrides: Record<string, "person">;
  registerPeriodDefault: 2;
}

export interface MockUpstreamOrder extends UpstreamOrder { years: number; registrantFingerprint: string; costMinor: bigint; pendingReason?: "forced_pending" | "async"; completeAt?: Date }
interface MockDomain {
  fqdn: string; profileUsername: string; registrantFingerprint: string; createdAt: Date; expiresAt: Date; orderId: string; locked: boolean; nameservers: string[]; foreign: boolean;
}
interface FaultState { opts: FaultOptions; remaining: number | null }

const KNOWN_TAKEN = new Set(["google.com", "example.com", "mosshatch.com", "hatchkind.com", "moonfern.io"]);
const KNOWN_AVAILABLE = new Set(["moonfern.com"]);
const KNOWN_RESERVED = new Set(["example.dev", "example.app", "example.studio", "icann.com"]);

const addYears = (d: Date, y: number) => { const n = new Date(d); n.setUTCFullYear(n.getUTCFullYear() + y); return n; };
const sample = (minor: bigint): Money => ({ minor, currency: "usd", source: "sample" });
const rejected = (code: string, msg: string) => new RegistrarError("rejected", msg, { retryable: false, outcomeUnknown: false, code });

export class MockRegistrarPort implements RegistrarPort {
  readonly clock: MockClock;
  private wholesale: Record<string, bigint>;
  private restorePrice: Record<string, bigint> = { com: 8000n, ai: 20000n, dev: 15000n, io: 25000n, app: 15000n, studio: 8000n };
  private profiles = new Map<string, { password: string; createdAt: Date }>();
  private domains = new Map<string, MockDomain>();
  private orderList: MockUpstreamOrder[] = [];
  private balance: bigint;
  private seq = 0;
  private faultMap = new Map<FaultName, FaultState>();
  private windows: { starts: Date; ends: Date }[] = [];
  private lookupCache = new Map<string, { a: Availability; expires: number }>();
  private quoteOverrides = new Map<string, bigint>();
  private kindOverrides = new Map<string, AvailabilityKind>();

  /** Call counters, by adapter method: `calls.register` is the number of times the caller invoked it. */
  readonly calls = { checkAvailability: 0, checkAvailabilityNoCache: 0, quote: 0, register: 0, renew: 0, getDomain: 0, getOrdersByDomain: 0, cancelPendingOrder: 0, getFundingStatus: 0, health: 0 };
  /** What actually reached the upstream (differs from `calls` under `duplicateSubmit`). */
  readonly upstream = { registerSubmissions: 0, registerApplied: 0, renewApplied: 0, duplicateRejected: 0 };
  /** Every debit of the funding balance, in order. */
  readonly debits: { orderId: string; minor: bigint }[] = [];

  readonly faults = {
    set: (name: FaultName, opts: FaultOptions | boolean = {}): void => {
      if (opts === false) { this.faultMap.delete(name); return; }
      const o = opts === true ? {} : opts;
      this.faultMap.set(name, { opts: o, remaining: o.times ?? null });
      if (name === "registryMaintenance") this.windows.push({ starts: this.clock.now(), ends: new Date(this.clock.now().getTime() + (o.durationMs ?? 30 * 60_000)) });
    },
    clear: (name?: FaultName): void => { if (name) this.faultMap.delete(name); else this.faultMap.clear(); },
    has: (name: FaultName, fqdn?: string): boolean => { const f = this.faultMap.get(name); return !!f && (f.remaining === null || f.remaining > 0) && (!f.opts.fqdn || f.opts.fqdn === fqdn); },
  };

  constructor(opts: { clock?: MockClock; funding?: bigint; wholesalePerYear?: Record<string, bigint> } = {}) {
    this.clock = opts.clock ?? new ManualClock();
    this.balance = opts.funding ?? 1_000_000n;
    this.wholesale = opts.wholesalePerYear ?? Object.fromEntries(Object.entries(SAMPLE_WHOLESALE_CENTS).map(([k, v]) => [k, BigInt(v)]));
  }

  // ---- controls for tests --------------------------------------------------------------------------------------
  /** Advance the injectable clock and complete anything due. */
  advance(ms: number): void {
    if (!this.clock.advance) throw new Error("the injected clock has no advance(); advance it yourself and call tick()");
    this.clock.advance(ms); this.tick();
  }
  /** Complete due asynchronous orders. Every adapter method calls this first, so advancing a shared clock is enough. */
  tick(): void {
    const now = this.clock.now().getTime();
    for (const o of this.orderList) {
      if (o.status === "waiting" && o.completeAt && o.completeAt.getTime() <= now) this.complete(o);
    }
  }
  /** Add funds; clears the `insufficientFunds` fault and completes forced-pending orders the balance now covers, oldest first. */
  topUp(minor: bigint): void {
    this.balance += minor; this.faultMap.delete("insufficientFunds");
    for (const o of this.orderList) if (o.status === "pending" && o.pendingReason === "forced_pending" && this.balance >= o.costMinor) this.complete(o);
  }
  setBalance(minor: bigint) { this.balance = minor; }
  get fundingBalance(): bigint { return this.balance; }
  /** Put a domain under another customer's profile (a rival who registered first). */
  registerAsOther(fqdn: string, years = 1): void {
    const d = fqdn.toLowerCase(); const now = this.clock.now();
    const id = this.nextId();
    this.orderList.push({ registrarOrderId: id, fqdn: d, type: "new", status: "completed", orderDate: now, profileUsername: `other-${id}`, years, registrantFingerprint: "someone else", costMinor: 0n });
    this.domains.set(d, { fqdn: d, profileUsername: `other-${id}`, registrantFingerprint: "someone else", createdAt: now, expiresAt: addYears(now, years), orderId: id, locked: true, nameservers: [], foreign: true });
  }
  addMaintenanceWindow(starts: Date, ends: Date) { this.windows.push({ starts, ends }); }
  /** Force a kind for a name (seeded table override for tests). */
  setKind(fqdn: string, kind: AvailabilityKind) { this.kindOverrides.set(fqdn.toLowerCase(), kind); }
  /** A quote at a non-standard price (D-031 price guard tests). */
  overrideQuote(fqdn: string, wholesaleMinorPerYear: bigint) { this.quoteOverrides.set(fqdn.toLowerCase(), wholesaleMinorPerYear); }
  /** Inspection. */
  get orders(): readonly MockUpstreamOrder[] { return this.orderList; }
  domainRecord(fqdn: string): Readonly<MockDomain> | undefined { return this.domains.get(fqdn.toLowerCase()); }
  profileExists(username: string) { return this.profiles.has(username); }
  get domainCount() { return this.domains.size; }

  // ---- RegistrarPort -------------------------------------------------------------------------------------------
  capabilities(): MockCapabilities {
    return {
      mode: "mock", profile: "mock:opensrs", dnsHosting: true, dnssec: false, webhooks: false, idempotentRegister: false, sandbox: false,
      authCodeModel: "api", authCodeOverrides: { io: "person" },
      restore: { com: true, dev: true, studio: true, ai: false, io: false, app: false },
      funding: true, inventory: true, events: false,
      lookupBatchSize: 1, idempotencyKey: false, dnsMode: "replace_all", dnsTtl: false, dnsCaa: false,
      minTermYears: { ...MIN_TERM }, maxTermYears: MAX_TERM, outboundTransfer: "emailed_approval", registerPeriodDefault: 2,
    };
  }

  async health() {
    this.calls.health++; this.tick();
    const m = this.maintenanceUntil();
    if (m) return { status: "maintenance" as const, maintenanceUntil: m };
    if (this.faults.has("rateLimited")) return { status: "degraded" as const };
    return { status: "ok" as const };
  }

  async checkAvailability(fqdn: string, opts: { noCache?: boolean } = {}): Promise<Availability> {
    this.calls.checkAvailability++; if (opts.noCache) this.calls.checkAvailabilityNoCache++;
    this.tick();
    const d = fqdn.trim().toLowerCase();
    this.tldOf(d);
    this.guardCall(d);
    const now = this.clock.now();
    if (!opts.noCache) {
      const hit = this.lookupCache.get(d);
      if (hit && hit.expires > now.getTime()) return { ...hit.a };
    }
    let kind: AvailabilityKind;
    if (this.consumeFault("unknownAvailability", d)) kind = "unknown";
    else kind = this.classify(d);
    const a: Availability = { fqdn: d, kind, source: "sample", checkedAt: now };
    this.lookupCache.set(d, { a, expires: now.getTime() + LOOKUP_CACHE_MS });
    return { ...a };
  }

  async quote(fqdn: string, years: number, kind: "register" | "renew" = "register"): Promise<Quote> {
    this.calls.quote++; this.tick();
    const d = fqdn.trim().toLowerCase(); const tld = this.tldOf(d);
    this.guardCall(d);
    this.checkTerm(tld, years);
    const premium = this.classify(d) === "premium";
    const perYear = this.quoteOverrides.get(d) ?? (premium ? this.wholesale[tld]! * 10n : this.wholesale[tld]!); // premium multiple is a mock fixture, not a price
    void kind;
    return { fqdn: d, tld, years, wholesale: sample(perYear * BigInt(years)), renewalWholesale: sample(perYear * BigInt(years)), isRegistryPremium: premium, quotedAt: this.clock.now() };
  }

  async register(req: RegisterRequest): Promise<RegisterResult> {
    this.calls.register++; this.tick();
    const d = req.fqdn.trim().toLowerCase(); const tld = this.tldOf(d);
    this.guardCall(d);
    this.checkTerm(tld, req.years);
    if (this.classify(d) === "premium") throw rejected("premium_refused", "registry-premium names are not sold");
    if (this.classify(d) === "reserved") throw rejected("reserved", "name is reserved by the registry");
    // A rival takes the name between our lookup and our order.
    if (this.consumeFault("sameNameTwoUsers", d) && !this.domains.has(d)) this.registerAsOther(d);
    const dup = this.consumeFault("duplicateSubmit", d);
    // `defaultPeriod2`: the caller's period never reaches the upstream, which applies its default of 2.
    const years = this.consumeFault("defaultPeriod2", d) ? 2 : req.years;

    this.upstream.registerSubmissions++;
    const first = this.applyRegister(req, d, tld, years);
    if (dup) { // the same request arrives twice; the upstream rejects the second and the caller sees only the first answer
      this.upstream.registerSubmissions++;
      try { this.applyRegister(req, d, tld, years); } catch { this.upstream.duplicateRejected++; }
    }
    if (this.consumeFault("workerDeath", d)) throw new DeathSignal("register", d);
    if (this.consumeFault("timeoutAfterAccept", d)) throw new RegistrarError("unknown", "request timed out after submit", { retryable: false, outcomeUnknown: true, code: "timeout" });
    return first;
  }

  async renew(fqdn: string, years: number, currentExpiryYear: number) {
    this.calls.renew++; this.tick();
    const d = fqdn.trim().toLowerCase(); const tld = this.tldOf(d);
    this.guardCall(d);
    this.checkTerm(tld, years);
    const dom = this.domains.get(d);
    if (!dom || dom.foreign) throw rejected("not_found", "domain not found");
    if (this.orderList.some((o) => o.fqdn === d && o.type === "renew" && (o.status === "pending" || o.status === "waiting"))) throw rejected("draft_exists", "a draft renewal exists and must be cleared first");
    if (dom.expiresAt.getUTCFullYear() !== currentExpiryYear) throw rejected(currentExpiryYear > dom.expiresAt.getUTCFullYear() ? "541" : "555", "domain already renewed or expiry year does not match");
    const cost = this.wholesale[tld]! * BigInt(years);
    const id = this.nextId(); const now = this.clock.now();
    const order: MockUpstreamOrder = { registrarOrderId: id, fqdn: d, type: "renew", status: "pending", orderDate: now, profileUsername: dom.profileUsername, years, registrantFingerprint: dom.registrantFingerprint, costMinor: cost };
    this.orderList.push(order);
    if (this.consumeFault("renewDraft", d)) throw rejected("renew_failed", "renewal failed and left a draft order");
    if (this.consumeFault("insufficientFunds", d) || this.balance < cost) { order.pendingReason = "forced_pending"; return { status: "accepted_pending" as const, registrarOrderId: id }; }
    if (this.consumeFault("async250", d)) { order.status = "waiting"; order.pendingReason = "async"; order.completeAt = new Date(now.getTime() + ASYNC_COMPLETE_MS); return { status: "accepted_pending" as const, registrarOrderId: id }; }
    this.complete(order);
    const out = { status: "renewed" as const, registrarOrderId: id, expiresAt: dom.expiresAt };
    if (this.consumeFault("workerDeath", d)) throw new DeathSignal("renew", d);
    if (this.consumeFault("timeoutAfterAccept", d)) throw new RegistrarError("unknown", "request timed out after submit", { retryable: false, outcomeUnknown: true, code: "timeout" });
    return out;
  }

  async getDomain(fqdn: string): Promise<DomainStatus | null> {
    this.calls.getDomain++; this.tick();
    const d = fqdn.trim().toLowerCase();
    const dom = this.domains.get(d);
    if (!dom) return null;
    const expired = dom.expiresAt.getTime() <= this.clock.now().getTime();
    return {
      fqdn: d, state: expired ? "expired" : "active", registryStatuses: dom.locked ? ["clientTransferProhibited"] : ["ok"], expiresAt: new Date(dom.expiresAt),
      locked: dom.locked, nameservers: [...dom.nameservers], autoRenew: false, privacyStatus: this.tldOf(d) === "ai" || this.tldOf(d) === "io" ? "not_available" : "redacted_default",
      dsPresent: false, profileUsername: dom.profileUsername, registrarOrderId: dom.orderId, createdAt: new Date(dom.createdAt),
    };
  }

  async getOrdersByDomain(fqdn: string): Promise<UpstreamOrder[]> {
    this.calls.getOrdersByDomain++; this.tick();
    const d = fqdn.trim().toLowerCase();
    return this.orderList.filter((o) => o.fqdn === d).map((o) => ({ ...o }));
  }

  async cancelPendingOrder(registrarOrderId: string): Promise<{ cancelled: boolean }> {
    this.calls.cancelPendingOrder++; this.tick();
    const o = this.orderList.find((x) => x.registrarOrderId === registrarOrderId);
    if (!o || (o.status !== "pending" && o.status !== "waiting")) return { cancelled: false };
    o.status = "cancelled"; delete o.completeAt;
    return { cancelled: true };
  }

  async getFundingStatus(): Promise<Money> {
    this.calls.getFundingStatus++; this.tick();
    return sample(this.balance);
  }

  /** Restore fee table (mock fixture from the rate card in docs/research/reg-opensrs.md). */
  restoreFee(tld: string): bigint | undefined { return this.restorePrice[tld]; }

  // ---- internals -----------------------------------------------------------------------------------------------
  private nextId() { return `mock-ord-${String(++this.seq).padStart(5, "0")}`; }
  private tldOf(d: string): string {
    const i = d.indexOf(".");
    const tld = i < 0 ? "" : d.slice(i + 1);
    if (!(MOCK_EXTENSIONS as readonly string[]).includes(tld) || i < 1) throw rejected("unsupported_tld", "extension not supported");
    return tld;
  }
  private checkTerm(tld: string, years: number) {
    if (!Number.isInteger(years) || years < (MIN_TERM[tld] ?? 1) || years > MAX_TERM) throw rejected("invalid_period", `term of ${years} years is not allowed for .${tld}`);
  }
  private maintenanceUntil(): Date | undefined {
    const now = this.clock.now().getTime();
    let until: Date | undefined;
    for (const w of this.windows) if (w.starts.getTime() <= now && now < w.ends.getTime() && (!until || w.ends > until)) until = w.ends;
    return until;
  }
  /** Faults that stop a call before any side effect. */
  private guardCall(d: string) {
    const m = this.maintenanceUntil();
    if (m) throw new RegistrarError("maintenance", "registry maintenance", { retryable: true, outcomeUnknown: false, code: "maintenance" });
    if (this.consumeFault("rateLimited", d)) throw new RegistrarError("rate_limited", "rate limited", { retryable: true, outcomeUnknown: false, code: "429" });
  }
  private consumeFault(name: FaultName, fqdn: string): boolean {
    const f = this.faultMap.get(name);
    if (!f) return false;
    if (f.opts.fqdn && f.opts.fqdn !== fqdn) return false;
    if (f.remaining !== null) { if (f.remaining <= 0) return false; f.remaining--; if (f.remaining === 0) this.faultMap.delete(name); }
    return true;
  }
  /** The seeded availability table. The taken rule is the Phase 1 hash (one in four); the other kinds come from a second hash. */
  private classify(d: string): AvailabilityKind {
    const o = this.kindOverrides.get(d);
    if (o) return o;
    const dom = this.domains.get(d);
    if (dom) return "taken";
    const label = d.slice(0, d.indexOf("."));
    if (label.startsWith("taken-") || KNOWN_TAKEN.has(d)) return "taken";
    if (label.startsWith("reserved-") || KNOWN_RESERVED.has(d)) return "reserved";
    if (label.startsWith("premium-")) return "premium";
    if (label.startsWith("unknown-")) return "unknown";
    if (label.startsWith("free-") || KNOWN_AVAILABLE.has(d)) return "available";
    if (fnv1a("taken:" + d) % 4 === 0) return "taken";
    const h = fnv1a("kind:" + d) % 100;
    if (h < 3) return "reserved";
    if (h < 6 && !d.endsWith(".ai")) return "premium"; // .ai allows no registry premiums (docs/research/reg-opensrs.md)
    if (h < 9) return "unknown";
    return "available";
  }
  private applyRegister(req: RegisterRequest, d: string, tld: string, years: number): RegisterResult {
    void tld;
    const existing = this.domains.get(d);
    if (existing) throw rejected("domain_taken", "domain is already registered");
    // Any non-terminal `new` order for the name blocks a second one (OpenSRS "waiting registration exists").
    if (this.orderList.some((o) => o.fqdn === d && o.type === "new" && (o.status === "pending" || o.status === "waiting"))) throw rejected("order_exists", "a registration order for this name is already waiting");
    const prof = this.profiles.get(req.regUsername);
    if (prof && prof.password !== req.regPassword) throw rejected("profile_exists", "profile username is taken");
    if (req.regUsername.length < 3 || req.regUsername.length > 20 || req.regPassword.length < 10 || req.regPassword.length > 20) throw rejected("bad_profile", "reg_username needs 3 to 20 and reg_password 10 to 20 characters");
    if (!prof) this.profiles.set(req.regUsername, { password: req.regPassword, createdAt: this.clock.now() });
    const id = this.nextId(); const now = this.clock.now();
    const cost = this.wholesale[this.tldOf(d)]! * BigInt(years);
    const order: MockUpstreamOrder = { registrarOrderId: id, fqdn: d, type: "new", status: "pending", orderDate: now, profileUsername: req.regUsername, years, registrantFingerprint: registrantFingerprint(req.registrant), costMinor: cost };
    this.orderList.push(order);
    if (this.faults.has("insufficientFunds", d) || this.balance < cost) { this.consumeFault("insufficientFunds", d); order.pendingReason = "forced_pending"; return { status: "accepted_pending", registrarOrderId: id, reason: "forced_pending" }; }
    if (this.consumeFault("async250", d)) { order.status = "waiting"; order.pendingReason = "async"; order.completeAt = new Date(now.getTime() + ASYNC_COMPLETE_MS); return { status: "accepted_pending", registrarOrderId: id, reason: "async" }; }
    this.complete(order);
    return { status: "registered", registrarOrderId: id, expiresAt: new Date(this.domains.get(d)!.expiresAt) };
  }
  /** Debit the balance and apply the order's effect. */
  private complete(o: MockUpstreamOrder) {
    if (this.balance < o.costMinor) { o.status = "pending"; o.pendingReason = "forced_pending"; delete o.completeAt; return; }
    this.balance -= o.costMinor; this.debits.push({ orderId: o.registrarOrderId, minor: o.costMinor });
    o.status = "completed"; delete o.pendingReason; delete o.completeAt;
    const now = this.clock.now();
    if (o.type === "new") {
      if (this.domains.has(o.fqdn)) { o.status = "cancelled"; this.balance += o.costMinor; return; }
      this.domains.set(o.fqdn, { fqdn: o.fqdn, profileUsername: o.profileUsername!, registrantFingerprint: o.registrantFingerprint, createdAt: now, expiresAt: addYears(now, o.years), orderId: o.registrarOrderId, locked: true, nameservers: ["ns1.systemdns.com", "ns2.systemdns.com", "ns3.systemdns.com"], foreign: false });
      this.upstream.registerApplied++;
    } else if (o.type === "renew") {
      const dom = this.domains.get(o.fqdn)!;
      dom.expiresAt = addYears(dom.expiresAt, o.years);
      this.upstream.renewApplied++;
    }
  }
}
