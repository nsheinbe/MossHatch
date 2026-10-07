import { createHash } from "node:crypto";
import {
  DNS_RECORD_TYPES, RegistrarError,
  type Availability, type AvailabilityKind, type Balance, type ContactChangeResult, type DeletedDomain, type DnsRecord, type DnsRecordType, type DnsZone, type DomainStatus,
  type DsRecord, type InventoryRow, type Money, type Quote, type Registrant, type RegisterRequest, type RegisterResult, type RegistrarCapabilities, type RegistrarPort,
  type TransferAway, type UpstreamOrder, type TransferInCheck, type TransferInRequest, type TransferInStart, type TransferInState, type TransferInStatus,
} from "../port.ts";
import { registrantFingerprint } from "../claim.ts";
import { canonicalZone, OPENPROVIDER_NAMESERVERS, validateZone, zoneHash } from "../dns.ts";
import { readSwitch, VelocityFuse, type AdapterAlert, type FuseClass, type KillSwitch } from "../opensrs/guards.ts";
import { checkOperation, type OpName, type OpRequest } from "./allowlist.ts";
import { dsFromDnskey, dsMatchesKey, type Dnskey } from "./dnssec.ts";
import { PRODUCTION_URL, SANDBOX_URL, type OpHttpTransport } from "./transport.ts";
import { arr, bool, encodeJson, minorFromText, num, obj, parseAmsterdam, parseJson, parseUtc, str, stripSecrets, type Json } from "./wire.ts";

/**
 * Openprovider REST adapter (API v1, https://api.openprovider.eu/v1; sandbox https://api.sandbox.openprovider.nl/v1).
 * Written from the OpenAPI document (developer.openprovider.com/data/swagger.json, fetched 2026-09-30) and checked against the live sandbox on
 * 2026-09-30: every behaviour marked "observed" below was seen there. Anything marked UNVERIFIED was not, and must be confirmed before launch.
 * docs/registrar-parity.md has the Openprovider section.
 *
 * Model differences from OpenSRS that shape this code:
 *  - No per-order profile. Contacts are customer handles (`POST /customers`); the adapter creates one handle per registration or transfer so that
 *    a contact edit never touches another domain. The claim rule's "profile username" is stored in the domain `comments` field as `mh:<username>`.
 *  - Domains are addressed by a numeric id; names are resolved with `GET /domains?full_name=`.
 *  - No order objects. `getOrdersByDomain` synthesises the one order a domain carries (`type`, `status`, `order_date`).
 *  - The provider generates authorization codes (`POST /domains/{id}/authcode/reset` returns a new one); `PUT auth_code` is accepted and ignored.
 *  - DNSSEC is DNSKEY-based and Openprovider's own DNS signs new zones automatically, so a new domain already has a DS at the registry.
 */
export type Deployment = "local" | "preview" | "staging" | "production";
export interface OpenproviderCredentials { read(): { username: string; password: string } }
/** Server-only coordination. Implementations must never include credentials or bearer values in errors/logs. */
export interface OpenproviderLoginCache {
  get(input: { host: string; username: string; password: string; ttlMs: number }, login: () => Promise<string>): Promise<string>;
  invalidate(input: { host: string; username: string; password: string }, rejectedToken: string): Promise<void>;
}
export class MemoryOpenproviderCredentials implements OpenproviderCredentials {
  constructor(private c: { username: string; password: string }) {}
  read() { return { ...this.c }; }
  set(c: { username: string; password: string }) { this.c = { ...c }; }
}
export interface OpenproviderLogEvent { event: "openprovider_call"; op: OpName; write: boolean; httpStatus?: number; providerCode?: number; warnings?: number[]; outcome: "ok" | "error" | "refused" | "transport_error" }
export interface OpenproviderConfig {
  mode: "sandbox" | "live";
  deployment: Deployment;
  credentials: OpenproviderCredentials;
  transport: OpHttpTransport;
  killSwitch: KillSwitch;
  clock?: { now(): Date };
  fuse?: VelocityFuse;
  onAlert?: (a: AdapterAlert) => void;
  /** Codes and operation names only; never a domain, body, handle, token or code. */
  log?: (e: OpenproviderLogEvent) => void;
  timeoutMs?: number;
  /** How long a login token is reused before a fresh login. UNVERIFIED lifetime (the token is opaque, 32 characters); a 401 also forces a re-login. */
  tokenTtlMs?: number;
  /** Live registrar instances share a trusted store; without it sandbox/standalone adapters retain their local cache. */
  loginCache?: OpenproviderLoginCache;
}

const LAUNCH_TLDS = ["com", "ai", "dev", "io", "app", "studio"];
/** Observed: a 1-year .ai create is refused with code 316 "Invalid period!". */
const TLD_MIN_TERM: Record<string, number> = { ai: 2 };
const MAX_TERM = 10;
/** Observed: `POST /domains/{id}/restore` restored a deleted .io in soft quarantine at no charge. The others are UNVERIFIED (the API offers it for all). */
const RESTORE_TLDS: Record<string, boolean> = { com: true, dev: true, studio: true, ai: true, io: true, app: true };
/** Openprovider DNS. Observed: registering with these three names put the domain in ns_group `dns-openprovider` and created a signed master zone. */
export const OP_NAMESERVERS = OPENPROVIDER_NAMESERVERS;
const DNS_TTL = 900;
/** A fallback expiry (the create's own answer and the domain read both missing): the term from now, corrected by the next sync. */
const addYearsUtc = (d: Date, years: number): Date => new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
const PENDING = new Set(["REQ", "PEN", "SCH", "RRQ"]);

const err = (kind: RegistrarError["kind"], code: string, o: { retryable?: boolean; outcomeUnknown?: boolean } = {}, message = "registrar request failed") =>
  new RegistrarError(kind, message, { retryable: o.retryable ?? false, outcomeUnknown: o.outcomeUnknown ?? false, code });
const rejected = (code: string) => err("rejected", code, {}, "registrar rejected the request");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
type JObj = { [k: string]: Json };
interface Reply { data: JObj; code: number; warnings: number[]; secret?: string }
interface CallOpts { fuse?: FuseClass; secretOut?: boolean }
interface WireRecord { name: string; type: string; value: string; prio?: number; ttl: number }

/**
 * Provider error codes seen in the sandbox on 2026-09-30 (the spec lists none): 196 authentication failed (HTTP 401), 300 empty domain name,
 * 307 invalid extension, 316 invalid period, 320 domain not in this account, 346 duplicate domain, 358 invalid authorization code, 366 action
 * prohibited for the current status, 399 registry error (message in `data`), 223 no nameservers, 872 DNS zone not found, 18002 DNS record rejected.
 * Only the number travels in an error; the provider's text never does.
 */
export class OpenproviderAdapter implements RegistrarPort {
  private readonly cfg: OpenproviderConfig;
  private readonly clock: { now(): Date };
  private readonly fuse: VelocityFuse;
  private readonly pausedExtensions = new Set<string>();
  private token: { value: string; at: number } | null = null;
  private loggingIn: Promise<string> | null = null;
  private readonly ids = new Map<string, number>();

