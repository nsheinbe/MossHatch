import { createTestDb, type TestDb } from "@mosshatch/db/testing";
import type { AppContext, Config } from "../ports.ts";
import { LocalKms, LocalPii } from "../kms.ts";
import { FakeEmail } from "../email.ts";
import type { Router } from "../http/router.ts";

export class FakeClock {
  constructor(public t = new Date("2026-10-01T12:00:00Z")) {}
  now() { return new Date(this.t); }
  advance(ms: number) { this.t = new Date(this.t.getTime() + ms); }
  set(d: Date) { this.t = d; }
}

export const TEST_ORIGIN = "https://mosshatch.test";
export const TEST_RP_ID = "mosshatch.test";

export interface TestApp {
  db: TestDb;
  ctx: AppContext;
  clock: FakeClock;
  email: FakeEmail;
  router?: Router;
  drop(): Promise<void>;
  /** Build a Request with the headers the browser app sends on cookie routes. */
  req(method: string, path: string, opts?: { body?: unknown; cookie?: string; authorization?: string; headers?: Record<string, string>; browser?: boolean }): Request;
  call(method: string, path: string, opts?: Parameters<TestApp["req"]>[2]): Promise<{ status: number; json: any; headers: Headers; text: string; setCookies: string[] }>;
}

export async function createTestApp(router?: Router, config: Partial<Config> = {}): Promise<TestApp> {
  const db = await createTestDb();
  const clock = new FakeClock();
  const email = new FakeEmail();
  const ctx: AppContext = {
    runtime: db.runtime, cron: db.cron, clock, kms: new LocalKms(), pii: new LocalPii(), email,
    config: { mode: "local", origin: TEST_ORIGIN, rpId: TEST_RP_ID, allowedOrigins: [TEST_ORIGIN], cronSecret: "cron-secret-for-tests-only-0123456789", livemode: false, stripeKeyKind: "test", registrarMode: "mock", ...config },
    services: {},
  };
  const app: TestApp = {
    db, ctx, clock, email, router,
    drop: () => db.drop(),
    req(method, path, opts = {}) {
      const h = new Headers();
      if (opts.cookie) h.set("cookie", opts.cookie);
      if (opts.authorization) h.set("authorization", opts.authorization);
      const isBody = opts.body !== undefined;
      const after = () => { for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, v); };
      if (method !== "GET" && opts.browser !== false) {
        h.set("origin", TEST_ORIGIN); h.set("sec-fetch-site", "same-origin"); h.set("content-type", "application/json"); h.set("x-mh-client", "web");
      }
      after();
      return new Request(TEST_ORIGIN + path, { method, headers: h, body: isBody ? JSON.stringify(opts.body) : method === "GET" ? undefined : "" });
    },
    async call(method, path, opts) {
      if (!app.router) throw new Error("no router");
      const res = await app.router.dispatch(ctx, app.req(method, path, opts));
      const text = await res.text();
      let json: any = null; try { json = JSON.parse(text); } catch { /* html */ }
      return { status: res.status, json, headers: res.headers, text, setCookies: res.headers.getSetCookie() };
    },
  };
  return app;
}

/** Pull `name=value` from Set-Cookie headers, for feeding back as a Cookie header. */
export function cookieFrom(setCookies: string[], name: string): string | undefined {
  for (const c of setCookies) if (c.startsWith(name + "=")) return c.split(";")[0];
  return undefined;
}
