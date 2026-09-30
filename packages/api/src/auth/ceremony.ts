import type { PoolClient } from "@mosshatch/db";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { assertionOptions, challengeOf, registrationOptions } from "../webauthn.ts";
import { withNoUser } from "@mosshatch/db";
import { CEREMONY_TTL_MS } from "../webauthn.ts";

const ttl = `${Math.round(CEREMONY_TTL_MS / 1000)} seconds`;

/** Registration options for a user, with a stored challenge bound to a session hash or a pre-auth hash (never neither). */
export async function issueRegistrationOptions(
  ctx: AppContext, c: PoolClient,
  u: { id: string; email: string; handle: Buffer },
  bind: { sessionHash?: Buffer; preHash?: Buffer; recoveryId?: string },
) {
  if (!bind.sessionHash && !bind.preHash) throw new Error("registration challenge needs a binding");
  const existing = (await c.query("select credential_id from passkeys where user_id = $1", [u.id])).rows.map((r) => r.credential_id as string);
  const options = await registrationOptions(ctx, { userHandle: u.handle, email: u.email, existingCredentialIds: existing });
  await c.query("select auth2_challenge_put('register',$1,$2,$3,$4,$5,$6,$7::interval)", [options.challenge, u.id, bind.sessionHash ?? null, bind.preHash ?? null, bind.recoveryId ?? null, ctx.clock.now(), ttl]);
  return options;
}

/** Login options: a random challenge, discoverable credentials, bound to the hash of the pre-auth cookie. */
export async function issueLoginOptions(ctx: AppContext, preHash: Buffer) {
  const options = await assertionOptions(ctx, {});
  await withNoUser(ctx.runtime, (c) => c.query("select auth2_challenge_put('login',$1,null,null,$2,null,$3,$4::interval)", [options.challenge, preHash, ctx.clock.now(), ttl]));
  return options;
}

export type ConsumedChallenge = { id: string; user_id: string | null; recovery_id: string | null };

/** Consume a challenge in its own committed statement, before any verification, so a failed attempt also burns it. */
export async function consumeChallenge(ctx: AppContext, challenge: string, purpose: "register" | "login", bind: { sessionHash?: Buffer | null; preHash?: Buffer | null }): Promise<ConsumedChallenge | null> {
  const r = await withNoUser(ctx.runtime, (c) => c.query("select * from auth2_challenge_consume($1,$2,$3,$4,$5)", [challenge, purpose, bind.sessionHash ?? null, bind.preHash ?? null, ctx.clock.now()]));
  return (r.rows[0] as ConsumedChallenge | undefined) ?? null;
}

/** The challenge inside a ceremony response, or a 400 when the response is not shaped like one. */
export function challengeFrom(response: unknown): string {
  try {
    const ch = challengeOf(response as { response: { clientDataJSON: string } });
    if (typeof ch === "string" && ch.length > 0 && ch.length < 256) return ch;
  } catch { /* fall through */ }
  throw new HttpError(400, "invalid_request");
}

export function asRegistration(v: unknown): RegistrationResponseJSON {
  const o = v as RegistrationResponseJSON | null;
  if (!o || typeof o !== "object" || typeof o.id !== "string" || !o.response || typeof o.response.clientDataJSON !== "string" || typeof o.response.attestationObject !== "string") throw new HttpError(400, "invalid_request");
  return o;
}

export function asAssertion(v: unknown): AuthenticationResponseJSON {
  const o = v as AuthenticationResponseJSON | null;
  if (!o || typeof o !== "object" || typeof o.id !== "string" || !o.response || typeof o.response.clientDataJSON !== "string" || typeof o.response.authenticatorData !== "string" || typeof o.response.signature !== "string") throw new HttpError(400, "invalid_request");
  return o;
}
