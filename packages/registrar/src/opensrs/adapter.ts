import { createHash } from "node:crypto";
import {
  DNS_RECORD_TYPES, RegistrarError,
  type Availability, type AvailabilityKind, type Balance, type ContactChangeResult, type DeletedDomain, type DnsRecord, type DnsZone, type DomainStatus,
  type DsRecord, type InventoryRow, type Money, type Quote, type Registrant, type RegisterRequest, type RegisterResult, type RegistrarCapabilities, type RegistrarPort,
  type TransferAway, type TransferAwayStatus, type UpstreamOrder,
  type TransferInBlock, type TransferInCheck, type TransferInFailure, type TransferInRequest, type TransferInStart, type TransferInState, type TransferInStatus,
} from "../port.ts";
import { registrantFingerprint } from "../claim.ts";
import { randomAuthCode } from "../authcode.ts";
import { canonicalZone, validateZone, zoneHash, zonePayload } from "../dns.ts";
import { checkCommand } from "./allowlist.ts";
import { readSwitch, VelocityFuse, type AdapterAlert, type CredentialSource, type FuseClass, type KillSwitch } from "./guards.ts";
import { arr, decodeOps, encodeOps, flag, obj, str, type OpsObject, type OpsValue } from "./xml.ts";
import { opsSignature } from "./sign.ts";

/**
 * OpenSRS reseller API adapter, written from docs/research/reg-opensrs.md (and .verify-tech.md) only. NO real Horizon or live response has been
 * seen: every response shape below is the documented one where the dossier gives it, and is marked UNVERIFIED where it comes from memory of
 * the toolkit or is inferred. The unverified list is in the report and in docs/registrar-parity.md territory; do not treat any of it as fact.
 */
export const LIVE_URL = "https://rr-n1-tor.opensrs.net:55443";
export const HORIZON_URL = "https://horizon.opensrs.net:55443";

export interface HttpRequest { url: string; headers: Record<string, string>; body: string; timeoutMs: number }
export interface HttpResponse { status: number; body: string }
/** Injectable so tests never touch the network. A production transport throws on connect errors and on timeouts. */
export interface HttpTransport { post(req: HttpRequest): Promise<HttpResponse> }

export type Deployment = "local" | "preview" | "staging" | "production";
export interface AdapterLogEvent { event: "opensrs_call"; action: string; object: string; write: boolean; httpStatus?: number; responseCode?: number; outcome: "ok" | "error" | "refused" | "transport_error" }

export interface OpenSrsConfig {
  mode: "sandbox" | "live";
  /** The deployment the process runs in. `live` is refused anywhere but production (plan 4.3b environments table). */
  deployment: Deployment;
  credentials: CredentialSource;
  transport: HttpTransport;
  killSwitch: KillSwitch;
  clock?: { now(): Date };
  fuse?: VelocityFuse;
  onAlert?: (a: AdapterAlert) => void;
  /** Structured log sink: action, object, codes only. Never a domain, attribute, body or code value. */
  log?: (e: AdapterLogEvent) => void;
  timeoutMs?: number;
}

const TLD_MIN_TERM: Record<string, number> = { ai: 2 };
const MAX_TERM = 10;
const LAUNCH_TLDS = ["com", "ai", "dev", "io", "app", "studio"];
/** OpenSRS API redemption covers .com .dev .studio only (KB 201000063166); .app .ai .io go through support. */
const RESTORE_TLDS: Record<string, boolean> = { com: true, dev: true, studio: true, ai: false, io: false, app: false };
const NO_PRIVACY_SERVICE = new Set(["ai", "io"]);
const SYSTEMDNS = ["ns1.systemdns.com", "ns2.systemdns.com", "ns3.systemdns.com"];
/** UNVERIFIED: the per-type value key names inside SET_DNS_ZONE / GET_DNS_ZONE records. From toolkit memory, not the dossier; one place to fix after a Horizon test. */
export const DNS_VALUE_KEY: Record<(typeof DNS_RECORD_TYPES)[number], string> = { A: "ip_address", AAAA: "ipv6_address", CNAME: "hostname", MX: "hostname", SRV: "hostname", TXT: "text" };

const err = (kind: RegistrarError["kind"], code: string, o: { retryable?: boolean; outcomeUnknown?: boolean } = {}, message = "registrar request failed") =>
  new RegistrarError(kind, message, { retryable: o.retryable ?? false, outcomeUnknown: o.outcomeUnknown ?? false, code });
const rejected = (code: string) => err("rejected", code, {}, "registrar rejected the request");

/** "14.50" -> 1450n. Refuses anything that is not a plain decimal (no floating point anywhere). */
export function parseMinor(s: string | undefined): bigint {
  const m = /^(\d{1,9})(?:\.(\d{1,4}))?$/.exec((s ?? "").trim());
  if (!m) throw err("unknown", "bad_amount");
  const frac = (m[2] ?? "").padEnd(2, "0");
  if (/[1-9]/.test(frac.slice(2))) throw err("unknown", "bad_amount");
  return BigInt(m[1]!) * 100n + BigInt(frac.slice(0, 2));
}
function parseDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  // UNVERIFIED format: assumed "YYYY-MM-DD HH:MM:SS" in UTC.
  const d = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? s.replace(" ", "T") + "Z" : s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const yn = (b: boolean) => (b ? 1 : 0);

