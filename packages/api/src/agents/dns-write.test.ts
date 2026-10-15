import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RegistrarError, type DnsRecord } from "@mosshatch/registrar/port";
import { zoneHash } from "@mosshatch/registrar/dns";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { bearer, clearCounters, createAgentToken, makeAgentKit, makeDomain, makeOwner, requestRow, stepUp, web, type AgentKit, type Owner } from "./testkit.ts";

/**
 * ST-131 review: an agent's DNS write (direct, or a sensitive change the owner approved) goes through the DNS tab's write safety
 * (`writeZoneLocked`): the pre-write snapshot and the intent row commit before the registrar is called, so a write whose outcome is
 * unknown keeps its snapshot, is audited as such, and can be rolled back from the DNS tab.
 */

let k: AgentKit; let ada: Owner;
beforeAll(async () => { k = await makeAgentKit(); ada = await makeOwner(k, "dnsw-ada"); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await clearCounters(k); k.app.email.clear(); });

let n = 0;
const live = async (fqdn: string) => (await k.h.registrar.getDns(fqdn)).records as DnsRecord[];
const snaps = async (id: string) => (await k.app.db.owner.query("select * from dns_snapshots where domain_id = $1 order by taken_at, id", [id])).rows;
const dnsAudit = async (id: string) => (await k.app.db.owner.query("select action, actor_kind from audit_log where resource_id = $1 and action like 'dns.%' order by seq", [id])).rows as { action: string; actor_kind: string }[];
const sensitiveMail = () => k.app.email.sent.filter((m) => m.kind === "dns.sensitive_changed");

/** The registrar applies the zone for this name, then answers with an unknown outcome, once. */
function unknownOnce(fqdn: string): () => void {
  const reg = k.h.registrar;
  const orig = reg.replaceZone.bind(reg);
  let once = true;
  reg.replaceZone = async (f: string, records: DnsRecord[]) => {
    const w = await orig(f, records);
    if (once && f === fqdn) { once = false; throw new RegistrarError("unknown", "transport timeout", { retryable: true, outcomeUnknown: true }); }
    return w;
  };
  return () => { reg.replaceZone = orig; };
}

async function setup() {
  const d = await makeDomain(k, ada, `dnsw-${++n}-${Date.now().toString(36)}.com`);
  const t = await createAgentToken(k, ada, [`dns.write:${d.fqdn}`, `dns.read:${d.fqdn}`], { name: `DNS bot ${n}` });
  return { d, t };
}

describe("ST-131 review: an agent's direct DNS write whose outcome is unknown keeps its snapshot", () => {
  it("answers 502 outcome_unknown, keeps the committed pre-write snapshot and intent, and the owner can roll it back", async () => {
    const { d, t } = await setup();
    const before = await live(d.fqdn);
    const restore = unknownOnce(d.fqdn);
    try {
      const res = await bearer(k, t.token, "POST", `/api/v1/agent/domains/${d.fqdn}/dns`, { records: [{ type: "A", name: "app", value: "203.0.113.10" }] });
      expect(res.status, res.text).toBe(502);
      expect(res.json.error.code).toBe("outcome_unknown");
    } finally { restore(); }
    const landed = await live(d.fqdn);
    expect(landed).toHaveLength(before.length + 1);                    // it did land upstream
    const s = await snaps(d.id);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ reason: "pre_write", actor_kind: "agent", zone_hash: zoneHash(before), after_hash: null, write_state: "unknown", intended_hash: zoneHash(landed) });
    const audit = await dnsAudit(d.id);
    expect(audit.map((a) => a.action)).toEqual(["dns.write_intent", "dns.write_outcome_unknown"]);
    expect(audit.every((a) => a.actor_kind === "agent")).toBe(true);
    const path = `/api/v1/domains/${d.fqdn}/dns-snapshots/${s[0].id}/rollback`;
    const prompt = await web(k, ada, "POST", path);
    expect(prompt.status).toBe(403);
    const consent = await stepUp(k, ada, prompt.json.error.type, prompt.json.error.target_id, prompt.json.error.user_input);
    expect(consent.status).toBe(200);
    const rb = await web(k, ada, "POST", path, {}, { [ACTION_HEADER]: consent.actionId });
    expect(rb.status, rb.text).toBe(200);
    expect(zoneHash(await live(d.fqdn))).toBe(zoneHash(before));
  });

  it("a normal write still applies once, with its snapshot marked applied and a dns.write row for the agent", async () => {
    const { d, t } = await setup();
    const res = await bearer(k, t.token, "POST", `/api/v1/agent/domains/${d.fqdn}/dns`, { records: [{ type: "A", name: "preview", value: "203.0.113.11" }] });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ applied: true, added: 1, removed: 0 });
    const s = await snaps(d.id);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ write_state: "applied", actor_kind: "agent", after_hash: res.json.zone_hash, id: res.json.snapshot_id });
    expect((await dnsAudit(d.id)).map((a) => a.action)).toEqual(["dns.write_intent", "dns.write"]);
  });
});

