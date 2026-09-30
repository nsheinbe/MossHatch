/** Thin client for /api/v1. Same-origin JSON only; the CSRF guard needs the X-MH-Client header on every mutation. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, public reason?: string) { super(code); this.name = "ApiError"; }
}

export async function api<T = unknown>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: { Accept: "application/json", ...headers } };
  if (method !== "GET") {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    (init.headers as Record<string, string>)["X-MH-Client"] = "web";
    init.body = JSON.stringify(body ?? {});
  }
  let res: Response;
  try { res = await fetch(path, init); } catch { throw new ApiError(0, "network"); }
  const text = await res.text();
  let json: { error?: { code?: string; reason?: string } } & Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, json.error?.code ?? "error", json.error?.reason);
  return json as T;
}

/** Whether the API is reachable and configured for this deployment (a preview without a database answers 503 not_configured). */
export async function apiAvailable(): Promise<boolean> {
  // Deployments without a backend never probe (a failing probe would print a console error on every visit). Set VITE_API_ENABLED=1 where the API is connected.
  if (import.meta.env.VITE_API_ENABLED !== "1") return false;
  try { await api("GET", "/api/v1/session"); return true; }
  catch { return false; }
}
