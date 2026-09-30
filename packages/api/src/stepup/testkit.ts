import { withUser } from "@mosshatch/db";
import type { TestApp } from "../testing/app.ts";
import { TEST_ORIGIN, TEST_RP_ID } from "../testing/app.ts";
import { VirtualAuthenticator } from "../testing/authenticator.ts";
import { createSession } from "../http/session.ts";
import { registrationOptions, verifyRegistration } from "../webauthn.ts";

export interface TestUser { userId: string; handle: Buffer; cookie: string; sessionHash: Buffer; email: string }

export async function makeUser(app: TestApp, email: string): Promise<TestUser> {
  const row = (await app.db.owner.query("insert into users (email, status, email_verified_at) values ($1,'active',now()) returning id, webauthn_user_handle", [email])).rows[0];
  const s = await createSession(app.ctx, row.id, {});
  return { userId: row.id, handle: row.webauthn_user_handle, cookie: s.cookie.split(";")[0]!, sessionHash: s.idHash, email };
}

export async function newSession(app: TestApp, u: TestUser): Promise<TestUser> {
  const s = await createSession(app.ctx, u.userId, {});
  return { ...u, cookie: s.cookie.split(";")[0]!, sessionHash: s.idHash };
}

export const authenticator = (o: ConstructorParameters<typeof VirtualAuthenticator>[0] extends infer T ? Partial<T> : never = {}) =>
  new VirtualAuthenticator({ origin: TEST_ORIGIN, rpId: TEST_RP_ID, ...o } as never);

/** Register a virtual authenticator through the real registration verification and store the credential. */
export async function addPasskey(app: TestApp, u: TestUser, o: { backupEligible?: boolean; backupState?: boolean; label?: string } = {}): Promise<{ auth: VirtualAuthenticator; passkeyId: string; credentialId: string }> {
  const auth = authenticator({ backupEligible: o.backupEligible, backupState: o.backupState });
  const opts = await registrationOptions(app.ctx, { userHandle: u.handle, email: u.email });
  const reg = await verifyRegistration(app.ctx, auth.create(opts as never) as never, opts.challenge);
  const r = await withUser(app.ctx.runtime, u.userId, (c) => c.query(
    "insert into passkeys (user_id, credential_id, public_key, alg, sign_count, transports, backup_eligible, backup_state, label) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id",
    [u.userId, reg.credentialId, reg.publicKey, reg.alg, reg.signCount, reg.transports, reg.backupEligible, reg.backupState, o.label ?? "Test key"]));
  return { auth, passkeyId: r.rows[0].id, credentialId: reg.credentialId };
}

export async function prepare(app: TestApp, u: TestUser, body: unknown) {
  return app.call("POST", "/api/v1/actions/prepare", { cookie: u.cookie, body });
}
export async function commit(app: TestApp, u: TestUser, actionId: string, assertion: unknown) {
  return app.call("POST", `/api/v1/actions/${actionId}/commit`, { cookie: u.cookie, body: { assertion } });
}
