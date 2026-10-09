import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { RegistrarError, type DnsRecord } from "@mosshatch/registrar/port";
import { zoneHash } from "@mosshatch/registrar/dns";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { snapshotSweepJob } from "../domain-mgmt/dns.ts";
import { bearer, clearCounters, createAgentToken, makeAgentKit, makeDomain, makeOwner, requestRow, stepUp, web, type AgentKit, type Owner } from "./testkit.ts";

// Documented mock registrar only. No external domain or provider API is used.
let k: AgentKit; let ada: Owner; let bob: Owner; let seq = 0;
beforeAll(async () => { k = await makeAgentKit(); ada = await makeOwner(k, "dns-sec-ada"); bob = await makeOwner(k, "dns-sec-bob"); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await clearCounters(k); k.app.email.clear(); });
async function setup() {
  const d = await makeDomain(k, ada, `dns-sec-${++seq}.com`);
  const t = await createAgentToken(k, ada, [`dns.read:${d.fqdn}`, `dns.write:${d.fqdn}`]);
  return { d, t, path: `/api/v1/agent/domains/${d.fqdn}/dns`, ownerPath: `/api/v1/domains/${d.fqdn}/dns` };
}
const live = async (fqdn: string) => [...(await k.h.registrar.getDns(fqdn)).records];
const snapshots = async (domainId: string) => (await k.app.db.owner.query("select * from dns_snapshots where domain_id=$1 order by taken_at,id", [domainId])).rows;
async function prepareOwner(path: string, body: unknown, method = "POST") {
  const first = await web(k, ada, method, path, body);
  expect(first.status, first.text).toBe(403);
  const e = first.json.error;
  expect(e.code).toBe("step_up_required");
  const s = await stepUp(k, ada, e.type, e.target_id, e.user_input);
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  return s.actionId;
}
const txt = (value = "vendor-ownership=opaque") => ({ records: [{ type: "TXT", name: "custom", value }] });

function gateRead(fqdn: string, nth: number) {
  const original = k.h.registrar.getDns.bind(k.h.registrar);
  let reached!: () => void, release!: () => void, calls = 0;
  const at = new Promise<void>((r) => { reached = r; });
  const open = new Promise<void>((r) => { release = r; });
  k.h.registrar.getDns = async (name) => {
    if (name === fqdn && ++calls === nth) { reached(); await open; }
    return original(name);
  };
  return { at, release, restore: () => { release(); k.h.registrar.getDns = original; } };
}

