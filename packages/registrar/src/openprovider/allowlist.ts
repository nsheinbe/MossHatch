import { RegistrarError } from "../port.ts";
import { JsonNum, type Json } from "./wire.ts";

/**
 * Operation allow-list for the Openprovider REST API (the same role as the OpenSRS command allow-list: one reseller-wide login cannot be scoped, so
 * the `registrar` project sends only what the adapter needs). Every request names an operation; its method, path template, query keys and body
 * keys are checked here BEFORE a token is fetched or a request is built. Anything else is refused with a `rejected` error that carries a code only.
 *
 * `verified`: `sandbox` means the operation was called against api.sandbox.openprovider.nl on 2026-09-30 with these keys and the effect was
 * read back; `spec` means only the OpenAPI document (developer.openprovider.com/data/swagger.json) was read.
 *
 * Deliberately absent: `GET /domains/{id}/authcode` (Mosshatch never reads a stored code back), `POST /domains/trade`, `POST .../transfer/approve`
 * (approving an outbound transfer early), `PUT /domains/{id}` with `auth_code`, `reset_auth_code` or handle fields other than the owner, and the
 * `replace`/`update` sub-operations of `PUT /dns/zones/{name}` (the adapter writes DNS with per-record add and remove only).
 */
export type OpName =
  | "LOGIN" | "CHECK" | "PRICE" | "RESELLER" | "CREATE_CUSTOMER" | "GET_CUSTOMER" | "UPDATE_CUSTOMER"
  | "CREATE_DOMAIN" | "TRANSFER_DOMAIN" | "LIST_DOMAINS" | "GET_DOMAIN" | "UPDATE_DOMAIN" | "RENEW_DOMAIN" | "RESET_AUTHCODE" | "RESTORE_DOMAIN" | "DELETE_DOMAIN"
  | "GET_ZONE" | "LIST_ZONE_RECORDS" | "UPDATE_ZONE";
export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface OpRule {
  op: OpName; method: Method;
  /** Path template relative to /v1 with `{id}`, `{handle}` or `{name}` parameters. */
  path: string;
  write: boolean;
  query?: readonly string[];
  body?: readonly string[];
  requiredBody?: readonly string[];
  /** Billed orders must state the term (the provider default is not relied on; observed 2026-09-30: a renew without `period` renewed one year). */
  explicitPeriod?: boolean;
  check?: (body: Record<string, Json>, query: Record<string, string>) => string | null;
  verified: "sandbox" | "spec";
}
const R = (r: OpRule): [OpName, OpRule] => [r.op, r];
const HANDLES = ["owner_handle", "admin_handle", "tech_handle", "billing_handle"] as const;