interface Reply { code: number; text: string; attrs: OpsObject; async: boolean }
interface CallOpts { fuse?: FuseClass; okCodes?: number[]; }

export class OpenSrsAdapter implements RegistrarPort {
  private readonly cfg: OpenSrsConfig;
  private readonly clock: { now(): Date };
  private readonly fuse: VelocityFuse;
  private readonly pausedExtensions = new Set<string>();

  constructor(cfg: OpenSrsConfig) {
    if (cfg.mode === "live" && cfg.deployment !== "production") throw err("rejected", "live_outside_production", {}, "live registrar refused outside production");
    this.cfg = cfg;
    this.clock = cfg.clock ?? { now: () => new Date() };
    this.fuse = cfg.fuse ?? new VelocityFuse(this.clock, (a) => this.alert(a));
  }
  private alert(a: AdapterAlert) { this.cfg.onAlert?.(a); }
  /** Operator action after a debit mismatch has been investigated. */
  resumeExtension(tld: string) { this.pausedExtensions.delete(tld); }
  isExtensionPaused(tld: string) { return this.pausedExtensions.has(tld); }

  // ---- transport --------------------------------------------------------------------------------------------------
  private async call(action: string, object: string, attrs: OpsObject, o: CallOpts = {}): Promise<Reply> {
    const log = (e: Omit<AdapterLogEvent, "event" | "action" | "object">) => this.cfg.log?.({ event: "opensrs_call", action, object, ...e });
    let rule;
    try { rule = checkCommand(action, object, attrs); } catch (e) { log({ write: true, outcome: "refused" }); throw e; }
    const sw = await readSwitch(this.cfg.killSwitch);
    if (sw === "all_paused" || (sw === "writes_paused" && rule.write)) {
      this.alert({ kind: "kill_switch_closed", detail: rule.write ? "write" : "read" });
      log({ write: rule.write, outcome: "refused" });
      throw err("unavailable", "kill_switch", { retryable: true }, "registrar calls are paused");
    }
    if (o.fuse) this.fuse.take(o.fuse);
    let cred: { username: string; apiKey: string };
    try { cred = this.cfg.credentials.read(); } catch { cred = { username: "", apiKey: "" }; }
    if (!cred.username || !cred.apiKey) throw err("unavailable", "no_credentials", { retryable: true }, "registrar credentials are not set");
    const xml = encodeOps(action, object, attrs);
    const url = this.cfg.mode === "live" ? LIVE_URL : HORIZON_URL;
    let res: HttpResponse;
    try {
      res = await this.cfg.transport.post({
        url, timeoutMs: this.cfg.timeoutMs ?? 30_000, body: xml,
        headers: { "Content-Type": "text/xml", "X-Username": cred.username, "X-Signature": opsSignature(xml, cred.apiKey) },
      });
    } catch {
      // Sent, answer not seen. For a write the outcome is unknown and the caller must reconcile, never resend (plan rule 1).
      log({ write: rule.write, outcome: "transport_error" });
      throw err(rule.write ? "unknown" : "unavailable", "transport", { retryable: !rule.write, outcomeUnknown: rule.write }, "registrar request did not complete");
    }
    if (res.status === 401) { this.alert({ kind: "auth_failed", detail: "http_401" }); log({ write: rule.write, httpStatus: 401, outcome: "error" }); throw rejected("401"); }
    if (res.status >= 500 || res.status !== 200) { log({ write: rule.write, httpStatus: res.status, outcome: "error" }); throw err(rule.write ? "unknown" : "unavailable", `http_${res.status}`, { retryable: !rule.write, outcomeUnknown: rule.write }); }
    let parsed: OpsObject;
    try { parsed = decodeOps(res.body); } catch { log({ write: rule.write, httpStatus: 200, outcome: "error" }); throw err("unknown", "bad_response", { outcomeUnknown: rule.write }); }
    const code = Number(str(parsed.response_code));
    const reply: Reply = { code, text: "", attrs: obj(parsed.attributes) ?? {}, async: code === 250 };
    log({ write: rule.write, httpStatus: 200, responseCode: code, outcome: (o.okCodes ?? [200, 250]).includes(code) ? "ok" : "error" });
    if (!Number.isFinite(code)) throw err("unknown", "bad_response", { outcomeUnknown: rule.write });
    if ((o.okCodes ?? [200, 250]).includes(code)) return reply;
    throw this.mapError(code, rule.write);
  }

