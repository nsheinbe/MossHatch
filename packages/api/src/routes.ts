import { Router } from "./http/router.ts";
import { registerStepUp } from "./stepup/routes.ts";
import { authRoutes } from "./auth/routes.ts";
import { registerSearchRoutes } from "./search/routes.ts";
import { registerOps } from "./ops/routes.ts";
import { registerOrderRoutes } from "./orders/routes.ts";
import { registerAccountRoutes } from "./account/routes.ts";
import { registerDomainRoutes } from "./domains/routes.ts";
import { registerDomainMgmt } from "./domain-mgmt/routes.ts";
import { registerTransfers } from "./transfers/routes.ts";
import { registerVaultRoutes } from "./vault/routes.ts";
import { registerPublish } from "./publish/routes.ts";
import { registerBindings } from "./bindings/routes.ts";
import { registerRecipes } from "./recipes/routes.ts";
import { registerAgentRoutes } from "./agents/routes.ts";
import { registerCspRoutes } from "./csp/report.ts";
import { registerClosureRoutes } from "./closure/routes.ts";
import { requireLiveAccess } from "./waitlist/gate.ts";
import { registerLauncher } from "./launcher/routes.ts";

/** The route table. Each module adds one registration line. */
export function buildRouter(): Router {
  const router = new Router();
  router.setLiveAccessGate(requireLiveAccess);
  registerStepUp(router);
  router.add(...authRoutes);
  registerSearchRoutes(router);
  registerOps(router);
  registerOrderRoutes(router);
  registerAccountRoutes(router);
  registerDomainRoutes(router);
  registerDomainMgmt(router);
  registerTransfers(router);
  registerVaultRoutes(router);
  registerPublish(router);
  registerBindings(router);
  registerRecipes(router);
  registerAgentRoutes(router);
  registerCspRoutes(router);
  registerClosureRoutes(router);
  registerLauncher(router);
  return router;
}
