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
  /** Phase 3 additions (all optional so Phase 2 callers compile unchanged). */
  /** SHA-256 hex of the lower-cased owner email; the detector compares hashes and never sees the address. */
  ownerEmailHash?: string;
  /** OpenSRS `let_expire` flag (separate from auto_renew). */
  letExpire?: boolean;
  /** `transfer_away_in_progress` from `GET type=status`. */
  transferAwayInProgress?: boolean;
  /** True when the paid WHOIS/contact privacy service is switched on (the product does not sell it, so a change is worth noticing). */
  privacyServiceEnabled?: boolean;
}

export interface UpstreamOrder { registrarOrderId: string; fqdn: string; type: "new" | "renew" | "transfer"; status: "pending" | "waiting" | "completed" | "cancelled"; orderDate: Date; profileUsername?: string }

export interface RegistrarCapabilities {
  mode: "mock" | "sandbox" | "live";
  dnsHosting: boolean; dnssec: boolean; webhooks: boolean; idempotentRegister: boolean; sandbox: boolean;
  authCodeModel: "api" | "emailed" | "person";
  restore: Record<string, boolean>;
  funding: boolean; inventory: boolean; events: boolean;
  /** True only when the provider has an API to end a pending outbound transfer. OpenSRS: false (the owner's decline link or Tucows support ends it). */
  cancelTransferAway: boolean;
}

export type Registrant = RegisterRequest["registrant"];

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "MX" | "SRV" | "TXT";
export const DNS_RECORD_TYPES: readonly DnsRecordType[] = ["A", "AAAA", "CNAME", "MX", "SRV", "TXT"];
/** `name` is the label relative to the zone apex ("" is the apex). No TTL and no CAA/NS: OpenSRS SystemDNS has neither (docs/research/reg-opensrs.md 2). */
export interface DnsRecord { type: DnsRecordType; name: string; value: string; priority?: number; weight?: number; port?: number }
export interface DnsZone { hosted: boolean; records: DnsRecord[] }

export interface DsRecord { keyTag: number; algorithm: number; digestType: number; digest: string }

export interface ContactChangeResult {
  /** `pending_approval`: an ICANN Change of Registrant (trade) started and the contact has not changed yet. */
  status: "applied" | "pending_approval";
  /** First name, last name (organization) or email of the registrant changed. */
  registrantChange: boolean;
  /** An email change triggers registrant email verification; failing it suspends the domain. */
  verificationRequired: boolean;
  /** A registrant change starts the 60-day inter-registrar transfer lock unless the registrant opted out. */
  transferLock60d: boolean;
}

export type TransferAwayStatus = "pending_admin" | "pending_owner" | "pending_registry" | "completed" | "cancelled";
export interface TransferAway { fqdn: string; status: TransferAwayStatus; requestedAt: Date; gainingRegistrar?: string }

export interface InventoryRow { fqdn: string; expiresAt: Date }
export interface DeletedDomain { fqdn: string; deletedAt: Date; redemptionEndsAt: Date }
export interface Balance { balance: Money; held: Money; available: Money }


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

  // ---- Phase 3 ----------------------------------------------------------------------------------------------------
  /** `MODIFY data=status lock_state`. Unlocking is the risky direction and is counted by the velocity fuse. */
  setLock(fqdn: string, locked: boolean): Promise<void>;
  /** Refuses (`dnssec_would_break`) when a DS record exists and the target DNS is not signed. */
  setNameservers(fqdn: string, nameservers: string[], opts?: { targetSigned?: boolean }): Promise<void>;
  /**
   * Generates a fresh random code, sets it upstream and returns it ONCE. The port never stores or logs it and never reads a code back
   * (`GET type=domain_auth_info` is not on the allow-list). `SEND_AUTHCODE` is never called.
   */
  issueAuthCode(fqdn: string): Promise<{ code: string; issuedAt: Date }>;
  /** Sets a new random code nobody sees (re-lock, the 24-hour re-randomise, Stop). */
  rerandomizeAuthCode(fqdn: string): Promise<void>;
  /** Reads the zone. `hosted` is false when the nameservers are not the provider's (SystemDNS): the DNS tab is then read-only. */
  getDns(fqdn: string): Promise<DnsZone>;
  /**
   * Replaces the whole zone with `records`, correct whether the provider overwrites the whole zone or only the types it is sent:
   * every type is sent, empty ones as empty, then the zone is read back and compared. A mismatch throws `dns_readback_mismatch`.
   * The caller holds the per-domain lock and keeps the pre-write snapshot.
   */
  replaceZone(fqdn: string, records: DnsRecord[]): Promise<{ hash: string; records: DnsRecord[] }>;
  getDs(fqdn: string): Promise<DsRecord[]>;
  addDs(fqdn: string, ds: DsRecord): Promise<void>;
  removeDs(fqdn: string, ds: DsRecord): Promise<void>;
  /** Changes the owner contact. A registrant change is reported, never hidden (C-07). */
  updateContact(fqdn: string, registrant: Registrant): Promise<ContactChangeResult>;
  /** `GET_TRANSFERS_AWAY`; the hostile-transfer poll asks for pending statuses only. */
  getTransfersAway(opts?: { statuses?: TransferAwayStatus[]; since?: Date }): Promise<TransferAway[]>;
  /** Cancels a transfer-in the reseller started (`CANCEL_TRANSFER`). There is no such call for outbound transfers. */
  cancelTransfer(fqdn: string): Promise<{ cancelled: boolean }>;
  /** "Stop": re-locks and re-randomises the code. A pending outbound transfer is NOT ended by this; `pendingTransferRemains` says so. */
  stopTransferAway(fqdn: string): Promise<{ relocked: true; codeRerandomized: true; pendingTransferRemains: boolean }>;
  /** Forces `auto_renew` (and sends `let_expire=0` explicitly). Renewal is driven by Mosshatch, so callers normally pass false. */
  setAutoRenew(fqdn: string, enabled: boolean): Promise<void>;
  /** Inventory for the unattributed-change detector; `cursor` is opaque. */
  listDomains(opts?: { cursor?: string; limit?: number }): Promise<{ rows: InventoryRow[]; next?: string }>;
  /** Names in redemption (`GET_DELETED_DOMAINS`); `getDomain` returns null for them. */
  getDeletedDomains(): Promise<DeletedDomain[]>;
  /** Redemption restore (`REDEEM`); only extensions with `capabilities().restore[tld]`. */
  restore(fqdn: string): Promise<{ status: "restored" | "accepted_pending"; registrarOrderId?: string }>;
  /** `GET_BALANCE`. `getFundingStatus()` is `available`. */
  getBalance(): Promise<Balance>;
}