  /** Response-code table from the dossier (S11). Error text is never copied into the error: only the numeric code travels. */
  private mapError(code: number, write: boolean): RegistrarError {
    const c = String(code);
    if (code === 300 || code === 310 || code === 350) return err("rate_limited", c, { retryable: true });
    if (code === 401 || code === 410 || code === 415) { this.alert({ kind: "auth_failed", detail: c }); return err("rejected", c); }
    if (code === 440) return err("insufficient_funds", c);
    if (code === 437 || code === 486 || code === 221) return err("unknown", c, { outcomeUnknown: write }, "an order for this name is already in progress");
    if (code === 705) return err("unknown", c, { outcomeUnknown: write });
    if (code >= 700 && code < 800) return err("unavailable", c, { retryable: true, outcomeUnknown: write });
    return err("rejected", c);
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------
  private tldOf(fqdn: string): string {
    const d = fqdn.trim().toLowerCase(); const i = d.indexOf(".");
    const tld = i < 0 ? "" : d.slice(i + 1);
    if (i < 1 || !LAUNCH_TLDS.includes(tld)) throw rejected("unsupported_tld");
    return tld;
  }
  private norm(fqdn: string): string { const d = fqdn.trim().toLowerCase(); this.tldOf(d); return d; }
  private checkTerm(tld: string, years: number) {
    if (!Number.isInteger(years) || years < (TLD_MIN_TERM[tld] ?? 1) || years > MAX_TERM) throw rejected("invalid_period");
  }
  private money(minor: bigint): Money { return { minor, currency: "usd", source: this.cfg.mode === "live" ? "live" : "sample" }; }
  private checkSales(tld: string) { if (this.pausedExtensions.has(tld)) throw err("rejected", "sales_paused", {}, "sales of this extension are paused"); }

  capabilities(): RegistrarCapabilities {
    return {
      mode: this.cfg.mode, dnsHosting: true, dnssec: false /* fee conflict unanswered (dossier finding 11) */, webhooks: false, idempotentRegister: false,
      sandbox: this.cfg.mode === "sandbox", authCodeModel: "api", restore: { ...RESTORE_TLDS }, funding: true, inventory: true, events: false, cancelTransferAway: false,
    };
  }

  async health() {
    try { await this.call("GET_BALANCE", "BALANCE", {}); return { status: "ok" as const }; }
    catch (e) {
      if (e instanceof RegistrarError && (e.code === "kill_switch" || e.kind === "unavailable" || e.kind === "rate_limited" || e.kind === "unknown")) return { status: "degraded" as const };
      throw e;
    }
  }

  // ---- lookup and price -------------------------------------------------------------------------------------------
  async checkAvailability(fqdn: string, opts: { noCache?: boolean } = {}): Promise<Availability> {
    const d = this.norm(fqdn);
    const attrs: OpsObject = { domain: d }; if (opts.noCache) attrs.no_cache = 1;
    const r = await this.call("LOOKUP", "DOMAIN", attrs, { okCodes: [200, 210, 211, 221] });
    // 210 available, 211 taken (is_success=1), 221 taken with a waiting registration (S11, S12).
    let kind: AvailabilityKind = r.code === 210 ? "available" : r.code === 211 || r.code === 221 ? "taken" : "unknown";
    if (kind === "available" && flag(r.attrs.is_registry_premium)) kind = "premium"; // UNVERIFIED that LOOKUP carries this flag; quote() is authoritative
    return { fqdn: d, kind, source: this.cfg.mode === "live" ? "live" : "sample", checkedAt: this.clock.now() };
  }

  async quote(fqdn: string, years: number, kind: "register" | "renew" | "transfer" = "register"): Promise<Quote> {
    const d = this.norm(fqdn); const tld = this.tldOf(d); this.checkTerm(tld, years);
    const price = async (t: "new" | "renewal" | "transfer") => {
      const r = await this.call("GET_PRICE", "DOMAIN", { domain: d, reg_type: t, period: years });
      // UNVERIFIED: whether `price` is the total for `period` or per year. The dossier says only that it includes the ICANN fee.
      return { minor: parseMinor(str(r.attrs.price)), premium: flag(r.attrs.is_registry_premium) };
    };
    const first = await price(kind === "renew" ? "renewal" : kind === "transfer" ? "transfer" : "new");
    const renewal = kind === "renew" ? first : await price("renewal");
    return { fqdn: d, tld, years, wholesale: this.money(first.minor), renewalWholesale: this.money(renewal.minor), isRegistryPremium: first.premium || renewal.premium, quotedAt: this.clock.now() };
  }

  // ---- register and renew -----------------------------------------------------------------------------------------
  private contactSet(r: Registrant): OpsObject {
    const [first = "", ...rest] = r.name.trim().split(/\s+/);
    // UNVERIFIED attribute names (toolkit memory). Admin/billing/tech mirror the owner: whether they are optional after the ICANN RDP is unverified.
    const c: OpsObject = { first_name: first, last_name: rest.join(" ") || first, org_name: "", address1: r.street, city: r.city, state: r.region, postal_code: r.postalCode, country: r.country, phone: r.phone, email: r.email };
    return { owner: c, admin: { ...c }, billing: { ...c }, tech: { ...c } };
  }

  private async available(): Promise<bigint> { return (await this.getBalance()).balance.minor; }

  /** Compares the upstream debit with the quote after a billed order (plan 4.3b rule 4). Balance deltas are racy with other traffic; a false positive only pauses sales, which is the safe direction. */
  private async debitCheck(tld: string, quoted: bigint, before: bigint) {
    const after = await this.available();
    const diff = before - after - quoted;
    if (diff > 1n || diff < -1n) {
      this.pausedExtensions.add(tld);
      this.alert({ kind: "debit_mismatch", detail: `.${tld}` });
    }
  }

  async register(req: RegisterRequest): Promise<RegisterResult> {
    const d = this.norm(req.fqdn); const tld = this.tldOf(d);
    this.checkTerm(tld, req.years); this.checkSales(tld);
    const q = await this.quote(d, req.years, "register");
    if (q.isRegistryPremium) throw rejected("premium_refused"); // D-031
    const before = await this.available();
    const attrs: OpsObject = {
      domain: d, reg_type: "new", period: req.years, handle: "process", auto_renew: 0, f_lock_domain: 1,
      reg_username: req.regUsername, reg_password: req.regPassword, contact_set: this.contactSet(req.registrant),
      custom_nameservers: 1, nameserver_list: SYSTEMDNS.map((name, i) => ({ sortorder: String(i + 1), name })), custom_tech_contact: 0,
    };
    if (!NO_PRIVACY_SERVICE.has(tld)) attrs.f_whois_privacy = 0;
    const r = await this.call("SW_REGISTER", "DOMAIN", attrs);
    const id = str(r.attrs.id) ?? str(r.attrs.order_id) ?? ""; // UNVERIFIED attribute name
    if (r.async) return { status: "accepted_pending", registrarOrderId: id, reason: "async" };
    if (flag(r.attrs.forced_pending)) return { status: "accepted_pending", registrarOrderId: id, reason: "forced_pending" };
    await this.debitCheck(tld, q.wholesale.minor, before);
    const dom = await this.getDomain(d);
    return { status: "registered", registrarOrderId: id, expiresAt: dom?.expiresAt ?? new Date(0) };
  }

  async renew(fqdn: string, years: number, currentExpiryYear: number) {
    const d = this.norm(fqdn); const tld = this.tldOf(d); this.checkTerm(tld, years); this.checkSales(tld);
    const q = await this.quote(d, years, "renew");
    const before = await this.available();
    const r = await this.call("RENEW", "DOMAIN", { domain: d, currentexpirationyear: currentExpiryYear, period: years, handle: "process" });
    const id = str(r.attrs.order_id) ?? str(r.attrs.id) ?? "";
    if (r.async || flag(r.attrs.forced_pending)) return { status: "accepted_pending" as const, registrarOrderId: id };
    await this.debitCheck(tld, q.wholesale.minor, before);
    const dom = await this.getDomain(d);
    return { status: "renewed" as const, registrarOrderId: id, ...(dom?.expiresAt ? { expiresAt: dom.expiresAt } : {}) };
  }

  // ---- reads ------------------------------------------------------------------------------------------------------
  private ownerOf(attrs: OpsObject): Registrant | undefined {
    const o = obj(obj(attrs.contact_set)?.owner); if (!o) return undefined;
    const g = (k: string) => str(o[k]) ?? "";
    return { name: `${g("first_name")} ${g("last_name")}`.trim(), email: g("email"), phone: g("phone"), street: g("address1"), city: g("city"), region: g("state"), postalCode: g("postal_code"), country: g("country") };
  }

  async getDomain(fqdn: string): Promise<DomainStatus | null> {
    const d = this.norm(fqdn); const tld = this.tldOf(d);
    // GET returns nothing once a name is deleted (redemption and after); 480/404 both read as "not ours or not there" (UNVERIFIED which one).
    let all: Reply;
    try { all = await this.call("GET", "DOMAIN", { domain: d, type: "all_info" }); }
    catch (e) { if (e instanceof RegistrarError && (e.code === "480" || e.code === "404")) return null; throw e; }
    const st = await this.call("GET", "DOMAIN", { domain: d, type: "status" });
    const priv = await this.call("GET", "DOMAIN", { domain: d, type: "whois_privacy_state" });
    const ds = tld === "io" ? [] : await this.getDs(d);
    const a = all.attrs;
    const nsRaw = arr(a.nameserver_list).map((n) => str(obj(n)?.name) ?? (typeof n === "string" ? n : "")).filter(Boolean);
    const expiresAt = parseDate(str(a.expiredate));
    const away = flag(st.attrs.transfer_away_in_progress);
    const owner = this.ownerOf(a);
    const privState = str(priv.attrs.state) ?? "";
    // The RDP redacts by default (KB 201000115819), and the paid service is not sold (D-020). Whether it is switched on is reported separately.
    const out: DomainStatus = {
      fqdn: d, state: away ? "transferring_out" : expiresAt && expiresAt.getTime() <= this.clock.now().getTime() ? "expired" : "active",
      registryStatuses: [], // OpenSRS returns no raw EPP status strings (dossier 2, getDomain)
      locked: flag(st.attrs.lock_state), nameservers: nsRaw.map((n) => n.toLowerCase()), autoRenew: flag(a.auto_renew),
      privacyStatus: NO_PRIVACY_SERVICE.has(tld) ? "not_available" : "redacted_default", dsPresent: ds.length > 0,
      letExpire: flag(a.let_expire), transferAwayInProgress: away, privacyServiceEnabled: privState === "enabled" || privState === "enabling",
    };
    if (expiresAt) out.expiresAt = expiresAt;
    const created = parseDate(str(a.registry_createdate)); if (created) out.createdAt = created;
    const pu = str(a.reg_username); if (pu) out.profileUsername = pu; // UNVERIFIED attribute name: the claim rule depends on it
    if (owner?.email) out.ownerEmailHash = sha256(owner.email.trim().toLowerCase());
    return out;
  }

  async getOrdersByDomain(fqdn: string): Promise<UpstreamOrder[]> {
    const d = this.norm(fqdn);
    const r = await this.call("GET_ORDERS_BY_DOMAIN", "DOMAIN", { domain: d });
    const list = arr(r.attrs.orders);
    // The registrant fingerprint lets the claim rule pass (plan 4.3b); read the current owner contact once. UNVERIFIED: phone formats may be normalised upstream.
    let fp: string | undefined;
    if (list.length) {
      try { const all = await this.call("GET", "DOMAIN", { domain: d, type: "all_info" }); const o = this.ownerOf(all.attrs); if (o) fp = registrantFingerprint(o); } catch { /* claim then reports registrant_unverifiable */ }
    }
    const status = (s: string): UpstreamOrder["status"] => (s === "completed" || s === "processed" ? "completed" : s === "waiting" ? "waiting" : s === "pending" ? "pending" : "cancelled");
    return list.map((x) => {
      const o = obj(x) ?? {};
      const type = str(o.type) === "renew" || str(o.type) === "renewal" ? "renew" : str(o.type) === "transfer" ? "transfer" : "new";
      const row: UpstreamOrder & { registrantFingerprint?: string } = {
        registrarOrderId: str(o.order_id) ?? "", fqdn: d, type, status: status(str(o.status) ?? ""), orderDate: parseDate(str(o.req_date) ?? str(o.order_date)) ?? new Date(0),
      };
      const pu = str(o.reg_username); if (pu) row.profileUsername = pu; // UNVERIFIED attribute name
      if (fp && type === "new") row.registrantFingerprint = fp;
      return row;
    });
  }

  async cancelPendingOrder(registrarOrderId: string): Promise<{ cancelled: boolean }> {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(registrarOrderId)) throw rejected("order_id_invalid");
    try { await this.call("PROCESS_PENDING", "ORDER", { order_id: registrarOrderId, command: "cancel" }); return { cancelled: true }; }
    catch (e) { if (e instanceof RegistrarError && e.kind === "rejected") return { cancelled: false }; throw e; }
  }

