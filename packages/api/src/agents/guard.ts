import { withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { appendAudit } from "../audit.ts";
import { hit, type Limit } from "../ratelimit.ts";
import { raiseAlert } from "../ops/alerts.ts";
import type { Caller } from "./common.ts";

/**
 * Every agent call, over MCP or REST, runs through here (threat rows 19 and 20): a limit keyed by the token id (never by
 * address: hosted connectors share one range), an audit row per call with the binding id and the operation name (static
 * strings, never arguments or results), and scope-denied bursts audited and alerted (ST-82).
 */

export const AGENT_LIMITS: Record<"read" | "write", Limit> = {
  read: { bucket: "agent.call.read", max: 120, windowSeconds: 60 },
  write: { bucket: "agent.call.write", max: 30, windowSeconds: 60 },
};
export const SCOPE_DENIED_BURST: Limit = { bucket: "agent.scope_denied", max: 10, windowSeconds: 600 };

export async function guarded<T>(ctx: AppContext, caller: Caller, op: string, kind: "read" | "write", via: "mcp" | "rest", fn: () => Promise<T>): Promise<T> {
  const rl = await withUser(ctx.runtime, caller.userId, (c) => hit(ctx, c, caller.bindingId, AGENT_LIMITS[kind]));
  if (!rl.allowed) throw new HttpError(429, "rate_limited", undefined, { "Retry-After": String(rl.retryAfterSeconds) });
  try {
    const out = await fn();
    await audit(ctx, caller, op, via, "ok");
    return out;
  } catch (e) {
    const code = e instanceof HttpError ? e.code : "error";
    await audit(ctx, caller, op, via, code === "scope_missing" || code === "scope_conflict" ? "scope_denied" : "refused");
    if (code === "scope_missing" || code === "scope_conflict") await scopeDenied(ctx, caller, op);
    throw e;
  }
}

async function audit(ctx: AppContext, caller: Caller, op: string, via: string, outcome: string): Promise<void> {
  await withUser(ctx.runtime, caller.userId, (c) => appendAudit(ctx, c, {
    chainId: caller.userId, actorKind: caller.kind, actorId: caller.bindingId, action: via === "mcp" ? "mcp.tool_call" : "agent.call",
    resourceKind: "binding", resourceId: caller.bindingId, detail: { op, outcome },
  })).catch(() => undefined);
}

async function scopeDenied(ctx: AppContext, caller: Caller, op: string): Promise<void> {
  try {
    await withUser(ctx.runtime, caller.userId, async (c) => {
      await appendAudit(ctx, c, { chainId: caller.userId, actorKind: caller.kind, actorId: caller.bindingId, action: "agent.scope_denied", resourceKind: "binding", resourceId: caller.bindingId, detail: { op } });
      const h = await hit(ctx, c, caller.bindingId, SCOPE_DENIED_BURST);
      if (h.count > SCOPE_DENIED_BURST.max) await raiseAlert(ctx, c, { severity: "warn", kind: "agent.scope_denied_burst", subject: caller.bindingId, detail: { count: h.count } });
    });
  } catch { /* the refusal stands either way */ }
}
