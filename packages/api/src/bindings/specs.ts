import { z } from "zod";
import type { PoolClient } from "@mosshatch/db";
import { HttpError } from "../http/router.ts";
import { hashOf } from "../util/bytes.ts";
import { registerActionSpec, type ActionSpec } from "../stepup/specs.ts";
import { lintScopes, ownedDomainMap, parseScopes, ScopeError, scopeString, storedScopes, type Scope } from "./scopes.ts";
import { AGENT_DEFAULT_MS, AGENT_MAX_MS, DAY } from "./tokens.ts";

/**
 * `agent.token.create` and `agent.token.widen` (PLAN 4.5). The person supplies only the name, the scope strings, the cap
 * and the lifetime; the server parses them against the person's own live domains, lints them token-wide, and binds the
 * canonical result. A lint failure or any unparseable scope is 422 at prepare, so nothing is signed.
 */

export const NAME_RE = /^[A-Za-z0-9 ._:()-]{1,64}$/;
const days = z.number().int().min(1).max(AGENT_MAX_MS / DAY);

const createInput = z.strictObject({
  name: z.string().regex(NAME_RE),
  scopes: z.array(z.string().max(300)).min(1).max(50),
  spend_cap_minor: z.number().int().min(0).max(100_000_00).optional(),
  expires_in_days: days.optional(),
});
const widenInput = z.strictObject({
  name: z.string().regex(NAME_RE).optional(),
  scopes: z.array(z.string().max(300)).min(1).max(50),
  spend_cap_minor: z.number().int().min(0).max(100_000_00).optional(),
  expires_in_days: days.optional(),
});

export async function parseForUser(c: PoolClient, userId: string, raw: string[]): Promise<Scope[]> {
  let scopes: Scope[];
  try { scopes = parseScopes(raw, await ownedDomainMap(c, userId)); }
  catch (e) { if (e instanceof ScopeError) throw new HttpError(422, "invalid_scope", undefined, undefined, { reason: e.reason }); throw e; }
  const lint = lintScopes(scopes);
  if (lint) throw new HttpError(422, "scope_conflict", undefined, undefined, { reason: lint });
  return scopes;
}

export const canonical = (s: Scope[]) => s.map((x) => ({ capability: x.capability, domain_id: x.domain_id, env: x.env, label: x.label }));

export const agentTokenCreateSpec: ActionSpec<z.infer<typeof createInput>> = {
  type: "agent.token.create", held: true, userInput: createInput,
  async derive(_ctx, c, userId, targetId, input) {
    if (targetId !== userId) throw new HttpError(404, "not_found");
    const scopes = await parseForUser(c, userId, input.scopes);
    return { params: { name: input.name, scopes: canonical(scopes), spend_cap_minor: input.spend_cap_minor ?? 0, expires_in_days: input.expires_in_days ?? AGENT_DEFAULT_MS / DAY }, resourceId: userId };
  },
  summary: (p) => `Create a token named "${String(p.name)}" for ${String(p.expires_in_days)} days that can: ${(p.scopes as Scope[]).map(scopeString).join(", ")}.`,
};

/** The binding as it stands, hashed: a change between prepare and commit (or a revoke) invalidates the assertion. */
export async function bindingState(c: PoolClient, userId: string, bindingId: string, lock = false) {
  if (!/^[0-9a-f-]{36}$/i.test(bindingId)) throw new HttpError(404, "not_found");
  const b = (await c.query(`select id, kind, name, scopes, spend_cap_minor, expires_at, family_expires_at, paused_at, oauth_client_id, audience from bindings where id = $1 and user_id = $2 and revoked_at is null${lock ? " for update" : ""}`, [bindingId, userId])).rows[0];
  if (!b) throw new HttpError(404, "not_found");
  const before = { name: b.name as string, scopes: canonical(storedScopes(b.scopes)), spend_cap_minor: String(b.spend_cap_minor), expires_at: new Date(b.expires_at).toISOString(), grant_expires_at: new Date(b.family_expires_at ?? b.expires_at).toISOString(), paused: !!b.paused_at, kind: b.kind, client_id: b.oauth_client_id, audience: b.audience };
  return { row: b, before, beforeHash: hashOf(before).toString("hex") };
}

export const agentTokenWidenSpec: ActionSpec<z.infer<typeof widenInput>> = {
  type: "agent.token.widen", held: true, userInput: widenInput,
  async derive(_ctx, c, userId, targetId, input) {
    const { row, before, beforeHash } = await bindingState(c, userId, targetId);
    const scopes = await parseForUser(c, userId, input.scopes);
    const after = { name: input.name ?? row.name, scopes: canonical(scopes), spend_cap_minor: input.spend_cap_minor ?? Number(row.spend_cap_minor), expires_in_days: input.expires_in_days ?? null };
    return { params: { binding_id: row.id, kind: row.kind, before_hash: beforeHash, before_scopes: before.scopes, after }, resourceId: row.id };
  },
  summary: (p) => {
    const a = p.after as { name: string; scopes: Scope[]; expires_in_days: number | null };
    return `Change the token "${a.name}" so it can: ${a.scopes.map(scopeString).join(", ")}${a.expires_in_days ? `, for ${a.expires_in_days} more days` : ""}. A paused token resumes.`;
  },
};

export function registerBindingSpecs(): void {
  registerActionSpec(agentTokenCreateSpec);
  registerActionSpec(agentTokenWidenSpec);
}