  async getBalance(): Promise<Balance> {
    const r = await this.call("GET_BALANCE", "BALANCE", {});
    const balance = parseMinor(str(r.attrs.balance)); const held = parseMinor(str(r.attrs.hold_balance) ?? "0"); // UNVERIFIED attribute names
    return { balance: this.money(balance), held: this.money(held), available: this.money(balance - held) };
  }
  async getFundingStatus(): Promise<Money> { return (await this.getBalance()).available; }

  // ---- lock, nameservers, codes ------------------------------------------------------------------------------------
  async setLock(fqdn: string, locked: boolean): Promise<void> {
    const d = this.norm(fqdn);
    await this.call("MODIFY", "DOMAIN", { domain: d, data: "status", lock_state: yn(locked) }, locked ? {} : { fuse: "unlock" });
  }

  async setNameservers(fqdn: string, nameservers: string[], opts: { targetSigned?: boolean } = {}): Promise<void> {
    const d = this.norm(fqdn); const tld = this.tldOf(d);
    if (nameservers.length < 2 || nameservers.length > 13 || nameservers.some((n) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(n))) throw rejected("bad_nameservers");
    void opts;
    if (tld !== "io" && (await this.getDs(d)).length > 0) throw rejected("dnssec_would_break");
    // UNVERIFIED attribute names: op_type / assign_ns.
    await this.call("ADVANCED_UPDATE_NAMESERVERS", "DOMAIN", { domain: d, op_type: "assign", assign_ns: nameservers.map((n) => n.toLowerCase()) }, { fuse: "ns_change" });
  }

