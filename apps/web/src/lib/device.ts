import { api } from "./api";
import { gated } from "./domains";

/** The device-approval calls. The code comes only from what the person types; nothing here reads the URL. */
export interface DeviceLookup {
  request_id: string;
  observed: { address: string | null; requested_at: string; expires_at: string };
  reported: { client_name: string | null; client_version: string | null; scopes: string[] };
  default_envs: ("dev" | "preview")[];
  grant: string[];
  prod_choices: string[];
}
export const lookupDevice = (userCode: string) => api<DeviceLookup>("POST", "/api/v1/oauth/device/lookup", { user_code: userCode });
export const approveDevice = (actionId: string) => api<{ state: string; scopes: string[] }>("POST", "/api/v1/oauth/device/approve", {}, gated(actionId));
export const denyDevice = (requestId: string, userCode: string) => api("POST", "/api/v1/oauth/device/deny", { request_id: requestId, user_code: userCode });

/** The scopes the page will ask the server to grant, in the server's own words (the step-up summary repeats them). */
export function shownScopes(envs: readonly string[], prod: readonly string[]): string[] {
  const out = ["domains.read:*"];
  for (const e of envs) for (const c of ["nest.names", "secrets.read", "secrets.write"]) out.push(`${c}:*:${e}`);
  for (const d of prod) for (const c of ["nest.names", "secrets.read", "secrets.write"]) out.push(`${c}:${d}:prod`);
  return out;
}