describe("ST-201 DNS: complete-state plans and owner consent", () => {
  it("preserves unseen CAA, unknown RDATA, long TXT and every TTL in records, snapshot and intended hash", async () => {
    const x = await setup();
    const before: DnsRecord[] = [{ type: "CAA", name: "", value: '0 issue "ca.example"', ttl: 86400 },
      { type: "TYPE65280", name: "policy", value: "OPAQUE|byte;value", ttl: 47 },
      { type: "TXT", name: "long", value: "x".repeat(500), ttl: 3600 }, { type: "A", name: "stage", value: "192.0.2.1", ttl: 60 }];
    k.h.registrar.oob.editZone(x.d.fqdn, before);
    const res = await bearer(k, x.t.token, "POST", x.path, { records: [{ type: "A", name: "preview", value: "192.0.2.2", ttl: 120 }] });
    expect(res.status, res.text).toBe(200);
    expect(await live(x.d.fqdn)).toEqual(expect.arrayContaining(before));
    const snap = (await snapshots(x.d.id))[0];
    expect(snap.records).toEqual(expect.arrayContaining(before));
    expect(snap.intended_hash).toBe(zoneHash(await live(x.d.fqdn)));
    expect(snap.intended_records).toEqual(await live(x.d.fqdn));
    expect(res.json).toMatchObject({ accepted: true, provider_state: "desired_observed", authoritative_visibility: "not_checked", propagation: "not_sampled" });
  });

  it("a whole editable-zone PUT keeps unsupported records and an omitted existing TTL", async () => {
    const x = await setup();
    const opaque: DnsRecord = { type: "CAA", name: "", value: '0 issue "ca.example"', ttl: 999 };
    k.h.registrar.oob.editZone(x.d.fqdn, [opaque, { type: "A", name: "stage", value: "192.0.2.1", ttl: 333 }]);
    const res = await web(k, ada, "PUT", x.ownerPath, { records: [{ type: "A", name: "stage", value: "192.0.2.1" }, { type: "A", name: "preview", value: "192.0.2.2" }] });
    expect(res.status, res.text).toBe(200);
    expect(await live(x.d.fqdn)).toEqual(expect.arrayContaining([opaque, { type: "A", name: "stage", value: "192.0.2.1", ttl: 333 }]));
  });

  it.each(["delete", "MX dependency", "SRV dependency", "production", "unknown TXT"])("requires owner consent for %s", async (reason) => {
    const x = await setup();
    let before: DnsRecord[] = [], body: unknown;
    if (reason === "delete") { before = [{ type: "A", name: "preview", value: "192.0.2.1" }]; body = { remove: [{ type: "A", name: "preview" }] }; }
    else if (reason === "MX dependency") { before = [{ type: "MX", name: "", value: `odd-target.${x.d.fqdn}`, priority: 10 }]; body = { records: [{ type: "A", name: "odd-target", value: "192.0.2.1" }] }; }
    else if (reason === "SRV dependency") { before = [{ type: "SRV", name: "_sip._tcp", value: `odd-target.${x.d.fqdn}`, priority: 0, weight: 1, port: 443 }]; body = { records: [{ type: "A", name: "odd-target", value: "192.0.2.1" }] }; }
    else if (reason === "production") body = { records: [{ type: "A", name: "api.prod", value: "192.0.2.1" }] };
    else body = txt();
    k.h.registrar.oob.editZone(x.d.fqdn, before);
    const writes = k.h.registrar.calls.replaceZone;
    const res = await bearer(k, x.t.token, "POST", x.path, body);
    expect(res.status, res.text).toBe(202);
    expect(res.json.sensitive_records).toBeGreaterThan(0);
    expect(k.h.registrar.calls.replaceZone).toBe(writes);
    expect(zoneHash(await live(x.d.fqdn))).toBe(zoneHash(before));
  });

  it("browser cancellation makes no write, exact consent applies once and repeated action cannot execute again", async () => {
    const x = await setup();
    const writes = k.h.registrar.calls.replaceZone;
    const action = await prepareOwner(x.ownerPath, txt());
    expect(k.h.registrar.calls.replaceZone).toBe(writes);
    const changed = await web(k, ada, "POST", x.ownerPath, txt("other-value"), { [ACTION_HEADER]: action });
    expect(changed.status).toBe(409); expect(changed.json.error.code).toBe("params_changed");
    const applied = await web(k, ada, "POST", x.ownerPath, txt(), { [ACTION_HEADER]: action });
    expect(applied.status, applied.text).toBe(200);
    const replay = await web(k, ada, "POST", x.ownerPath, txt(), { [ACTION_HEADER]: action });
    expect([403, 409]).toContain(replay.status);
    expect(k.h.registrar.calls.replaceZone).toBe(writes + 1);
  });

  it("approved owner DNS requests settle with one runtime connection and dispatch the action only once", async () => {
    const x = await setup();
    const action = await prepareOwner(x.ownerPath, txt());
    const original = k.app.ctx.runtime;
    // Bound acquisition time so a nested checkout fails this regression instead of hanging the suite.
    const single = new pg.Pool({ connectionString: k.app.db.urlFor("runtime"), max: 1, connectionTimeoutMillis: 1000 });
    const writes = k.h.registrar.calls.replaceZone;
    k.app.ctx.runtime = single;
    try {
      const responses = await Promise.all(Array.from({ length: 3 }, () => web(k, ada, "POST", x.ownerPath, txt(), { [ACTION_HEADER]: action })));
      expect(responses.filter((r) => r.status === 200), JSON.stringify(responses)).toHaveLength(1);
      expect(responses.every((r) => [200, 403, 409].includes(r.status))).toBe(true);
      expect(k.h.registrar.calls.replaceZone).toBe(writes + 1);
    } finally { k.app.ctx.runtime = original; await single.end(); }
  });

  it("stale approval detects an out-of-band TTL-only change", async () => {
    const x = await setup();
    const old: DnsRecord = { type: "A", name: "stage", value: "192.0.2.1", ttl: 60 };
    k.h.registrar.oob.editZone(x.d.fqdn, [old]);
    const action = await prepareOwner(x.ownerPath, txt());
    k.h.registrar.oob.editZone(x.d.fqdn, [{ ...old, ttl: 120 }]);
    const writes = k.h.registrar.calls.replaceZone;
    const res = await web(k, ada, "POST", x.ownerPath, txt(), { [ACTION_HEADER]: action });
    expect(res.status).toBe(409); expect(res.json.error.code).toBe("zone_changed");
    expect(k.h.registrar.calls.replaceZone).toBe(writes);
  });

  it("an owner approval cannot authorize another tenant or domain", async () => {
    const x = await setup(), other = await setup();
    const action = await prepareOwner(x.ownerPath, txt());
    const wrongDomain = await web(k, ada, "POST", other.ownerPath, txt(), { [ACTION_HEADER]: action });
    expect(wrongDomain.status).toBe(409);
    expect((await web(k, bob, "POST", x.ownerPath, txt(), { [ACTION_HEADER]: action })).status).toBe(404);
    expect((await web(k, bob, "GET", `/api/v1/domains/${x.d.fqdn}/dns-snapshots`)).status).toBe(404);
    expect(await live(x.d.fqdn)).toHaveLength(0);
  });

  it("rejects malicious control characters before approval, writes, snapshots or value-bearing logs", async () => {
    const x = await setup();
    const canary = "canary-dns-content\r\nTYPE A 127.0.0.1";
    const res = await bearer(k, x.t.token, "POST", x.path, { records: [{ type: "TXT", name: "custom", value: canary }] });
    expect(res.status).toBe(422);
    expect(await snapshots(x.d.id)).toHaveLength(0);
    const audit = await k.app.db.owner.query("select detail from audit_log where chain_id=$1", [ada.user.userId]);
    expect(JSON.stringify(audit.rows)).not.toContain("canary-dns-content");
    expect(JSON.stringify(k.app.email.sent)).not.toContain("canary-dns-content");
  });
});

