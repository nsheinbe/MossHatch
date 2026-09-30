import { z } from "zod";
import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { ACTION_TYPES, type ActionType } from "../http/types.ts";
import { HttpError } from "../http/router.ts";
import { hashOf } from "../util/bytes.ts";

export interface DerivedAction {
  /** Canonical parameters, built from server state only. Hashed into the challenge. */
  params: Record<string, unknown>;
  /** Opaque id of the thing acted on, when there is one. */
  resourceId?: string;
}

export interface CommittedAction {
  id: string;
  userId: string;
  type: ActionType;
  params: Record<string, unknown>;
  resourceId: string | null;
  targetId: string;
}

export interface ActionSpec<I = any> {
  type: ActionType;
  /** Refused during the recovery holds (all true except `mandate.sign`). */
  held: boolean;
  /** Strict schema for what the person supplies. The client never supplies params. */
  userInput: z.ZodType<I>;
  /** Build the canonical params from current server state. Throw HttpError for a missing or unowned target (404). */
  derive(ctx: AppContext, client: PoolClient, userId: string, targetId: string, input: I): Promise<DerivedAction>;
  /** Plain-language summary rendered from the canonical params (what the person sees before touching the key). */
  summary(params: Record<string, unknown>): string;
  /** Optional. Runs inside the commit transaction (may queue an `action.execute` job with `enqueue`). */
  execute?(ctx: AppContext, client: PoolClient, action: CommittedAction): Promise<void>;
}

const specs = new Map<ActionType, ActionSpec>();
const placeholders = new Set<ActionType>();

export function registerActionSpec<I>(spec: ActionSpec<I>): void {
  if (!ACTION_TYPES.includes(spec.type)) throw new Error(`action spec for unknown id: ${String(spec.type)}`);
  specs.set(spec.type, spec as ActionSpec);
  placeholders.delete(spec.type);
}
export function getActionSpec(type: string): ActionSpec | undefined {
  return specs.get(type as ActionType);
}
export const isPlaceholderSpec = (type: ActionType) => placeholders.has(type);

/** The registry keyed by the thirteen ids. */
export const actionSpecs: ReadonlyMap<ActionType, ActionSpec> = specs;

/** Test hook: back to the shipped specs. */
export function resetActionSpecs(): void {
  specs.clear(); placeholders.clear();
  installDefaults();
}

const unavailable = (type: ActionType): ActionSpec => ({
  type, held: type !== "mandate.sign",
  userInput: z.record(z.string(), z.unknown()),
  async derive() { throw new HttpError(409, "action_unavailable"); },
  summary: () => "",
});

// passkey.add ---------------------------------------------------------------------------------------------------

export const SUPPORTED_ALG_LIST = [-7, -257];

/** The options a registration ceremony will use, hashed. Includes the live credential ids, so adding one in between invalidates the action. */
export async function passkeyAddOptionsHash(ctx: AppContext, client: PoolClient, userId: string): Promise<string> {
  const ids = (await client.query("select credential_id from passkeys where user_id = $1 and revoked_at is null order by credential_id", [userId])).rows.map((r) => r.credential_id as string);
  return hashOf({ rp_id: ctx.config.rpId, algs: SUPPORTED_ALG_LIST, attestation: "none", user_verification: "required", exclude: ids }).toString("hex");
}

const passkeyAddInput = z.object({ label: z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f\u007f]+$/) }).strict();

export const passkeyAddSpec: ActionSpec<z.infer<typeof passkeyAddInput>> = {
  type: "passkey.add", held: true, userInput: passkeyAddInput,
  async derive(ctx, client, userId, targetId, input) {
    if (targetId !== userId) throw new HttpError(404, "not_found");
    return { params: { label: input.label, options_hash: await passkeyAddOptionsHash(ctx, client, userId) }, resourceId: userId };
  },
  summary: (p) => `Add a passkey named "${String(p.label)}" to your account.`,
};

function installDefaults(): void {
  for (const t of ACTION_TYPES) { specs.set(t, unavailable(t)); placeholders.add(t); }
  registerActionSpec(passkeyAddSpec);
}
installDefaults();
