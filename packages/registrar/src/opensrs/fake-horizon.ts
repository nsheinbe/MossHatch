import { DNS_RECORD_TYPES, RegistrarError, type DnsRecord, type DnsRecordType, type Registrant } from "../port.ts";
import { MockRegistrarPort } from "../mock-port.ts";
import { DNS_VALUE_KEY, type HttpRequest, type HttpResponse, type HttpTransport } from "./adapter.ts";
import { opsSignature } from "./sign.ts";
import { arr, decodeOps, obj, str, type OpsObject, type OpsValue } from "./xml.ts";

/**
 * A fake Horizon: speaks the OPS XML envelope over the injectable transport and answers with documented-shape responses.
 * source: "documented" -- every response body here is HAND-WRITTEN from docs/research/reg-opensrs.md and the API guide pages it cites, never
 * recorded from a real Horizon (no credentials exist). Response attribute names the dossier does not give are the same UNVERIFIED names the
 * adapter uses, so passing the contract proves the wiring, not the wire.
 * State lives in a MockRegistrarPort (the fake never re-implements registry behaviour), so the same contract suite runs against both.
 */
export const FIXTURE_SOURCE = "documented" as const;

const two = (n: number) => String(n).padStart(2, "0");
const dt = (d: Date) => `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
const money = (m: bigint) => `${m / 100n}.${String(m % 100n).padStart(2, "0")}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function enc(v: OpsValue): string {
  if (Array.isArray(v)) return `<dt_array>${v.map((x, i) => `<item key="${i}">${enc(x)}</item>`).join("")}</dt_array>`;
  if (v && typeof v === "object") return `<dt_assoc>${Object.entries(v).map(([k, x]) => `<item key="${esc(k)}">${enc(x)}</item>`).join("")}</dt_assoc>`;
  return esc(String(v ?? ""));
}
/** The documented reply envelope: response_code / is_success / response_text / attributes (S11, S15). */
export function opsReply(code: number, attributes: OpsObject = {}, text = code === 200 ? "Command completed successfully" : code === 250 ? "Command accepted, processing asynchronously" : "Command failed"): string {
  const body: OpsObject = { protocol: "XCP", object: "DOMAIN", response_code: String(code), action: "REPLY", is_success: code === 200 || code === 250 || code === 210 || code === 211 ? "1" : "0", response_text: text, attributes };
  return `<?xml version='1.0' encoding='UTF-8' standalone='no' ?>\n<!DOCTYPE OPS_envelope SYSTEM 'ops.dtd'>\n<OPS_envelope><header><version>0.9</version></header><body><data_block>${enc(body)}</data_block></body></OPS_envelope>`;
}

const CODE_BY_MOCK: Record<string, number> = {
  domain_taken: 485, order_exists: 486, not_found: 480, invalid_period: 465, period_required: 465, premium_refused: 465, reserved: 465,
  "541": 541, "555": 555, draft_exists: 465, renew_failed: 465, profile_exists: 465, bad_profile: 465, unsupported_tld: 465,
};

export interface FakeFaults {
  /** The ST-107 harness rule: any SW_REGISTER, RENEW or GET_PRICE that omits `period` fails (real OpenSRS would silently use 2). */
  defaultPeriod2: boolean;
  /** Real OpenSRS behaviour: an omitted `period` is treated as 2 and billed for two years. */
  silentDefault2: boolean;
  /** Extra minor units debited after each successful SW_REGISTER (a bill that differs from the quote). */
  overbillMinor: bigint;
  /** The next N requests throw as if the connection failed before any answer. */
  dropNext: number;
  /** The next SW_REGISTER/MODIFY is applied and THEN the connection drops (timeout after accept). */
  dropAfterApplyNext: number;
}

export interface RecordedRequest { action: string; object: string; attributes: OpsObject; signatureOk: boolean }

export class FakeHorizonTransport implements HttpTransport {
  readonly requests: RecordedRequest[] = [];
  readonly faults: FakeFaults = { defaultPeriod2: false, silentDefault2: false, overbillMinor: 0n, dropNext: 0, dropAfterApplyNext: 0 };
  /** Every URL a request was sent to (a preview or sandbox deployment must never appear at the live host). */
  readonly urls: string[] = [];
  constructor(readonly mock: MockRegistrarPort, private cred: { username: string; apiKey: string }) {}

