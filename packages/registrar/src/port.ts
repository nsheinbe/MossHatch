/**
 * The registrar port: a superset of the brief's sketch (plan 4.3b, "RegistrarAdapter: what the sketched interface is missing").
 * Money is bigint minor units with a source label; nothing here uses floating point.
 */
export type Currency = "usd";
export interface Money { minor: bigint; currency: Currency; source: "live" | "sample" }

export type AvailabilityKind = "available" | "taken" | "premium" | "reserved" | "unknown";
export interface Availability { fqdn: string; kind: AvailabilityKind; source: "live" | "sample"; checkedAt: Date }

export interface Quote {
  fqdn: string;
  tld: string;
  years: number;
  /** Wholesale cost for the whole term, from the effective-dated price table (never from the client). */
  wholesale: Money;
  renewalWholesale: Money;
  isRegistryPremium: boolean;
  quotedAt: Date;
}

export type RegistrarErrorKind = "maintenance" | "unavailable" | "insufficient_funds" | "rate_limited" | "rejected" | "unknown";
export class RegistrarError extends Error {
  constructor(public kind: RegistrarErrorKind, message: string, public opts: { retryable: boolean; outcomeUnknown: boolean; code?: string }) { super(message); this.name = "RegistrarError"; }
  get retryable() { return this.opts.retryable; }
  /** True when the request was sent and the answer was not seen: the caller must reconcile by polling, never resend. */
  get outcomeUnknown() { return this.opts.outcomeUnknown; }
  get code() { return this.opts.code; }
}

export interface RegisterRequest {
  fqdn: string;
  years: number;
  /** The per-order profile username generated before the call and stored on the order (the claim rule keys on it). */
  regUsername: string;
  regPassword: string;
  registrant: { name: string; email: string; phone: string; street: string; city: string; region: string; postalCode: string; country: string };
}

export type RegisterResult =
  | { status: "registered"; registrarOrderId: string; expiresAt: Date }
  | { status: "accepted_pending"; registrarOrderId: string; reason: "forced_pending" | "async" };

export interface DomainStatus {
  fqdn: string;
  state: "active" | "pending" | "expired" | "redemption" | "pending_delete" | "transferring_out" | "unknown";
  registryStatuses: string[];
  expiresAt?: Date;
  locked: boolean;
  nameservers: string[];
  autoRenew: boolean;
  privacyStatus: "redacted_default" | "not_available" | "exposed";
  dsPresent: boolean;
  /** The profile username that owns the domain upstream, when known (used to claim an order as ours). */
  profileUsername?: string;
  registrarOrderId?: string;
  createdAt?: Date;
}

export interface UpstreamOrder { registrarOrderId: string; fqdn: string; type: "new" | "renew" | "transfer"; status: "pending" | "waiting" | "completed" | "cancelled"; orderDate: Date; profileUsername?: string }

export interface RegistrarCapabilities {
  mode: "mock" | "sandbox" | "live";
  dnsHosting: boolean; dnssec: boolean; webhooks: boolean; idempotentRegister: boolean; sandbox: boolean;
  authCodeModel: "api" | "emailed" | "person";
  restore: Record<string, boolean>;
  funding: boolean; inventory: boolean; events: boolean;
}

export interface RegistrarPort {
  capabilities(): RegistrarCapabilities;
  health(): Promise<{ status: "ok" | "degraded" | "maintenance"; maintenanceUntil?: Date }>;
  checkAvailability(fqdn: string, opts?: { noCache?: boolean }): Promise<Availability>;
  quote(fqdn: string, years: number, kind?: "register" | "renew"): Promise<Quote>;
  register(req: RegisterRequest): Promise<RegisterResult>;
  renew(fqdn: string, years: number, currentExpiryYear: number): Promise<{ status: "renewed" | "accepted_pending"; registrarOrderId: string; expiresAt?: Date }>;
  getDomain(fqdn: string): Promise<DomainStatus | null>;
  /** Provider order lookup by domain (OpenSRS filters by domain, date, status and type only). */
  getOrdersByDomain(fqdn: string): Promise<UpstreamOrder[]>;
  /** Cancel a pending or waiting upstream order (PROCESS_PENDING cancel). */
  cancelPendingOrder(registrarOrderId: string): Promise<{ cancelled: boolean }>;
  getFundingStatus(): Promise<Money | "unsupported">;
  /** Lock, nameservers, restore, transfer, DNS and DNSSEC methods arrive in Phase 3 and 5; the contract test suite grows with them. */
}
