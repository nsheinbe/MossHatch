import { withNoUser } from "@mosshatch/db";
import { json, type Router } from "../http/router.ts";
import type { Route } from "../http/types.ts";
import { runTick, tickAgeSeconds } from "../jobs/engine.ts";
import { registerOpsJobs } from "./jobs.ts";

/** Cron tick: the router compares the Authorization value only with CRON_SECRET. Idempotent; safe when duplicated. */
export const tickRoute: Route = {
  method: "GET", path: "/api/cron/tick", principals: ["cron"], tag: "ops",
  handler: async (r) => {
    const budget = Number(process.env.MH_TICK_BUDGET_MS ?? 50_000);
    const res = await runTick(r.ctx, { budgetMs: Number.isFinite(budget) && budget > 0 ? budget : 50_000 });
    return json(res);
  },
};

/**
 * Age of the last completed tick and nothing else, for the external dead-man's switch. Anonymous on purpose: the
 * monitor holds no secret. Reads through the runtime role, which may only select flags.
 */
export const healthTicksRoute: Route = {
  method: "GET", path: "/api/health/ticks", principals: ["anonymous"], tag: "ops",
  handler: async (r) => {
    const age = await withNoUser(r.ctx.runtime, (c) => tickAgeSeconds(r.ctx, c as never));
    return json({ ageSeconds: age });
  },
};

export function registerOps(router: Router): void {
  registerOpsJobs();
  router.add(tickRoute, healthTicksRoute);
}