export const OPERATIONS: ReadonlyMap<OpName, OpRule> = new Map([
  R({ op: "LOGIN", method: "POST", path: "/auth/login", write: false, body: ["username", "password", "ip"], requiredBody: ["username", "password", "ip"], verified: "sandbox" }),
  R({ op: "CHECK", method: "POST", path: "/domains/check", write: false, body: ["domains", "with_price"], requiredBody: ["domains"],
    check: (b) => (Array.isArray(b.domains) && b.domains.length === 1 ? null : "one_domain_per_check"), verified: "sandbox" }),
  R({ op: "PRICE", method: "GET", path: "/domains/prices", write: false, query: ["domain.name", "domain.extension", "operation", "period"],
    check: (_b, q) => (["create", "renew", "transfer", "restore"].includes(q.operation ?? "") && /^(10|[1-9])$/.test(q.period ?? "") ? null : "price_query_invalid"), verified: "sandbox" }),
  R({ op: "RESELLER", method: "GET", path: "/resellers", write: false, query: [], verified: "sandbox" }),
  R({ op: "CREATE_CUSTOMER", method: "POST", path: "/customers", write: true, body: ["name", "email", "phone", "address", "company_name"], requiredBody: ["name", "email", "phone", "address"], verified: "sandbox" }),
  R({ op: "GET_CUSTOMER", method: "GET", path: "/customers/{handle}", write: false, query: [], verified: "sandbox" }),
  // Name changes are not sent here: the sandbox accepts a new name on a handle and silently keeps the old one (observed 2026-09-30).
  R({ op: "UPDATE_CUSTOMER", method: "PUT", path: "/customers/{handle}", write: true, body: ["email", "phone", "address"], verified: "sandbox" }),
  R({ op: "CREATE_DOMAIN", method: "POST", path: "/domains", write: true, explicitPeriod: true,
    body: ["domain", "period", "unit", ...HANDLES, "autorenew", "name_servers", "is_private_whois_enabled", "comments"],
    requiredBody: ["domain", "period", "unit", ...HANDLES, "autorenew", "name_servers", "comments"],
    check: (b) => (b.autorenew !== "off" ? "autorenew_must_be_off" : b.unit !== "y" ? "unit_must_be_years" : null), verified: "sandbox" }),
  R({ op: "TRANSFER_DOMAIN", method: "POST", path: "/domains/transfer", write: true, explicitPeriod: true,
    body: ["domain", "period", "unit", "auth_code", ...HANDLES, "autorenew", "ns_group", "import_nameservers_from_registry", "is_private_whois_enabled", "comments"],
    requiredBody: ["domain", "period", "unit", "auth_code", ...HANDLES, "autorenew", "comments"],
    check: (b) => (typeof b.auth_code !== "string" || b.auth_code.length < 6 ? "auth_code_required" : b.autorenew !== "off" ? "autorenew_must_be_off" : null), verified: "spec" }),
  R({ op: "LIST_DOMAINS", method: "GET", path: "/domains", write: false, query: ["full_name", "limit", "offset", "order_by.id", "status"], verified: "sandbox" }),
  R({ op: "GET_DOMAIN", method: "GET", path: "/domains/{id}", write: false, query: ["with_registry_statuses"], verified: "sandbox" }),
  R({ op: "UPDATE_DOMAIN", method: "PUT", path: "/domains/{id}", write: true, body: ["is_locked", "name_servers", "autorenew", "dnssec_keys", "is_dnssec_enabled", "owner_handle"],
    check: (b) => (Object.keys(b).length === 0 ? "empty_update" : b.autorenew !== undefined && b.autorenew !== "on" && b.autorenew !== "off" ? "autorenew_value" : null), verified: "sandbox" }),
  R({ op: "RENEW_DOMAIN", method: "POST", path: "/domains/{id}/renew", write: true, explicitPeriod: true, body: ["period"], requiredBody: ["period"], verified: "sandbox" }),
  R({ op: "RESET_AUTHCODE", method: "POST", path: "/domains/{id}/authcode/reset", write: true, body: [], verified: "sandbox" }),
  R({ op: "RESTORE_DOMAIN", method: "POST", path: "/domains/{id}/restore", write: true, body: [], verified: "sandbox" }),
  // Used only for pending orders and pending transfers; the adapter re-reads the status first and never sends it for an active name.
  R({ op: "DELETE_DOMAIN", method: "DELETE", path: "/domains/{id}", write: true, query: [], verified: "sandbox" }),
  R({ op: "GET_ZONE", method: "GET", path: "/dns/zones/{name}", write: false, query: ["with_records"], verified: "sandbox" }),
  R({ op: "LIST_ZONE_RECORDS", method: "GET", path: "/dns/zones/{name}/records", write: false, query: ["limit", "offset"], verified: "sandbox" }),
  // One sub-operation per request: sent together, `add` applied and `remove` was silently dropped (observed 2026-09-30).
  R({ op: "UPDATE_ZONE", method: "PUT", path: "/dns/zones/{name}", write: true, body: ["records"], requiredBody: ["records"],
    check: (b) => {
      const r = b.records; if (!r || typeof r !== "object" || Array.isArray(r) || r instanceof JsonNum) return "records_shape";
      const keys = Object.keys(r); return keys.length === 1 && (keys[0] === "add" || keys[0] === "remove") ? null : "one_record_operation";
    }, verified: "sandbox" }),
]);

const FQDN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,24}$/;
const PARAM: Record<string, RegExp> = { id: /^[1-9]\d{0,11}$/, handle: /^[A-Z0-9][A-Z0-9-]{2,39}$/i, name: FQDN };
const refuse = (code: string) => new RegistrarError("rejected", "operation refused before sending", { retryable: false, outcomeUnknown: false, code });

export interface OpRequest { params?: Record<string, string | number>; query?: Record<string, string>; body?: Record<string, Json> }

/** Validates and returns the rule plus the concrete path. Throws a `rejected` RegistrarError (codes only) otherwise. */
export function checkOperation(op: OpName, req: OpRequest): { rule: OpRule; path: string } {
  const rule = OPERATIONS.get(op);
  if (!rule) throw refuse("operation_not_allowed");
  const params = req.params ?? {};
  const path = rule.path.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = params[k]; const s = v === undefined ? "" : String(v);
    if (!PARAM[k]?.test(s)) throw refuse("path_parameter_invalid");
    return encodeURIComponent(s);
  });
  const query = req.query ?? {};
  for (const k of Object.keys(query)) if (!(rule.query ?? []).includes(k)) throw refuse("query_key_not_allowed");
  const body = req.body;
  if (rule.method === "GET" || rule.method === "DELETE") { if (body !== undefined) throw refuse("body_not_allowed"); }
  else {
    const b = body ?? {};
    for (const k of Object.keys(b)) if (!(rule.body ?? []).includes(k)) throw refuse("body_key_not_allowed");
    for (const k of rule.requiredBody ?? []) { const v = b[k]; if (v === undefined || v === null || v === "") throw refuse("body_key_missing"); }
    if (rule.explicitPeriod || b.period !== undefined) {
      const p = b.period;
      if (typeof p !== "number" && !(p instanceof JsonNum)) throw refuse("period_missing_or_invalid");
      const n = Number(p instanceof JsonNum ? p.text : p);
      if (!Number.isInteger(n) || n < 1 || n > 10) throw refuse("period_missing_or_invalid");
    }
    const d = b.domain as { name?: unknown; extension?: unknown } | undefined;
    if (d !== undefined && (typeof d !== "object" || typeof d.name !== "string" || typeof d.extension !== "string" || !FQDN.test(`${d.name}.${d.extension}`))) throw refuse("domain_invalid");
  }
  if (query.full_name !== undefined && !FQDN.test(query.full_name)) throw refuse("domain_invalid");
  if (rule.check) { const why = rule.check(body ?? {}, query); if (why) throw refuse(why); }
  return { rule, path };
}