  /** "Generating a new API key immediately invalidates the previous key" (K1). */
  rotateKey(newKey: string) { this.cred = { ...this.cred, apiKey: newKey }; }

  async post(req: HttpRequest): Promise<HttpResponse> {
    this.urls.push(req.url);
    if (this.faults.dropNext > 0) { this.faults.dropNext--; throw new Error("connection reset"); }
    const sigOk = req.headers["X-Username"] === this.cred.username && req.headers["X-Signature"] === opsSignature(req.body, this.cred.apiKey);
    if (!sigOk) { this.requests.push({ action: "?", object: "?", attributes: {}, signatureOk: false }); return { status: 401, body: "" }; }
    const msg = decodeOps(req.body);
    const action = str(msg.action) ?? "", object = str(msg.object) ?? "", attrs = obj(msg.attributes) ?? {};
    this.requests.push({ action, object, attributes: attrs, signatureOk: true });
    try {
      const out = await this.dispatch(action, attrs);
      if (this.faults.dropAfterApplyNext > 0 && (action === "SW_REGISTER" || action === "MODIFY")) { this.faults.dropAfterApplyNext--; throw new Error("timeout after accept"); }
      return { status: 200, body: out };
    } catch (e) {
      if (e instanceof RegistrarError) return { status: 200, body: this.errorReply(e) };
      throw e;
    }
  }

  private errorReply(e: RegistrarError): string {
    if (e.kind === "maintenance") return opsReply(701, {}, "registry unavailable");
    if (e.kind === "rate_limited") return opsReply(300, {});
    if (e.kind === "insufficient_funds") return opsReply(440, {});
    if (e.outcomeUnknown) return opsReply(705, {}, "Timed out, resubmit request");
    return opsReply(CODE_BY_MOCK[e.code ?? ""] ?? 465, {});
  }

  private registrantFrom(attrs: OpsObject): Registrant {
    const o = obj(obj(attrs.contact_set)?.owner) ?? {}; const g = (k: string) => str(o[k]) ?? "";
    return { name: `${g("first_name")} ${g("last_name")}`.trim(), email: g("email"), phone: g("phone"), street: g("address1"), city: g("city"), region: g("state"), postalCode: g("postal_code"), country: g("country") };
  }
  private period(action: string, attrs: OpsObject): number | RegistrarError {
    const p = str(attrs.period);
    if (p === undefined) {
      if (this.faults.defaultPeriod2) return new RegistrarError("rejected", "period is required", { retryable: false, outcomeUnknown: false, code: "period_required" });
      if (this.faults.silentDefault2 && action === "SW_REGISTER") { this.mock.faults.set("defaultPeriod2", { times: 1 }); return 1; }
      return 2; // the documented OpenSRS default
    }
    return Number(p);
  }