describe("ST-202 DNS: durable outcomes and grant races", () => {
  it.each(["before", "partial"])("a timeout with %s state keeps an unresolved receipt, blocks retries and survives sweeping", async (state) => {
    const x = await setup();
    const before: DnsRecord[] = [{ type: "A", name: "existing", value: "192.0.2.1" }];
    k.h.registrar.oob.editZone(x.d.fqdn, before);
    const orig = k.h.registrar.replaceZone.bind(k.h.registrar); let attempts = 0;
    k.h.registrar.replaceZone = async () => {
      attempts++;
      if (state === "partial") k.h.registrar.oob.editZone(x.d.fqdn, []);
      throw new RegistrarError("unknown", "private-provider-detail", { outcomeUnknown: true, retryable: true });
    };
    try {
      const body = { records: [{ type: "A", name: "preview", value: "192.0.2.2" }] };
      const failed = await bearer(k, x.t.token, "POST", x.path, body);
      expect(failed.status).toBe(502); expect(failed.json.error.operation_id).toBeTruthy();
      expect(failed.text).not.toContain("private-provider-detail");
      const retry = await bearer(k, x.t.token, "POST", x.path, body);
      expect(retry.status).toBe(409); expect(retry.json.error.code).toBe("dns_reconciliation_required");
      expect(attempts).toBe(1);
      const history = await web(k, ada, "GET", `/api/v1/domains/${x.d.fqdn}/dns-snapshots`);
      expect(history.json.snapshots[0]).toMatchObject({ write_state: "unknown", reconciliation_state: `${state}_observed`, propagation: "not_sampled" });
      await k.app.db.owner.query("update dns_snapshots set expires_at=$2 where domain_id=$1", [x.d.id, new Date(k.app.clock.now().getTime() - 1)]);
      await snapshotSweepJob(k.app.ctx, {} as never);
      expect(await snapshots(x.d.id)).toHaveLength(1);
    } finally { k.h.registrar.replaceZone = orig; }
  });

  it("a timeout after application reconciles only by reading, completes the linked approval and never resends", async () => {
    const x = await setup();
    const proposed = await bearer(k, x.t.token, "POST", x.path, txt());
    const id = proposed.json.approval_id;
    const s = await stepUp(k, ada, "dns.sensitive.approve", `ar_${id}`);
    const orig = k.h.registrar.replaceZone.bind(k.h.registrar);
    let attempts = 0;
    k.h.registrar.replaceZone = async (...args) => { attempts++; await orig(...args); throw new RegistrarError("unknown", "timeout", { outcomeUnknown: true, retryable: false }); };
    try {
      const failed = await web(k, ada, "POST", `/api/v1/approvals/${id}/approve-dns`, {}, { [ACTION_HEADER]: s.actionId });
      expect(failed.status).toBe(502);
      expect((await requestRow(k, id)).state).toBe("approved");
      const h = await web(k, ada, "GET", `/api/v1/domains/${x.d.fqdn}/dns-snapshots`);
      expect(h.json.snapshots[0]).toMatchObject({ write_state: "applied", reconciliation_state: "desired_observed" });
      expect((await requestRow(k, id)).state).toBe("completed");
      await web(k, ada, "GET", `/api/v1/domains/${x.d.fqdn}/dns-snapshots`);
      expect(attempts).toBe(1);
    } finally { k.h.registrar.replaceZone = orig; }
  });

  it.each(["rate_limited", "rejected", "unavailable"] as const)("a %s read failure after accepted replacement preserves the receipt and approval until reconciliation", async (kind) => {
    const x = await setup();
    const proposed = await bearer(k, x.t.token, "POST", x.path, txt());
    const id = proposed.json.approval_id;
    const s = await stepUp(k, ada, "dns.sensitive.approve", `ar_${id}`);
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const originalWrite = k.h.registrar.replaceZone.bind(k.h.registrar);
    const originalRead = k.h.registrar.getDns.bind(k.h.registrar);
    let accepted = false, readFailure = true, writes = 0;
    k.h.registrar.replaceZone = async (...args) => {
      writes++;
      const result = await originalWrite(...args);
      accepted = true;
      return result;
    };
    k.h.registrar.getDns = async (fqdn) => {
      if (fqdn === x.d.fqdn && accepted && readFailure) throw new RegistrarError(kind, "private-read-canary", { outcomeUnknown: false, retryable: true });
      return originalRead(fqdn);
    };
    try {
      const failed = await web(k, ada, "POST", `/api/v1/approvals/${id}/approve-dns`, {}, { [ACTION_HEADER]: s.actionId });
      expect(failed.status, failed.text).toBe(502);
      expect(failed.json.error).toMatchObject({ code: "outcome_unknown", operation_id: expect.any(String) });
      expect(failed.text).not.toContain("private-read-canary");
      expect((await snapshots(x.d.id))[0]).toMatchObject({ id: failed.json.error.operation_id, write_state: "unknown" });
      expect((await requestRow(k, id)).state).toBe("approved");
      const unresolved = await web(k, ada, "GET", `/api/v1/domains/${x.d.fqdn}/dns-snapshots`);
      expect(unresolved.json.snapshots).toHaveLength(1);
      expect(unresolved.json.snapshots[0].write_state).toBe("unknown");
      readFailure = false;
      const reconciled = await web(k, ada, "GET", `/api/v1/domains/${x.d.fqdn}/dns-snapshots`);
      expect(reconciled.json.snapshots[0]).toMatchObject({ write_state: "applied", reconciliation_state: "desired_observed" });
      expect((await requestRow(k, id)).state).toBe("completed");
      const retry = await web(k, ada, "POST", `/api/v1/approvals/${id}/approve-dns`, {}, { [ACTION_HEADER]: s.actionId });
      expect([403, 409]).toContain(retry.status);
      expect(writes).toBe(1);
    } finally { k.h.registrar.replaceZone = originalWrite; k.h.registrar.getDns = originalRead; }
  });

  it.each(["revoked", "paused", "expired", "scope removed"])("rechecks a %s grant after the locked authoritative read before sending", async (state) => {
    const x = await setup();
    const gate = gateRead(x.d.fqdn, 2), writes = k.h.registrar.calls.replaceZone;
    const pending = bearer(k, x.t.token, "POST", x.path, { records: [{ type: "A", name: "preview", value: "192.0.2.1" }] });
    try {
      await gate.at;
      if (state === "revoked") await k.app.db.owner.query("update bindings set revoked_at=$2 where id=$1", [x.t.id, k.app.clock.now()]);
      if (state === "paused") await k.app.db.owner.query("update bindings set paused_at=$2 where id=$1", [x.t.id, k.app.clock.now()]);
      if (state === "expired") await k.app.db.owner.query("update bindings set expires_at=$2 where id=$1", [x.t.id, new Date(k.app.clock.now().getTime() - 1)]);
      if (state === "scope removed") await k.app.db.owner.query("update bindings set scopes='[]'::jsonb where id=$1", [x.t.id]);
      gate.release();
      const res = await pending;
      expect([403, 409]).toContain(res.status);
      expect(k.h.registrar.calls.replaceZone).toBe(writes);
      expect(await snapshots(x.d.id)).toHaveLength(0);
    } finally { gate.restore(); }
  });

  it("expires an approval while execution waits on its authoritative read", async () => {
    const x = await setup();
    const proposed = await bearer(k, x.t.token, "POST", x.path, txt());
    const id = proposed.json.approval_id;
    const s = await stepUp(k, ada, "dns.sensitive.approve", `ar_${id}`);
    const gate = gateRead(x.d.fqdn, 1), writes = k.h.registrar.calls.replaceZone;
    const pending = web(k, ada, "POST", `/api/v1/approvals/${id}/approve-dns`, {}, { [ACTION_HEADER]: s.actionId });
    try {
      await gate.at;
      await k.app.db.owner.query("update actions set expires_at=$2 where id=$1", [s.actionId, new Date(k.app.clock.now().getTime() - 1)]);
      gate.release();
      const res = await pending;
      expect(res.status).toBe(409); expect(res.json.error.code).toBe("approval_expired");
      expect(k.h.registrar.calls.replaceZone).toBe(writes);
    } finally { gate.restore(); }
  });
});


