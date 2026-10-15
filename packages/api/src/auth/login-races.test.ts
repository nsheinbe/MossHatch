import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestApp } from "../testing/app.ts";
import { newApp, signIn, signUp } from "./testkit.ts";

let app: TestApp;
beforeAll(async () => { app = await newApp(); });
afterAll(async () => { await app?.drop(); });

/** Wait for the real verification request to reach its final account lock; no cryptographic or database mocks. */
async function blockedLogin(count = 1) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = (await app.db.owner.query("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'select status, hardened_mode from users%'")).rows[0];
    if (row.n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Login did not reach final account lock");
}

describe("ST-51 owner login rechecks under lock", () => {
  it.each(["revoked", "suspended", "inactive"] as const)("ST-51 refuses a credential/account made %s while its signature was being verified", async (change) => {
    const person = await signUp(app, `login-race-${change}@example.test`);
    const before = Number((await app.db.owner.query("select count(*) as n from sessions where user_id = $1", [person.userId])).rows[0].n);
    const holder = await app.db.owner.connect();
    await holder.query("begin");
    try {
      await holder.query("select id from users where id = $1 for update", [person.userId]);
      const pending = signIn(app, person.auth);
      await blockedLogin();
      if (change === "inactive") await holder.query("update users set status = 'closing' where id = $1", [person.userId]);
      else await holder.query(`update passkeys set ${change === "revoked" ? "revoked_at" : "suspended_at"} = $2 where user_id = $1`, [person.userId, app.clock.now()]);
      await holder.query("commit");
      const result = await pending;
      expect(result.res.status).toBe(401);
      expect(result.res.json).toEqual({ error: { code: "login_failed" } });
      expect(result.cookie).toBeUndefined();
      expect(Number((await app.db.owner.query("select count(*) as n from sessions where user_id = $1", [person.userId])).rows[0].n)).toBe(before);
    } finally { await holder.query("rollback"); holder.release(); }
  });

  it("ST-51 concurrent assertions cannot overwrite a newer device-bound counter or both mint sessions", async () => {
    const person = await signUp(app, "login-counter-race@example.test");
    const holder = await app.db.owner.connect();
    await holder.query("begin");
    try {
      await holder.query("select id from users where id = $1 for update", [person.userId]);
      const first = signIn(app, person.auth);
      await blockedLogin();
      const second = signIn(app, person.auth);
      await blockedLogin(2);
      await holder.query("commit");
      expect((await Promise.all([first, second])).map((result) => result.res.status).sort()).toEqual([200, 401]);
    } finally { await holder.query("rollback"); holder.release(); }
  });
});
