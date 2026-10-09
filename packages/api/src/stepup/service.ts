import { z } from "zod";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { withUser, type PoolClient } from "@mosshatch/db";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { ACTION_TYPES, type ActionType } from "../http/types.ts";
import { HttpError, json } from "../http/router.ts";
import { appendAudit } from "../audit.ts";
import { hit } from "../ratelimit.ts";
import { assertionOptions, verifyAssertion } from "../webauthn.ts";
import { b64u, canonicalJson, fromB64u, hashOf, randomBytes, sha256, safeEqual } from "../util/bytes.ts";
import { getActionSpec, type ActionSpec, type CommittedAction, type DerivedAction } from "./specs.ts";
import { assertNotHeld } from "./holds-port.ts";

export const STEPUP_TTL_MS = 120_000;
export const PREPARE_LIMIT = { bucket: "stepup_prepare", max: 10, windowSeconds: 600 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PrepareBody = z.object({
  type: z.enum(ACTION_TYPES as [ActionType, ...ActionType[]]),
  target_id: z.string().min(1).max(256),
  user_input: z.unknown().optional(),
}).strict();

const Assertion = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal("public-key"),
  authenticatorAttachment: z.string().max(64).nullish(),
  response: z.object({
    clientDataJSON: z.string().min(1).max(8192),
    authenticatorData: z.string().min(1).max(8192),
    signature: z.string().min(1).max(8192),
    userHandle: z.string().max(512).nullish(),
  }).strict(),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
}).strict();
const CommitBody = z.object({ assertion: Assertion }).strict();

function sessionOf(req: HandlerReq): { userId: string; sessionHash: Buffer } {
  const p = req.principal;
  if (p.kind !== "session" || !p.userId || !p.sessionIdHash) throw new HttpError(403, "forbidden_principal");
  return { userId: p.userId, sessionHash: p.sessionIdHash };
}

/** Derive canonical params and their hash. Also used at commit to re-derive from current state. */
export async function deriveAction(ctx: HandlerReq["ctx"], c: PoolClient, spec: ActionSpec, userId: string, targetId: string, input: unknown): Promise<DerivedAction & { paramsHash: Buffer; summary: string }> {
  const d = await spec.derive(ctx, c, userId, targetId, input);
  return { ...d, paramsHash: hashOf(d.params), summary: spec.summary(d.params) };
}

// prepare ---------------------------------------------------------------------------------------------------------

export async function prepareHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const { userId, sessionHash } = sessionOf(req);
  // Counted in its own committed statement so a refused request still costs a slot.
  const rl = await withUser(ctx.runtime, userId, (c) => hit(ctx, c, `stepup.prepare:${userId}:${sessionHash.toString("hex")}`, PREPARE_LIMIT));
  if (!rl.allowed) throw new HttpError(429, "rate_limited", undefined, { "Retry-After": String(rl.retryAfterSeconds) });

  const body = PrepareBody.safeParse(req.body);
  if (!body.success) throw new HttpError(400, "invalid_request");
  const spec = getActionSpec(body.data.type);
  if (!spec) throw new HttpError(409, "action_unavailable");
  const input = spec.userInput.safeParse(body.data.user_input ?? {});
  if (!input.success) throw new HttpError(400, "invalid_request");

  return withUser(ctx.runtime, userId, async (c) => {
    if (spec.held) await assertNotHeld(ctx, c, userId, spec.type);
    const d = await deriveAction(ctx, c, spec, userId, body.data.target_id, input.data);
    // Hardened mode keeps no weaker fallback: backup-eligible (synced) credentials are not offered (ST-53).
    const allow = (await c.query(
      `select p.credential_id from passkeys p join users u on u.id = p.user_id
        where p.user_id = $1 and p.revoked_at is null and p.suspended_at is null and not (u.hardened_mode and p.backup_eligible)
        order by p.created_at, p.id`, [userId])).rows.map((r) => r.credential_id as string);
    if (allow.length === 0) throw new HttpError(409, "no_passkey");

    const now = ctx.clock.now();
    const exp = new Date(now.getTime() + STEPUP_TTL_MS);
    const actionId = (await c.query("select uuidv7() as id")).rows[0].id as string;
    const nonce = b64u(randomBytes(16));
    const digest = sha256(canonicalJson({ action_id: actionId, type: spec.type, params_hash: d.paramsHash.toString("hex"), user_id: userId, session_id: b64u(sessionHash), nonce, exp: exp.toISOString() }));
    const options = await assertionOptions(ctx, { challenge: new Uint8Array(digest), allowCredentialIds: allow });

    await c.query(
      `insert into actions (id, user_id, session_id_hash, type, params, params_hash, resource_id, state, expires_at, allow_credential_ids, target_id, user_input, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,'prepared',$8,$9,$10,$11,$12)`,
      [actionId, userId, sessionHash, spec.type, d.params, d.paramsHash, d.resourceId ?? null, exp, allow, body.data.target_id, input.data as object, now],
    );
    await c.query("select stepup_challenge_put($1,$2,$3,$4,$5,$6::interval)", [options.challenge, userId, sessionHash, actionId, now, `${STEPUP_TTL_MS} milliseconds`]);
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "stepup.prepare", resourceKind: "action", resourceId: actionId, detail: { type: spec.type } });
    return json({ action_id: actionId, webauthn_options: options, summary: d.summary, expires_at: exp.toISOString() });
  });
}

