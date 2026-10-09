import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zoneHash } from "@mosshatch/registrar/dns";
import { bearer, createAgentToken, makeAgentKit, makeDomain, makeOwner, stepUp, web, type AgentKit } from "./testkit.ts";

let k: AgentKit;
beforeAll(async () => { k = await makeAgentKit(); }, 120_000);
afterAll(async () => { await k?.drop(); });

describe("ST-209 DNS upgrade fixtures: old approval and incomplete snapshot rows fail closed", () => {
  it("applies migration1130 over existing main-format snapshots without asserting their fidelity", async () => {
    const c = await k.app.db.owner.connect();
    try {
      await c.query("begin");
      // An isolated temporary copy has the main schema immediately before this migration.
      await c.query("create temporary table agent_requests (id uuid primary key) on commit drop");
      await c.query("create temporary table dns_snapshots (like public.dns_snapshots including defaults including constraints) on commit drop");
      await c.query("alter table dns_snapshots drop column state_format, drop column intended_records, drop column agent_request_id, drop column observed_hash, drop column observed_at, drop column reconciliation_state");
      await c.query(`insert into dns_snapshots(id,user_id,domain_id,reason,zone_hash,records,write_state,expires_at)
        values(uuidv7(),uuidv7(),uuidv7(),'pre_write','old-format-hash','[{"type":"A","name":"stage","value":"192.0.2.1"}]','unknown',now()+interval '1 day')`);
      await c.query(readFileSync(new URL("../../../db/migrations/1130_dns_reconciliation.sql", import.meta.url), "utf8"));
      const rows = (await c.query("select state_format,intended_records,write_state,reconciliation_state from dns_snapshots")).rows;
      expect(rows).toEqual([{ state_format: null, intended_records: null, write_state: "unknown", reconciliation_state: "unresolved" }]);
    } finally { await c.query("rollback"); c.release(); }
  });

  it.each(["applied", "unknown"])("retains a pre-upgrade %s snapshot for review without using it as a full rollback inventory", async (state) => {
    const owner = await makeOwner(k, `legacy-${state}`);
    const d = await makeDomain(k, owner, `legacy-${state}.com`);
    const oldVisible = [{ type: "A", name: "stage", value: "192.0.2.1" }];
    const current = [{ type: "A", name: "stage", value: "192.0.2.2", ttl: 60 }, { type: "CAA", name: "", value: '0 issue "ca.example"', ttl: 86400 }];
    k.h.registrar.oob.editZone(d.fqdn, current);
    // The old provider model discarded TTL/CAA; old hashes used delimiter-joined records.
    const oldHash = (ip: string) => createHash("sha256").update(`A|stage|${ip}|||`).digest("hex");
    // Insert only columns present before migration1130, exactly as persisted by live main.
    const row = (await k.app.db.owner.query(`insert into dns_snapshots
      (user_id,domain_id,reason,zone_hash,records,after_hash,intended_hash,write_state,taken_at,expires_at)
      values($1,$2,'pre_write',$3,$4,$5,$5,$6,$7,$8) returning *`,
    [owner.user.userId, d.id, oldHash("192.0.2.1"), JSON.stringify(oldVisible), oldHash("192.0.2.2"), state, k.app.clock.now(), new Date(k.app.clock.now().getTime() + 86_400_000)])).rows[0];
    expect(row.state_format).toBeNull(); expect(row.intended_records).toBeNull();
    const writes = k.h.registrar.calls.replaceZone;
    const rollback = await web(k, owner, "POST", `/api/v1/domains/${d.fqdn}/dns-snapshots/${row.id}/rollback`, {});
    expect(rollback.status, rollback.text).toBe(409);
    expect(rollback.json.error.code).toBe("snapshot_requires_manual_review");
    const history = await web(k, owner, "GET", `/api/v1/domains/${d.fqdn}/dns-snapshots`);
    expect(history.json.snapshots[0]).toMatchObject({ write_state: state, reconciliation_state: "unresolved" });
    if (state === "unknown") {
      // Even a matching modern intended hash cannot upgrade an incomplete legacy receipt.
      await k.app.db.owner.query("update dns_snapshots set intended_hash=$2 where id=$1", [row.id, zoneHash(current)]);
      const retry = await web(k, owner, "POST", `/api/v1/domains/${d.fqdn}/dns`, { records: [{ type: "A", name: "preview", value: "192.0.2.3" }] });
      expect(retry.status).toBe(409); expect(retry.json.error.code).toBe("dns_reconciliation_required");
      const saved = (await k.app.db.owner.query("select * from dns_snapshots where id=$1", [row.id])).rows[0];
      expect(saved).toMatchObject({ write_state: "unknown", reconciliation_state: "unresolved", observed_hash: zoneHash(current) });
    }
    expect(k.h.registrar.calls.replaceZone).toBe(writes);
    expect(zoneHash((await k.h.registrar.getDns(d.fqdn)).records)).toBe(zoneHash(current));
  });

  it("refuses a pending main-format agent request with shortened owner values and no grant version", async () => {
    const owner = await makeOwner(k, "legacy-approval");
    const d = await makeDomain(k, owner, "legacy-approval.com");
    const t = await createAgentToken(k, owner, [`dns.write:${d.fqdn}`]);
    k.h.registrar.oob.editZone(d.fqdn, [{ type: "TXT", name: "verify", value: "x".repeat(1100), ttl: 60 }]);
    const proposed = await bearer(k, t.token, "POST", `/api/v1/agent/domains/${d.fqdn}/dns`, { remove: [{ type: "TXT", name: "verify" }] });
    expect(proposed.status, proposed.text).toBe(202);
    await k.app.db.owner.query(`update agent_requests set params=jsonb_set(params-'review_format'-'grant_hash','{removed}',$2::jsonb) where id=$1`,
      [proposed.json.approval_id, JSON.stringify([{ type: "TXT", name: "verify", value: "x".repeat(1024), sensitive: true }])]);
    const approval = await stepUp(k, owner, "dns.sensitive.approve", `ar_${proposed.json.approval_id}`);
    expect(approval.status).toBe(409); expect(approval.json.error.code).toBe("request_unavailable");
    expect(k.h.registrar.calls.replaceZone).toBe(0);
  });
});
