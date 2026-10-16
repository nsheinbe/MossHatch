import { api, ApiError } from "./api";
import { explainDomain, gated } from "./domains";

/** The Connect tab's calls: provider connections (a pasted token, sealed in the vault), recipe plans, their approval and apply. */
const enc = encodeURIComponent;
const D = (fqdn: string) => `/api/v1/domains/${enc(fqdn)}`;

export type Service = "vercel" | "neon" | "resend";
export interface RecipeInfo { id: string; version: number; title: string; summary: string; services: Service[] }
export interface ConnectionView { id: string; service: Service; status: string; checked_at: string | null; connected_at: string; recipe_application_id: string | null }
export interface Finding { id: string; kind: string; host: string; found_at: string }
export interface Rec { type: string; name: string; value: string; priority?: number }
export interface PlanView {
  recipe: string; version: number; domain: string; plan_hash: string; needs_approval: boolean;
  dns: { add: Rec[]; remove: Rec[] }; pending_records: { type: string; name: string }[];
  variables: { name: string; targets: string[] }[];
  steps: { service: string; op: string; target: string; creates_resource: boolean; cost: string }[];
  sensitive: { type: string; name: string; reasons: string[] }[];
}
export interface Planned { application_id: string; state: string; expires_at: string; plan: PlanView; notices: { code: string; text: string }[] }
export interface Application { application_id: string; recipe: string; state: string; needs_approval: boolean; failure_code: string | null; plan: PlanView; applied_at: string | null }
export interface ApplicationRow { id: string; recipe: string; state: string; needs_approval: boolean; failure_code: string | null; created_by: { kind: string; name?: string | null; live?: boolean }; created_at: string; expires_at: string; applied_at: string | null }

export const listRecipes = async () => (await api<{ recipes: RecipeInfo[] }>("GET", "/api/v1/recipes")).recipes;
export const listConnections = (f: string) => api<{ connections: ConnectionView[]; findings: Finding[] }>("GET", `${D(f)}/connections`);
export const checkConnection = (f: string, s: Service) => api<{ connection_id: string; state: string }>("POST", `${D(f)}/connections/${s}/check`, {});
export const disconnect = (id: string) => api<{ connection_id: string; status: string; records_removed: number }>("DELETE", `/api/v1/connections/${enc(id)}`);
export const planRecipe = (f: string, recipe: string, input: Record<string, unknown>) => api<Planned>("POST", `${D(f)}/recipes/${enc(recipe)}/plan`, { input });
export const applyRecipe = (f: string, recipe: string, applicationId: string, planHash: string) => api<{ application_id: string; state: string }>("POST", `${D(f)}/recipes/${enc(recipe)}/apply`, { application_id: applicationId, plan_hash: planHash });
export const getApplication = (id: string) => api<Application>("GET", `/api/v1/recipe-applications/${enc(id)}`);
export const listApplications = async (f: string) => (await api<{ applications: ApplicationRow[] }>("GET", `${D(f)}/recipe-applications`)).applications;
export const approveApplication = (id: string, actionId: string) => api<{ state: string }>("POST", `/api/v1/recipe-applications/${enc(id)}/approve`, {}, gated(actionId));

/** PUT a provider token. The shared client has no PUT; the token goes in the body only and is not kept here after the call. */
export async function connectService(f: string, s: Service, credential: string, externalRef?: string): Promise<{ connection_id: string }> {
  let res: Response;
  try {
    res = await fetch(`${D(f)}/connections/${s}`, {
      method: "PUT", credentials: "same-origin", cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-MH-Client": "web" },
      body: JSON.stringify({ kind: "pasted_token", credential, ...(externalRef ? { external_ref: externalRef } : {}) }),
    });
  } catch { throw new ApiError(0, "network"); }
  let json: { connection_id?: string; error?: { code?: string } } = {};
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, json.error?.code ?? "error");
  return { connection_id: String(json.connection_id ?? "") };
}

/** Plain words for the codes the recipe routes and the apply job answer with. */
export function explainRecipe(code: string | unknown): string {
  const c = typeof code === "string" ? code : code instanceof ApiError ? code.code : "";
  switch (c) {
    case "connection_missing": return "Connect the provider first.";
    case "connection_unchecked": return "We have not read the provider's settings yet. Check the connection, then preview again.";
    case "credential_missing": return "The stored token is gone. Connect the provider again.";
    case "dns_not_hosted": return "This name uses other nameservers, so its DNS cannot be written here.";
    case "invalid_input": return "Check the options and try again.";
    case "invalid_name": return "One of the variable names is not allowed. Change the prefix.";
    case "plan_changed": case "recipe_changed": case "state_changed": return "Something changed since the preview: the records, or the provider's settings. Preview again.";
    case "plan_expired": return "The preview is more than an hour old. Preview again.";
    case "plan_used": return "This preview was already used. Preview again.";
    case "approval_required": return "This needs your passkey first.";
    case "domain_gone": return "This name is no longer in your account.";
    case "value_unavailable": return "The provider did not hand over the value to store. Nothing was stored; try again.";
    case "write_conflict": return "Someone changed this connection at the same moment. Try again.";
    case "rate_limited": return "Too many previews in an hour. Try again later.";
    case "invalid_request": return "The token or the project was not accepted. Check them and try again.";
  }
  if (/^(vercel|neon|resend)_(401|403)$/.test(c)) return "The provider refused the stored token. Connect again with a token that can reach this project.";
  if (/^(vercel|neon|resend)_404$/.test(c)) return "The provider could not find the project. Check its name or ID and connect again.";
  if (/^(vercel|neon|resend)_\d+$/.test(c)) return "The provider answered with an error. Try again in a few minutes.";
  return c && typeof code === "string" ? "The recipe stopped before finishing. Nothing more will run; preview again to retry." : explainDomain(code);
}
