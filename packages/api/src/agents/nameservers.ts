import { hashOf } from "../util/bytes.ts";
import type { AppContext } from "../ports.ts";
import { nameserverPlan } from "../domain-mgmt/nameservers.ts";
import { callerDomain, need } from "./capabilities.ts";
import { createRequest } from "./requests.ts";
import type { Caller } from "./common.ts";

/** Propose only. Agents cannot approve or execute registry delegation and never receive destination-provider credentials. */
export async function agentNameserverPropose(ctx: AppContext, caller: Caller, fqdn: string, raw: unknown) {
  const d = await callerDomain(ctx, caller, fqdn);
  need(caller, "nameservers.propose", d.id, null);
  const plan = await nameserverPlan(ctx, d, raw);
  const params = { ...plan, binding_id: caller.bindingId, tenant_id: caller.userId };
  const proposal = await createRequest(ctx, caller, {
    kind: "nameservers_change", domainId: d.id, fqdn: d.fqdn_ascii, years: null, quotedMinor: 0n, priceHash: null, requiredCapability: "nameservers.propose",
    requestHash: hashOf({ kind: "nameservers_change", ...params }), params,
    facts: { kind: "nameservers_change", bindingName: "", fqdn: d.fqdn_ascii, years: null, totalMinor: 0n },
  });
  return { ...proposal, executable: false, blockers: plan.blockers, plan_hash: plan.plan_hash };
}