  constructor(cfg: OpenproviderConfig) {
    if (cfg.mode === "live" && cfg.deployment !== "production") throw err("rejected", "live_outside_production", {}, "live registrar refused outside production");
    if (cfg.mode === "sandbox" && cfg.deployment === "production") throw err("rejected", "sandbox_in_production", {}, "sandbox registrar refused in production");
    this.cfg = cfg;
    this.clock = cfg.clock ?? { now: () => new Date() };
    this.fuse = cfg.fuse ?? new VelocityFuse(this.clock, (a) => this.alert(a));
  }
  private alert(a: AdapterAlert) { this.cfg.onAlert?.(a); }
  resumeExtension(tld: string) { this.pausedExtensions.delete(tld); }
  isExtensionPaused(tld: string) { return this.pausedExtensions.has(tld); }
  private get base() { return this.cfg.mode === "live" ? PRODUCTION_URL : SANDBOX_URL; }

  // ---- transport --------------------------------------------------------------------------------------------------
  private async login(): Promise<string> {
    if (this.loggingIn) return this.loggingIn;
    this.loggingIn = (async () => {
      let cred: { username: string; password: string };
      try { cred = this.cfg.credentials.read(); } catch { cred = { username: "", password: "" }; }
      if (!cred.username || !cred.password) throw err("unavailable", "no_credentials", { retryable: true }, "registrar credentials are not set");
      const requestToken = async () => {
        const body = { username: cred.username, password: cred.password, ip: "0.0.0.0" };
        const { path } = checkOperation("LOGIN", { body });
        const log = (e: Omit<OpenproviderLogEvent, "event" | "op" | "write">) => this.cfg.log?.({ event: "openprovider_call", op: "LOGIN", write: false, ...e });
        let res;
        try { res = await this.cfg.transport.request({ method: "POST", url: this.base + path, headers: { "Content-Type": "application/json" }, body: encodeJson(body), timeoutMs: this.cfg.timeoutMs ?? 30_000 }); }
        catch { log({ outcome: "transport_error" }); throw err("unavailable", "transport", { retryable: true }, "registrar request did not complete"); }
        let j: JObj | undefined; try { j = obj(parseJson(res.body)); } catch { j = undefined; }
        const code = num(j?.code);
        const token = str(obj(j?.data)?.token);
        log({ httpStatus: res.status, ...(code !== undefined ? { providerCode: code } : {}), outcome: res.status === 200 && code === 0 && token ? "ok" : "error" });
        if (res.status === 401 || code === 196) { this.alert({ kind: "auth_failed", detail: "login" }); throw rejected("auth_failed"); }
        if (res.status === 429) throw err("rate_limited", "http_429", { retryable: true });
        if (res.status >= 500) throw err("unavailable", `http_${res.status}`, { retryable: true });
        if (res.status !== 200 || code !== 0 || !token) throw err("unavailable", "login_failed", { retryable: true });
        this.token = { value: token, at: this.clock.now().getTime() };
        return token;
      };
      return this.cfg.loginCache
        ? this.cfg.loginCache.get({ host: this.base, ...cred, ttlMs: this.cfg.tokenTtlMs ?? 12 * 3_600_000 }, requestToken)
        : requestToken();
    })();
    try { return await this.loggingIn; } finally { this.loggingIn = null; }
  }
  private async bearer(): Promise<string> {
    // Shared cache TTL is measured at provider login, never extended by another instance reading the token.
    if (this.cfg.loginCache) return this.login();
    const ttl = this.cfg.tokenTtlMs ?? 12 * 3_600_000;
    if (this.token && this.clock.now().getTime() - this.token.at < ttl) return this.token.value;
    this.token = null;
    return this.login();
  }