  private async dispatch(action: string, a: OpsObject): Promise<string> {
    const m = this.mock; const domain = str(a.domain) ?? "";
    switch (action) {
      case "LOOKUP": {
        const r = await m.checkAvailability(domain, { noCache: str(a.no_cache) === "1" });
        if (r.kind === "available") return opsReply(210, { status: "available" });
        if (r.kind === "premium") return opsReply(210, { status: "available", is_registry_premium: "1" });
        if (r.kind === "unknown") return opsReply(200, { status: "unknown" });
        return opsReply(211, { status: "taken" });
      }
      case "GET_PRICE": {
        const p = this.period(action, a); if (p instanceof RegistrarError) throw p;
        const q = await m.quote(domain, p, str(a.reg_type) === "renewal" ? "renew" : "register");
        return opsReply(200, { price: money(str(a.reg_type) === "renewal" ? q.renewalWholesale.minor : q.wholesale.minor), is_registry_premium: q.isRegistryPremium ? "1" : "0" });
      }
      case "SW_REGISTER": {
        const p = this.period(action, a); if (p instanceof RegistrarError) throw p;
        const before = m.fundingBalance;
        const r = await m.register({ fqdn: domain, years: p, regUsername: str(a.reg_username) ?? "", regPassword: str(a.reg_password) ?? "", registrant: this.registrantFrom(a) });
        if (r.status === "registered" && this.faults.overbillMinor > 0n) m.setBalance(m.fundingBalance - this.faults.overbillMinor);
        void before;
        if (r.status === "accepted_pending") return r.reason === "async" ? opsReply(250, { id: r.registrarOrderId }) : opsReply(200, { id: r.registrarOrderId, forced_pending: "1" });
        return opsReply(200, { id: r.registrarOrderId, registration_code: "documented-shape" });
      }
      case "RENEW": {
        const p = this.period(action, a); if (p instanceof RegistrarError) throw p;
        const r = await m.renew(domain, p, Number(str(a.currentexpirationyear)));
        return opsReply(200, r.status === "renewed" ? { order_id: r.registrarOrderId } : { order_id: r.registrarOrderId, forced_pending: "1" });
      }
      case "GET": return this.get(domain, str(a.type) ?? "");
      case "MODIFY": {
        const data = str(a.data);
        if (data === "status") await m.setLock(domain, str(a.lock_state) === "1");
        else if (data === "domain_auth_info") m.setAuthInfo(domain, str(a.domain_auth_info) ?? "");
        else if (data === "expire_action") await m.setAutoRenew(domain, str(a.auto_renew) === "1");
        else if (data === "contact_info") await m.updateContact(domain, this.registrantFrom(a));
        else return opsReply(465, {});
        return opsReply(200, {});
      }
      case "ADVANCED_UPDATE_NAMESERVERS":
        await m.setNameservers(domain, arr(a.assign_ns).map(String), { targetSigned: true }); return opsReply(200, {});
      case "GET_DNS_ZONE": {
        const z = await m.getDns(domain);
        const recs: OpsObject = {};
        for (const t of DNS_RECORD_TYPES) recs[t] = z.records.filter((r) => r.type === t).map((r) => ({ subdomain: r.name, [DNS_VALUE_KEY[t]]: r.value, ...(r.priority !== undefined ? { priority: String(r.priority) } : {}), ...(r.weight !== undefined ? { weight: String(r.weight) } : {}), ...(r.port !== undefined ? { port: String(r.port) } : {}) }));
        return opsReply(200, { nameservers_ok: z.hosted ? "1" : "0", records: recs });
      }
      case "SET_DNS_ZONE": {
        const src = obj(a.records) ?? {}; const payload: Partial<Record<DnsRecordType, DnsRecord[]>> = {};
        for (const t of DNS_RECORD_TYPES) {
          if (!(t in src)) continue;
          payload[t] = arr(src[t]).map((x) => {
            const o = obj(x) ?? {}; const r: DnsRecord = { type: t, name: str(o.subdomain) ?? "", value: str(o[DNS_VALUE_KEY[t]]) ?? "" };
            if (o.priority !== undefined) r.priority = Number(str(o.priority)); if (o.weight !== undefined) r.weight = Number(str(o.weight)); if (o.port !== undefined) r.port = Number(str(o.port));
            return r;
          });
        }
        m.rawSetZone(domain, payload); return opsReply(200, {});
      }
      case "GET_DNSSEC_INFO": return opsReply(200, { dnssec: (await m.getDs(domain)).map((d) => ({ key_tag: String(d.keyTag), algorithm: String(d.algorithm), digest_type: String(d.digestType), digest: d.digest })) });
      case "SET_DNSSEC_INFO": {
        const want = arr(a.dnssec_info).map((x) => { const o = obj(x) ?? {}; return { keyTag: Number(str(o.key_tag)), algorithm: Number(str(o.algorithm)), digestType: Number(str(o.digest_type)), digest: str(o.digest) ?? "" }; });
        const have = await m.getDs(domain); const same = (x: typeof want[0], y: typeof want[0]) => x.keyTag === y.keyTag && x.digest.toLowerCase() === y.digest.toLowerCase();
        for (const h of have) if (!want.some((w) => same(w, h))) await m.removeDs(domain, h);
        for (const w of want) if (!have.some((h) => same(w, h))) await m.addDs(domain, w);
        return opsReply(200, {});
      }
      case "GET_TRANSFERS_AWAY": {
        const st = str(a.status) as "pending_owner" | undefined;
        const list = await m.getTransfersAway(st ? { statuses: [st] } : {});
        return opsReply(200, { transfers: list.map((t) => ({ domain: t.fqdn, status: t.status, request_date: dt(t.requestedAt), ...(t.gainingRegistrar ? { gaining_registrar: t.gainingRegistrar } : {}) })) });
      }
      case "CANCEL_TRANSFER": return (await m.cancelTransfer(domain)).cancelled ? opsReply(200, {}) : opsReply(465, {});
      case "GET_BALANCE": { const b = await m.getBalance(); return opsReply(200, { balance: money(b.balance.minor), hold_balance: money(b.held.minor) }); }
      case "GET_DOMAINS_BY_EXPIREDATE": {
        const all: { fqdn: string; expiresAt: Date }[] = []; let cursor: string | undefined;
        do { const r = await m.listDomains({ ...(cursor ? { cursor } : {}), limit: 100 }); all.push(...r.rows); cursor = r.next; } while (cursor);
        const limit = Number(str(a.limit) ?? 40), page = Number(str(a.page) ?? 1);
        return opsReply(200, { total: String(all.length), page: String(page), exp_domains: all.slice((page - 1) * limit, page * limit).map((r) => ({ name: r.fqdn, expiredate: dt(r.expiresAt) })) });
      }
      case "GET_DELETED_DOMAINS": return opsReply(200, { deleted_domains: (await m.getDeletedDomains()).map((d) => ({ name: d.fqdn, delete_date: dt(d.deletedAt), redemption_grace_period_end_date: dt(d.redemptionEndsAt) })) });
      case "GET_ORDERS_BY_DOMAIN":
        return opsReply(200, { orders: (await m.getOrdersByDomain(domain)).map((o) => ({ order_id: o.registrarOrderId, type: o.type, status: o.status, req_date: dt(o.orderDate), ...(o.profileUsername ? { reg_username: o.profileUsername } : {}) })) });
      case "PROCESS_PENDING": return (await m.cancelPendingOrder(str(a.order_id) ?? "")).cancelled ? opsReply(200, {}) : opsReply(465, {});
      case "REDEEM": {
        const r = await m.restore(domain);
        return opsReply(200, r.status === "restored" ? { order_id: r.registrarOrderId ?? "" } : { order_id: r.registrarOrderId ?? "", forced_pending: "1" });
      }
      default: return opsReply(465, {}, "unknown command in the fake");
    }
  }

