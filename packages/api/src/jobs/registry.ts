import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";

export type JobPriority = 0 | 1;

export interface JobRow {
  id: string;
  kind: string;
  attempt_id: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
  user_id: string | null;
}

export interface JobDef {
  kind: string;
  /** 0 = money (first 60% of a tick's budget), 1 = everything else. */
  priority: JobPriority;
  /** Lease = now + maxRuntimeSec + 30 s. A job that outlives its lease cannot commit. */
  maxRuntimeSec: number;
  maxAttempts?: number;
  /** Must be safe to run twice. Throw to retry with backoff; registrar writes are at-most-once through order_operations. */
  handler(ctx: AppContext, job: JobRow): Promise<void>;
}

const defs = new Map<string, JobDef>();
export function registerJob(def: JobDef): void {
  if (defs.has(def.kind)) throw new Error(`job kind registered twice: ${def.kind}`);
  defs.set(def.kind, def);
}
export const getJobDef = (kind: string) => defs.get(kind);
export const listJobDefs = () => [...defs.values()];
/** Test hook. */
export function clearJobRegistry(): void { defs.clear(); }

export interface EnqueueOpts {
  kind: string;
  payload: Record<string, unknown>;      // ids only: the table rejects secret-shaped keys
  userId?: string;
  runAt?: Date;
  dedupeKey?: string;
  priority?: JobPriority;
  maxAttempts?: number;
}

/** Insert a job inside the caller's transaction. A live duplicate (same dedupe key, queued or running) is a no-op. */
export async function enqueue(c: PoolClient, o: EnqueueOpts): Promise<{ id: string | null }> {
  const def = getJobDef(o.kind);
  const r = await c.query(
    `insert into jobs (kind, priority, run_at, dedupe_key, payload, user_id, max_attempts)
     values ($1,$2,coalesce($3, now()),$4,$5,$6,$7) on conflict do nothing returning id`,
    [o.kind, o.priority ?? def?.priority ?? 1, o.runAt ?? null, o.dedupeKey ?? null, o.payload, o.userId ?? null, o.maxAttempts ?? def?.maxAttempts ?? 8],
  );
  return { id: r.rows[0]?.id ?? null };
}