  async getDnssecCapabilities(fqdn: string) {
    const supported = this.tldOf(this.norm(fqdn)) !== "io";
    return { supported, addMode: supported ? "ds" as const : "unsupported" as const, removeSupported: supported, managedSigning: false };
  }

  async issueAuthCode(fqdn: string): Promise<{ code: string; issuedAt: Date }> {
    const d = this.norm(fqdn);
    if (this.tldOf(d) === "io") throw rejected("code_by_support"); // .io codes are set by OpenSRS support (K6)
    const code = randomAuthCode();
    await this.call("MODIFY", "DOMAIN", { domain: d, data: "domain_auth_info", domain_auth_info: code }, { fuse: "code_issue" });
    return { code, issuedAt: this.clock.now() };
  }
  async rerandomizeAuthCode(fqdn: string): Promise<void> {
    const d = this.norm(fqdn);
    if (this.tldOf(d) === "io") throw rejected("code_by_support");
    await this.call("MODIFY", "DOMAIN", { domain: d, data: "domain_auth_info", domain_auth_info: randomAuthCode() });
  }

  // ---- DNS --------------------------------------------------------------------------------------------------------
  private parseZone(attrs: OpsObject): DnsRecord[] {
    const recs = obj(attrs.records);
    if (!recs || Object.keys(recs).some((t) => !(DNS_RECORD_TYPES as readonly string[]).includes(t) || !Array.isArray(recs[t]))) throw rejected("dns_fidelity_unavailable");
    const out: DnsRecord[] = [];
    for (const t of DNS_RECORD_TYPES) {
      for (const x of arr(recs[t])) {
        const o = obj(x);
        if (!o || Object.keys(o).some((k) => !["subdomain", DNS_VALUE_KEY[t], "priority", "weight", "port"].includes(k))) throw rejected("dns_fidelity_unavailable");
        const name = str(o.subdomain), value = str(o[DNS_VALUE_KEY[t]]);
        if (name === undefined || value === undefined || /[\x00-\x20\x7f]/.test(name)) throw rejected("dns_fidelity_unavailable");
        const rec: DnsRecord = { type: t, name, value };
        const pr = str(o.priority); if (pr !== undefined) rec.priority = Number(pr);
        const w = str(o.weight); if (w !== undefined) rec.weight = Number(w);
        const p = str(o.port); if (p !== undefined) rec.port = Number(p);
        out.push(rec);
      }
    }
    return canonicalZone(out);
  }
  async getDns(fqdn: string): Promise<DnsZone> {
    const d = this.norm(fqdn);
    const r = await this.call("GET_DNS_ZONE", "DOMAIN", { domain: d });
    const ok = r.attrs.nameservers_ok;
    if (ok === undefined) throw err("unknown", "unexpected_shape");
    if (!flag(ok)) return { hosted: false, records: [] };
    return { hosted: true, records: this.parseZone(r.attrs) };
  }
  async replaceZone(fqdn: string, records: DnsRecord[], opts?: { expectedHash?: string }): Promise<{ hash: string; records: DnsRecord[] }> {
    const d = this.norm(fqdn);
    validateZone(records);
    const cur = await this.getDns(d);
    if (!cur.hosted) throw rejected("dns_not_hosted");
    if (opts?.expectedHash !== undefined && opts.expectedHash !== zoneHash(cur.records)) throw rejected("dns_state_changed");
    // Every type is sent, empty ones as empty arrays, so the result is right whether SET_DNS_ZONE overwrites the whole zone or only the types it is
    // sent (the dossier says neither; a Horizon test settles it). UNVERIFIED that an empty array clears a type: the read-back below is the guard.
    const payload = zonePayload(records);
    const wire: OpsObject = {};
    for (const t of DNS_RECORD_TYPES) {
      wire[t] = payload[t].map((r) => {
        const o: OpsObject = { subdomain: r.name, [DNS_VALUE_KEY[t]]: r.value };
        if (r.priority !== undefined) o.priority = r.priority; if (r.weight !== undefined) o.weight = r.weight; if (r.port !== undefined) o.port = r.port;
        return o;
      });
    }
    await this.call("SET_DNS_ZONE", "DOMAIN", { domain: d, records: wire });
    try {
      const back = await this.getDns(d);
      const want = canonicalZone(records);
      if (!back.hosted || zoneHash(back.records) !== zoneHash(want)) throw err("unknown", "dns_readback_mismatch", { outcomeUnknown: true });
      return { hash: zoneHash(back.records), records: back.records };
    } catch (e) {
      throw err("unknown", e instanceof RegistrarError ? e.code ?? "dns_partial_or_unknown" : "dns_partial_or_unknown", { outcomeUnknown: true });
    }
  }

