import type { Saved, TokenStore } from "./store.ts";

/**
 * The CLI's HTTP client. `fetch` is injected (tests run the CLI against the in-process API with no network). A token is
 * sent only as an Authorization header, never in a URL or an argument. An expired access token is refreshed once with the
 * rotating refresh token and the new pair is saved before the request is retried.
 */

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export const CLIENT_ID = "mosshatch-cli";

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) { super(code); }
}

export interface ApiOptions { base: string; fetch: Fetch; store: TokenStore; envToken?: string; now: () => number }

export class Api {
  constructor(private o: ApiOptions) {}
  get base() { return this.o.base.replace(/\/$/, ""); }

  async raw(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try { res = await this.o.fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { throw new ApiFailure(0, "network"); }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  }

  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await this.raw(method, path, body);
    if (r.status >= 400) throw new ApiFailure(r.status, r.json?.error?.code ?? "error", r.json?.error ?? {});
    return r;
  }

  /** A token for an authenticated call: MOSSHATCH_TOKEN, else the saved access token, refreshed when it has run out. */
  private async token(forceRefresh = false): Promise<string> {
    if (this.o.envToken) return this.o.envToken;
    const s = await this.o.store.load();
    if (!s || s.api !== this.base) throw new ApiFailure(401, "not_signed_in");
    const fresh = s.expires_at ? Date.parse(s.expires_at) - 30_000 > this.o.now() : true;
    if (fresh && !forceRefresh) return s.access_token;
    if (!s.refresh_token) throw new ApiFailure(401, "not_signed_in");
    const r = await this.raw("POST", "/api/v1/oauth/token", { grant_type: "refresh_token", refresh_token: s.refresh_token, client_id: CLIENT_ID });
    if (r.status !== 200) { await this.o.store.clear(); throw new ApiFailure(401, "not_signed_in"); }
    await this.save(r.json);
    return r.json.access_token as string;
  }

  async save(t: { access_token: string; refresh_token?: string; expires_in?: number }): Promise<void> {
    const s: Saved = { api: this.base, access_token: t.access_token };
    if (t.refresh_token) s.refresh_token = t.refresh_token;
    if (t.expires_in) s.expires_at = new Date(this.o.now() + t.expires_in * 1000).toISOString();
    await this.o.store.save(s);
  }

  async authed(method: string, path: string, body?: unknown): Promise<any> {
    let r = await this.raw(method, path, body, await this.token());
    if (r.status === 401 && !this.o.envToken) r = await this.raw(method, path, body, await this.token(true));
    if (r.status >= 400) throw new ApiFailure(r.status, r.json?.error?.code ?? "error", r.json?.error ?? {});
    return r.json;
  }
}
