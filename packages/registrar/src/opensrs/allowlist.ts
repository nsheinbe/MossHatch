import { RegistrarError } from "../port.ts";
import type { OpsObject } from "./xml.ts";

/**
 * Command allow-list with argument validation (plan 4.3b "Egress to the registrar": the one reseller-wide key cannot be scoped, so the
 * `registrar` project accepts only what the adapter needs). Anything else is refused BEFORE a request is built or signed.
 *
 * `verified: "dossier"` means the action and object appear together in docs/research/reg-opensrs.md. `verified: "action-only"` means the
 * dossier names the action but not the object or the attribute names. `verified: "unverified"` means the command is not in the dossier at
 * all. Attribute names marked in the adapter as UNVERIFIED come from memory of the OpenSRS toolkit and must be checked in Horizon.
 */
export interface CommandRule {
  action: string; object: string; write: boolean;
  /** Every attribute key the adapter may send; anything else is refused. */
  allowed: readonly string[];
  required: readonly string[];
  /** Attribute value constraints (exact match against the listed values). */
  enums?: Readonly<Record<string, readonly string[]>>;
  /** Writes that create a billed order must state the term explicitly (the default of 2 would bill two years for a one-year order). */
  explicitPeriod?: boolean;
  verified: "dossier" | "action-only" | "unverified";
}
const R = (r: CommandRule): [string, CommandRule] => [`${r.action}:${r.object}`, r];

export const ALLOWED_COMMANDS: ReadonlyMap<string, CommandRule> = new Map([
  R({ action: "LOOKUP", object: "DOMAIN", write: false, allowed: ["domain", "no_cache"], required: ["domain"], verified: "dossier" }),
  R({ action: "GET_PRICE", object: "DOMAIN", write: false, allowed: ["domain", "reg_type", "period", "all_periods"], required: ["domain", "reg_type", "period"], enums: { reg_type: ["new", "renewal"] }, verified: "dossier" }),
  R({ action: "SW_REGISTER", object: "DOMAIN", write: true, explicitPeriod: true,
    allowed: ["domain", "reg_type", "period", "handle", "auto_renew", "f_whois_privacy", "f_lock_domain", "reg_username", "reg_password", "contact_set", "custom_nameservers", "nameserver_list", "custom_tech_contact"],
    required: ["domain", "reg_type", "period", "handle", "auto_renew", "f_lock_domain", "reg_username", "reg_password", "contact_set"],
    enums: { reg_type: ["new"], handle: ["process"] }, verified: "dossier" }),
  R({ action: "RENEW", object: "DOMAIN", write: true, explicitPeriod: true,
    allowed: ["domain", "currentexpirationyear", "period", "handle"], required: ["domain", "currentexpirationyear", "period", "handle"], enums: { handle: ["process"] }, verified: "dossier" }),
  // `type=domain_auth_info` is deliberately absent: Mosshatch never reads a stored authorization code back (plan Gate (5)).
  R({ action: "GET", object: "DOMAIN", write: false, allowed: ["domain", "type"], required: ["domain", "type"], enums: { type: ["all_info", "status", "whois_privacy_state"] }, verified: "dossier" }),
  R({ action: "MODIFY", object: "DOMAIN", write: true, allowed: ["domain", "data", "lock_state", "domain_auth_info", "auto_renew", "let_expire", "contact_set"], required: ["domain", "data"],
    enums: { data: ["status", "domain_auth_info", "expire_action", "contact_info"] }, verified: "dossier" }),
  R({ action: "ADVANCED_UPDATE_NAMESERVERS", object: "DOMAIN", write: true, allowed: ["domain", "op_type", "assign_ns"], required: ["domain", "op_type", "assign_ns"], enums: { op_type: ["assign"] }, verified: "action-only" }),
  R({ action: "GET_DNS_ZONE", object: "DOMAIN", write: false, allowed: ["domain"], required: ["domain"], verified: "action-only" }),
  R({ action: "SET_DNS_ZONE", object: "DOMAIN", write: true, allowed: ["domain", "records"], required: ["domain", "records"], verified: "action-only" }),
  R({ action: "GET_DNSSEC_INFO", object: "DOMAIN", write: false, allowed: ["domain"], required: ["domain"], verified: "unverified" }),
  R({ action: "SET_DNSSEC_INFO", object: "DOMAIN", write: true, allowed: ["domain", "dnssec_info"], required: ["domain", "dnssec_info"], verified: "action-only" }),
  R({ action: "GET_TRANSFERS_AWAY", object: "DOMAIN", write: false, allowed: ["status", "req_from", "limit", "page"], required: [], verified: "action-only" }),
  R({ action: "CANCEL_TRANSFER", object: "TRANSFER", write: true, allowed: ["domain"], required: ["domain"], verified: "action-only" }),
  R({ action: "GET_BALANCE", object: "BALANCE", write: false, allowed: [], required: [], verified: "action-only" }),
  R({ action: "GET_DOMAINS_BY_EXPIREDATE", object: "DOMAIN", write: false, allowed: ["exp_from", "exp_to", "page", "limit"], required: ["exp_from", "exp_to"], verified: "action-only" }),
  R({ action: "GET_DELETED_DOMAINS", object: "DOMAIN", write: false, allowed: ["page", "limit"], required: [], verified: "action-only" }),
  R({ action: "GET_ORDERS_BY_DOMAIN", object: "DOMAIN", write: false, allowed: ["domain"], required: ["domain"], verified: "action-only" }),
  R({ action: "PROCESS_PENDING", object: "ORDER", write: true, allowed: ["order_id", "command"], required: ["order_id", "command"], enums: { command: ["cancel"] }, verified: "action-only" }),
  R({ action: "REDEEM", object: "DOMAIN", write: true, allowed: ["domain"], required: ["domain"], verified: "action-only" }),
]);

const FQDN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,24}$/;
const refuse = (code: string) => new RegistrarError("rejected", "command refused before sending", { retryable: false, outcomeUnknown: false, code });

/** Throws a `rejected` RegistrarError (codes only, never values) unless the command and its arguments are allowed. Returns the rule. */
export function checkCommand(action: string, object: string, attributes: OpsObject): CommandRule {
  const rule = ALLOWED_COMMANDS.get(`${action}:${object}`);
  if (!rule) throw refuse("command_not_allowed");
  for (const k of Object.keys(attributes)) if (!rule.allowed.includes(k)) throw refuse("attribute_not_allowed");
  for (const k of rule.required) { const v = attributes[k]; if (v === undefined || v === null || v === "") throw refuse("attribute_missing"); }
  for (const [k, vals] of Object.entries(rule.enums ?? {})) { const v = attributes[k]; if (v !== undefined && !vals.includes(String(v))) throw refuse("attribute_value_not_allowed"); }
  const d = attributes.domain;
  if (d !== undefined && (typeof d !== "string" || !FQDN.test(d))) throw refuse("domain_invalid");
  if (rule.explicitPeriod || attributes.period !== undefined) {
    const p = attributes.period;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 10) throw refuse("period_missing_or_invalid");
  }
  return rule;
}