describe("ST-204 DNS: immutable identity and interrupted receipt completion", () => {
  it("binds the approval to its original agent even if a stored request changes", async () => {
    const x = await setup();
    const proposed = await bearer(k, x.t.token, "POST", x.path, txt());
    const id = proposed.json.approval_id;
    const approval = await stepUp(k, ada, "dns.sensitive.approve", `ar_${id}`);
    const other = await createAgentToken(k, ada, [`dns.write:${x.d.fqdn}`]);
    await k.app.db.owner.query("update agent_requests set binding_id=$2 where id=$1", [id, other.id]);
    const writes = k.h.registrar.calls.replaceZone;
    const res = await web(k, ada, "POST", `/api/v1/approvals/${id}/approve-dns`, {}, { [ACTION_HEADER]: approval.actionId });
    expect(res.status).toBe(409); expect(res.json.error.code).toBe("params_changed");
    expect(k.h.registrar.calls.replaceZone).toBe(writes);
  });

  it("changes to the approved grant version cannot silently widen its approval", async () => {
    const x = await setup();
    const proposed = await bearer(k, x.t.token, "POST", x.path, txt());
    const id = proposed.json.approval_id;
    const approval = await stepUp(k, ada, "dns.sensitive.approve", `ar_${id}`);
    await k.app.db.owner.query("update bindings set expires_at=expires_at + interval '1 day' where id=$1", [x.t.id]);
    const writes = k.h.registrar.calls.replaceZone;
    const res = await web(k, ada, "POST", `/api/v1/approvals/${id}/approve-dns`, {}, { [ACTION_HEADER]: approval.actionId });
    expect(res.status).toBe(409); expect(res.json.error.code).toBe("grant_changed");
    expect(k.h.registrar.calls.replaceZone).toBe(writes);
  });

  it("a successful provider response with divergent read-back never triggers an automatic restoration write", async () => {
    const x = await setup();
    const original = k.h.registrar.replaceZone.bind(k.h.registrar); let writes = 0;
    k.h.registrar.replaceZone = async (...args) => {
      writes++;
      const accepted = await original(...args);
      k.h.registrar.oob.editZone(x.d.fqdn, [...await live(x.d.fqdn), { type: "A", name: "outside", value: "192.0.2.9" }]);
      return accepted;
    };
    try {
      const res = await bearer(k, x.t.token, "POST", x.path, { records: [{ type: "A", name: "preview", value: "192.0.2.1" }] });
      expect(res.status).toBe(502); expect(res.json.error.code).toBe("outcome_unknown");
      expect(writes).toBe(1);
      expect((await live(x.d.fqdn)).some((r) => r.name === "outside")).toBe(true);
      const h = await web(k, ada, "GET", `/api/v1/domains/${x.d.fqdn}/dns-snapshots`);
      expect(h.json.snapshots[0].reconciliation_state).toBe("partial_observed");
    } finally { k.h.registrar.replaceZone = original; }
  });

  it("a crash after provider read-back leaves a durable pending receipt and a retry reconciles without writing", async () => {
    const x = await setup();
    const original = k.app.ctx.kms.hmac.bind(k.app.ctx.kms);
    let once = true;
    k.app.ctx.kms.hmac = async (key, data) => {
      if (once && key === "audit" && Buffer.from(data).toString().includes('"dns.write"')) { once = false; throw new Error("simulated receipt failure"); }
      return original(key, data);
    };
    const body = { records: [{ type: "A", name: "preview", value: "192.0.2.1" }] };
    try {
      const res = await bearer(k, x.t.token, "POST", x.path, body);
      expect(res.status).toBe(500);
      expect((await snapshots(x.d.id))[0].write_state).toBe("pending");
    } finally { k.app.ctx.kms.hmac = original; }
    const writes = k.h.registrar.calls.replaceZone;
    const h = await web(k, ada, "GET", `/api/v1/domains/${x.d.fqdn}/dns-snapshots`);
    expect(h.json.snapshots[0].write_state).toBe("applied");
    const retry = await bearer(k, x.t.token, "POST", x.path, body);
    expect(retry.status, retry.text).toBe(200); expect(retry.json.changed).toBe(false);
    expect(k.h.registrar.calls.replaceZone).toBe(writes);
  });
});

