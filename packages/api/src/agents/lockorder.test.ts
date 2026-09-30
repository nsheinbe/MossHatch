import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { expireDue, reconcileReservations } from "./requests.ts";
import { bearer, bindingRow, clearCounters, createAgentToken, makeAgentKit, makeOwner, requestRow, stepUp, web, type AgentKit } from "./testkit.ts";

/**
 * ST-66 and ST-74 review: one lock order everywhere (the user's agent lock, then agent requests by id, then bindings by id, then refresh
 * tokens). Revoke-all used to lock bindings and then requests while decline, approval and the reservation-release trigger lock requests
 * and then bindings, so the two could deadlock. Here they race many times; no request may fail with a server error.
 */

let k: AgentKit;
beforeAll(async () => { k = await makeAgentKit(); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await clearCounters(k); await k.app.db.owner.query("update flags set value = '1000' where name = 'pricing.tax_ceiling_bps'"); });

let n = 0;
const fresh = () => `free-lock${++n}x${Date.now().toString(36)}.com`;
const TERMINAL = ["approved", "completed", "void", "expired", "declined", "failed"];

describe("ST-66 / ST-74 review: revoke-all racing decline and approval never deadlocks", () => {
  it("runs revoke-all concurrently with declines, an approval and the sweeper, round after round, with no server error", async () => {
    const statuses: number[] = [];
    for (let round = 0; round < 16; round++) {
      await clearCounters(k);
      const p = await makeOwner(k, `lock${round}`);
      const bots = [await createAgentToken(k, p, ["register.propose:*"], { cap: 10_000_000, name: `Bot ${round}a` }), await createAgentToken(k, p, ["register.propose:*"], { cap: 10_000_000, name: `Bot ${round}b` })];
      const ids: string[] = [];
      for (const t of bots) for (let i = 0; i < 3; i++) {
        const r = await bearer(k, t.token, "POST", "/api/v1/agent/proposals", { kind: "register", domain: fresh() });
        expect(r.status, r.text).toBe(202);
        ids.push(r.json.approval_id as string);
      }
      // Two approvals signed ahead (one per binding), decided during the race.
      const signed: { id: string; action: string }[] = [];
      for (const id of [ids[0]!, ids[3]!]) {
        const s = await stepUp(k, p, "agent.purchase.approve", id, { typed_domain: (await requestRow(k, id)).fqdn_ascii });
        expect(s.status, JSON.stringify(s.json)).toBe(200);
        signed.push({ id, action: s.actionId });
      }
      const declines = ids.filter((id) => !signed.some((s) => s.id === id));
      const race = await Promise.all([
        web(k, p, "POST", "/api/v1/bindings/revoke-all"),
        ...declines.map((id) => web(k, p, "POST", `/api/v1/approvals/${id}/decline`)),
        ...signed.map((s) => web(k, p, "POST", `/api/v1/approvals/${s.id}/decide`, {}, { [ACTION_HEADER]: s.action })),
        web(k, p, "POST", "/api/v1/bindings/revoke-all"),
        expireDue(k.app.ctx).then(() => ({ status: 200, text: "" })),
      ]);
      for (const r of race) {
        statuses.push(r.status);
        expect(r.status, `round ${round}: ${r.text}`).toBeLessThan(500);
      }
      for (const id of ids) expect(TERMINAL, `round ${round}`).toContain((await requestRow(k, id)).state);
      // Every binding is revoked, and what is still reserved is exactly what approved requests hold.
      for (const t of bots) {
        const b = await bindingRow(k, t.id);
        expect(b.revoked_at, `round ${round}`).not.toBeNull();
        const held = (await k.app.db.owner.query("select coalesce(sum(quoted_minor),0)::text s from agent_requests where binding_id = $1 and reservation = 'held'", [t.id])).rows[0].s;
        expect(String(b.reserved_minor), `round ${round}`).toBe(held);
      }
    }
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
    expect((await reconcileReservations(k.app.ctx)).corrected).toBe(0);
  }, 240_000);
});
