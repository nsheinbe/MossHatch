/** Injectable HTTP transport so tests never touch the network. A production transport throws on connect errors and timeouts. */
export interface OpHttpRequest { method: "GET" | "POST" | "PUT" | "DELETE"; url: string; headers: Record<string, string>; body?: string; timeoutMs: number }
export interface OpHttpResponse { status: number; body: string }
export interface OpHttpTransport { request(req: OpHttpRequest): Promise<OpHttpResponse> }

/** `fetch`-backed transport: no redirects, a hard timeout, and nothing but status and body passed back. */
export function fetchTransport(fetchImpl: typeof fetch = fetch): OpHttpTransport {
  return {
    async request(r) {
      const res = await fetchImpl(r.url, { method: r.method, headers: r.headers, body: r.body, redirect: "error", signal: AbortSignal.timeout(r.timeoutMs) });
      return { status: res.status, body: await res.text() };
    },
  };
}

export const SANDBOX_URL = "https://api.sandbox.openprovider.nl/v1";
export const PRODUCTION_URL = "https://api.openprovider.eu/v1";
