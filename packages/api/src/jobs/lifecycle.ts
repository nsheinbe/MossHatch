/** The same request hook used by @vercel/functions waitUntil. Kept dependency-free like our OIDC adapter. */
export type WaitUntil = (promise: Promise<unknown>) => void;
export function requestWaitUntil(): WaitUntil | undefined {
  const context = (globalThis as Record<symbol, { get?: () => { waitUntil?: WaitUntil } } | undefined>)[Symbol.for("@vercel/request-context")]?.get?.();
  return context?.waitUntil?.bind(context);
}

/** A larger wave reduces backlog latency; instances still coordinate through durable SKIP LOCKED claims. */
export function tickConcurrency(env: Record<string, string | undefined>): number {
  const value = env.MH_TICK_CONCURRENCY?.trim();
  return value && /^\d+$/.test(value) ? Math.max(1, Math.min(256, Number(value))) : 32;
}
/** Leave 350 seconds for the last wave (the longest registered handler is 300 seconds) and bookkeeping. */
export function tickBudget(env: Record<string, string | undefined>): number {
  const value = env.MH_TICK_BUDGET_MS?.trim();
  return value && /^\d+$/.test(value) ? Math.max(1, Math.min(450_000, Number(value))) : 450_000;
}
