import crypto from "node:crypto";
import { Router } from "../http/router.ts";
import { cookieFrom, createTestApp, TEST_ORIGIN, TEST_RP_ID, type TestApp } from "../testing/app.ts";
import { VirtualAuthenticator } from "../testing/authenticator.ts";
import { authRoutes } from "./routes.ts";
import { PRE_AUTH_COOKIE, SESSION_COOKIE } from "../http/session.ts";
import { hit } from "../ratelimit.ts";
import { CLASS_A, CLASS_A_KINDS } from "./mail.ts";

/** A router with only the auth routes and a stub step-up gate that hands the request body to the handler as the action params. */
export function authRouter(): Router {
  const r = new Router().add(...authRoutes);
  r.setStepUpGate(async (req, type) => ({ id: crypto.randomUUID(), type, params: req.body }));
  return r;
}

export const newApp = (): Promise<TestApp> => createTestApp(authRouter());

export const authenticator = (o: Partial<ConstructorParameters<typeof VirtualAuthenticator>[0]> = {}) =>
  new VirtualAuthenticator({ origin: TEST_ORIGIN, rpId: TEST_RP_ID, ...o } as never);

/** Each test person gets their own source prefix so the per-source budgets never leak between tests. */
let ipCounter = 10;
export const nextIp = (): string => `198.51.${(ipCounter++ % 250) + 1}.7`;
export const xff = (ip: string) => ({ "x-forwarded-for": ip });

export const codeFrom = (text: string): string => /\b(\d{8})\b/.exec(text)![1]!;
export const lastMail = (app: TestApp, to: string, kind?: string) => [...app.email.to(to)].reverse().find((m) => !kind || m.kind === kind);
export const linkFrom = (text: string): string => /https?:\/\/\S+\/api\/v1\/email-actions\/([A-Za-z0-9_-]{43})/.exec(text)![1]!;

export interface Person {
  email: string; userId: string; ip: string; cookie: string; auth: VirtualAuthenticator; recoveryCodes: string[]; credentialId: string;
}

/** The whole sign-up through the real routes. */
export async function signUp(app: TestApp, email: string, o: { auth?: VirtualAuthenticator; ip?: string } = {}): Promise<Person> {
  const ip = o.ip ?? nextIp();
  const auth = o.auth ?? authenticator();
  const s = await app.call("POST", "/api/v1/auth/signup/start", { body: { email }, headers: xff(ip) });
  if (s.status !== 202) throw new Error("signup start " + s.status);
  const code = codeFrom(lastMail(app, email, "signup.code")!.text);
  const v = await app.call("POST", "/api/v1/auth/signup/verify", { body: { email, code }, headers: xff(ip) });
  if (v.status !== 200) throw new Error("signup verify " + v.status + " " + v.text);
  const pre = cookieFrom(v.setCookies, PRE_AUTH_COOKIE)!;
  const reg = await app.call("POST", "/api/v1/auth/register/verify", { body: { response: auth.create(v.json.options) }, cookie: pre, headers: xff(ip) });
  if (reg.status !== 201) throw new Error("register verify " + reg.status + " " + reg.text);
  return { email, userId: reg.json.user.id, ip, cookie: cookieFrom(reg.setCookies, SESSION_COOKIE)!, auth, recoveryCodes: reg.json.recoveryCodes, credentialId: auth.id };
}

/** Sign in with a virtual authenticator through the real routes. Returns the raw response and the new session cookie. */
export async function signIn(app: TestApp, auth: VirtualAuthenticator, o: { ip?: string; cookie?: string; override?: Parameters<VirtualAuthenticator["get"]>[1] } = {}) {
  const ip = o.ip ?? nextIp();
  const opts = await app.call("POST", "/api/v1/auth/login/options", { body: {}, headers: xff(ip) });
  const pre = cookieFrom(opts.setCookies, PRE_AUTH_COOKIE)!;
  const res = await app.call("POST", "/api/v1/auth/login/verify", { body: { response: auth.get(opts.json.options, o.override) }, cookie: [pre, o.cookie].filter(Boolean).join("; "), headers: xff(ip) });
  return { res, cookie: cookieFrom(res.setCookies, SESSION_COOKIE), pre, options: opts.json.options, ip };
}

export const me = (app: TestApp, cookie: string) => app.call("GET", "/api/v1/me", { cookie });

/** Exhaust the class A mail buckets for an address (per-address hour and day) and the global ceiling, the way a flood would. */
export async function fillClassA(app: TestApp, address: string): Promise<void> {
  const c = await app.db.runtime.connect();
  try {
    for (const kind of CLASS_A_KINDS) {
      for (let i = 0; i <= CLASS_A.perAddressDay.max; i++) {
        await hit(app.ctx, c, address.toLowerCase(), { ...CLASS_A.perAddressHour, bucket: `${CLASS_A.perAddressHour.bucket}.${kind}` });
        await hit(app.ctx, c, address.toLowerCase(), { ...CLASS_A.perAddressDay, bucket: `${CLASS_A.perAddressDay.bucket}.${kind}` });
      }
    }
    // The global ceiling: write the counter directly to just over its limit.
    const key = await app.ctx.kms.hmac("rate", Buffer.from("global"));
    const w = CLASS_A.global.windowSeconds * 1000;
    const start = new Date(Math.floor(app.clock.now().getTime() / w) * w);
    await c.query("insert into rate_counters (key_hash, bucket, window_start, count) values ($1,$2,$3,$4) on conflict (key_hash, bucket, window_start) do update set count = $4", [key, CLASS_A.global.bucket, start, CLASS_A.global.max + 1]);
  } finally { c.release(); }
}

export const auditActions = async (app: TestApp, userId: string): Promise<string[]> =>
  (await app.db.owner.query("select action from audit_log where chain_id = $1 order by seq", [userId])).rows.map((r) => r.action as string);

/** Undo `fillClassA` for everyone (the global ceiling is shared by every test in a file). */
export const clearClassA = (app: TestApp) => app.db.owner.query("delete from rate_counters where bucket like 'mailA.%'");