  private async get(domain: string, type: string): Promise<string> {
    const d = await this.mock.getDomain(domain); const rec = this.mock.domainRecord(domain);
    if (!d || !rec || rec.foreign) return opsReply(480, {}, "Domain not found");
    if (type === "all_info") {
      const r = rec.registrant;
      return opsReply(200, {
        expiredate: dt(d.expiresAt!), registry_createdate: dt(d.createdAt!), auto_renew: d.autoRenew ? "1" : "0", let_expire: d.letExpire ? "1" : "0", sponsoring_rsp: "1", reg_username: d.profileUsername ?? "",
        nameserver_list: d.nameservers.map((n, i) => ({ sortorder: String(i + 1), name: n })),
        contact_set: { owner: r ? { first_name: r.name.split(" ")[0] ?? "", last_name: r.name.split(" ").slice(1).join(" ") || (r.name.split(" ")[0] ?? ""), org_name: "", address1: r.street, city: r.city, state: r.region, postal_code: r.postalCode, country: r.country, phone: r.phone, email: r.email } : {} },
      });
    }
    if (type === "status") return opsReply(200, { lock_state: d.locked ? "1" : "0", can_modify: "1", transfer_away_in_progress: d.transferAwayInProgress ? "1" : "0", domain_supports: { lock: "1" }, auctionescrow: "0" });
    if (type === "whois_privacy_state") return opsReply(200, { state: d.privacyServiceEnabled ? "enabled" : "disabled" });
    return opsReply(465, {});
  }
}
