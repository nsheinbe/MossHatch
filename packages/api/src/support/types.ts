import type { AppContext } from "../ports.ts";

export type SupportCtx = Pick<AppContext, "cron" | "kms" | "clock">;

/** Support staff are identified by an opaque id (never an email), recorded as `actor_id` on every audit row. */
export interface SupportActor { staffId: string }

/**
 * Starts the NORMAL recovery flow for a user (the auth module's recovery start), with the same cooling-off, holds and
 * notices as a self-service start. Injected so support has no import path into the auth or step-up code.
 * It takes no option that could shorten or skip a delay, and returns no code or link.
 */
export type RecoveryStarter = (args: { userId: string; initiatedBy: "support" }) => Promise<{ status: "started" | "already_open" | "not_available"; requestId?: string }>;

export const STAFF_ID_RE = /^[a-z0-9][a-z0-9_-]{2,39}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SupportError extends Error {
  override name = "SupportError";
  constructor(public code: "bad_actor" | "bad_id") { super(code); }
}
