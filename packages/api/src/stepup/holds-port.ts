import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import type { ActionType } from "../http/types.ts";

/** Signature exported by the auth module (`auth/holds.ts`): throws HttpError 423 `recovery_hold` for a held id. */
export type AssertNotHeld = (ctx: AppContext, client: PoolClient, userId: string, actionType: ActionType) => Promise<void>;

let injected: AssertNotHeld | undefined;
/** Tests inject a fake; pass undefined to restore the default. */
export function setHoldsPort(fn: AssertNotHeld | undefined): void { injected = fn; }

let loaded: AssertNotHeld | undefined;
/**
 * Default: the auth module's `assertNotHeld`. It is loaded lazily so this module builds before the auth module exists.
 * Outside tests a missing auth module fails closed (the error propagates and the request is refused).
 */
async function resolvePort(): Promise<AssertNotHeld> {
  if (injected) return injected;
  if (loaded) return loaded;
  const spec = "../auth/holds.ts";
  try {
    const mod = (await import(/* @vite-ignore */ spec)) as { assertNotHeld: AssertNotHeld };
    loaded = mod.assertNotHeld;
    return loaded;
  } catch (e) {
    if (process.env.VITEST && /Cannot find|Failed to load|Failed to resolve/i.test(String((e as Error).message))) return async () => undefined;
    throw e;
  }
}

export async function assertNotHeld(ctx: AppContext, client: PoolClient, userId: string, actionType: ActionType): Promise<void> {
  return (await resolvePort())(ctx, client, userId, actionType);
}
