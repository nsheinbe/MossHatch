import { tx } from "@mosshatch/db";
import { appendAudit } from "../audit.ts";
import { STAFF_ID_RE, SupportError, UUID_RE, type RecoveryStarter, type SupportActor, type SupportCtx } from "./types.ts";

/**
 * The whole write surface of support: it can ask the normal recovery flow to start for a customer who lost every
 * passkey. That flow carries its own cooling-off period, holds and notices to every address, and a customer can cancel
 * it; support gets back a status and an opaque request id, never a code or link, and has no way to shorten a delay.
 * An identity claim by email or phone is not an input here: it never replaces a passkey ceremony.
 */
export async function startLostPasskeyRecovery(
  ctx: SupportCtx, actor: SupportActor, userId: string, startRecovery: RecoveryStarter,
): Promise<{ status: "started" | "already_open" | "not_available"; requestId?: string }> {
  if (!STAFF_ID_RE.test(actor?.staffId ?? "")) throw new SupportError("bad_actor");
  if (!UUID_RE.test(userId)) throw new SupportError("bad_id");
  let outcome: "started" | "already_open" | "not_available" | "error" = "error";
  let requestId: string | undefined;
  try {
    const r = await startRecovery({ userId, initiatedBy: "support" });
    outcome = r.status; requestId = r.requestId;
    return r.requestId ? { status: r.status, requestId: r.requestId } : { status: r.status };
  } finally {
    await tx(ctx.cron, (c) => appendAudit(ctx, c, {
      chainId: userId, actorKind: "support", actorId: actor.staffId, action: "support.recovery_start", resourceKind: "recovery_request", resourceId: requestId, detail: { outcome },
    }));
  }
}