  // ---- DNSSEC -----------------------------------------------------------------------------------------------------
  async getDs(fqdn: string): Promise<DsRecord[]> {
    const d = this.norm(fqdn);
    if (this.tldOf(d) === "io") return [];
    const r = await this.call("GET_DNSSEC_INFO", "DOMAIN", { domain: d }); // command not in the dossier: UNVERIFIED
    return arr(r.attrs.dnssec).map((x) => { const o = obj(x) ?? {}; return { keyTag: Number(str(o.key_tag)), algorithm: Number(str(o.algorithm)), digestType: Number(str(o.digest_type)), digest: (str(o.digest) ?? "").toLowerCase() }; });
  }
  private async setDs(d: string, list: DsRecord[]) {
    // UNVERIFIED shape: the whole DS set is written back.
    await this.call("SET_DNSSEC_INFO", "DOMAIN", { domain: d, dnssec_info: list.map((x) => ({ key_tag: x.keyTag, algorithm: x.algorithm, digest_type: x.digestType, digest: x.digest })) });
  }
  private checkDs(d: string, ds: DsRecord) {
    if (this.tldOf(d) === "io") throw rejected("dnssec_unsupported");
    if (!Number.isInteger(ds.keyTag) || ds.keyTag < 0 || ds.keyTag > 65535 || !Number.isInteger(ds.algorithm) || !Number.isInteger(ds.digestType) || !/^[0-9a-f]{20,128}$/i.test(ds.digest)) throw rejected("bad_ds");
  }
  private same = (a: DsRecord, b: DsRecord) => a.keyTag === b.keyTag && a.algorithm === b.algorithm && a.digestType === b.digestType && a.digest.toLowerCase() === b.digest.toLowerCase();
  async addDs(fqdn: string, ds: DsRecord): Promise<void> {
    const d = this.norm(fqdn); this.checkDs(d, ds);
    const cur = await this.getDs(d);
    if (!cur.some((x) => this.same(x, ds))) await this.setDs(d, [...cur, ds]);
  }
  async removeDs(fqdn: string, ds: DsRecord): Promise<void> {
    const d = this.norm(fqdn); this.checkDs(d, ds);
    await this.setDs(d, (await this.getDs(d)).filter((x) => !this.same(x, ds)));
  }

