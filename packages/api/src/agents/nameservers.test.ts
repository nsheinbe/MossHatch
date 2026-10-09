import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bearer, callTool, clearCounters, createAgentToken, makeAgentKit, makeDomain, makeOwner, requestRow, web, type AgentKit, type Owner } from "./testkit.ts";
import { parseScope } from "../bindings/scopes.ts";

let k: AgentKit, owner: Owner, d: { id: string; fqdn: string };
let sequence = 0;
const desired = ["ns2.destination.example", "ns1.destination.example"];
const proposalPath = (fqdn: string) => `/api/v1/agent/domains/${fqdn}/nameservers/proposals`;
beforeAll(async () => { k = await makeAgentKit(); }, 120_000);
beforeEach(async () => {
  await clearCounters(k);
  owner = await makeOwner(k, "ns-owner");
  d = await makeDomain(k, owner, `ns-fixture-${++sequence}.com`);
});
afterAll(async () => { await k?.drop(); });

describe("ST-NS-01: domain-specific nameserver proposals use one browser/MCP/REST plan", () => {
  it("requires explicit domain consent and never inherits dns.write or wildcard scope", async () => {
    expect(() => parseScope("nameservers.propose:*", new Map())).toThrow("domain_required");
    const token = await createAgentToken(k, owner, [`dns.write:${d.fqdn}`]);
    expect((await bearer(k, token.token, "POST", proposalPath(d.fqdn), { nameservers: desired })).status).toBe(403);
    const tool = await callTool(k, token.token, "nameservers_propose", { domain: d.fqdn, nameservers: desired });
    expect(tool.isError).toBe(true);
  });

  it("returns the same immutable plan for browser, MCP and REST; repeats create only one request and no provider write", async () => {
    const token = await createAgentToken(k, owner, [`nameservers.propose:${d.fqdn}`]);
    const writes = k.h.registrar.calls.setNameservers;
    const browser = await web(k, owner, "POST", `/api/v1/domains/${d.fqdn}/nameserver-proposals`, { nameservers: desired });
    expect(browser.status).toBe(200);
    const rest = await bearer(k, token.token, "POST", proposalPath(d.fqdn), { nameservers: desired });
    expect(rest.status, rest.text).toBe(202);
    const tool = await callTool(k, token.token, "nameservers_propose", { domain: d.fqdn, nameservers: [...desired].reverse() });
    expect(tool.isError).not.toBe(true);
    expect(tool.structuredContent.data).toMatchObject({ approval_id: rest.json.approval_id, created: false, plan_hash: browser.json.plan_hash, executable: false });
    const row = await requestRow(k, rest.json.approval_id);
    expect(row.params).toMatchObject({ tenant_id: owner.user.userId, binding_id: token.id, domain_id: d.id, before_hash: browser.json.before_hash, source_records_preserved: true });
    expect(row.expires_at).toBeInstanceOf(Date);
    expect(k.h.registrar.calls.setNameservers).toBe(writes);
    expect((await web(k, owner, "POST", `/api/v1/approvals/${rest.json.approval_id}/decline`, {})).status).toBe(200);
    expect((await web(k, owner, "POST", `/api/v1/approvals/${rest.json.approval_id}/decline`, {})).status).toBe(409);
  });

  it("isolates tenants, domains and the requesting agent", async () => {
    const token = await createAgentToken(k, owner, [`nameservers.propose:${d.fqdn}`]);
    const other = await makeOwner(k, "ns-other");
    const otherDomain = await makeDomain(k, other, `ns-other-${sequence}.com`);
    const ownOther = await makeDomain(k, owner, `ns-own-other-${sequence}.com`);
    const foreign = await bearer(k, token.token, "POST", proposalPath(otherDomain.fqdn), { nameservers: desired });
    const absent = await bearer(k, token.token, "POST", proposalPath("absent-ns.com"), { nameservers: desired });
    expect([foreign.status, foreign.text]).toEqual([absent.status, absent.text]);
    expect(foreign.status).toBe(404);
    expect((await bearer(k, token.token, "POST", proposalPath(ownOther.fqdn), { nameservers: desired })).status).toBe(403);
    const created = await bearer(k, token.token, "POST", proposalPath(d.fqdn), { nameservers: desired });
    const wrongAgent = await createAgentToken(k, owner, [`nameservers.propose:${d.fqdn}`]);
    expect((await bearer(k, wrongAgent.token, "GET", `/api/v1/approvals/${created.json.approval_id}`)).status).toBe(404);
    expect((await web(k, other, "GET", `/api/v1/approvals/${created.json.approval_id}`)).status).toBe(404);
  });

  it("binds out-of-band source changes and rejects malicious nameserver/glue inputs", async () => {
    const before = await web(k, owner, "POST", `/api/v1/domains/${d.fqdn}/nameserver-proposals`, { nameservers: desired });
    k.h.registrar.oob.setNameservers(d.fqdn, ["ns1.changed.example", "ns2.changed.example"]);
    const after = await web(k, owner, "POST", `/api/v1/domains/${d.fqdn}/nameserver-proposals`, { nameservers: desired });
    expect(after.json.before_hash).not.toBe(before.json.before_hash);
    expect(after.json.blockers).toContain("source_inventory_required");
    for (const nameservers of [[`ns1.${d.fqdn}`, `ns2.${d.fqdn}`], ["ns1.example\nInjected", "ns2.example"], ["127.0.0.1", "[::1]"], ["127.0.0.1", "10.0.0.1"]]) {
      expect((await web(k, owner, "POST", `/api/v1/domains/${d.fqdn}/nameserver-proposals`, { nameservers })).status).toBe(422);
    }
  });

  it("blocks claimed signed destinations and unknown DNSSEC; never asks the owner to remove DS to bypass the gate", async () => {
    await k.h.registrar.addDs(d.fqdn, { keyTag: 1, algorithm: 13, digestType: 2, digest: "ab".repeat(32) });
    const plan = await web(k, owner, "POST", `/api/v1/domains/${d.fqdn}/nameserver-proposals`, { nameservers: desired });
    expect(plan.json).toMatchObject({ executable: false, parent_ds: "unverified", destination_dnskey_signatures: "unverified" });
    expect(plan.json.blockers).toContain("dnssec_transition_unverified");
    const prepare = await web(k, owner, "POST", "/api/v1/actions/prepare", { type: "domain.nameservers.change", target_id: d.fqdn, user_input: { kind: "nameservers", nameservers: desired, target_signed: true } });
    expect(prepare.status).toBe(409);
    expect(prepare.json.error.code).toBe("nameserver_migration_unavailable");
    await expect(k.h.registrar.setNameservers(d.fqdn, desired, { targetSigned: true })).rejects.toMatchObject({ code: "dnssec_would_break" });
    expect((await k.h.registrar.getDomain(d.fqdn))!.nameservers).not.toEqual(desired);
  });

  it("rejects revoked and expired proposal grants", async () => {
    const token = await createAgentToken(k, owner, [`nameservers.propose:${d.fqdn}`]);
    await k.app.db.owner.query("update bindings set expires_at = $2 where id = $1", [token.id, new Date(k.app.clock.now().getTime() - 1000)]);
    expect((await bearer(k, token.token, "POST", proposalPath(d.fqdn), { nameservers: desired })).status).toBe(401);
    const revoked = await createAgentToken(k, owner, [`nameservers.propose:${d.fqdn}`]);
    await web(k, owner, "DELETE", `/api/v1/bindings/${revoked.id}`);
    expect((await bearer(k, revoked.token, "POST", proposalPath(d.fqdn), { nameservers: desired })).status).toBe(401);
  });

  it("rechecks a narrowed grant after upstream reads before persisting a proposal", async () => {
    const token = await createAgentToken(k, owner, [`nameservers.propose:${d.fqdn}`]);
    const original = k.h.registrar.getDomain.bind(k.h.registrar);
    const changed = vi.spyOn(k.h.registrar, "getDomain").mockImplementationOnce(async (name) => {
      await k.app.db.owner.query("update bindings set scopes = '[]' where id = $1", [token.id]);
      return original(name);
    });
    try { expect((await bearer(k, token.token, "POST", proposalPath(d.fqdn), { nameservers: desired })).status).toBe(403); }
    finally { changed.mockRestore(); }
    expect((await k.app.db.owner.query("select id from agent_requests where binding_id = $1", [token.id])).rowCount).toBe(0);
  });

  it("uses provider DNSKEY capabilities and fails closed if DNSSEC state cannot be read", async () => {
    const capabilities = vi.spyOn(k.h.registrar, "getDnssecCapabilities").mockResolvedValue({ supported: true, addMode: "dnskey" as never, removeSupported: true, managedSigning: true });
    try {
      const info = await web(k, owner, "GET", `/api/v1/domains/${d.fqdn}/ds`);
      expect(info.json).toMatchObject({ supported: true, add_mode: "dnskey", delegation_changes_supported: false });
      const prep = await web(k, owner, "POST", "/api/v1/actions/prepare", { type: "domain.nameservers.change", target_id: d.fqdn, user_input: { kind: "ds_add", ds: { keyTag: 1, algorithm: 13, digestType: 2, digest: "aa".repeat(32) } } });
      expect(prep.json.error.code).toBe("ds_change_unavailable");
    } finally { capabilities.mockRestore(); }
    const unavailable = vi.spyOn(k.h.registrar, "getDs").mockRejectedValue(new Error("fixture failure"));
    try {
      const plan = await web(k, owner, "POST", `/api/v1/domains/${d.fqdn}/nameserver-proposals`, { nameservers: desired });
      expect(plan.json.blockers).toContain("dnssec_transition_unverified");
      expect(plan.json.executable).toBe(false);
    } finally { unavailable.mockRestore(); }
  });
});