describe("ST-131 review: an approved sensitive change whose outcome is unknown keeps its snapshot", () => {
  it("spends the assertion, keeps the snapshot and intent, tells the owner the change may have landed, and a retry cannot write over it", async () => {
    const { d, t } = await setup();
    const before = await live(d.fqdn);
    const mx = await bearer(k, t.token, "POST", `/api/v1/agent/domains/${d.fqdn}/dns`, { records: [{ type: "MX", name: "@", value: "mail.example.net", priority: 10 }] });
    expect(mx.status, mx.text).toBe(202);
    const id = mx.json.approval_id as string;
    const s = await stepUp(k, ada, "dns.sensitive.approve", `ar_${id}`);
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const restore = unknownOnce(d.fqdn);
    try {
      const res = await web(k, ada, "POST", `/api/v1/approvals/${id}/approve-dns`, {}, { [ACTION_HEADER]: s.actionId });
      expect(res.status, res.text).toBe(502);
      expect(res.json.error.code).toBe("outcome_unknown");
    } finally { restore(); }
    const landed = await live(d.fqdn);
    expect(landed.some((r) => r.type === "MX" && r.value.startsWith("mail.example.net"))).toBe(true);
    const snap = await snaps(d.id);
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ reason: "pre_write", zone_hash: zoneHash(before), write_state: "unknown", intended_hash: zoneHash(landed), after_hash: null });
    expect((await dnsAudit(d.id)).map((a) => a.action)).toEqual(["dns.write_intent", "dns.write_outcome_unknown"]);
    const mail = sensitiveMail();
    expect(mail.length).toBeGreaterThan(0);
    expect(mail.every((m) => /may have/i.test(m.text))).toBe(true);
    // The assertion is spent (it approved one write). The request stays approved by it, not marked done: the write may have landed.
    expect((await k.app.db.owner.query("select state from actions where id = $1", [s.actionId])).rows[0].state).toBe("executed");
    expect(await requestRow(k, id)).toMatchObject({ state: "approved", decided_by_action_id: s.actionId });
    expect((await bearer(k, t.token, "GET", `/api/v1/approvals/${id}`)).json.status).toBe("approved");
    const writes = k.h.registrar.calls.replaceZone;
    const replay = await web(k, ada, "POST", `/api/v1/approvals/${id}/approve-dns`, {}, { [ACTION_HEADER]: s.actionId });
    expect([403, 409]).toContain(replay.status);
    // Nothing can write over it: a fresh approval is refused before the passkey, and a decline finds it decided.
    const s2 = await stepUp(k, ada, "dns.sensitive.approve", `ar_${id}`);
    expect(s2.status, JSON.stringify(s2.json)).toBe(409);
    expect(s2.json.error.code).toBe("request_unavailable");
    const dec = await web(k, ada, "POST", `/api/v1/approvals/${id}/decline`);
    expect(dec.status, dec.text).toBe(409);
    expect(k.h.registrar.calls.replaceZone).toBe(writes);
    expect((await requestRow(k, id)).state).toBe("approved");
  });

  it("a write the registrar refuses changes nothing: the snapshot is refused and the request fails (the agent can propose again)", async () => {
    const { d, t } = await setup();
    const before = await live(d.fqdn);
    const mx = await bearer(k, t.token, "POST", `/api/v1/agent/domains/${d.fqdn}/dns`, { records: [{ type: "MX", name: "@", value: "mx.refused.example", priority: 10 }] });
    expect(mx.status, mx.text).toBe(202);
    const id = mx.json.approval_id as string;
    const s = await stepUp(k, ada, "dns.sensitive.approve", `ar_${id}`);
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const reg = k.h.registrar;
    const orig = reg.replaceZone.bind(reg);
    reg.replaceZone = async (f: string, records: DnsRecord[]) => {
      if (f === d.fqdn) throw new RegistrarError("unavailable", "maintenance window", { retryable: true, outcomeUnknown: false });
      return orig(f, records);
    };
    try {
      const res = await web(k, ada, "POST", `/api/v1/approvals/${id}/approve-dns`, {}, { [ACTION_HEADER]: s.actionId });
      expect(res.status, res.text).toBe(503);
    } finally { reg.replaceZone = orig; }
    expect(zoneHash(await live(d.fqdn))).toBe(zoneHash(before));
    expect((await snaps(d.id))[0]).toMatchObject({ write_state: "refused" });
    expect(await requestRow(k, id)).toMatchObject({ state: "failed", decision_reason: "write_refused" });
    expect((await bearer(k, t.token, "GET", `/api/v1/approvals/${id}`)).json.status).toBe("failed");
  });

  it("an approval that applies marks the request completed, keeps an applied snapshot, audits the approval and sends one notice", async () => {
    const { d, t } = await setup();
    const mx = await bearer(k, t.token, "POST", `/api/v1/agent/domains/${d.fqdn}/dns`, { records: [{ type: "MX", name: "@", value: "mx.example.org", priority: 5 }] });
    expect(mx.status, mx.text).toBe(202);
    const id = mx.json.approval_id as string;
    const s = await stepUp(k, ada, "dns.sensitive.approve", `ar_${id}`);
    expect(s.status).toBe(200);
    const ok = await web(k, ada, "POST", `/api/v1/approvals/${id}/approve-dns`, {}, { [ACTION_HEADER]: s.actionId });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toMatchObject({ id, state: "applied" });
    expect((await requestRow(k, id)).state).toBe("completed");
    const snap = await snaps(d.id);
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ write_state: "applied", id: ok.json.snapshot_id, after_hash: ok.json.zone_hash });
    expect((await k.app.db.owner.query("select count(*)::int n from audit_log where resource_id = $1 and action = 'dns.sensitive_approved'", [id])).rows[0].n).toBe(1);
    expect(k.app.email.to(ada.login).filter((m) => m.kind === "dns.sensitive_changed")).toHaveLength(1);
  });
});