  // ---- contacts ---------------------------------------------------------------------------------------------------
  async updateContact(fqdn: string, registrant: Registrant): Promise<ContactChangeResult> {
    const d = this.norm(fqdn);
    const all = await this.call("GET", "DOMAIN", { domain: d, type: "all_info" });
    const cur = this.ownerOf(all.attrs); const lc = (s: string) => s.trim().toLowerCase();
    const nameChanged = !cur || lc(cur.name) !== lc(registrant.name), emailChanged = !cur || lc(cur.email) !== lc(registrant.email);
    const registrantChange = nameChanged || emailChanged;
    // UNVERIFIED command variant: MODIFY data=contact_info is not in the dossier. Whether the ICANN trade starts is derived here from the K9 rule
    // (first name, last name, organisation or email); K9 also says the process was "temporarily suspended", so callers re-read getDomain to confirm.
    await this.call("MODIFY", "DOMAIN", { domain: d, data: "contact_info", contact_set: { owner: this.contactSet(registrant).owner as OpsValue } }, { fuse: "contact_change" });
    return { status: registrantChange ? "pending_approval" : "applied", registrantChange, verificationRequired: emailChanged, transferLock60d: registrantChange };
  }

  // ---- transfers --------------------------------------------------------------------------------------------------
  async getTransfersAway(opts: { statuses?: TransferAwayStatus[]; since?: Date } = {}): Promise<TransferAway[]> {
    const statuses = opts.statuses ?? ["pending_admin", "pending_owner", "pending_registry"];
    const seen = new Map<string, TransferAway>();
    for (const s of statuses) {
      const a: OpsObject = { status: s, limit: 40 }; if (opts.since) a.req_from = isoDay(opts.since);
      const r = await this.call("GET_TRANSFERS_AWAY", "DOMAIN", a);
      // UNVERIFIED response field names (transfers / domain / request_date / gaining_registrar).
      for (const x of arr(r.attrs.transfers)) {
        const o = obj(x); const f = str(o?.domain)?.toLowerCase(); if (!o || !f) continue;
        const t: TransferAway = { fqdn: f, status: s, requestedAt: parseDate(str(o.request_date)) ?? new Date(0) };
        const g = str(o.gaining_registrar); if (g) t.gainingRegistrar = g;
        seen.set(`${f}|${s}`, t);
      }
    }
    return [...seen.values()];
  }
  async cancelTransfer(fqdn: string): Promise<{ cancelled: boolean }> {
    const d = this.norm(fqdn);
    try { await this.call("CANCEL_TRANSFER", "TRANSFER", { domain: d }); return { cancelled: true }; }
    catch (e) { if (e instanceof RegistrarError && e.kind === "rejected") return { cancelled: false }; throw e; }
  }
  async stopTransferAway(fqdn: string) {
    const d = this.norm(fqdn);
    await this.setLock(d, true);
    try { await this.rerandomizeAuthCode(d); } catch (e) { if (!(e instanceof RegistrarError && e.code === "code_by_support")) throw e; }
    const pending = await this.getTransfersAway();
    return { relocked: true as const, codeRerandomized: true as const, pendingTransferRemains: pending.some((t) => t.fqdn === d) };
  }

  async setAutoRenew(fqdn: string, enabled: boolean): Promise<void> {
    const d = this.norm(fqdn);
    // UNVERIFIED that auto_renew=0 with let_expire=0 is a valid pair; the dossier names both fields under expire_action only.
    await this.call("MODIFY", "DOMAIN", { domain: d, data: "expire_action", auto_renew: yn(enabled), let_expire: 0 });
  }

  // ---- transfer-in (Phase 5) ---------------------------------------------------------------------------------------
  // Horizon cannot run a transfer ("You cannot transfer domains in Horizon", KB 201000063316): this code has never met a real response.
  // Commands and the attributes `reg_type=transfer`, `auth_info`, `check_status` are in the dossier (S15, S20); every RESPONSE attribute
  // name below (transferrable, reason, status, order_id, request_date) is UNVERIFIED and must be confirmed in the live rehearsal.