  private async call(op: OpName, req: OpRequest, o: CallOpts = {}): Promise<Reply> {
    let checked;
    try { checked = checkOperation(op, req); } catch (e) { this.cfg.log?.({ event: "openprovider_call", op, write: true, outcome: "refused" }); throw e; }
    const { rule, path } = checked;
    const log = (e: Omit<OpenproviderLogEvent, "event" | "op" | "write">) => this.cfg.log?.({ event: "openprovider_call", op, write: rule.write, ...e });
    const sw = await readSwitch(this.cfg.killSwitch);
    if (sw === "all_paused" || (sw === "writes_paused" && rule.write)) {
      this.alert({ kind: "kill_switch_closed", detail: rule.write ? "write" : "read" });
      log({ outcome: "refused" });
      throw err("unavailable", "kill_switch", { retryable: true }, "registrar calls are paused");
    }
    if (o.fuse) this.fuse.take(o.fuse);
    const qs = new URLSearchParams(Object.entries(req.query ?? {})).toString();
    const url = this.base + path + (qs ? `?${qs}` : "");
    const body = rule.method === "GET" || rule.method === "DELETE" ? undefined : encodeJson(req.body ?? {});
    for (let attempt = 0; ; attempt++) {
      const token = await this.bearer();
      let res;
      try {
        res = await this.cfg.transport.request({ method: rule.method, url, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body !== undefined ? { body } : {}), timeoutMs: this.cfg.timeoutMs ?? 30_000 });
      } catch {
        // Sent, answer not seen. For a write the outcome is unknown: the caller reconciles by reading, never resends. Observed 2026-09-30: a
        // `POST /domains` for .ai answered 504 from the gateway and the domain existed afterwards in status REQ.
        log({ outcome: "transport_error" });
        throw err(rule.write ? "unknown" : "unavailable", "transport", { retryable: !rule.write, outcomeUnknown: rule.write }, "registrar request did not complete");
      }
      let parsed: JObj | undefined;
      try { parsed = obj(parseJson(res.body)); } catch { parsed = undefined; }
      const code = num(parsed?.code);
      const warnings = arr(parsed?.warnings).map((w) => num(obj(w)?.code)).filter((n): n is number => n !== undefined);
      const base = { httpStatus: res.status, ...(code !== undefined ? { providerCode: code } : {}), ...(warnings.length ? { warnings } : {}) };
      // A 401 means the request was not processed (observed: every call with a bad or expired token answers 401 code 196), so one retry after a
      // fresh login is safe even for a write.
      if (res.status === 401 || code === 196) {
        log({ ...base, outcome: "error" });
        this.token = null;
        if (this.cfg.loginCache) {
          let cred: { username: string; password: string };
          try { cred = this.cfg.credentials.read(); } catch { throw err("unavailable", "no_credentials", { retryable: true }); }
          await this.cfg.loginCache.invalidate({ host: this.base, ...cred }, token);
        }
        if (attempt === 0) continue;
        this.alert({ kind: "auth_failed", detail: "http_401" });
        throw rejected("auth_failed");
      }
      if (res.status === 429) { log({ ...base, outcome: "error" }); throw err("rate_limited", "http_429", { retryable: true }); }
      if (res.status >= 500 || !parsed) {
        log({ ...base, outcome: "error" });
        throw err(rule.write ? "unknown" : "unavailable", res.status >= 500 ? `http_${res.status}` : "bad_response", { retryable: !rule.write, outcomeUnknown: rule.write });
      }
      if (parsed.maintenance === true) { log({ ...base, outcome: "error" }); throw err("maintenance", "maintenance", { retryable: true }); } // UNVERIFIED: never observed set
      if (code !== 0 || res.status < 200 || res.status >= 300) { log({ ...base, outcome: "error" }); throw this.mapError(code, str(parsed.desc) ?? ""); }
      log({ ...base, outcome: "ok" });
      const rawData = obj(parsed.data) ?? {};
      const secret = o.secretOut ? str(rawData.auth_code) : undefined;
      const data = obj(stripSecrets(rawData)) ?? {};
      return { data, code: 0, warnings, ...(secret !== undefined ? { secret } : {}) };
    }
  }

  private mapError(code: number | undefined, desc: string): RegistrarError {
    const c = code === undefined ? "bad_response" : String(code);
    // UNVERIFIED: the insufficient-balance code was not provoked in the sandbox (100,000 of play money); matched on the description instead.
    if (/insufficient|not enough (balance|funds|credit)|balance is too low/i.test(desc)) return err("insufficient_funds", c);
    if (/try again later|temporar/i.test(desc) && code !== 18002) return err("unavailable", c, { retryable: true });
    return rejected(c);
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------
  private split(fqdn: string): { d: string; name: string; tld: string } {
    const d = fqdn.trim().toLowerCase(); const i = d.indexOf(".");
    const tld = i < 0 ? "" : d.slice(i + 1);
    if (i < 1 || !LAUNCH_TLDS.includes(tld)) throw rejected("unsupported_tld");
    return { d, name: d.slice(0, i), tld };
  }
  private checkTerm(tld: string, years: number) {
    if (years === undefined || years === null) throw rejected("period_required");
    if (!Number.isInteger(years) || years < (TLD_MIN_TERM[tld] ?? 1) || years > MAX_TERM) throw rejected("invalid_period");
  }
  private checkSales(tld: string) { if (this.pausedExtensions.has(tld)) throw err("rejected", "sales_paused", {}, "sales of this extension are paused"); }
  private money(minor: bigint): Money { return { minor, currency: "usd", source: this.cfg.mode === "live" ? "live" : "sample" }; }
  private amount(v: Json | undefined): bigint { try { return minorFromText(str(v)); } catch { throw err("unknown", "bad_amount"); } }

  /** Resolves a name to its domain record in this account (list call), or null. Includes deleted (DEL) names, which the list still returns. */
  private async find(d: string): Promise<JObj | null> {
    const r = await this.call("LIST_DOMAINS", { query: { full_name: d, limit: "10", offset: "0" } });
    const hit = arr(r.data.results).map(obj).find((x) => x && `${str(obj(x.domain)?.name)}.${str(obj(x.domain)?.extension)}`.toLowerCase() === d);
    if (!hit) { this.ids.delete(d); return null; }
    const id = num(hit.id); if (id !== undefined) this.ids.set(d, id);
    return hit;
  }
  private async idOf(d: string): Promise<number> {
    const cached = this.ids.get(d); if (cached !== undefined) return cached;
    const hit = await this.find(d);
    const id = hit ? num(hit.id) : undefined;
    if (id === undefined) throw rejected("not_in_account");
    return id;
  }
  /** Full record (`GET /domains/{id}`); null when the name is not in this account. */
  private async detail(d: string): Promise<JObj | null> {
    let id = this.ids.get(d);
    if (id === undefined) { const hit = await this.find(d); id = hit ? num(hit.id) : undefined; if (id === undefined) return null; }
    try {
      const r = await this.call("GET_DOMAIN", { params: { id }, query: { with_registry_statuses: "true" } });
      const got = `${str(obj(r.data.domain)?.name)}.${str(obj(r.data.domain)?.extension)}`.toLowerCase();
      if (got !== d) { this.ids.delete(d); return this.find(d).then((h) => (h ? this.detail(d) : null)); }
      return r.data;
    } catch (e) {
      if (e instanceof RegistrarError && e.code === "320") { this.ids.delete(d); return null; }
      throw e;
    }
  }

  // ---- contacts (customer handles) ----------------------------------------------------------------------------------
  private customerBody(r: Registrant): Record<string, Json> {
    const [first = "", ...rest] = r.name.trim().split(/\s+/);
    // The port carries EPP-style "+CC.NNNN". Openprovider splits it into country code, area code and subscriber number; the split point does not
    // change the number (the fingerprint re-joins them). UNVERIFIED for non-NANP numbers: the area code is the first three digits.
    const m = /^\+(\d{1,3})\.(\d{4,14})$/.exec(r.phone.trim());
    if (!m) throw rejected("phone_format");
    return {
      name: { first_name: first, last_name: rest.join(" ") || first },
      email: r.email.trim(),
      phone: { country_code: `+${m[1]}`, area_code: m[2]!.slice(0, 3), subscriber_number: m[2]!.slice(3) },
      // Observed: an empty house number is accepted for .com and .io; .dev and .app were refused in the sandbox with "Incorrect contact's details"
      // whether or not the number was split out (UNVERIFIED why; see the parity doc).
      address: { street: r.street.trim(), number: "", city: r.city.trim(), state: r.region.trim(), zipcode: r.postalCode.trim(), country: r.country.trim().toUpperCase() },
    };
  }
  private async createHandle(r: Registrant): Promise<string> {
    const res = await this.call("CREATE_CUSTOMER", { body: this.customerBody(r) });
    const h = str(res.data.handle);
    if (!h) throw err("unknown", "no_handle", { outcomeUnknown: true });
    return h;
  }
  private async registrantOf(handle: string | undefined): Promise<Registrant | undefined> {
    if (!handle) return undefined;
    const c = (await this.call("GET_CUSTOMER", { params: { handle } })).data;
    const n = obj(c.name), p = obj(c.phone), a = obj(c.address);
    const number = str(a?.number) ?? "";
    return {
      name: (str(n?.full_name) ?? `${str(n?.first_name) ?? ""} ${str(n?.last_name) ?? ""}`).trim(),
      email: str(c.email) ?? "",
      phone: `${str(p?.country_code) ?? ""}.${str(p?.area_code) ?? ""}${str(p?.subscriber_number) ?? ""}`,
      street: number ? `${str(a?.street) ?? ""} ${number}` : str(a?.street) ?? "",
      city: str(a?.city) ?? "", region: str(a?.state) ?? "", postalCode: str(a?.zipcode) ?? "", country: str(a?.country) ?? "",
    };
  }

  // ---- capabilities and health --------------------------------------------------------------------------------------
  capabilities(): RegistrarCapabilities {
    return {
      mode: this.cfg.mode, dnsHosting: true, dnssec: true, webhooks: false, idempotentRegister: false, sandbox: this.cfg.mode === "sandbox",
      authCodeModel: "api", restore: { ...RESTORE_TLDS }, funding: true, inventory: true, events: false, cancelTransferAway: false,
    };
  }
  async health() {
    try { await this.call("RESELLER", { query: {} }); return { status: "ok" as const }; }
    catch (e) {
      if (e instanceof RegistrarError && e.kind === "maintenance") return { status: "maintenance" as const };
      if (e instanceof RegistrarError && (e.kind === "unavailable" || e.kind === "rate_limited" || e.kind === "unknown")) return { status: "degraded" as const };
      throw e;
    }
  }

  // ---- lookup and price -------------------------------------------------------------------------------------------
  async checkAvailability(fqdn: string, _opts: { noCache?: boolean } = {}): Promise<Availability> {
    const { d, name, tld } = this.split(fqdn);
    // UNVERIFIED whether the check is cached upstream; there is no no-cache flag in the spec, so `noCache` has nothing to set.
    const r = await this.call("CHECK", { body: { domains: [{ name, extension: tld }], with_price: false } });
    const hit = arr(r.data.results).map(obj).find((x) => str(x?.domain)?.toLowerCase() === d);
    const status = str(hit?.status) ?? "";
    // Observed statuses: "free" and "active" (reason "Domain exists"). Others (reserved, in-use-by-registry) are UNVERIFIED and read as unknown.
    let kind: AvailabilityKind = status === "free" ? "available" : status === "active" ? "taken" : "unknown";
    if (kind === "available" && bool(hit?.is_premium)) kind = "premium";
    return { fqdn: d, kind, source: this.cfg.mode === "live" ? "live" : "sample", checkedAt: this.clock.now() };
  }

  async quote(fqdn: string, years: number, kind: "register" | "renew" | "transfer" = "register"): Promise<Quote> {
    const { d, name, tld } = this.split(fqdn); this.checkTerm(tld, years);
    const price = async (operation: "create" | "renew" | "transfer") => {
      const r = await this.call("PRICE", { query: { "domain.name": name, "domain.extension": tld, operation, period: String(years) } });
      // Observed: `price.reseller.price` is the total for the period (.com create 11.98 for 1 year, 23.96 for 2; .ai 218 for 2) in USD.
      const p = obj(obj(r.data.price)?.reseller);
      if ((str(p?.currency) ?? "").toUpperCase() !== "USD") throw err("rejected", "currency_mismatch");
      return { minor: this.amount(p?.price), premium: bool(r.data.is_premium) };
    };
    const first = await price(kind === "renew" ? "renew" : kind === "transfer" ? "transfer" : "create");
    const renewal = kind === "renew" ? first : await price("renew");
    return { fqdn: d, tld, years, wholesale: this.money(first.minor), renewalWholesale: this.money(renewal.minor), isRegistryPremium: first.premium || renewal.premium, quotedAt: this.clock.now() };
  }

  // ---- balance ------------------------------------------------------------------------------------------------------
  async getBalance(): Promise<Balance> {
    const r = await this.call("RESELLER", { query: {} });
    // Observed: `balance` and `reserved_balance` (a pending .ai order held 218 in `reserved_balance` while `balance` was unchanged).
    const balance = this.amount(r.data.balance); const held = this.amount(r.data.reserved_balance ?? "0");
    return { balance: this.money(balance), held: this.money(held), available: this.money(balance - held) };
  }
  async getFundingStatus(): Promise<Money> { return (await this.getBalance()).available; }
  /** The debit check after a write that took effect: a balance read that fails is an alert, never an error for the caller. */
  private async settleAfterWrite(tld: string, quoted: bigint, before: bigint): Promise<void> {
    try { await this.debitCheck(tld, quoted, before); }
    catch { this.alert({ kind: "debit_unverified", detail: `.${tld}` }); }
  }
  private async debitCheck(tld: string, quoted: bigint, before: bigint) {
    const after = (await this.getBalance()).available.minor;
    const diff = before - after - quoted;
    if (diff > 1n || diff < -1n) { this.pausedExtensions.add(tld); this.alert({ kind: "debit_mismatch", detail: `.${tld}` }); }
  }

  // ---- register and renew -----------------------------------------------------------------------------------------
  async register(req: RegisterRequest): Promise<RegisterResult> {
    const { d, name, tld } = this.split(req.fqdn);
    this.checkTerm(tld, req.years); this.checkSales(tld);
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(req.regUsername ?? "")) throw rejected("reg_username_invalid");
    const q = await this.quote(d, req.years, "register");
    if (q.isRegistryPremium) throw rejected("premium_refused"); // D-031
    const before = (await this.getBalance()).available.minor;
    const handle = await this.createHandle(req.registrant);
    const r = await this.call("CREATE_DOMAIN", { body: {
      domain: { name, extension: tld }, period: req.years, unit: "y",
      owner_handle: handle, admin_handle: handle, tech_handle: handle, billing_handle: handle,
      autorenew: "off", name_servers: OP_NAMESERVERS.map((n, i) => ({ name: n, seq_nr: i + 1 })), is_private_whois_enabled: false,
      comments: `mh:${req.regUsername}`,
    } });
    const id = num(r.data.id); if (id !== undefined) this.ids.set(d, id);
    const orderId = id !== undefined ? String(id) : "";
    const status = str(r.data.status) ?? "";
    // Observed: .com and .io answer ACT at once; .ai answered 504 and then sat in REQ with the price held in reserved_balance.
    if (status !== "ACT") return { status: "accepted_pending", registrarOrderId: orderId, reason: "async" };
    // The name is registered from here on. Nothing below may throw: a failed read after the create would reach the order machine as
    // "refused before any effect", which retries, meets the duplicate refusal and voids a name that is ours (docs/AUDIT-2026-10-07.md F1).
    await this.settleAfterWrite(tld, q.wholesale.minor, before);
    const dom = await this.getDomain(d).catch(() => null);
    return { status: "registered", registrarOrderId: orderId, expiresAt: dom?.expiresAt ?? parseUtc(str(r.data.expiration_date)) ?? addYearsUtc(this.clock.now(), req.years) };
  }

  async renew(fqdn: string, years: number, currentExpiryYear: number) {
    const { d, tld } = this.split(fqdn); this.checkTerm(tld, years); this.checkSales(tld);
    // Openprovider has no expiry-year guard (observed: a repeated renew simply added another year), so the adapter compares first. A renewal by
    // someone else between this read and the send is not caught (UNVERIFIED window; the post-order debit check still sees a double charge).
    const cur = await this.getDomain(d);
    if (!cur) throw rejected("not_in_account");
    if (cur.expiresAt?.getUTCFullYear() !== currentExpiryYear) throw rejected("expiry_year_mismatch");
    const q = await this.quote(d, years, "renew");
    const before = (await this.getBalance()).available.minor;
    const id = await this.idOf(d);
    const r = await this.call("RENEW_DOMAIN", { params: { id }, body: { period: years } });
    if ((str(r.data.status) ?? "") !== "ACT") return { status: "accepted_pending" as const, registrarOrderId: String(id) };
    // Renewed from here on: as for register, a failed read after the write never turns into an error.
    await this.settleAfterWrite(tld, q.wholesale.minor, before);
    const dom = await this.getDomain(d).catch(() => null);
    return { status: "renewed" as const, registrarOrderId: String(id), ...(dom?.expiresAt ? { expiresAt: dom.expiresAt } : {}) };
  }

  // ---- reads ------------------------------------------------------------------------------------------------------
  private keysOf(raw: JObj): (Dnskey & { readonly?: number })[] {
    return arr(raw.dnssec_keys).flatMap((x) => {
      const o = obj(x); const pk = str(o?.pub_key); if (!o || !pk) return [];
      const k: Dnskey & { readonly?: number } = { flags: num(o.flags) ?? 0, protocol: num(o.protocol) ?? 3, algorithm: num(o.alg) ?? 0, publicKey: pk };
      const ro = num(o.readonly); if (ro !== undefined) k.readonly = ro;
      return [k];
    });
  }
  private profileOf(raw: JObj): string | undefined { return /^mh:([A-Za-z0-9_-]{3,40})$/.exec(str(raw.comments) ?? "")?.[1]; }

  async getDomain(fqdn: string): Promise<DomainStatus | null> {
    const { d } = this.split(fqdn);
    const raw = await this.detail(d);
    if (!raw) return null;
    const status = str(raw.status) ?? "";
    if (status === "DEL") return null; // deleted and restorable: reported by getDeletedDomains, as OpenSRS GET does during redemption
    const expiresAt = parseUtc(str(raw.registry_expiration_date)) ?? parseUtc(str(raw.expiration_date));
    const rs = obj(raw.registry_statuses);
    const registryStatuses: string[] = [];
    if (num(obj(rs?.client_transfer_prohibited)?.value) === 1) registryStatuses.push("clientTransferProhibited");
    if (num(obj(rs?.client_hold)?.value) === 1) registryStatuses.push("clientHold");
    const state: DomainStatus["state"] = status === "ACT" ? (expiresAt && expiresAt.getTime() <= this.clock.now().getTime() ? "expired" : "active") : PENDING.has(status) ? "pending" : "unknown";
    const auto = str(raw.autorenew) ?? "";
    const owner = await this.registrantOf(str(raw.owner_handle));
    const out: DomainStatus = {
      fqdn: d, state, registryStatuses,
      locked: bool(raw.is_locked),
      nameservers: arr(raw.name_servers).map((n) => (str(obj(n)?.name) ?? "").toLowerCase()).filter(Boolean),
      // "default" follows the reseller setting (UNVERIFIED which way it is set); read as on, the direction that can spend money.
      autoRenew: auto === "on" || auto === "default",
      privacyStatus: "redacted_default",
      dsPresent: this.keysOf(raw).length > 0,
      privacyServiceEnabled: bool(raw.is_private_whois_enabled),
    };
    if (expiresAt) out.expiresAt = expiresAt;
    const created = parseUtc(str(raw.creation_date)); if (created && status === "ACT") out.createdAt = created;
    const pu = this.profileOf(raw); if (pu) out.profileUsername = pu;
    const id = num(raw.id); if (id !== undefined) out.registrarOrderId = String(id);
    if (owner?.email) out.ownerEmailHash = sha256(owner.email.trim().toLowerCase());
    return out;
  }

  /** Openprovider has no order objects: the domain itself is the one order (`type` NEW or TRANSFER, `order_date` in Amsterdam time). */
  async getOrdersByDomain(fqdn: string): Promise<UpstreamOrder[]> {
    const { d } = this.split(fqdn);
    const raw = await this.detail(d);
    if (!raw) return [];
    const s = str(raw.status) ?? "";
    const owner = await this.registrantOf(str(raw.owner_handle)).catch(() => undefined);
    const row: UpstreamOrder & { registrantFingerprint?: string } = {
      registrarOrderId: String(num(raw.id) ?? ""), fqdn: d,
      type: (str(raw.type) ?? "").toUpperCase() === "TRANSFER" ? "transfer" : "new", // "NEW" observed; "TRANSFER" UNVERIFIED
      status: s === "ACT" ? "completed" : PENDING.has(s) ? "pending" : "cancelled",
      orderDate: parseAmsterdam(str(raw.order_date)) ?? new Date(0),
    };
    const pu = this.profileOf(raw); if (pu) row.profileUsername = pu;
    if (owner) row.registrantFingerprint = registrantFingerprint(owner);
    return [row];
  }

  /** Observed: `DELETE /domains/{id}` on a pending (REQ) .ai order answered 366 "prohibited for current domain status", so this reports false then. */
  async cancelPendingOrder(registrarOrderId: string): Promise<{ cancelled: boolean }> {
    if (!/^[1-9]\d{0,11}$/.test(registrarOrderId)) throw rejected("order_id_invalid");
    const r = await this.call("GET_DOMAIN", { params: { id: registrarOrderId }, query: {} }).catch((e) => { if (e instanceof RegistrarError && e.kind === "rejected") return null; throw e; });
    if (!r || !PENDING.has(str(r.data.status) ?? "")) return { cancelled: false }; // never delete an active name
    try { await this.call("DELETE_DOMAIN", { params: { id: registrarOrderId }, query: {} }); return { cancelled: true }; }
    catch (e) { if (e instanceof RegistrarError && e.kind === "rejected") return { cancelled: false }; throw e; }
  }

  // ---- lock, nameservers, codes ------------------------------------------------------------------------------------
  async setLock(fqdn: string, locked: boolean): Promise<void> {
    const { d } = this.split(fqdn);
    const id = await this.idOf(d);
    await this.call("UPDATE_DOMAIN", { params: { id }, body: { is_locked: locked } }, locked ? {} : { fuse: "unlock" });
  }

  async setNameservers(fqdn: string, nameservers: string[], opts: { targetSigned?: boolean } = {}): Promise<void> {
    const { d } = this.split(fqdn);
    const ns = nameservers.map((n) => n.trim().toLowerCase().replace(/\.$/, ""));
    if (ns.length < 2 || ns.length > 13 || new Set(ns).size !== ns.length || ns.some((n) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(n))) throw rejected("bad_nameservers");
    // Openprovider DNS signs every zone it hosts (observed: a new domain has a read-only DNSKEY and dnssec=signedDelegation), and the key stays at
    // the registry when the nameservers change (observed). Moving to unsigned DNS with a DS present would stop the name resolving.
    const toOwnDns = ns.every((n) => OP_NAMESERVERS.includes(n));
    if (!toOwnDns && !opts.targetSigned && (await this.getDs(d)).length > 0) throw rejected("dnssec_would_break");
    const id = await this.idOf(d);
    // Observed: the sandbox registry refuses hosts it does not know (code 399, "Parent domain does not exist for host").
    await this.call("UPDATE_DOMAIN", { params: { id }, body: { name_servers: ns.map((name, i) => ({ name, seq_nr: i + 1 })) } }, { fuse: "ns_change" });
  }

  /**
   * Openprovider generates the code: `POST /domains/{id}/authcode/reset` returns a new one (observed: 12 characters with symbols, different on each
   * reset). `PUT /domains/{id}` with our own `auth_code` answered code 0 and changed nothing (observed), so a Mosshatch-generated code cannot be set.
   * The code is read from the reset reply only, returned once and stripped from everything else.
   */
  async issueAuthCode(fqdn: string): Promise<{ code: string; issuedAt: Date }> {
    const { d } = this.split(fqdn);
    const id = await this.idOf(d);
    const r = await this.call("RESET_AUTHCODE", { params: { id }, body: {} }, { fuse: "code_issue", secretOut: true });
    if (!r.secret) throw err("unknown", "no_code_returned", { outcomeUnknown: true });
    return { code: r.secret, issuedAt: this.clock.now() };
  }
  async rerandomizeAuthCode(fqdn: string): Promise<void> {
    const { d } = this.split(fqdn);
    const id = await this.idOf(d);
    await this.call("RESET_AUTHCODE", { params: { id }, body: {} }); // the new code is stripped unread
  }

  // ---- DNS --------------------------------------------------------------------------------------------------------
  private relName(name: string, zone: string): string {
    const n = name.trim().toLowerCase().replace(/\.$/, "");
    return n === zone ? "" : n.endsWith(`.${zone}`) ? n.slice(0, -zone.length - 1) : n;
  }
  /** Observed: TXT values come back wrapped in double quotes; a 300-character value came back as one quoted string. Multi-string join is UNVERIFIED. */
  private unquoteTxt(v: string): string {
    const segs = [...v.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(["\\])/g, "$1"));
    return segs.length ? segs.join("") : v;
  }
  private fromWire(w: WireRecord, zone: string): DnsRecord | null {
    const type = w.type.toUpperCase();
    if (!(DNS_RECORD_TYPES as readonly string[]).includes(type)) return null;
    const name = this.relName(w.name, zone);
    if (type === "TXT") return { type: "TXT", name, value: this.unquoteTxt(w.value) };
    if (type === "SRV") {
      // Observed: SRV value is "weight port target" with the priority in `prio`.
      const [weight, port, target] = w.value.trim().split(/\s+/);
      return { type: "SRV", name, value: target ?? "", priority: w.prio ?? 0, weight: Number(weight), port: Number(port) };
    }
    const r: DnsRecord = { type: type as DnsRecordType, name, value: w.value };
    if (type === "MX") r.priority = w.prio ?? 0;
    return r;
  }
  private toWire(r: DnsRecord): WireRecord {
    if (r.type === "SRV") return { name: r.name, type: "SRV", value: `${r.weight ?? 0} ${r.port ?? 0} ${r.value}`, prio: r.priority ?? 0, ttl: DNS_TTL };
    const w: WireRecord = { name: r.name, type: r.type, value: r.value, ttl: DNS_TTL };
    if (r.type === "MX") w.prio = r.priority ?? 0;
    return w;
  }
  private async zoneRecords(d: string): Promise<WireRecord[] | null> {
    const out: WireRecord[] = [];
    for (let offset = 0; offset < 5000; offset += 500) {
      let r: Reply;
      try { r = await this.call("LIST_ZONE_RECORDS", { params: { name: d }, query: { limit: "500", offset: String(offset) } }); }
      catch (e) { if (e instanceof RegistrarError && e.code === "872") return null; throw e; }
      const rows = arr(r.data.results).flatMap((x) => { const o = obj(x); if (!o) return []; const w: WireRecord = { name: str(o.name) ?? "", type: str(o.type) ?? "", value: str(o.value) ?? "", ttl: num(o.ttl) ?? DNS_TTL }; const p = num(o.prio); if (p !== undefined) w.prio = p; return [w]; });
      out.push(...rows);
      if (rows.length < 500 || out.length >= (num(r.data.total) ?? 0)) break;
    }
    return out;
  }
  /** Hosted means every nameserver of the domain is Openprovider's and the zone exists. SOA and NS are the provider's and never shown. */
  private async zoneState(d: string): Promise<{ hosted: boolean; raw: WireRecord[] }> {
    const dom = await this.detail(d);
    if (!dom) throw rejected("not_in_account");
    const ns = arr(dom.name_servers).map((n) => (str(obj(n)?.name) ?? "").toLowerCase());
    if (!ns.length || !ns.every((n) => OP_NAMESERVERS.includes(n))) return { hosted: false, raw: [] };
    const raw = await this.zoneRecords(d);
    return raw ? { hosted: true, raw: raw.filter((w) => w.type !== "SOA" && w.type !== "NS") } : { hosted: false, raw: [] };
  }
  async getDns(fqdn: string): Promise<DnsZone> {
    const { d } = this.split(fqdn);
    const z = await this.zoneState(d);
    if (!z.hosted) return { hosted: false, records: [] };
    return { hosted: true, records: canonicalZone(z.raw.flatMap((w) => { const r = this.fromWire(w, d); return r ? [r] : []; })) };
  }
  /**
   * Replace-all over per-record operations. The sandbox (2026-09-30) showed why every step is separate and read back:
   *  - `add` and `remove` in one request: the add applied and the remove was silently dropped;
   *  - a `remove` must match the stored form exactly (relative name, TXT value with its quotes, MX/SRV `prio`); otherwise it answers code 0 and
   *    removes nothing, or 18002 when nothing in the batch matched;
   *  - `replace` swaps the whole zone at once (observed), but it is not used: the brief asks for per-record operations, and a half-applied remove
   *    or add is caught by the read-back like any other mismatch.
   * Records of types the port cannot express (CAA and so on) are removed too: this is a replace of the whole zone except SOA and NS.
   */
  async replaceZone(fqdn: string, records: DnsRecord[]): Promise<{ hash: string; records: DnsRecord[] }> {
    const { d } = this.split(fqdn);
    validateZone(records);
    for (const r of records) {
      if (r.type === "SRV" && (r.priority === undefined || r.weight === undefined || r.port === undefined)) throw rejected("srv_fields_required");
      if (r.type === "MX" && r.priority === undefined) throw rejected("mx_priority_required");
    }
    const cur = await this.zoneState(d);
    if (!cur.hosted) throw rejected("dns_not_hosted");
    const want = canonicalZone(records);
    const key = (r: DnsRecord) => zoneHash([r]);
    const wantKeys = new Set(want.map(key));
    const haveKeys = new Set<string>();
    const remove: WireRecord[] = [];
    for (const w of cur.raw) {
      const r = this.fromWire(w, d);
      const k = r ? key(r) : null;
      if (k && wantKeys.has(k) && !haveKeys.has(k)) { haveKeys.add(k); continue; }
      remove.push({ name: this.relName(w.name, d), type: w.type, value: w.value, ttl: w.ttl, ...(w.prio !== undefined && (w.type === "MX" || w.type === "SRV") ? { prio: w.prio } : {}) });
    }
    const add = want.filter((r) => !haveKeys.has(key(r))).map((r) => this.toWire(r));
    const recs = (list: WireRecord[]) => list.map((w) => ({ ...w }) as unknown as Json);
    if (remove.length) await this.call("UPDATE_ZONE", { params: { name: d }, body: { records: { remove: recs(remove) } } });
    if (add.length) await this.call("UPDATE_ZONE", { params: { name: d }, body: { records: { add: recs(add) } } });
    const back = await this.getDns(d);
    if (!back.hosted || zoneHash(back.records) !== zoneHash(want)) throw rejected("dns_readback_mismatch");
    return { hash: zoneHash(back.records), records: back.records };
  }

  // ---- DNSSEC -----------------------------------------------------------------------------------------------------
  /** DS records as the registry derives them (SHA-256) from the DNSKEYs Openprovider holds for the domain. */
  async getDs(fqdn: string): Promise<DsRecord[]> {
    const { d } = this.split(fqdn);
    const raw = await this.detail(d);
    if (!raw) throw rejected("not_in_account");
    return this.keysOf(raw).map((k) => dsFromDnskey(d, k, 2));
  }
  private checkDs(ds: DsRecord) {
    if (!Number.isInteger(ds.keyTag) || ds.keyTag < 0 || ds.keyTag > 65535 || !Number.isInteger(ds.algorithm) || !Number.isInteger(ds.digestType) || !/^[0-9a-f]{20,128}$/i.test(ds.digest)) throw rejected("bad_ds");
  }
  /** Openprovider accepts DNSKEY material only (the registry computes the DS); a DS alone cannot be added. Use `addDnskey`. */
  async addDs(fqdn: string, ds: DsRecord): Promise<void> {
    this.split(fqdn); this.checkDs(ds);
    throw rejected("dnssec_dnskey_required");
  }
  async removeDs(fqdn: string, ds: DsRecord): Promise<void> {
    const { d } = this.split(fqdn); this.checkDs(ds);
    const raw = await this.detail(d); if (!raw) throw rejected("not_in_account");
    const keys = this.keysOf(raw);
    const keep = keys.filter((k) => !dsMatchesKey(d, ds, k));
    if (keep.length === keys.length) return;
    await this.writeKeys(d, keep);
    const back = await this.detail(d);
    if (!back || this.keysOf(back).some((k) => dsMatchesKey(d, ds, k))) throw rejected("dnssec_key_not_applied");
  }
  /** Observed: `dnssec_keys` on `PUT /domains/{id}` replaces the whole key set; an empty set with `is_dnssec_enabled: false` made the domain unsigned. */
  private async writeKeys(d: string, keys: (Dnskey & { readonly?: number })[]) {
    const id = await this.idOf(d);
    await this.call("UPDATE_DOMAIN", { params: { id }, body: {
      is_dnssec_enabled: keys.length > 0,
      dnssec_keys: keys.map((k) => ({ flags: k.flags, protocol: k.protocol, alg: k.algorithm, pub_key: k.publicKey })),
    } });
  }
  private checkKey(k: Dnskey) {
    if (![256, 257].includes(k.flags) || k.protocol !== 3 || !Number.isInteger(k.algorithm) || k.algorithm < 1 || k.algorithm > 255 || !/^[A-Za-z0-9+/]{20,}={0,2}$/.test(k.publicKey.replace(/\s+/g, ""))) throw rejected("bad_dnskey");
  }
  /** Adapter extra (not on the port): adds a DNSKEY; idempotent. The DS that results is `dsFromDnskey(fqdn, key)`. */
  async addDnskey(fqdn: string, key: Dnskey): Promise<DsRecord> {
    const { d } = this.split(fqdn); this.checkKey(key);
    const raw = await this.detail(d); if (!raw) throw rejected("not_in_account");
    const keys = this.keysOf(raw);
    const same = (k: Dnskey) => k.flags === key.flags && k.algorithm === key.algorithm && k.publicKey.replace(/\s+/g, "") === key.publicKey.replace(/\s+/g, "");
    if (!keys.some(same)) {
      await this.writeKeys(d, [...keys, key]);
      // Observed 2026-09-30: while Openprovider's own read-only key is on the domain (its DNS signs the zone), a written key set is accepted with
      // code 0 and the added key silently dropped. Read back and say so instead of reporting success.
      const back = await this.detail(d);
      if (!back || !this.keysOf(back).some(same)) throw rejected("dnssec_key_not_applied");
    }
    return dsFromDnskey(d, key, 2);
  }

  // ---- contacts ---------------------------------------------------------------------------------------------------
  /**
   * Observed 2026-09-30 (sandbox, .com): a new email on the owner handle applied at once; a new name on a handle answered success and changed
   * nothing; pointing the domain at a new owner handle applied at once, with no pending ICANN Change of Registrant step visible in the API.
   * So a name change goes through a new handle and every change reports `applied`. `transferLock60d` follows the ICANN rule and is UNVERIFIED
   * at Openprovider (no lock was visible afterwards; `is_locked` did not change).
   */
  async updateContact(fqdn: string, registrant: Registrant): Promise<ContactChangeResult> {
    const { d } = this.split(fqdn);
    const raw = await this.detail(d); if (!raw) throw rejected("not_in_account");
    const handle = str(raw.owner_handle);
    const cur = await this.registrantOf(handle);
    const lc = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const nameChanged = !cur || lc(cur.name) !== lc(registrant.name), emailChanged = !cur || lc(cur.email) !== lc(registrant.email);
    this.fuse.take("contact_change");
    const id = await this.idOf(d);
    if (nameChanged || !handle) {
      const h = await this.createHandle(registrant);
      await this.call("UPDATE_DOMAIN", { params: { id }, body: { owner_handle: h } });
    } else {
      const b = this.customerBody(registrant);
      await this.call("UPDATE_CUSTOMER", { params: { handle }, body: { email: b.email!, phone: b.phone!, address: b.address! } });
    }
    const registrantChange = nameChanged || emailChanged;
    return { status: "applied", registrantChange, verificationRequired: emailChanged, transferLock60d: registrantChange };
  }

  // ---- transfers --------------------------------------------------------------------------------------------------
  /** The spec has no list of outbound transfers and no status for one was observed; returning [] would hide a hostile transfer, so this refuses. */
  async getTransfersAway(): Promise<TransferAway[]> { throw rejected("transfers_away_unsupported"); }
  async cancelTransfer(fqdn: string): Promise<{ cancelled: boolean }> {
    const { d } = this.split(fqdn);
    const raw = await this.detail(d);
    // Observed: an active .com reports transfer_cancel_supported=false. Cancelling a real pending transfer is UNVERIFIED (none could be started).
    if (!raw || !PENDING.has(str(raw.status) ?? "") || !bool(raw.transfer_cancel_supported)) return { cancelled: false };
    try { await this.call("DELETE_DOMAIN", { params: { id: num(raw.id) ?? 0 }, query: {} }); return { cancelled: true }; }
    catch (e) { if (e instanceof RegistrarError && e.kind === "rejected") return { cancelled: false }; throw e; }
  }
  /** Re-locks and resets the code. Openprovider exposes no outbound transfer state, so `pendingTransferRemains` is reported true: never assume it ended. */
  async stopTransferAway(fqdn: string) {
    await this.setLock(fqdn, true);
    await this.rerandomizeAuthCode(fqdn);
    return { relocked: true as const, codeRerandomized: true as const, pendingTransferRemains: true };
  }
  async setAutoRenew(fqdn: string, enabled: boolean): Promise<void> {
    const { d } = this.split(fqdn);
    const id = await this.idOf(d);
    await this.call("UPDATE_DOMAIN", { params: { id }, body: { autorenew: enabled ? "on" : "off" } });
  }

  // ---- transfer-in ------------------------------------------------------------------------------------------------
  // The sandbox checks the code synchronously (observed: 358 "Authorization code is invalid" for any wrong code, even for an unregistered
  // name), and no domain exists at another sandbox registrar to transfer, so only the refusal paths were seen. Status mapping is UNVERIFIED.
  async checkTransferIn(fqdn: string): Promise<TransferInCheck> {
    const { d, name, tld } = this.split(fqdn);
    const mine = await this.find(d);
    if (mine && str(mine.status) !== "DEL") return { fqdn: d, transferable: false, reason: "already_here", registryStatuses: [] };
    const r = await this.call("CHECK", { body: { domains: [{ name, extension: tld }], with_price: false } });
    const st = str(obj(arr(r.data.results)[0])?.status) ?? "";
    if (st === "free") return { fqdn: d, transferable: false, reason: "not_registered", registryStatuses: [] };
    // UNVERIFIED: the check does not say whether the losing registrar holds a transfer lock; the transfer order itself reports that.
    return st === "active" ? { fqdn: d, transferable: true, registryStatuses: [] } : { fqdn: d, transferable: false, reason: "other", registryStatuses: [] };
  }
  async startTransferIn(req: TransferInRequest): Promise<TransferInStart> {
    const { d, name, tld } = this.split(req.fqdn); this.checkSales(tld);
    if (req.years !== (tld === "ai" ? 2 : 1)) throw rejected("invalid_period");
    if (typeof req.authCode !== "string" || !/^[\x21-\x7e]{6,64}$/.test(req.authCode)) throw rejected("auth_code_required");
    const q = await this.quote(d, req.years, "transfer");
    if (q.isRegistryPremium) throw rejected("premium_refused");
    const handle = await this.createHandle(req.registrant);
    let r: Reply;
    try {
      r = await this.call("TRANSFER_DOMAIN", { body: {
        domain: { name, extension: tld }, period: req.years, unit: "y", auth_code: req.authCode,
        owner_handle: handle, admin_handle: handle, tech_handle: handle, billing_handle: handle, autorenew: "off",
        // Keep the domain's own nameservers (a signed domain moved to our DNS would stop resolving). Observed: the flag alone is refused with 223;
        // with ns_group as well it passes validation. UNVERIFIED which of the two wins on a real transfer.
        import_nameservers_from_registry: true, ns_group: "dns-openprovider", is_private_whois_enabled: false, comments: `mh:${req.regUsername}`,
      } });
    } catch (e) { if (e instanceof RegistrarError && e.code === "358") throw rejected("invalid_auth_code"); throw e; }
    const id = num(r.data.id); if (id !== undefined) this.ids.set(d, id);
    // UNVERIFIED: whether Openprovider emails the owner for a .com transfer with a valid code (a send-foa1 call exists; it is not used).
    return { status: "pending_registry", registrarOrderId: id !== undefined ? String(id) : "", ownerEmailSent: false };
  }
  async getTransferInStatus(fqdn: string): Promise<TransferInState | null> {
    const { d } = this.split(fqdn);
    const raw = await this.detail(d);
    if (!raw || (str(raw.type) ?? "").toUpperCase() !== "TRANSFER") return null;
    const s = str(raw.status) ?? "";
    const map: Record<string, TransferInStatus> = { ACT: "completed", REQ: "pending_registry", PEN: "pending_registry", SCH: "pending_registry", FAI: "cancelled", DEL: "cancelled" };
    const status = map[s]; if (!status) return null;
    const out: TransferInState = { fqdn: d, status, registrarOrderId: String(num(raw.id) ?? "") };
    const at = parseAmsterdam(str(raw.order_date)); if (at) out.requestedAt = at;
    const exp = parseUtc(str(raw.expiration_date)); if (status === "completed" && exp) out.expiresAt = exp;
    if (status === "cancelled") out.failure = "unknown";
    return out;
  }
  async cancelTransferIn(fqdn: string): Promise<{ cancelled: boolean }> { return this.cancelTransfer(fqdn); }

  // ---- inventory and lifecycle -------------------------------------------------------------------------------------
  async listDomains(opts: { cursor?: string; limit?: number } = {}): Promise<{ rows: InventoryRow[]; next?: string }> {
    const offset = opts.cursor ? Number(opts.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw rejected("bad_cursor");
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 100));
    // Newest first: a name registered during a scan shifts later pages by one, which repeats a row (harmless, callers key by name) instead of
    // skipping one, as a deletion would with oldest-first paging.
    const r = await this.call("LIST_DOMAINS", { query: { limit: String(limit), offset: String(offset), "order_by.id": "desc" } });
    const results = arr(r.data.results).map(obj);
    const rows = results.flatMap((o) => {
      if (!o || str(o.status) === "DEL") return [];
      const f = `${str(obj(o.domain)?.name)}.${str(obj(o.domain)?.extension)}`.toLowerCase();
      const e = parseUtc(str(o.registry_expiration_date)) ?? parseUtc(str(o.expiration_date));
      return e ? [{ fqdn: f, expiresAt: e }] : [];
    });
    const total = num(r.data.total) ?? 0;
    return offset + results.length < total && results.length > 0 ? { rows, next: String(offset + results.length) } : { rows };
  }
  /** Observed: a deleted name has status DEL, `delete_status` softQuarantine and `restorable_until`; `deleted_at` stayed 0000-00-00 (so `last_changed` stands in). */
  async getDeletedDomains(): Promise<DeletedDomain[]> {
    const out: DeletedDomain[] = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const r = await this.call("LIST_DOMAINS", { query: { status: "DEL", limit: "100", offset: String(offset), "order_by.id": "asc" } });
      const results = arr(r.data.results).map(obj);
      for (const o of results) {
        if (!o) continue;
        const f = `${str(obj(o.domain)?.name)}.${str(obj(o.domain)?.extension)}`.toLowerCase();
        const end = parseUtc(str(o.restorable_until)); if (!end) continue;
        out.push({ fqdn: f, deletedAt: parseUtc(str(o.deleted_at)) ?? parseAmsterdam(str(o.last_changed)) ?? new Date(0), redemptionEndsAt: end });
      }
      if (results.length < 100) break;
    }
    return out;
  }
  async restore(fqdn: string) {
    const { d, tld } = this.split(fqdn);
    if (!RESTORE_TLDS[tld]) throw rejected("restore_unsupported");
    const hit = await this.find(d);
    if (!hit || str(hit.status) !== "DEL") throw rejected("not_restorable");
    const id = num(hit.id) ?? 0;
    const r = await this.call("RESTORE_DOMAIN", { params: { id }, body: {} });
    return str(r.data.status) === "ACT" ? { status: "restored" as const, registrarOrderId: String(id) } : { status: "accepted_pending" as const, registrarOrderId: String(id) };
  }
}
