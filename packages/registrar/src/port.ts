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

/** Provider operation support, not proof of the DS currently published by the parent zone. */
export interface DnssecCapabilities {
  supported: boolean;
  addMode: "ds" | "dnskey" | "unsupported";
  removeSupported: boolean;
  managedSigning: boolean;
}

export type Registrant = RegisterRequest["registrant"];

/** Upstream record types are open-ended; unsupported types remain visible and immutable. */
export type DnsRecordType = string;
/** Types currently editable through the shared DNS policy. This is not an upstream inventory filter. */
export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "SRV", "TXT"] as const;
/** `name` is relative to the zone apex ("" is the apex). Opaque RDATA keeps its exact case and whitespace. */
export interface DnsRecord { type: DnsRecordType; name: string; value: string; priority?: number; weight?: number; port?: number; ttl?: number }
/** Complete user-managed inventory. Registrar-generated apex SOA/NS stay under provider control. */
export interface DnsZone { hosted: boolean; records: DnsRecord[]; defaultTtl?: number }

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

// ---- Phase 5: transfer-in (Rescue) -------------------------------------------------------------------------------------
/**
 * Upstream transfer-in statuses (OpenSRS `CHECK_TRANSFER check_status=1`: pending_owner, pending_admin (deprecated), pending_registry,
 * completed, cancelled, undef). `pending_admin` is folded into `pending_owner`; `undef` is reported as `null` by `getTransferInStatus`.
 */
export type TransferInStatus = "pending_owner" | "pending_registry" | "completed" | "cancelled";
/** Why a name cannot be transferred in right now (pre-check), each with a plain message in the app. */
export type TransferInBlock =
  | "not_registered" | "already_here" | "locked_at_losing" | "registry_lock" | "too_new" | "recently_transferred" | "pending_transfer"
  | "redemption" | "pending_delete" | "dispute" | "other";
/** Transfer Policy I.A.3.7 (may deny) and I.A.3.8 (must deny) reasons a losing registrar gives in a NACK. */
export const TRANSFER_DENIAL_REASONS = [
  "fraud", "identity_dispute", "non_payment", "owner_objection", "within_60_days_creation", "within_60_days_transfer",
  "udrp", "urs", "court_order", "tdrp", "cor_lock",
] as const;
export type TransferDenialReason = (typeof TRANSFER_DENIAL_REASONS)[number] | "unstated";
/** Why a submitted transfer-in ended without completing. */
export type TransferInFailure =
  | "invalid_auth_code" | "owner_declined" | "owner_timeout" | "nack" | "registry_lock" | "locked_at_losing" | "cancelled_by_us" | "unknown";

export interface TransferInCheck {
  fqdn: string;
  transferable: boolean;
  reason?: TransferInBlock;
  /** When the 60-day rule lifts (registry creation or last transfer plus 60 days), when the adapter knows the dates. */
  transferableAt?: Date;
  createdAt?: Date;
  lastTransferAt?: Date;
  expiresAt?: Date;
  registryStatuses: string[];
  /** DS records at the registry. `undefined` when the adapter cannot tell (OpenSRS CHECK_TRANSFER does not say; RDAP does). */
  dsPresent?: boolean;
}
export interface TransferInRequest {
  fqdn: string;
  /** Years the transfer adds (1 for gTLDs and .io, 2 for .ai); always sent explicitly. */
  years: number;
  /** The authorization code from the losing registrar. The port sends it once and keeps nothing. */
  authCode: string;
  regUsername: string;
  regPassword: string;
  registrant: Registrant;
}
export interface TransferInStart { status: Exclude<TransferInStatus, "completed" | "cancelled">; registrarOrderId: string; ownerEmailSent: boolean }
export interface TransferInState {
  fqdn: string;
  status: TransferInStatus;
  registrarOrderId?: string;
  requestedAt?: Date;
  updatedAt?: Date;
  failure?: TransferInFailure;
  nackReason?: TransferDenialReason;
  /** pending_owner: the owner confirms by the emailed link before this, or the provider cancels. */
  ownerDeadlineAt?: Date;
  /** pending_registry: the losing registrar answers before this, or the registry acknowledges automatically. */
  registryDeadlineAt?: Date;
  /** Registry expiry after completion. */
  expiresAt?: Date;
}


export interface RegistrarPort {
  capabilities(): RegistrarCapabilities;
  health(): Promise<{ status: "ok" | "degraded" | "maintenance"; maintenanceUntil?: Date }>;
  checkAvailability(fqdn: string, opts?: { noCache?: boolean }): Promise<Availability>;
  quote(fqdn: string, years: number, kind?: "register" | "renew" | "transfer"): Promise<Quote>;
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
  /** A caller assertion cannot prove destination DNSSEC compatibility. Signed transitions fail closed. */
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
   * unchanged upstream records and TTLs are preserved; unsupported edits fail closed. The zone is read back and compared.
   * expectedHash is checked immediately before writing, but is not upstream compare-and-swap. Errors after a write may have
   * partial effects and carry outcomeUnknown=true: reconcile read-only, never automatically retry or restore a snapshot.
   * The caller holds the per-domain lock and durably records the intent and pre-write snapshot before calling.
   */
  replaceZone(fqdn: string, records: DnsRecord[], opts?: { expectedHash?: string }): Promise<{ hash: string; records: DnsRecord[] }>;
  getDs(fqdn: string): Promise<DsRecord[]>;
  getDnssecCapabilities?(fqdn: string): Promise<DnssecCapabilities>;
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

  // ---- Phase 5: transfer-in ---------------------------------------------------------------------------------------
  /** Pre-transfer check (`CHECK_TRANSFER`): whether the name can be transferred in now, and why not. Sends no code. */
  checkTransferIn(fqdn: string): Promise<TransferInCheck>;
  /**
   * Starts a transfer-in as the gaining registrar (`SW_REGISTER reg_type=transfer` with `auth_info`). Returns only after the provider accepted
   * the order; the transfer is NOT complete until `getTransferInStatus` says `completed`. A timeout after sending is `outcomeUnknown`: poll, never resend.
   */
  startTransferIn(req: TransferInRequest): Promise<TransferInStart>;
  /** `CHECK_TRANSFER check_status=1` for a transfer this reseller started; null when the provider knows none (`undef`). */
  getTransferInStatus(fqdn: string): Promise<TransferInState | null>;
  /** `CANCEL_TRANSFER` for a pending transfer-in this reseller started. False when it can no longer be cancelled. */
  cancelTransferIn(fqdn: string): Promise<{ cancelled: boolean }>;
}
