import type { Router } from "../http/router.ts";
import type { Route } from "../http/types.ts";
import { registerDomainMgmtJobs } from "./jobs.ts";
import { installDomainSpecs } from "./specs.ts";
import { dsChangeHandler, dsListHandler, issueCodeHandler, lockHandler, nameserversHandler, securityHandler, unlockHandler } from "./security.ts";
import { stopHandler, transferStateHandler } from "./transfer.ts";
import { contactChangesHandler, contactHandler, draftHandler, submitHandler } from "./contact.ts";
import { dnsAddHandler, dnsDeleteHandler, dnsPatchHandler, dnsPutHandler, dnsReadHandler, rollbackHandler, snapshotsHandler } from "./dns.ts";
import { verificationSendHandler, verificationStatusHandler, verificationVerifyHandler } from "./verification.ts";

const P = "/api/v1/domains/:fqdn";
const base = { principals: ["session" as const], tag: "domain-mgmt" };

/**
 * Domain management routes. All are session-only: a bearer token gets 401 or 403 (agents reach DNS through the recipe and approval
 * routes of later phases). The four gated ones fail with 403 `step_up_required` before any handler code runs.
 */
export const domainMgmtRoutes: Route[] = [
  { ...base, method: "GET", path: `${P}/security`, handler: securityHandler },
  { ...base, method: "GET", path: `${P}/transfer`, handler: transferStateHandler },
  { ...base, method: "POST", path: `${P}/unlock`, stepUp: "domain.unlock", handler: unlockHandler },
  { ...base, method: "POST", path: `${P}/lock`, handler: lockHandler },
  { ...base, method: "POST", path: `${P}/transfer-out`, stepUp: "domain.transfer_out", handler: issueCodeHandler },
  { ...base, method: "POST", path: `${P}/transfer/stop`, handler: stopHandler },
  { ...base, method: "POST", path: `${P}/nameservers`, stepUp: "domain.nameservers.change", handler: nameserversHandler },
  { ...base, method: "GET", path: `${P}/ds`, handler: dsListHandler },
  { ...base, method: "POST", path: `${P}/ds`, stepUp: "domain.nameservers.change", handler: dsChangeHandler },
  { ...base, method: "GET", path: `${P}/contact`, handler: contactHandler },
  { ...base, method: "POST", path: `${P}/contact`, stepUp: "domain.contact.change", handler: submitHandler },
  { ...base, method: "POST", path: `${P}/contact-drafts`, handler: draftHandler },
  { ...base, method: "GET", path: `${P}/contact-changes`, handler: contactChangesHandler },
  { ...base, method: "GET", path: `${P}/dns`, handler: dnsReadHandler },
  { ...base, method: "POST", path: `${P}/dns`, handler: dnsAddHandler },
  { ...base, method: "PUT", path: `${P}/dns`, handler: dnsPutHandler },
  { ...base, method: "PATCH", path: `${P}/dns/:id`, handler: dnsPatchHandler },
  { ...base, method: "DELETE", path: `${P}/dns/:id`, handler: dnsDeleteHandler },
  { ...base, method: "GET", path: `${P}/dns-snapshots`, handler: snapshotsHandler },
  { ...base, method: "POST", path: `${P}/dns-snapshots/:sid/rollback`, handler: rollbackHandler },
  { ...base, method: "GET", path: `${P}/registrant-verification`, handler: verificationStatusHandler },
  { ...base, method: "POST", path: `${P}/registrant-verification/send`, handler: verificationSendHandler },
  { ...base, method: "POST", path: `${P}/registrant-verification/verify`, handler: verificationVerifyHandler },
];

/** One registration line in `routes.ts`. Installs the step-up specs and the jobs as well, so a router built anywhere is complete. */
export function registerDomainMgmt(router: Router): Router {
  installDomainSpecs();
  registerDomainMgmtJobs();
  router.add(...domainMgmtRoutes);
  return router;
}