describe("ST-205 DNS: ownership stays stable through the write intent", () => {
  it("a domain release waits for the locked authoritative read and durable intent", async () => {
    const x = await setup();
    const gate = gateRead(x.d.fqdn, 2);
    const pending = bearer(k, x.t.token, "POST", x.path, { records: [{ type: "A", name: "preview", value: "192.0.2.1" }] });
    let release: Promise<unknown> | undefined;
    try {
      await gate.at;
      let settled = false;
      release = k.app.db.owner.query("update domains set released_at=$2 where id=$1", [x.d.id, k.app.clock.now()]);
      void release.then(() => { settled = true; });
      // Observe the actual database row-lock wait; no wall-clock ordering assumption.
      for (;;) {
        const waiters = (await k.app.db.owner.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'")).rows[0].n as number;
        if (waiters) break;
        if (settled) throw new Error("ownership changed while the write was still reading");
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(settled).toBe(false);
      gate.release();
      const result = await pending;
      expect(result.status, result.text).toBe(200);
      await release;
      expect((await snapshots(x.d.id))[0]).toMatchObject({ write_state: "applied" });
      const later = await bearer(k, x.t.token, "POST", x.path, { records: [{ type: "A", name: "later", value: "192.0.2.2" }] });
      expect(later.status).toBe(404);
    } finally { gate.restore(); await release; }
  });
});

describe("ST-206 DNS: sensitive execution rechecks owner sessions", () => {
  it.each(["browser", "agent approval"])("rejects a revoked owner session during the %s authoritative read", async (route) => {
    const x = await setup();
    let path = x.ownerPath, body: unknown = txt(), action: string;
    if (route === "browser") action = await prepareOwner(path, body);
    else {
      const proposed = await bearer(k, x.t.token, "POST", x.path, body);
      path = `/api/v1/approvals/${proposed.json.approval_id}/approve-dns`; body = {};
      action = (await stepUp(k, ada, "dns.sensitive.approve", `ar_${proposed.json.approval_id}`)).actionId;
    }
    const gate = gateRead(x.d.fqdn, 1), writes = k.h.registrar.calls.replaceZone;
    const pending = web(k, ada, "POST", path, body, { [ACTION_HEADER]: action });
    try {
      await gate.at;
      await k.app.db.owner.query("update sessions set revoked_at=$2 where id_hash=$1", [ada.user.sessionHash, k.app.clock.now()]);
      gate.release();
      const result = await pending;
      expect(result.status).toBe(403); expect(result.json.error.code).toBe("session_unavailable");
      expect(k.h.registrar.calls.replaceZone).toBe(writes);
    } finally {
      gate.restore();
      await k.app.db.owner.query("update sessions set revoked_at=null where id_hash=$1", [ada.user.sessionHash]);
    }
  });
});
