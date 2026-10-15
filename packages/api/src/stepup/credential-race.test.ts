import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Router } from "../http/router.ts";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { registerStepUp } from "./routes.ts";
import { registerActionSpec, resetActionSpecs } from "./specs.ts";
import { addPasskey, commit, makeUser, prepare } from "./testkit.ts";

let app: TestApp;
beforeAll(async () => {
  const router = new Router();
  registerStepUp(router);
  app = await createTestApp(router);
}, 120_000);
afterAll(async () => { await app?.drop(); resetActionSpecs(); });

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("ST-55: credential and session changes during a verified step-up", () => {
  for (const mutation of ["revoke", "suspend", "counter", "session", "hardened"] as const) {
    it(`refuses a ${mutation} change that commits after signature verification`, async () => {
      const user = await makeUser(app, `stepup-race-${mutation}@example.org`);
      const key = await addPasskey(app, user, { backupEligible: mutation === "hardened", backupState: mutation === "hardened" });
      const entered = barrier(), release = barrier();
      let derives = 0, effects = 0;
      registerActionSpec({
        type: "card.publish", held: true, userInput: z.strictObject({}),
        async derive() {
          if (++derives === 2) { entered.resolve(); await release.promise; }
          return { params: { target: "fixture" } };
        },
        summary: () => "Publish fixture.",
        async execute() { effects++; },
      });
      const prep = await prepare(app, user, { type: "card.publish", target_id: "fixture", user_input: {} });
      expect(prep.status, prep.text).toBe(200);
      const pending = commit(app, user, prep.json.action_id, key.auth.get(prep.json.webauthn_options));
      await entered.promise;
      try {
        if (mutation === "revoke") await app.db.owner.query("update passkeys set revoked_at = now() where id = $1", [key.passkeyId]);
        if (mutation === "suspend") await app.db.owner.query("update passkeys set suspended_at = now() where id = $1", [key.passkeyId]);
        if (mutation === "counter") await app.db.owner.query("update passkeys set sign_count = sign_count + 10 where id = $1", [key.passkeyId]);
        if (mutation === "session") await app.db.owner.query("update sessions set revoked_at = now() where id_hash = $1", [user.sessionHash]);
        if (mutation === "hardened") await app.db.owner.query("update users set hardened_mode = true where id = $1", [user.userId]);
      } finally { release.resolve(); }
      const result = await pending;
      expect(result.status, result.text).toBe(403);
      expect(result.json.error.code).toBe("assertion_invalid");
      expect(effects).toBe(0);
      const row = (await app.db.owner.query("select state, credential_id from actions where id = $1", [prep.json.action_id])).rows[0];
      expect(row).toMatchObject({ state: "cancelled", credential_id: null });
      const challenge = (await app.db.owner.query("select consumed_at from webauthn_challenges where action_id = $1", [prep.json.action_id])).rows[0];
      expect(challenge.consumed_at).not.toBeNull();
      const credential = (await app.db.owner.query("select sign_count from passkeys where id = $1", [key.passkeyId])).rows[0];
      expect(Number(credential.sign_count)).toBe(mutation === "counter" ? 10 : 0);
    });
  }
});
