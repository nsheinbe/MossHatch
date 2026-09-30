import { Router } from "./http/router.ts";
import { registerStepUp } from "./stepup/routes.ts";
import { authRoutes } from "./auth/routes.ts";
import { registerSearchRoutes } from "./search/routes.ts";
import { registerOps } from "./ops/routes.ts";
import { registerOrderRoutes } from "./orders/routes.ts";
import { registerAccountRoutes } from "./account/routes.ts";

/** The route table. Each module adds one registration line. */
export function buildRouter(): Router {
  const router = new Router();
  registerStepUp(router);
  router.add(...authRoutes);
  registerSearchRoutes(router);
  registerOps(router);
  registerOrderRoutes(router);
  registerAccountRoutes(router);
  return router;
}
