import { afterAll, beforeAll, expect, it } from "vitest";
import { cookieFrom, type TestApp } from "../testing/app.ts";
import { PRE_AUTH_COOKIE } from "../http/session.ts";
import { authenticator, codeFrom, lastMail, newApp, signUp } from "./testkit.ts";

let app: TestApp;
beforeAll(async () => { app = await newApp(); });
afterAll(async () => { await app?.drop(); });

it("ST-49 concurrent recovery replay yields one ticket, rejects another owner's code and redacts audit details", async () => {
  const owner = await signUp(app, "replay-owner@example.test");
  const other = await signUp(app, "replay-other@example.test");
  await app.call("POST", "/api/v1/auth/recovery/start", { body: { email: owner.email, path: "codes_email" } });
  const code = codeFrom(lastMail(app, owner.email, "recovery.code")!.text);
  const redeem = (recoveryCode: string) => app.call("POST", "/api/v1/auth/recovery/redeem", { body: { email: owner.email, code, recoveryCode } });
  expect((await redeem(other.recoveryCodes[0]!)).status).toBe(401);
  const attempts = await Promise.all([redeem(owner.recoveryCodes[0]!), redeem(owner.recoveryCodes[0]!)]);
  expect(attempts.map((attempt) => attempt.status).sort()).toEqual([200, 401]);
  expect((await redeem(owner.recoveryCodes[0]!)).status).toBe(401);
  const success = attempts.find((attempt) => attempt.status === 200)!;
  const pre = cookieFrom(success.setCookies, PRE_AUTH_COOKIE)!;
  const response = authenticator().create(success.json.options);
  const first = await app.call("POST", "/api/v1/auth/register/verify", { cookie: pre, body: { response } });
  expect(first.status).toBe(201);
  const replay = await app.call("POST", "/api/v1/auth/register/verify", { cookie: pre, body: { response } });
  expect(replay.status).toBe(401);
  const audit = JSON.stringify((await app.db.owner.query("select detail from audit_log where chain_id = $1", [owner.userId])).rows);
  for (const secret of [owner.email, code, ...owner.recoveryCodes, pre.split("=")[1]!]) expect(audit).not.toContain(secret);
  expect((await app.db.owner.query("select count(*)::int as n from recovery_codes where user_id = $1 and used_at is not null", [owner.userId])).rows[0].n).toBe(1);
});
