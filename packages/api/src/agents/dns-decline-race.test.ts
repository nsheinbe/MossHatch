import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DnsRecord } from "@mosshatch/registrar/port";
import { zoneHash } from "@mosshatch/registrar/dns";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { bearer, clearCounters, createAgentToken, makeAgentKit, makeDomain, makeOwner, requestRow, stepUp, web, type AgentKit, type Owner } from "./testkit.ts";

/**
 * ST-131 review: the owner declines an agent's sensitive DNS change while its approval is writing the zone. Approve and decline
 * serialise on the request row (the lock order: the user's agent lock, the request, the binding), so exactly one wins: the approval
 * claims the request (pending to approved) in the transaction that commits its pre-write snapshot, before the registrar is called.
 * Each interleaving is set up by hand (a gate in the registrar or the audit signer), with no timing: a decline that lands before the
 * claim wins and nothing is written; one that comes during or after it loses with 409, and the write completes (snapshot applied,
 * request completed).
 */

let k: AgentKit; let ada: Owner;
beforeAll(async () => { k = await makeAgentKit(); ada = await makeOwner(k, "dnsrace-ada"); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await clearCounters(k); k.app.email.clear(); });

let n = 0;
const live = async (fqdn: string) => (await k.h.registrar.getDns(fqdn)).records as DnsRecord[];
const snaps = async (id: string) => (await k.app.db.owner.query("select * from dns_snapshots where domain_id = $1 order by taken_at, id", [id])).rows;
const hasMx = (zone: DnsRecord[], v: string) => zone.some((r) => r.type === "MX" && r.value.startsWith(v));

/** A pending sensitive change (an MX) and a passkey assertion approving it, not yet used. */
async function pendingMx() {
  const d = await makeDomain(k, ada, `dnsrace-${++n}-${Date.now().toString(36)}.com`);
  const t = await createAgentToken(k, ada, [`dns.write:${d.fqdn}`, `dns.read:${d.fqdn}`], { name: `Race bot ${n}` });
  const value = `mx${n}.example.net`;
  const mx = await bearer(k, t.token, "POST", `/api/v1/agent/domains/${d.fqdn}/dns`, { records: [{ type: "MX", name: "@", value, priority: 10 }] });
  expect(mx.status, mx.text).toBe(202);
  const id = mx.json.approval_id as string;
  const s = await stepUp(k, ada, "dns.sensitive.approve", `ar_${id}`);
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  return { d, id, action: s.actionId, value, before: await live(d.fqdn) };
}

/** Hold the first call of `fn` on the object until released (the call itself runs after the release). */
function gate<O extends object, K extends keyof O>(obj: O, key: K, when: (...args: any[]) => boolean) {
  const orig = (obj[key] as any).bind(obj);
  let reached!: () => void, release!: () => void, armed = true;
  const atGate = new Promise<void>((r) => { reached = r; });
  const open = new Promise<void>((r) => { release = r; });
  (obj as any)[key] = async (...args: any[]) => {
    if (armed && when(...args)) { armed = false; reached(); await open; }
    return orig(...args);
  };
  // Restoring also releases a held call, so a failed assertion never leaves a request (and its connection) waiting.
  return { atGate, release, restore: () => { release(); (obj as any)[key] = orig; } };
}

/** Resolve once `p` is waiting on a row or advisory lock in this database (true), or has settled without waiting (false). */
async function blockedOnLock(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  for (;;) {
    const w = (await k.app.db.owner.query("select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")).rows[0].n as number;
    if (w > 0) return true;
    if (settled) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
}

const approve = (id: string, action: string) => web(k, ada, "POST", `/api/v1/approvals/${id}/approve-dns`, {}, { [ACTION_HEADER]: action });
const decline = (id: string) => web(k, ada, "POST", `/api/v1/approvals/${id}/decline`);

describe("ST-131 review: approve and decline of a sensitive DNS change serialise on the request row", () => {
  it("a decline while the approved zone is at the registrar loses with 409; the write completes, its snapshot applied and the request completed", async () => {
    const x = await pendingMx();
    const g = gate(k.h.registrar, "replaceZone", (fqdn: string) => fqdn === x.d.fqdn);
    let a;
    try {
      a = approve(x.id, x.action);
      await g.atGate;                                              // the snapshot and the claim have committed; the write is out
      const dec = await decline(x.id);
      expect(dec.status, dec.text).toBe(409);
      expect(dec.json.error.code).toBe("request_unavailable");
      g.release();
      const res = await a;
      expect(res.status, res.text).toBe(200);
      expect(res.json).toMatchObject({ id: x.id, state: "applied" });
    } finally { g.restore(); }
    expect(hasMx(await live(x.d.fqdn), x.value)).toBe(true);
    const s = await snaps(x.d.id);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ write_state: "applied", after_hash: zoneHash(await live(x.d.fqdn)) });
    expect(await requestRow(k, x.id)).toMatchObject({ state: "completed", decided_by_action_id: x.action, decision_reason: "owner" });
    expect((await k.app.db.owner.query("select count(*)::int n from audit_log where resource_id = $1 and action = 'agent.request.declined'", [x.id])).rows[0].n).toBe(0);
  });

  it("a decline while the approval's claim is open waits for the row, then loses with 409; the write completes", async () => {
    const x = await pendingMx();
    // The approval's step 1 is paused while it signs its `dns.write_intent` audit row: after the claim, before the commit.
    const g = gate(k.app.ctx.kms, "hmac", (key: string, data: Uint8Array) => key === "audit" && Buffer.from(data).toString().includes('"dns.write_intent"'));
    let a;
    try {
      a = approve(x.id, x.action);
      await g.atGate;
      const dec = decline(x.id);
      expect(await blockedOnLock(dec)).toBe(true);
      g.release();
      const res = await a;
      expect(res.status, res.text).toBe(200);
      const d = await dec;
      expect(d.status, d.text).toBe(409);
      expect(d.json.error.code).toBe("request_unavailable");
    } finally { g.restore(); }
    expect(hasMx(await live(x.d.fqdn), x.value)).toBe(true);
    expect((await snaps(x.d.id))[0]).toMatchObject({ write_state: "applied" });
    expect((await requestRow(k, x.id)).state).toBe("completed");
  });

  it("a decline that lands before the approval claims the request wins: nothing is written, no snapshot is kept, the assertion is spent", async () => {
    const x = await pendingMx();
    const writes = k.h.registrar.calls.replaceZone;
    // The approval has spent its assertion and is reading the zone under the domain lock; it has not claimed the request yet.
    const g = gate(k.h.registrar, "getDns", (fqdn: string) => fqdn === x.d.fqdn);
    let res;
    try {
      const a = approve(x.id, x.action);
      await g.atGate;
      const dec = await decline(x.id);
      expect(dec.status, dec.text).toBe(200);
      expect(dec.json).toMatchObject({ id: x.id, state: "declined" });
      g.release();
      res = await a;
    } finally { g.restore(); }
    expect(res.status, res.text).toBe(409);
    expect(res.json.error.code).toBe("request_unavailable");
    expect(k.h.registrar.calls.replaceZone).toBe(writes);
    expect(zoneHash(await live(x.d.fqdn))).toBe(zoneHash(x.before));
    expect(await snaps(x.d.id)).toHaveLength(0);
    expect(await requestRow(k, x.id)).toMatchObject({ state: "declined", decided_by_action_id: null });
    expect((await k.app.db.owner.query("select state from actions where id = $1", [x.action])).rows[0].state).toBe("executed");
    expect(k.app.email.sent.filter((m) => m.kind === "dns.sensitive_changed")).toHaveLength(0);
  });
});
