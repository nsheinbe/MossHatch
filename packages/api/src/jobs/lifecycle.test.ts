import { afterEach, describe, expect, it } from "vitest";
import { requestWaitUntil, tickBudget, tickConcurrency } from "./lifecycle.ts";

const symbol = Symbol.for("@vercel/request-context");
const globals = globalThis as Record<symbol, unknown>;
const original = globals[symbol];
afterEach(() => { if (original === undefined) delete globals[symbol]; else globals[symbol] = original; });

describe("serverless worker lifecycle", () => {
  it("passes the exact worker promise to the current request's lifecycle hook", async () => {
    let waited: Promise<unknown> | undefined;
    const context = { waitUntil(p: Promise<unknown>) { expect(this).toBe(context); waited = p; } };
    globals[symbol] = { get: () => context };
    const work = Promise.resolve("complete");
    requestWaitUntil()?.(work);
    expect(waited).toBe(work);
    await expect(waited).resolves.toBe("complete");
  });
  it("reads each request context independently and allows local callers without a runtime hook", () => {
    delete globals[symbol];
    expect(requestWaitUntil()).toBeUndefined();
    let current = { waitUntil: () => undefined };
    globals[symbol] = { get: () => current };
    const first = requestWaitUntil();
    current = { waitUntil: () => undefined };
    expect(requestWaitUntil()).not.toBe(first);
  });
  it("makes parallelism tunable and leaves enough time for a complete 300-second last wave", () => {
    expect(tickConcurrency({})).toBe(32);
    expect(tickConcurrency({ MH_TICK_CONCURRENCY: "128" })).toBe(128);
    expect(tickConcurrency({ MH_TICK_CONCURRENCY: "999" })).toBe(256);
    expect(tickConcurrency({ MH_TICK_CONCURRENCY: "NaN" })).toBe(32);
    expect(tickBudget({})).toBe(450_000);
    expect(tickBudget({ MH_TICK_BUDGET_MS: "999999999" })).toBe(450_000);
    expect(tickBudget({ MH_TICK_BUDGET_MS: "-1" })).toBe(450_000);
    expect(tickBudget({}) + 300_000).toBeLessThan(800_000);
  });
});
