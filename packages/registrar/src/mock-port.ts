import { createHash } from "node:crypto";
import { fnv1a } from "@mosshatch/core";
import {
  DNS_RECORD_TYPES, RegistrarError,
  type Availability, type AvailabilityKind, type Balance, type ContactChangeResult, type DeletedDomain, type DnsRecord, type DnsRecordType, type DnsZone, type DomainStatus,
  type DsRecord, type InventoryRow, type Money, type Quote, type Registrant, type RegisterRequest, type RegisterResult,
  type RegistrarCapabilities, type RegistrarPort, type TransferAway, type TransferAwayStatus, type UpstreamOrder,
  type TransferDenialReason, type TransferInCheck, type TransferInFailure, type TransferInRequest, type TransferInStart, type TransferInState, type TransferInStatus,
} from "./port.ts";
import { randomAuthCode } from "./authcode.ts";
import { canonicalZone, validateZone, zoneHash } from "./dns.ts";
import { registrantFingerprint } from "./claim.ts";
import { SAMPLE_WHOLESALE_CENTS } from "./mock.ts";

export { claimRegistration, registrantFingerprint, CLAIM_SKEW_MS, type ClaimResult } from "./claim.ts";

/**
 * MockRegistrarPort: the Phase 2 in-memory registrar, profile `mock:opensrs` (plan 4.3b "MockRegistrar rules").
 * It reproduces OpenSRS constraints so the app cannot lean on features the real provider lacks. Every Money and
 * Availability it returns carries `source: 'sample'`. State changes only through adapter methods and the injectable
 * clock (`advance`), never through timers. The Phase 1 `MockRegistrar` (UI sample prices) is a separate class.
 */

/** Days after expiry until the name is deleted into redemption, and the redemption length (TLD chart: grace 40, redemption 30 for all six; docs/research/reg-opensrs.md 6). */
export const GRACE_DAYS = 40;
export const REDEMPTION_DAYS = 30;
const DAY = 86_400_000;
export type DnsOverwriteMode = "whole_zone" | "per_type";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const emailHash = (email: string) => sha(email.trim().toLowerCase());

export const MOCK_EXTENSIONS = ["com", "ai", "dev", "io", "app", "studio"] as const;
const MIN_TERM: Record<string, number> = { ai: 2 };
const MAX_TERM = 10;
/** OpenSRS serves `LOOKUP` from its cache unless `no_cache=1`; the mock keeps a result for five minutes. */
export const LOOKUP_CACHE_MS = 5 * 60_000;
/** How long an `async250` order stays `waiting` before it completes on the clock. */
export const ASYNC_COMPLETE_MS = 60_000;

export type FaultName =
  | "timeoutAfterAccept" | "workerDeath" | "duplicateSubmit" | "sameNameTwoUsers" | "insufficientFunds" | "async250"
  | "registryMaintenance" | "renewDraft" | "defaultPeriod2" | "rateLimited" | "unknownAvailability"
  /** Like insufficientFunds but only `releasePending` or `processPending` completes the order (OpenSRS `forced_pending`). */
  | "forcedPending"
  /** The zone write is accepted and silently dropped, so only the read-back can notice. */
  | "dnsWriteIgnored";
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
  dnsOverwrite: DnsOverwriteMode;
  dnsTtl: false;
  dnsCaa: false;
  minTermYears: Record<string, number>;
  maxTermYears: number;
  outboundTransfer: "emailed_approval";
  authCodeOverrides: Record<string, "person">;
  registerPeriodDefault: 2;
}

export interface MockUpstreamOrder extends UpstreamOrder { registrant?: Registrant; years: number; registrantFingerprint: string; costMinor: bigint; pendingReason?: "forced_pending" | "async"; completeAt?: Date }
interface MockDomain {
  fqdn: string; profileUsername: string; registrantFingerprint: string; createdAt: Date; expiresAt: Date; orderId: string; locked: boolean; nameservers: string[]; foreign: boolean;
  registrant?: Registrant; pendingRegistrant?: Registrant;
  autoRenew: boolean; letExpire: boolean; privacy?: "redacted_default" | "exposed"; privacyService?: boolean;
  ds: DsRecord[]; zone: Map<DnsRecordType, DnsRecord[]>; authHash?: string;
  /** Set when the name arrived by transfer-in (the 60-day rule counts from it). */
  lastTransferAt?: Date;
}

// ---- Phase 5: transfer-in simulator (Horizon cannot run a transfer: "You cannot transfer domains in Horizon", KB 201000063316) ----
/** OpenSRS cancels a transfer the owner has not confirmed within five days (check_transfer, S20; KB 201000063138). */
export const TRANSFER_OWNER_WINDOW_MS = 5 * 86_400_000;
/** OpenSRS review before the request reaches the registry: "typically takes 24 to 48 hours" (K5). The mock uses the short end. */
export const TRANSFER_REVIEW_MS = 24 * 3_600_000;
/** The registry's pending window: silence from the losing registrar for five days acknowledges the transfer (Transfer Policy I.A.3.5-3.6). */
export const TRANSFER_REGISTRY_WINDOW_MS = 5 * 86_400_000;
/** Transfer Policy I.A.3.7.5 / 3.7.6 and the registry rule: no transfer within 60 days of creation or of a prior transfer (OpenSRS error 552). */
export const TRANSFER_LOCK_MS = 60 * 86_400_000;
/** Years a transfer adds: one for the gTLDs and .io, two for .ai ("Domain Transfer: 2 years renewal", K12). */
export const TRANSFER_YEARS: Record<string, number> = { com: 1, dev: 1, app: 1, studio: 1, io: 1, ai: 2 };

