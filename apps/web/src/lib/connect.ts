import { api, ApiError } from "./api";
import { gated } from "./domains";

/**
 * DC-06. The presets section asks capabilities first and hides itself unless `connect.ui` is on.
 * Plan and preset requests happen only when that section is on and presets are on.
 */

export interface ConnectCapabilities {
  apply: boolean; presets: boolean; ui: boolean; discovery: boolean;
  domainconnect_apply: boolean; verify: boolean; delegate: boolean; ai: boolean;
}
export interface ConnectRecord { type: string; name: string; value: string; priority?: number; weight?: number; port?: number }
export interface ConnectPlanView {
  v: 1; source: string; source_id: string; source_version: number; fqdn: string; zone_before: string;
  dns: { add: ConnectRecord[]; remove: ConnectRecord[] };
  warnings: { code: string; message: string }[];
  blocked: { code: string; message: string } | null;
  sensitive: { type: string; name: string; reasons: string[] }[];
}
export interface StoredPlan { plan_id: string; plan_hash: string; expires_at: string; plan: ConnectPlanView }
export interface PresetField { name: string; label: string; required: boolean; placeholder?: string }
export interface PresetInfo { id: string; version: number; title: string; doc: string; fields: PresetField[] }

const enc = encodeURIComponent;
const D = (fqdn: string) => `/api/v1/domains/${enc(fqdn)}`;

export const getCapabilities = () => api<ConnectCapabilities>("GET", "/api/v1/connect/capabilities");
export const listConnectPresets = () => api<{ presets: PresetInfo[] }>("GET", "/api/v1/connect/presets");
export const createConnectPlan = (fqdn: string, body: { source: "preset"; source_id: string; source_version: number; input: Record<string, string> }) =>
  api<StoredPlan>("POST", `${D(fqdn)}/connect/plans`, body);
export const applyConnectPlan = (fqdn: string, id: string, planHash: string) =>
  api<{ plan_id: string; state: string; changed: boolean }>("POST", `${D(fqdn)}/connect/plans/${enc(id)}/apply`, { plan_hash: planHash });
export const approveConnectPlan = (id: string, actionId: string) =>
  api<{ plan_id: string; state: string }>("POST", `/api/v1/connect/plans/${enc(id)}/approve`, {}, gated(actionId));

export interface DomainConnectPreview {
  provider_name?: string;
  fqdn?: string;
  redirect?: string;
  plan?: ConnectPlanView;
}
export interface DomainConnectConfirm { redirect?: string; plan_id?: string; state?: string }

/** The consent page lives at `/domainconnect/consent/:provider/:service`. Anything else is not that page. */
export function consentPath(pathname: string): { providerId: string; serviceId: string } | null {
  const m = /^\/domainconnect\/consent\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  try {
    const providerId = decodeURIComponent(m[1]!);
    const serviceId = decodeURIComponent(m[2]!);
    if (!providerId || !serviceId || providerId.includes("/") || serviceId.includes("/")) return null;
    return { providerId, serviceId };
  } catch { return null; }
}

export const previewDomainConnect = (body: { query: string; provider_id: string; service_id: string }) =>
  api<DomainConnectPreview>("POST", "/api/v1/connect/domainconnect/preview", body);
export const confirmDomainConnect = (
  body: { query: string; provider_id: string; service_id: string; decision: "confirm" | "cancel" },
  actionId?: string,
) => api<DomainConnectConfirm>("POST", "/api/v1/connect/domainconnect/confirm", body, actionId ? gated(actionId) : {});

/** The presets section is absent unless the UI flag is on. A missing read counts as off. */
export const presetsSectionOn = (caps: ConnectCapabilities | null | undefined): boolean => caps?.ui === true;
/** Preset list and plan posts happen only from a visible section whose presets flag is on. */
export const presetsRequestsOn = (caps: ConnectCapabilities | null | undefined): boolean => caps?.ui === true && caps.presets === true;

export const recordLine = (r: ConnectRecord): string => {
  const name = r.name === "" ? "@" : r.name;
  const extra = [r.priority, r.weight, r.port].filter((n) => n !== undefined).join(" ");
  return `${r.type} ${name}${extra ? ` ${extra}` : ""} ${r.value}`;
};

/** Every add and every remove, in full, before anyone confirms. */
export const planLines = (plan: ConnectPlanView): { add: string[]; remove: string[] } => ({
  add: plan.dns.add.map(recordLine),
  remove: plan.dns.remove.map(recordLine),
});

export const ALIAS_STAYS = "This host cannot be attached while DNS stays here.";
export const ALIAS_DELEGATE = "This host cannot be attached with a record here. Point the name at their nameservers from the DNS tab. If the name is signed and their DNS is not, remove DNSSEC first. That form does not remove it for you.";

export const blockedCopy = (code: string, serverMessage: string, delegate: boolean): string =>
  code === "needs_alias" ? (delegate ? ALIAS_DELEGATE : ALIAS_STAYS) : (serverMessage || "That plan cannot be applied.");

export const APPLIED_NOTE = "Applied. You can roll this back from the DNS tab.";
export const CHANGED_NOTE = "The zone changed before this was applied. Nothing was written. This is the plan now.";

export type PlanFault =
  | { kind: "changed"; plan: ConnectPlanView; plan_hash: string }
  | { kind: "blocked"; code: string; message: string };

/** A 409 with a replacement plan is a new plan to show, never a success. */
export function readPlanError(e: ApiError): PlanFault | null {
  const plan = e.body?.plan as ConnectPlanView | undefined;
  const hash = typeof e.body?.plan_hash === "string" ? e.body.plan_hash : "";
  if (e.status === 409 && e.code === "plan_changed" && plan && hash) return { kind: "changed", plan, plan_hash: hash };
  if (e.status === 422) {
    const code = plan?.blocked?.code ?? e.code;
    const message = plan?.blocked?.message ?? (typeof e.body?.message === "string" ? e.body.message : "");
    return { kind: "blocked", code, message };
  }
  return null;
}

export function explainConnect(e: unknown): string {
  if (e instanceof ApiError) {
    const fault = readPlanError(e);
    if (fault?.kind === "changed") return CHANGED_NOTE;
    if (fault?.kind === "blocked") return fault.message || "That plan cannot be applied.";
    if (e.code === "approval_required") return "This changes a sensitive record, so it needs your passkey.";
    if (e.code === "plan_used") return "That plan expired or was already used. Preview it again.";
    if (e.status === 404) return "Connect plans are turned off.";
  }
  return "That did not go through. Nothing was written.";
}