  /** UNVERIFIED mapping of CHECK_TRANSFER `reason` text to our codes: only the numbers and phrases the dossier quotes are relied on. */
  private blockOf(reason: string): TransferInBlock {
    const r = reason.toLowerCase();
    if (/60 days/.test(r)) return /transfer/.test(r) ? "recently_transferred" : "too_new";
    if (/server ?transfer ?prohibited|registry lock/.test(r)) return "registry_lock";
    if (/lock|prohibit/.test(r)) return "locked_at_losing";
    if (/not (yet )?registered|available/.test(r)) return "not_registered";
    if (/redemption/.test(r)) return "redemption";
    if (/pending ?delete/.test(r)) return "pending_delete";
    if (/pending|in progress|already/.test(r)) return "pending_transfer";
    return "other";
  }
  async checkTransferIn(fqdn: string): Promise<TransferInCheck> {
    const d = this.norm(fqdn);
    const r = await this.call("CHECK_TRANSFER", "DOMAIN", { domain: d });
    const ok = flag(r.attrs.transferrable);
    const out: TransferInCheck = { fqdn: d, transferable: ok, registryStatuses: [] };
    if (!ok) out.reason = this.blockOf(str(r.attrs.reason) ?? "");
    // CHECK_TRANSFER says nothing about DNSSEC or dates; `dsPresent` stays undefined and the caller reads RDAP.
    return out;
  }
  async startTransferIn(req: TransferInRequest): Promise<TransferInStart> {
    const d = this.norm(req.fqdn); const tld = this.tldOf(d); this.checkSales(tld);
    const need = tld === "ai" ? 2 : 1;
    if (req.years !== need) throw rejected("invalid_period");
    if (typeof req.authCode !== "string" || !/^[\x21-\x7e]{6,64}$/.test(req.authCode)) throw rejected("auth_code_required");
    const q = await this.quote(d, req.years, "transfer");
    if (q.isRegistryPremium) throw rejected("premium_refused"); // D-031 applies to transfers too
    const attrs: OpsObject = {
      domain: d, reg_type: "transfer", period: req.years, handle: "process", auto_renew: 0, f_lock_domain: 1,
      reg_username: req.regUsername, reg_password: req.regPassword, contact_set: this.contactSet(req.registrant),
      custom_nameservers: 0, custom_tech_contact: 0, auth_info: req.authCode,
    };
    if (!NO_PRIVACY_SERVICE.has(tld)) attrs.f_whois_privacy = 0;
    const r = await this.call("SW_REGISTER", "DOMAIN", attrs);
    const id = str(r.attrs.id) ?? str(r.attrs.order_id) ?? ""; // UNVERIFIED attribute name
    // Where the order went is read back rather than guessed: with a valid auth_info the API reference says no owner email is sent (S15),
    // a KB page says only the web interface takes the code with the order (KB 201000063138). A failed read reports the conservative state.
    let st: TransferInState | null = null;
    try { st = await this.getTransferInStatus(d); } catch { st = null; }
    const status = st?.status === "pending_registry" ? "pending_registry" : "pending_owner";
    return { status, registrarOrderId: st?.registrarOrderId ?? id, ownerEmailSent: status === "pending_owner" };
  }
  async getTransferInStatus(fqdn: string): Promise<TransferInState | null> {
    const d = this.norm(fqdn);
    const r = await this.call("CHECK_TRANSFER", "DOMAIN", { domain: d, check_status: 1 });
    const raw = (str(r.attrs.status) ?? "undef").toLowerCase();
    const map: Record<string, TransferInStatus> = { pending_owner: "pending_owner", pending_admin: "pending_owner", pending_registry: "pending_registry", completed: "completed", cancelled: "cancelled" };
    const status = map[raw];
    if (!status) return null;   // `undef`: the provider knows no transfer of ours for this name
    const out: TransferInState = { fqdn: d, status };
    const id = str(r.attrs.order_id) ?? str(r.attrs.id); if (id) out.registrarOrderId = id;
    const req = parseDate(str(r.attrs.request_date)); if (req) out.requestedAt = req;
    if (status === "cancelled") {
      const why = (str(r.attrs.reason) ?? "").toLowerCase();
      const failure: TransferInFailure = /auth/.test(why) ? "invalid_auth_code" : /declin|nack|reject|denied/.test(why) ? "nack" : /timed? ?out|expired|not approved/.test(why) ? "owner_timeout" : /lock|prohibit/.test(why) ? "locked_at_losing" : "unknown";
      out.failure = failure;
      if (failure === "nack") out.nackReason = "unstated";   // OpenSRS reports free text; the I.A.3.7 reason is not a documented field
    }
    return out;
  }
  async cancelTransferIn(fqdn: string): Promise<{ cancelled: boolean }> { return this.cancelTransfer(fqdn); }

  // ---- inventory and lifecycle -------------------------------------------------------------------------------------
  async listDomains(opts: { cursor?: string; limit?: number } = {}): Promise<{ rows: InventoryRow[]; next?: string }> {
    const page = opts.cursor ? Number(opts.cursor) : 1;
    if (!Number.isInteger(page) || page < 1) throw rejected("bad_cursor");
    const limit = Math.min(opts.limit ?? 40, 100);
    const r = await this.call("GET_DOMAINS_BY_EXPIREDATE", "DOMAIN", { exp_from: "2000-01-01", exp_to: "2099-12-31", page, limit }); // UNVERIFIED paging attributes
    const rows = arr(r.attrs.exp_domains).flatMap((x) => { const o = obj(x); const f = str(o?.name)?.toLowerCase(); const e = parseDate(str(o?.expiredate)); return o && f && e ? [{ fqdn: f, expiresAt: e }] : []; });
    const total = Number(str(r.attrs.total) ?? rows.length);
    return page * limit < total ? { rows, next: String(page + 1) } : { rows };
  }
  async getDeletedDomains(): Promise<DeletedDomain[]> {
    const r = await this.call("GET_DELETED_DOMAINS", "DOMAIN", {});
    return arr(r.attrs.deleted_domains).flatMap((x) => {
      const o = obj(x); const f = str(o?.name)?.toLowerCase(); const end = parseDate(str(o?.redemption_grace_period_end_date)); const del = parseDate(str(o?.delete_date));
      return o && f && end ? [{ fqdn: f, deletedAt: del ?? new Date(end.getTime() - 30 * 86_400_000), redemptionEndsAt: end }] : [];
    });
  }
  async restore(fqdn: string) {
    const d = this.norm(fqdn); const tld = this.tldOf(d);
    if (!RESTORE_TLDS[tld]) throw rejected("restore_unsupported");
    const r = await this.call("REDEEM", "DOMAIN", { domain: d }); // Horizon cannot run REDEEM (S23): proven by the mock only until the live rehearsal
    const id = str(r.attrs.order_id) ?? str(r.attrs.id);
    return r.async || flag(r.attrs.forced_pending) ? { status: "accepted_pending" as const, ...(id ? { registrarOrderId: id } : {}) } : { status: "restored" as const, ...(id ? { registrarOrderId: id } : {}) };
  }
}