/** A name registered at ANOTHER registrar, which this reseller can try to transfer in. */
export interface ForeignSeed {
  authCode: string;
  createdAt?: Date;
  lastTransferAt?: Date;
  expiresAt?: Date;
  /** clientTransferProhibited at the losing registrar. */
  locked?: boolean;
  /** serverTransferProhibited: a registry lock only the losing registrar can ask to lift. */
  registryLock?: boolean;
  dsPresent?: boolean;
  /** RGP states and an open UDRP (a must-deny, I.A.3.8). */
  status?: "active" | "redemption" | "pending_delete" | "udrp";
  nameservers?: string[];
  /** What the owner does with the approval email when one is sent. Default: confirms after an hour. */
  owner?: "confirm" | "decline" | "silent";
  /** What the losing registrar does in the registry window. Default: silence (auto-ACK after five days). */
  losing?: "ack" | "silent" | { nack: TransferDenialReason };
}
interface MockForeign extends Required<Pick<ForeignSeed, "owner" | "losing">> {
  fqdn: string; authHash: string; createdAt: Date; lastTransferAt?: Date; expiresAt: Date; locked: boolean; registryLock: boolean; dsPresent: boolean;
  status: NonNullable<ForeignSeed["status"]>; nameservers: string[];
}
interface MockTransferIn {
  fqdn: string; orderId: string; status: TransferInStatus; failure?: TransferInFailure; nackReason?: TransferDenialReason;
  requestedAt: Date; updatedAt: Date; ownerDeadlineAt?: Date; ownerActAt?: Date; reviewAt?: Date; registrySentAt?: Date; registryDeadlineAt?: Date;
  years: number; regUsername: string; registrant: Registrant; fingerprint: string; authHash: string; costMinor: bigint;
}
/** How the provider treats `auth_info` sent with the API order. The API reference: "If provided and valid, the transfer will not send an approval
 * email" (S15); KB 201000063138: "The RWI is the only interface that lets you supply the authorization code with the order itself". Unresolved, so both. */
