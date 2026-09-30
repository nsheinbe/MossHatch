import type { Router } from "../http/router.ts";
import { commitHandler, getActionHandler, prepareHandler } from "./service.ts";
import { createStepUpGate } from "./gate.ts";

/** Session-only step-up routes plus the gate every `stepUp` route passes through. Bearer tokens get 403 from the router. */
export function registerStepUp(router: Router): Router {
  router.add(
    { method: "POST", path: "/api/v1/actions/prepare", principals: ["session"], handler: prepareHandler, tag: "stepup" },
    { method: "POST", path: "/api/v1/actions/:id/commit", principals: ["session"], handler: commitHandler, tag: "stepup" },
    { method: "GET", path: "/api/v1/actions/:id", principals: ["session"], handler: getActionHandler, tag: "stepup" },
  );
  router.setStepUpGate(createStepUpGate());
  return router;
}