// commit ----------------------------------------------------------------------------------------------------------

interface ActionRow {
  id: string; user_id: string; type: ActionType; params: Record<string, unknown>; params_hash: Buffer; resource_id: string | null;
  state: string; expires_at: Date; allow_credential_ids: string[] | null; target_id: string | null; user_input: unknown; session_id_hash: Buffer;
}

/** Every failure after the challenge is consumed is audited, and the action is cancelled (its challenge is gone). */
async function recordFailure(req: HandlerReq, userId: string, action: ActionRow, reason: string): Promise<void> {
  try {
    await withUser(req.ctx.runtime, userId, async (c) => {
      await c.query("update actions set state = 'cancelled' where id = $1 and state = 'prepared'", [action.id]);
      await appendAudit(req.ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "stepup.commit_failed", resourceKind: "action", resourceId: action.id, detail: { type: action.type, reason } });
    });
  } catch { /* the request is already failing; never mask the real error */ }
}

async function raiseFlipAlert(req: HandlerReq, userId: string, action: ActionRow, passkeyId: string): Promise<void> {
  await withUser(req.ctx.runtime, userId, async (c) => {
    await c.query("insert into alerts (severity, kind, subject, detail, raised_at) values ('page','webauthn_backup_eligible_flip',$1,$2,$3)", [passkeyId, { action_id: action.id }, req.ctx.clock.now()]);
  });
}