export type TransferOwnerStep = "skipped_with_code" | "always_email";
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
  private deleted: DeletedDomain[] = [];
  private transfersAway: TransferAway[] = [];
  private transfersIn = new Set<string>();
  private foreign = new Map<string, MockForeign>();
  private inbound: MockTransferIn[] = [];
  /** Owner-approval emails the provider "sent" (the mock sends nothing): one per transfer that needed one. */
  readonly ownerApprovalEmails: { fqdn: string; at: Date }[] = [];
  transferOwnerStep: TransferOwnerStep = "skipped_with_code";
  readonly dnsOverwrite: DnsOverwriteMode;

  /** Call counters, by adapter method: `calls.register` is the number of times the caller invoked it. */
  readonly calls = { checkAvailability: 0, checkAvailabilityNoCache: 0, quote: 0, register: 0, renew: 0, getDomain: 0, getOrdersByDomain: 0, cancelPendingOrder: 0, getFundingStatus: 0, health: 0,
    setLock: 0, setNameservers: 0, issueAuthCode: 0, rerandomizeAuthCode: 0, getDns: 0, replaceZone: 0, getDs: 0, addDs: 0, removeDs: 0, updateContact: 0,
    getTransfersAway: 0, cancelTransfer: 0, stopTransferAway: 0, setAutoRenew: 0, listDomains: 0, getDeletedDomains: 0, restore: 0, getBalance: 0,
    checkTransferIn: 0, startTransferIn: 0, getTransferInStatus: 0, cancelTransferIn: 0 };
  /** What actually reached the upstream (differs from `calls` under `duplicateSubmit`). */
  readonly upstream = { registerSubmissions: 0, registerApplied: 0, renewApplied: 0, duplicateRejected: 0 };
  /** Every debit of the funding balance, in order. */
  readonly debits: { orderId: string; minor: bigint }[] = [];
  /** Funds returned to the balance (a transfer-in that failed after its funds were taken). */
  readonly credits: { orderId: string; minor: bigint }[] = [];

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

  constructor(opts: { clock?: MockClock; funding?: bigint; wholesalePerYear?: Record<string, bigint>; dnsOverwrite?: DnsOverwriteMode } = {}) {
    this.clock = opts.clock ?? new ManualClock();
    this.dnsOverwrite = opts.dnsOverwrite ?? "whole_zone";
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
    for (const [f, d] of [...this.domains]) { // expiry -> grace -> deleted (redemption) -> gone
      if (d.foreign || d.expiresAt.getTime() + GRACE_DAYS * DAY > now) continue;
      const deletedAt = new Date(d.expiresAt.getTime() + GRACE_DAYS * DAY);
      this.domains.delete(f); this.deleted.push({ fqdn: f, deletedAt, redemptionEndsAt: new Date(deletedAt.getTime() + REDEMPTION_DAYS * DAY) });
    }
    this.deleted = this.deleted.filter((x) => x.redemptionEndsAt.getTime() > now);
    for (const o of this.orderList) {
      if (o.status === "waiting" && o.completeAt && o.completeAt.getTime() <= now) this.complete(o);
    }
    this.tickTransfersIn();
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
    this.domains.set(d, { fqdn: d, profileUsername: `other-${id}`, registrantFingerprint: "someone else", createdAt: now, expiresAt: addYears(now, years), orderId: id, locked: true, nameservers: [], foreign: true, autoRenew: false, letExpire: false, ds: [], zone: new Map() });
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
      funding: true, inventory: true, events: false, cancelTransferAway: false,
      lookupBatchSize: 1, idempotencyKey: false, dnsMode: "replace_all", dnsOverwrite: this.dnsOverwrite, dnsTtl: false, dnsCaa: false,
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
    if (this.consumeFault("insufficientFunds", d) || this.consumeFault("forcedPending", d) || this.balance < cost) { order.pendingReason = "forced_pending"; return { status: "accepted_pending" as const, registrarOrderId: id }; }
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
    const away = this.transfersAway.some((t) => t.fqdn === d && (t.status === "pending_admin" || t.status === "pending_owner" || t.status === "pending_registry"));
    const noPrivacy = this.tldOf(d) === "ai" || this.tldOf(d) === "io";
    return {
      fqdn: d, state: away ? "transferring_out" : expired ? "expired" : "active", registryStatuses: dom.locked ? ["clientTransferProhibited"] : ["ok"], expiresAt: new Date(dom.expiresAt),
      locked: dom.locked, nameservers: [...dom.nameservers], autoRenew: dom.autoRenew, privacyStatus: noPrivacy ? "not_available" : (dom.privacy ?? "redacted_default"),
      dsPresent: dom.ds.length > 0, profileUsername: dom.profileUsername, registrarOrderId: dom.orderId, createdAt: new Date(dom.createdAt),
      ...(dom.registrant ? { ownerEmailHash: emailHash(dom.registrant.email) } : {}), letExpire: dom.letExpire, transferAwayInProgress: away, privacyServiceEnabled: dom.privacyService ?? false,
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


  // ---- Phase 3 methods -------------------------------------------------------------------------------------------
  private own(fqdn: string): MockDomain {
    const d = fqdn.trim().toLowerCase(); this.tldOf(d); this.guardCall(d);
    const dom = this.domains.get(d);
    if (!dom || dom.foreign) throw rejected("not_found", "domain not found");
    return dom;
  }
  private afterWrite(d: string) {
    if (this.consumeFault("workerDeath", d)) throw new DeathSignal("register", d);
    if (this.consumeFault("timeoutAfterAccept", d)) throw new RegistrarError("unknown", "request timed out after submit", { retryable: false, outcomeUnknown: true, code: "timeout" });
  }

  async setLock(fqdn: string, locked: boolean): Promise<void> {
    this.calls.setLock++; this.tick();
    const dom = this.own(fqdn); dom.locked = locked; this.afterWrite(dom.fqdn);
  }
  async setNameservers(fqdn: string, nameservers: string[], opts: { targetSigned?: boolean } = {}): Promise<void> {
    this.calls.setNameservers++; this.tick();
    const dom = this.own(fqdn);
    if (nameservers.length < 2 || nameservers.length > 13 || nameservers.some((n) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(n))) throw rejected("bad_nameservers", "2 to 13 valid hostnames are required");
    void opts;
    if (dom.ds.length > 0) throw rejected("dnssec_would_break", "DNSSEC transition has not been verified");
    dom.nameservers = nameservers.map((n) => n.toLowerCase()); this.afterWrite(dom.fqdn);
  }
  async getDnssecCapabilities(fqdn: string) {
    const supported = this.tldOf(fqdn) !== "io";
    return { supported, addMode: supported ? "ds" as const : "unsupported" as const, removeSupported: supported, managedSigning: false };
  }
  async issueAuthCode(fqdn: string): Promise<{ code: string; issuedAt: Date }> {
    this.calls.issueAuthCode++; this.tick();
    const dom = this.own(fqdn);
    if (this.tldOf(dom.fqdn) === "io") throw rejected("code_by_support", ".io codes are set by OpenSRS support (auth code model: person)");
    const code = randomAuthCode(); dom.authHash = sha(code);
    this.afterWrite(dom.fqdn); // a timeout here happens after the code is set and must not leak it
    return { code, issuedAt: this.clock.now() };
  }
  async rerandomizeAuthCode(fqdn: string): Promise<void> {
    this.calls.rerandomizeAuthCode++; this.tick();
    const dom = this.own(fqdn);
    if (this.tldOf(dom.fqdn) === "io") throw rejected("code_by_support", ".io codes are set by OpenSRS support");
    dom.authHash = sha(randomAuthCode()); this.afterWrite(dom.fqdn);
  }
  /** Test inspection: does this code match what is set upstream? The mock keeps only a hash. */
  authCodeMatches(fqdn: string, code: string): boolean { const d = this.domains.get(fqdn.toLowerCase()); return !!d?.authHash && d.authHash === sha(code); }
  /** What the Horizon fake sends through: the caller (the adapter) generated the code, the upstream stores it. */
  setAuthInfo(fqdn: string, code: string): void { const dom = this.own(fqdn); dom.authHash = sha(code); }

  private hosted(dom: MockDomain) { return dom.nameservers.length > 0 && dom.nameservers.every((n) => n.endsWith(".systemdns.com")); }
  async getDns(fqdn: string): Promise<DnsZone> {
    this.calls.getDns++; this.tick();
    const dom = this.own(fqdn);
    if (!this.hosted(dom)) return { hosted: false, records: [] };
    return { hosted: true, records: canonicalZone([...dom.zone.values()].flat()) };
  }
  /** SET_DNS_ZONE as the upstream applies it: types present in the payload are replaced; under `whole_zone` all other types are cleared too. */
  rawSetZone(fqdn: string, payload: Partial<Record<DnsRecordType, DnsRecord[]>>): void {
    const dom = this.own(fqdn);
    if (!this.hosted(dom)) throw rejected("dns_not_hosted", "nameservers are not SystemDNS");
    if (this.consumeFault("dnsWriteIgnored", dom.fqdn)) return;
    if (this.dnsOverwrite === "whole_zone") dom.zone = new Map();
    for (const [t, list] of Object.entries(payload)) if (list) dom.zone.set(t, list.map((r) => ({ ...r })));
  }
  async replaceZone(fqdn: string, records: DnsRecord[], opts?: { expectedHash?: string }): Promise<{ hash: string; records: DnsRecord[] }> {
    this.calls.replaceZone++; this.tick();
    const dom = this.own(fqdn);
    if (!this.hosted(dom)) throw rejected("dns_not_hosted", "nameservers are not SystemDNS");
    const live = canonicalZone([...dom.zone.values()].flat());
    if (opts?.expectedHash !== undefined && opts.expectedHash !== zoneHash(live)) throw rejected("dns_state_changed", "DNS state changed");
    validateZone(records, live);
    const want = canonicalZone(records);
    const payload: Partial<Record<DnsRecordType, DnsRecord[]>> = {};
    for (const t of new Set([...DNS_RECORD_TYPES, ...live.map((r) => r.type)])) payload[t] = want.filter((r) => r.type === t); // every type, empty included: correct under either overwrite mode
    this.rawSetZone(dom.fqdn, payload);
    const back = canonicalZone([...dom.zone.values()].flat());
    if (zoneHash(back) !== zoneHash(want)) throw new RegistrarError("unknown", "the zone read back does not match what was written", { retryable: false, outcomeUnknown: true, code: "dns_readback_mismatch" });
    return { hash: zoneHash(back), records: back };
  }

  async getDs(fqdn: string): Promise<DsRecord[]> { this.calls.getDs++; this.tick(); return this.own(fqdn).ds.map((x) => ({ ...x })); }
  private checkDs(dom: MockDomain, ds: DsRecord) {
    if (this.tldOf(dom.fqdn) === "io") throw rejected("dnssec_unsupported", "DNSSEC is not available for .io");
    if (!Number.isInteger(ds.keyTag) || ds.keyTag < 0 || ds.keyTag > 65535 || !Number.isInteger(ds.algorithm) || !Number.isInteger(ds.digestType) || !/^[0-9a-f]{20,128}$/i.test(ds.digest)) throw rejected("bad_ds", "DS record is malformed");
  }
  private sameDs = (a: DsRecord, b: DsRecord) => a.keyTag === b.keyTag && a.algorithm === b.algorithm && a.digestType === b.digestType && a.digest.toLowerCase() === b.digest.toLowerCase();
  async addDs(fqdn: string, ds: DsRecord): Promise<void> {
    this.calls.addDs++; this.tick(); const dom = this.own(fqdn); this.checkDs(dom, ds);
    if (!dom.ds.some((x) => this.sameDs(x, ds))) dom.ds.push({ ...ds });
    this.afterWrite(dom.fqdn);
  }
  async removeDs(fqdn: string, ds: DsRecord): Promise<void> {
    this.calls.removeDs++; this.tick(); const dom = this.own(fqdn); this.checkDs(dom, ds);
    dom.ds = dom.ds.filter((x) => !this.sameDs(x, ds)); this.afterWrite(dom.fqdn);
  }

  async updateContact(fqdn: string, registrant: Registrant): Promise<ContactChangeResult> {
    this.calls.updateContact++; this.tick();
    const dom = this.own(fqdn); const cur = dom.registrant;
    const lc = (s: string) => s.trim().toLowerCase();
    const nameChanged = !cur || lc(cur.name) !== lc(registrant.name), emailChanged = !cur || lc(cur.email) !== lc(registrant.email);
    const registrantChange = nameChanged || emailChanged;
    if (registrantChange) { dom.pendingRegistrant = { ...registrant }; this.afterWrite(dom.fqdn); return { status: "pending_approval", registrantChange: true, verificationRequired: emailChanged, transferLock60d: true }; }
    dom.registrant = { ...registrant }; this.afterWrite(dom.fqdn);
    return { status: "applied", registrantChange: false, verificationRequired: false, transferLock60d: false };
  }
  /** Both parties approved the trade (or the Designated Agent did): the contact changes. */
  approveContactChange(fqdn: string): void { const dom = this.own(fqdn); if (dom.pendingRegistrant) { dom.registrant = dom.pendingRegistrant; delete dom.pendingRegistrant; } }

  async getTransfersAway(opts: { statuses?: TransferAwayStatus[]; since?: Date } = {}): Promise<TransferAway[]> {
    this.calls.getTransfersAway++; this.tick(); this.guardCall("");
    return this.transfersAway.filter((t) => (!opts.statuses || opts.statuses.includes(t.status)) && (!opts.since || t.requestedAt >= opts.since)).map((t) => ({ ...t }));
  }
  /** Seed a transfer-in this reseller started (Horizon cannot run one; Phase 5 owns the flow). */
  seedTransferIn(fqdn: string) { this.transfersIn.add(fqdn.toLowerCase()); }
  async cancelTransfer(fqdn: string): Promise<{ cancelled: boolean }> {
    this.calls.cancelTransfer++; this.tick(); const d = fqdn.trim().toLowerCase(); this.guardCall(d);
    const live = this.liveInbound(d);
    if (live) { this.endInbound(live, "cancelled_by_us"); this.transfersIn.delete(d); return { cancelled: true }; }
    return { cancelled: this.transfersIn.delete(d) };
  }
  async stopTransferAway(fqdn: string) {
    this.calls.stopTransferAway++;
    await this.setLock(fqdn, true); await this.rerandomizeAuthCode(fqdn).catch((e) => { if (!(e instanceof RegistrarError && e.code === "code_by_support")) throw e; });
    const d = fqdn.trim().toLowerCase();
    return { relocked: true as const, codeRerandomized: true as const, pendingTransferRemains: this.transfersAway.some((t) => t.fqdn === d && t.status.startsWith("pending")) };
  }

  async setAutoRenew(fqdn: string, enabled: boolean): Promise<void> {
    this.calls.setAutoRenew++; this.tick();
    const dom = this.own(fqdn); dom.autoRenew = enabled; dom.letExpire = false; this.afterWrite(dom.fqdn);
  }

  async listDomains(opts: { cursor?: string; limit?: number } = {}): Promise<{ rows: InventoryRow[]; next?: string }> {
    this.calls.listDomains++; this.tick(); this.guardCall("");
    const all = [...this.domains.values()].filter((d) => !d.foreign).sort((a, b) => (a.fqdn < b.fqdn ? -1 : 1));
    const start = opts.cursor ? Number(opts.cursor) : 0; const limit = Math.min(opts.limit ?? 40, 100);
    if (!Number.isInteger(start) || start < 0) throw rejected("bad_cursor", "cursor is not valid");
    const rows = all.slice(start, start + limit).map((d) => ({ fqdn: d.fqdn, expiresAt: new Date(d.expiresAt) }));
    return start + limit < all.length ? { rows, next: String(start + limit) } : { rows };
  }
  async getDeletedDomains(): Promise<DeletedDomain[]> { this.calls.getDeletedDomains++; this.tick(); this.guardCall(""); return this.deleted.map((x) => ({ ...x })); }
  async restore(fqdn: string) {
    this.calls.restore++; this.tick();
    const d = fqdn.trim().toLowerCase(); const tld = this.tldOf(d); this.guardCall(d);
    if (!this.capabilities().restore[tld]) throw rejected("restore_unsupported", `.${tld} restores go through OpenSRS support`);
    const del = this.deleted.find((x) => x.fqdn === d);
    if (!del) throw rejected("not_in_redemption", "domain is not in redemption");
    const fee = this.restorePrice[tld]!;
    const id = this.nextId(); const now = this.clock.now();
    if (this.balance < fee) { this.orderList.push({ registrarOrderId: id, fqdn: d, type: "renew", status: "pending", orderDate: now, years: 1, registrantFingerprint: "", costMinor: fee, pendingReason: "forced_pending" }); return { status: "accepted_pending" as const, registrarOrderId: id }; }
    this.balance -= fee; this.debits.push({ orderId: id, minor: fee });
    this.deleted = this.deleted.filter((x) => x !== del);
    // UNVERIFIED: the docs give the restore fee but not the expiry after a restore; the mock uses one year from now.
    this.domains.set(d, { fqdn: d, profileUsername: "restored", registrantFingerprint: "", createdAt: now, expiresAt: addYears(now, 1), orderId: id, locked: true, nameservers: ["ns1.systemdns.com", "ns2.systemdns.com", "ns3.systemdns.com"], foreign: false, autoRenew: false, letExpire: false, ds: [], zone: new Map() });
    this.orderList.push({ registrarOrderId: id, fqdn: d, type: "renew", status: "completed", orderDate: now, years: 1, registrantFingerprint: "", costMinor: fee });
    return { status: "restored" as const, registrarOrderId: id };
  }
  async getBalance(): Promise<Balance> {
    this.calls.getBalance++; this.tick(); this.guardCall("");
    // The mock does not allocate funds for in-progress orders (OpenSRS does, KB 201000063400): listed in the parity gaps.
    return { balance: sample(this.balance), held: sample(0n), available: sample(this.balance) };
  }
  /** PROCESS_PENDING: complete a forced-pending order now (the caller topped up or an operator released it). */
  releasePending(registrarOrderId: string): boolean {
    const o = this.orderList.find((x) => x.registrarOrderId === registrarOrderId);
    if (!o || o.status !== "pending") return false;
    this.complete(o); return (o.status as string) === "completed";
  }

  /**
   * Out-of-band change simulator for the unattributed-change detector: each method changes upstream state the way a stolen login, a
   * registrant self-service session or a support agent would, without counting as an adapter call and without consuming faults.
   */
  readonly oob = {
    setLock: (fqdn: string, locked: boolean) => { this.mustDomain(fqdn).locked = locked; },
    setNameservers: (fqdn: string, ns: string[]) => { this.mustDomain(fqdn).nameservers = ns.map((n) => n.toLowerCase()); },
    addDs: (fqdn: string, ds: DsRecord) => { this.mustDomain(fqdn).ds.push({ ...ds }); },
    removeAllDs: (fqdn: string) => { this.mustDomain(fqdn).ds = []; },
    changeOwnerEmail: (fqdn: string, email: string) => { const d = this.mustDomain(fqdn); if (d.registrant) d.registrant = { ...d.registrant, email }; },
    setAutoRenew: (fqdn: string, on: boolean) => { this.mustDomain(fqdn).autoRenew = on; },
    letExpire: (fqdn: string, on = true) => { this.mustDomain(fqdn).letExpire = on; },
    setPrivacy: (fqdn: string, state: "redacted_default" | "exposed") => { this.mustDomain(fqdn).privacy = state; },
    setPrivacyService: (fqdn: string, on: boolean) => { this.mustDomain(fqdn).privacyService = on; },
    startTransferAway: (fqdn: string, o: { status?: TransferAwayStatus; gainingRegistrar?: string } = {}) => {
      this.mustDomain(fqdn); this.transfersAway.push({ fqdn: fqdn.toLowerCase(), status: o.status ?? "pending_owner", requestedAt: this.clock.now(), ...(o.gainingRegistrar ? { gainingRegistrar: o.gainingRegistrar } : {}) });
    },
    setTransferAwayStatus: (fqdn: string, status: TransferAwayStatus) => {
      const t = this.transfersAway.find((x) => x.fqdn === fqdn.toLowerCase() && x.status.startsWith("pending")); if (!t) throw new Error("no pending transfer");
      t.status = status; if (status === "completed") this.domains.delete(t.fqdn);
    },
    editZone: (fqdn: string, records: DnsRecord[]) => { const d = this.mustDomain(fqdn); d.zone = new Map(); for (const r of canonicalZone(records)) d.zone.set(r.type, [...(d.zone.get(r.type) ?? []), r]); },
  };
  private mustDomain(fqdn: string): MockDomain { const d = this.domains.get(fqdn.toLowerCase()); if (!d) throw new Error("oob: no such domain"); return d; }

  /** Restore fee table (mock fixture from the rate card in docs/research/reg-opensrs.md). */
  restoreFee(tld: string): bigint | undefined { return this.restorePrice[tld]; }

  // ---- Phase 5: transfer-in ----------------------------------------------------------------------------------------
  /** Test controls for the transfer-in simulator. None of them counts as an adapter call. */
  readonly transferIn = {
    /** A name registered at another registrar, with the code its owner holds. */
    seedForeign: (fqdn: string, o: ForeignSeed): void => {
      const d = fqdn.toLowerCase(); const now = this.clock.now();
      const createdAt = o.createdAt ?? new Date(now.getTime() - 3 * 365 * 86_400_000);
      this.foreign.set(d, {
        fqdn: d, authHash: sha(o.authCode), createdAt, ...(o.lastTransferAt ? { lastTransferAt: o.lastTransferAt } : {}), expiresAt: o.expiresAt ?? addYears(now, 1),
        locked: o.locked ?? false, registryLock: o.registryLock ?? false, dsPresent: o.dsPresent ?? false, status: o.status ?? "active",
        nameservers: o.nameservers ?? ["ns1.elsewhere.example", "ns2.elsewhere.example"], owner: o.owner ?? "confirm", losing: o.losing ?? "silent",
      });
    },
    /** Change what the losing side looks like after the seed (the owner re-locks, the registry locks, a DS record appears). */
    updateForeign: (fqdn: string, patch: Partial<Pick<MockForeign, "locked" | "registryLock" | "dsPresent" | "status" | "owner" | "losing">>): void => {
      const f = this.foreign.get(fqdn.toLowerCase()); if (!f) throw new Error("no such foreign domain"); Object.assign(f, patch);
    },
    ownerConfirm: (fqdn: string): void => { const t = this.liveInbound(fqdn); if (t?.status === "pending_owner") { t.ownerActAt = this.clock.now(); this.foreignOf(t).owner = "confirm"; this.tickTransfersIn(); } },
    ownerDecline: (fqdn: string): void => { const t = this.liveInbound(fqdn); if (t?.status === "pending_owner") this.endInbound(t, "owner_declined"); },
    losingAck: (fqdn: string): void => { const t = this.liveInbound(fqdn); if (t?.status === "pending_registry" && t.registrySentAt) this.completeInbound(t); },
    losingNack: (fqdn: string, reason: TransferDenialReason): void => { const t = this.liveInbound(fqdn); if (t?.status === "pending_registry" && t.registrySentAt) this.endInbound(t, "nack", reason); },
    /** Inspection. */
    list: (): readonly Readonly<MockTransferIn>[] => this.inbound,
    isForeign: (fqdn: string): boolean => this.foreign.has(fqdn.toLowerCase()),
  };
  private foreignOf(t: MockTransferIn): MockForeign { return this.foreign.get(t.fqdn) ?? { fqdn: t.fqdn, authHash: "", createdAt: new Date(0), expiresAt: new Date(0), locked: false, registryLock: false, dsPresent: false, status: "active", nameservers: [], owner: "silent", losing: "silent" }; }
  private liveInbound(fqdn: string): MockTransferIn | undefined { const d = fqdn.toLowerCase(); return this.inbound.find((t) => t.fqdn === d && (t.status === "pending_owner" || t.status === "pending_registry")); }
  private latestInbound(fqdn: string): MockTransferIn | undefined { const d = fqdn.toLowerCase(); return [...this.inbound].reverse().find((t) => t.fqdn === d); }
  private upstreamOf(t: MockTransferIn) { return this.orderList.find((o) => o.registrarOrderId === t.orderId); }
  private endInbound(t: MockTransferIn, failure: TransferInFailure, nack?: TransferDenialReason) {
    t.status = "cancelled"; t.failure = failure; if (nack) t.nackReason = nack; t.updatedAt = this.clock.now();
    const o = this.upstreamOf(t); if (o && o.status !== "cancelled") { o.status = "cancelled"; this.balance += t.costMinor; this.credits.push({ orderId: t.orderId, minor: t.costMinor }); }
  }
  private completeInbound(t: MockTransferIn) {
    const f = this.foreignOf(t); const now = this.clock.now();
    const cap = addYears(now, MAX_TERM);
    const grown = addYears(f.expiresAt, t.years);
    this.domains.set(t.fqdn, {
      fqdn: t.fqdn, profileUsername: t.regUsername, registrantFingerprint: t.fingerprint, createdAt: f.createdAt, expiresAt: grown > cap ? cap : grown, orderId: t.orderId,
      locked: true, nameservers: [...f.nameservers], foreign: false, registrant: { ...t.registrant }, autoRenew: false, letExpire: false,
      ds: f.dsPresent ? [{ keyTag: 12345, algorithm: 13, digestType: 2, digest: "a".repeat(64) }] : [], zone: new Map(), lastTransferAt: now,
    });
    this.foreign.delete(t.fqdn);
    t.status = "completed"; t.updatedAt = now;
    const o = this.upstreamOf(t); if (o) o.status = "completed";
  }
  /** Moves every pending transfer-in along the clock. Called from `tick()`, so every adapter method sees current state. */
  private tickTransfersIn(): void {
    const now = this.clock.now();
    for (const t of this.inbound) {
      if (t.status === "pending_owner") {
        const f = this.foreignOf(t);
        if (f.owner === "decline" && t.ownerActAt && t.ownerActAt <= now) { this.endInbound(t, "owner_declined"); continue; }
        if (f.owner === "confirm" && t.ownerActAt && t.ownerActAt <= now) { t.status = "pending_registry"; t.reviewAt = new Date(t.ownerActAt.getTime() + TRANSFER_REVIEW_MS); t.updatedAt = now; }
        else if (t.ownerDeadlineAt && now >= t.ownerDeadlineAt) { this.endInbound(t, "owner_timeout"); continue; }
      }
      if (t.status === "pending_registry" && !t.registrySentAt && t.reviewAt && now >= t.reviewAt) {
        const f = this.foreignOf(t);
        // The registry checks the code and its own lock when the request arrives; a wrong code ends the transfer at once.
        if (!this.foreign.has(t.fqdn)) { this.endInbound(t, "unknown"); continue; }
        if (f.authHash !== t.authHash) { this.endInbound(t, "invalid_auth_code"); continue; }
        if (f.registryLock) { this.endInbound(t, "registry_lock"); continue; }
        if (f.locked) { this.endInbound(t, "locked_at_losing"); continue; }
        t.registrySentAt = t.reviewAt; t.registryDeadlineAt = new Date(t.reviewAt.getTime() + TRANSFER_REGISTRY_WINDOW_MS); t.updatedAt = now;
        if (typeof f.losing === "object") { this.endInbound(t, "nack", f.losing.nack); continue; }
        if (f.losing === "ack") { this.completeInbound(t); continue; }
      }
      if (t.status === "pending_registry" && t.registryDeadlineAt && now >= t.registryDeadlineAt) this.completeInbound(t);
    }
  }
  private checkOf(d: string): TransferInCheck {
    const now = this.clock.now();
    const ours = this.domains.get(d);
    if (ours) return { fqdn: d, transferable: false, reason: "already_here", registryStatuses: [], ...(ours.foreign ? {} : { createdAt: ours.createdAt }) };
    const f = this.foreign.get(d);
    if (!f) return { fqdn: d, transferable: false, reason: this.classify(d) === "available" ? "not_registered" : "other", registryStatuses: [] };
    const statuses = [...(f.locked ? ["clientTransferProhibited"] : []), ...(f.registryLock ? ["serverTransferProhibited"] : []),
      ...(f.status === "redemption" ? ["redemptionPeriod"] : f.status === "pending_delete" ? ["pendingDelete"] : [])];
    const base = { fqdn: d, createdAt: f.createdAt, expiresAt: f.expiresAt, registryStatuses: statuses, dsPresent: f.dsPresent, ...(f.lastTransferAt ? { lastTransferAt: f.lastTransferAt } : {}) };
    const since = f.lastTransferAt && f.lastTransferAt > f.createdAt ? f.lastTransferAt : f.createdAt;
    const opens = new Date(since.getTime() + TRANSFER_LOCK_MS);
    const block = (reason: TransferInCheck["reason"], extra: Partial<TransferInCheck> = {}): TransferInCheck => ({ ...base, transferable: false, reason, ...extra });
    if (this.liveInbound(d)) return block("pending_transfer");
    if (f.status === "redemption") return block("redemption");
    if (f.status === "pending_delete") return block("pending_delete");
    if (f.status === "udrp") return block("dispute");
    if (now < opens) return block(f.lastTransferAt && f.lastTransferAt > f.createdAt ? "recently_transferred" : "too_new", { transferableAt: opens });
    if (f.registryLock) return block("registry_lock");
    if (f.locked) return block("locked_at_losing");
    return { ...base, transferable: true };
  }
  async checkTransferIn(fqdn: string): Promise<TransferInCheck> {
    this.calls.checkTransferIn++; this.tick();
    const d = fqdn.trim().toLowerCase(); this.tldOf(d); this.guardCall(d);
    return this.checkOf(d);
  }
  async startTransferIn(req: TransferInRequest): Promise<TransferInStart> {
    this.calls.startTransferIn++; this.tick();
    const d = req.fqdn.trim().toLowerCase(); const tld = this.tldOf(d); this.guardCall(d);
    if (req.years === undefined || req.years === null) throw rejected("period_required", "period must be sent explicitly");
    if (req.years !== TRANSFER_YEARS[tld]) throw rejected("invalid_period", `a .${tld} transfer adds ${TRANSFER_YEARS[tld]} years`);
    if (typeof req.authCode !== "string" || req.authCode.length < 6 || req.authCode.length > 64) throw rejected("auth_code_required", "an authorization code is required");
    const chk = this.checkOf(d);
    if (!chk.transferable) {
      const code = chk.reason === "too_new" || chk.reason === "recently_transferred" ? "552" : chk.reason === "pending_transfer" ? "order_exists" : `not_transferable_${chk.reason ?? "other"}`;
      throw rejected(code, "domain is not transferable now");
    }
    const prof = this.profiles.get(req.regUsername);
    if (prof && prof.password !== req.regPassword) throw rejected("profile_exists", "profile username is taken");
    if (req.regUsername.length < 3 || req.regUsername.length > 20 || req.regPassword.length < 10 || req.regPassword.length > 20) throw rejected("bad_profile", "reg_username needs 3 to 20 and reg_password 10 to 20 characters");
    const cost = this.wholesale[tld]! * BigInt(req.years);
    if (this.consumeFault("insufficientFunds", d) || this.balance < cost) throw new RegistrarError("insufficient_funds", "insufficient funds", { retryable: true, outcomeUnknown: false, code: "440" });
    if (!prof) this.profiles.set(req.regUsername, { password: req.regPassword, createdAt: this.clock.now() });
    const id = this.nextId(); const now = this.clock.now();
    // Funds for the added year are taken when the order is placed and returned if the transfer fails.
    this.balance -= cost; this.debits.push({ orderId: id, minor: cost });
    this.orderList.push({ registrarOrderId: id, fqdn: d, type: "transfer", status: "pending", orderDate: now, profileUsername: req.regUsername, years: req.years, registrantFingerprint: registrantFingerprint(req.registrant), costMinor: cost });
    const ownerStep = this.transferOwnerStep === "always_email";
    const f = this.foreign.get(d)!;
    const t: MockTransferIn = {
      fqdn: d, orderId: id, status: ownerStep ? "pending_owner" : "pending_registry", requestedAt: now, updatedAt: now,
      years: req.years, regUsername: req.regUsername, registrant: { ...req.registrant }, fingerprint: registrantFingerprint(req.registrant), authHash: sha(req.authCode), costMinor: cost,
      ...(ownerStep ? { ownerDeadlineAt: new Date(now.getTime() + TRANSFER_OWNER_WINDOW_MS), ...(f.owner === "silent" ? {} : { ownerActAt: new Date(now.getTime() + 3_600_000) }) } : { reviewAt: new Date(now.getTime() + TRANSFER_REVIEW_MS) }),
    };
    this.inbound.push(t);
    if (ownerStep) this.ownerApprovalEmails.push({ fqdn: d, at: now });
    if (this.consumeFault("workerDeath", d)) throw new DeathSignal("register", d);
    if (this.consumeFault("timeoutAfterAccept", d)) throw new RegistrarError("unknown", "request timed out after submit", { retryable: false, outcomeUnknown: true, code: "timeout" });
    return { status: t.status as TransferInStart["status"], registrarOrderId: id, ownerEmailSent: ownerStep };
  }
  async getTransferInStatus(fqdn: string): Promise<TransferInState | null> {
    this.calls.getTransferInStatus++; this.tick();
    const d = fqdn.trim().toLowerCase(); this.tldOf(d); this.guardCall(d);
    const t = this.latestInbound(d);
    if (!t) return null;
    const out: TransferInState = { fqdn: d, status: t.status, registrarOrderId: t.orderId, requestedAt: new Date(t.requestedAt), updatedAt: new Date(t.updatedAt) };
    if (t.failure) out.failure = t.failure;
    if (t.nackReason) out.nackReason = t.nackReason;
    if (t.status === "pending_owner" && t.ownerDeadlineAt) out.ownerDeadlineAt = new Date(t.ownerDeadlineAt);
    if (t.status === "pending_registry" && t.registryDeadlineAt) out.registryDeadlineAt = new Date(t.registryDeadlineAt);
    if (t.status === "completed") { const dom = this.domains.get(d); if (dom) out.expiresAt = new Date(dom.expiresAt); }
    return out;
  }
  async cancelTransferIn(fqdn: string): Promise<{ cancelled: boolean }> {
    this.calls.cancelTransferIn++; this.tick();
    const d = fqdn.trim().toLowerCase(); this.tldOf(d); this.guardCall(d);
    const t = this.liveInbound(d);
    if (!t) return { cancelled: false };
    this.endInbound(t, "cancelled_by_us");
    return { cancelled: true };
  }

  // ---- internals -----------------------------------------------------------------------------------------------
  private nextId() { return `mock-ord-${String(++this.seq).padStart(5, "0")}`; }
  private tldOf(d: string): string {
    const i = d.indexOf(".");
    const tld = i < 0 ? "" : d.slice(i + 1);
    if (!(MOCK_EXTENSIONS as readonly string[]).includes(tld) || i < 1) throw rejected("unsupported_tld", "extension not supported");
    return tld;
  }
  private checkTerm(tld: string, years: number) {
    if (years === undefined || years === null) throw rejected("period_required", "period must be sent explicitly (OpenSRS would default it to 2)");
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
    if (dom || this.foreign.has(d)) return "taken";
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
    const order: MockUpstreamOrder = { registrarOrderId: id, fqdn: d, type: "new", status: "pending", orderDate: now, profileUsername: req.regUsername, years, registrantFingerprint: registrantFingerprint(req.registrant), registrant: { ...req.registrant }, costMinor: cost };
    this.orderList.push(order);
    if (this.faults.has("insufficientFunds", d) || this.faults.has("forcedPending", d) || this.balance < cost) { this.consumeFault("insufficientFunds", d); this.consumeFault("forcedPending", d); order.pendingReason = "forced_pending"; return { status: "accepted_pending", registrarOrderId: id, reason: "forced_pending" }; }
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
      this.domains.set(o.fqdn, { fqdn: o.fqdn, profileUsername: o.profileUsername!, registrantFingerprint: o.registrantFingerprint, createdAt: now, expiresAt: addYears(now, o.years), orderId: o.registrarOrderId, locked: true, nameservers: ["ns1.systemdns.com", "ns2.systemdns.com", "ns3.systemdns.com"], foreign: false,
        registrant: o.registrant, autoRenew: false, letExpire: false, ds: [], zone: new Map() });
      this.upstream.registerApplied++;
    } else if (o.type === "renew") {
      const dom = this.domains.get(o.fqdn)!;
      dom.expiresAt = addYears(dom.expiresAt, o.years);
      this.upstream.renewApplied++;
    }
  }
}
