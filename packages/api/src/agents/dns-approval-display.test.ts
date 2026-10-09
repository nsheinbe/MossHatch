import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, createAgentToken, makeAgentKit, makeDomain, makeOwner, stepUp, web, type AgentKit } from "./testkit.ts";

let k: AgentKit;
beforeAll(async () => { k = await makeAgentKit(); }, 120_000);
afterAll(async () => { await k?.drop(); });

describe("ST-201 exact agent DNS approval card", () => {
  it("shows full upstream removals, exact Unicode additions, TTL and all SRV fields to the owner", async () => {
    const owner = await makeOwner(k, "dns-display");
    const domain = await makeDomain(k, owner, "dns-display.com");
    const token = await createAgentToken(k, owner, [`dns.read:${domain.fqdn}`, `dns.write:${domain.fqdn}`]);
    const old = { type: "TXT", name: "old", value: `${"x".repeat(1800)}\u202e-TAIL`, ttl: 86400 };
    const txt = { type: "TXT", name: "proof", value: "e\u0301-owner\u2066-token", ttl: 47 };
    const srv = { type: "SRV", name: "_sip._tcp", value: `service.${domain.fqdn}`, priority: 0, weight: 9, port: 5060, ttl: 120 };
    k.h.registrar.oob.editZone(domain.fqdn, [old]);
    const proposed = await bearer(k, token.token, "POST", `/api/v1/agent/domains/${domain.fqdn}/dns`, { records: [txt, srv], remove: [{ type: "TXT", name: "old" }] });
    expect(proposed.status, proposed.text).toBe(202);
    const card = await web(k, owner, "GET", `/api/v1/approvals/${proposed.json.approval_id}`);
    expect(card.status, card.text).toBe(200);
    expect(card.json.dns.added).toEqual(expect.arrayContaining([txt, srv]));
    expect(card.json.dns.removed).toEqual([old]);
    expect(k.h.registrar.calls.replaceZone).toBe(0);
    const agentRead = await bearer(k, token.token, "GET", `/api/v1/agent/domains/${domain.fqdn}/dns`);
    expect(agentRead.json.records[0].value.length).toBeLessThan(old.value.length);
    expect(agentRead.json.records[0].value).not.toContain("\u202e");
    // Pre-upgrade requests did not retain complete owner-visible values: never sign one after upgrading.
    await k.app.db.owner.query("update agent_requests set params=params-'review_format' where id=$1", [proposed.json.approval_id]);
    const legacy = await stepUp(k, owner, "dns.sensitive.approve", `ar_${proposed.json.approval_id}`);
    expect(legacy.status).toBe(409);
    expect(legacy.json.error.code).toBe("request_unavailable");
  });
});