export async function commitHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const { userId, sessionHash } = sessionOf(req);
  const actionId = req.params.id ?? "";
  if (!UUID.test(actionId)) throw new HttpError(404, "not_found");
  const body = CommitBody.safeParse(req.body);
  if (!body.success) throw new HttpError(400, "invalid_request");
  const assertion = body.data.assertion;

  // Same 404 for unknown, other users' and other sessions' actions.
  const action = await withUser(ctx.runtime, userId, async (c) => (await c.query("select * from actions where id = $1 and user_id = $2 and session_id_hash = $3", [actionId, userId, sessionHash])).rows[0] as ActionRow | undefined);
  if (!action) throw new HttpError(404, "not_found");
  const spec = getActionSpec(action.type);
  if (!spec) throw new HttpError(409, "action_unavailable");
  if (action.state !== "prepared") throw new HttpError(409, "action_not_prepared");

  if (spec.held) await withUser(ctx.runtime, userId, (c) => assertNotHeld(ctx, c, userId, action.type));

  // (a) Consume the challenge in its own committed statement, before verification. Zero rows ends the request.
  const consumed = await withUser(ctx.runtime, userId, async (c) =>
    (await c.query("select * from stepup_challenge_consume($1,$2,$3,$4)", [action.id, userId, sessionHash, ctx.clock.now()])).rows[0] as { id: string; challenge: string } | undefined);
  if (!consumed) {
    // Replay, race loser or expired: audited, and the action is left alone (a winner may be finishing it).
    await withUser(ctx.runtime, userId, (c) => appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "stepup.commit_refused", resourceKind: "action", resourceId: action.id, detail: { type: action.type, reason: "challenge_unavailable" } })).catch(() => undefined);
    throw new HttpError(409, "challenge_unavailable");
  }

  const fail = async (status: number, code: string, reason = code): Promise<never> => {
    await recordFailure(req, userId, action, reason);
    throw new HttpError(status, code);
  };

  // (b) Session and user match (checked by the lookup above), response.id was issued, credential belongs to this user and is live.
  if (!(action.allow_credential_ids ?? []).includes(assertion.id)) return fail(403, "assertion_invalid", "credential_not_allowed");
  const cred = await withUser(ctx.runtime, userId, async (c) => (await c.query(
    `select p.id, p.credential_id, p.public_key, p.sign_count, p.transports, p.backup_eligible, p.backup_state, u.webauthn_user_handle, u.hardened_mode
       from passkeys p join users u on u.id = p.user_id
      where p.credential_id = $1 and p.user_id = $2 and p.revoked_at is null and p.suspended_at is null`, [assertion.id, action.user_id])).rows[0]);
  if (!cred) return fail(403, "assertion_invalid", "credential_unavailable");
  // Hardened mode, turned on after prepare, still refuses a synced credential (ST-53).
  if (cred.hardened_mode && cred.backup_eligible) return fail(403, "assertion_invalid", "hardened_mode");
  const handle = assertion.response.userHandle;
  if (handle && !safeEqual(fromB64u(handle), Buffer.from(cred.webauthn_user_handle))) return fail(403, "assertion_invalid", "user_handle_mismatch");

  const wire = { ...assertion, response: { ...assertion.response, userHandle: handle ?? undefined } } as unknown as AuthenticationResponseJSON;
  let verified;
  try {
    // signCount is enforced only for credentials whose backup-eligible bit is 0.
    verified = await verifyAssertion(ctx, wire, consumed.challenge, {
      credentialId: cred.credential_id, publicKey: cred.public_key, signCount: cred.backup_eligible ? 0 : Number(cred.sign_count),
      transports: cred.transports, backupEligible: cred.backup_eligible,
    });
  } catch { return fail(403, "assertion_invalid", "verification_failed"); }
  if (!verified.userVerified) return fail(403, "assertion_invalid", "user_not_verified");
  if (verified.backupEligible !== cred.backup_eligible) {
    await raiseFlipAlert(req, userId, action, cred.id).catch(() => undefined);
    return fail(403, "assertion_invalid", "backup_eligible_flip");
  }

  // (c) One transaction: re-derive, compare, compare-and-set, execute, audit.
  let out: HandlerResult;
  try {
    out = await withUser(ctx.runtime, userId, async (c) => {
      if (spec.held) await assertNotHeld(ctx, c, userId, action.type);
      const d = await deriveAction(ctx, c, spec, userId, action.target_id ?? "", action.user_input ?? {});
      if (!safeEqual(d.paramsHash, action.params_hash)) throw new HttpError(409, "params_changed");
      const now = ctx.clock.now();
      const r = await c.query(
        `update actions set state = 'committed', committed_at = $4, expires_at = $5, credential_id = $6, uv = $7, be = $8, bs = $9,
                client_data_json = $10, authenticator_data = $11, signature = $12
          where id = $1 and user_id = $2 and session_id_hash = $3 and state = 'prepared' and expires_at > $4 returning id`,
        [action.id, userId, sessionHash, now, new Date(now.getTime() + STEPUP_TTL_MS), assertion.id, verified.userVerified, verified.backupEligible, verified.backupState,
          fromB64u(assertion.response.clientDataJSON), fromB64u(assertion.response.authenticatorData), fromB64u(assertion.response.signature)],
      );
      if (r.rowCount !== 1) throw new HttpError(409, "action_conflict");
      // Verification happens outside this transaction. A revoke, recovery suspension, newer assertion or session
      // revocation that won while verification/derivation ran must prevent the approval from committing.
      const credential = await c.query(
        `update passkeys p set sign_count = $2, backup_state = $3, last_used_at = $4
          where p.id = $1 and p.user_id = $5 and p.revoked_at is null and p.suspended_at is null
            and p.sign_count = $6 and p.backup_eligible = $7
            and exists (select 1 from users u where u.id = p.user_id and u.status = 'active'
              and not (u.hardened_mode and p.backup_eligible))
            and exists (select 1 from sessions s where s.id_hash = $8 and s.user_id = p.user_id
              and s.revoked_at is null and s.expires_at > $4 and s.idle_expires_at > $4)
          returning p.id`,
        [cred.id, verified.newCounter, verified.backupState, now, userId, cred.sign_count, cred.backup_eligible, sessionHash],
      );
      if (credential.rowCount !== 1) throw new HttpError(403, "assertion_invalid");
      const committed: CommittedAction = { id: action.id, userId, type: action.type, params: action.params, resourceId: action.resource_id, targetId: action.target_id ?? "" };
      if (spec.execute) await spec.execute(ctx, c, committed);
      await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "stepup.commit", resourceKind: "action", resourceId: action.id, detail: { type: action.type, passkey_id: cred.id } });
      const state = (await c.query("select state from actions where id = $1", [action.id])).rows[0].state as string;
      return json({ action_id: action.id, type: action.type, state });
    });
  } catch (e) {
    await recordFailure(req, userId, action, e instanceof HttpError ? e.code : "commit_error");
    throw e;
  }
  return out;
}

// read ------------------------------------------------------------------------------------------------------------

export async function getActionHandler(req: HandlerReq): Promise<HandlerResult> {
  const { userId, sessionHash } = sessionOf(req);
  const id = req.params.id ?? "";
  if (!UUID.test(id)) throw new HttpError(404, "not_found");
  const row = await withUser(req.ctx.runtime, userId, async (c) => (await c.query("select id, type, state, params, expires_at, committed_at from actions where id = $1 and user_id = $2 and session_id_hash = $3", [id, userId, sessionHash])).rows[0]);
  if (!row) throw new HttpError(404, "not_found");
  const spec = getActionSpec(row.type);
  return json({ id: row.id, type: row.type, state: row.state, summary: spec ? spec.summary(row.params) : "", expires_at: new Date(row.expires_at).toISOString(), committed_at: row.committed_at ? new Date(row.committed_at).toISOString() : null });
}
