import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { scopesToSign, type Card, type VisitorList } from "./visitors";

const BID = "0190f0f0-0000-7000-8000-00000000b0b1";
const card = (o: Partial<Card> = {}): Card => ({
  id: "r1", kind: "scope", state: "pending", agent_state: "pending", requested_at: "", age_seconds: 1, expires_at: "", new_network: false, decided_at: null, decision_reason: null, order_id: null,
  requester: { binding_id: BID, name: "Build bot", kind: "agent", connected_app: false, token_expires_at: "", live: true }, scopes: ["secrets.read:fern.com:dev"], ...o,
});
const list = (scopes: string[], o: Record<string, unknown> = {}): VisitorList => ({
  visitors: [{ id: BID, kind: "agent", name: "Build bot", prefix: "mh_live_x", scopes, connected_app: null, created_at: "", last_used_at: null, expires_at: "", revoked_at: null, paused: false, spend: { cap_minor: "0", spent_minor: "0", reserved_minor: "0" }, pending_requests: 1, ...o }],
  pending_requests: 1, confirm_threshold_minor: "0", device_login_enabled: true,
});
const io = (c: Card, l: VisitorList) => ({ getCard: vi.fn(async () => c), listVisitors: vi.fn(async () => l) });

describe("ST-72: approving more access signs what the server has now plus exactly what the card shows", () => {
  it("re-fetches the request and the token right before the passkey step and never uses a list loaded earlier", async () => {
    const deps = io(card(), list(["domains.read:*"]));
    const r = await scopesToSign("r1", ["secrets.read:fern.com:dev"], deps);
    expect(deps.getCard).toHaveBeenCalledWith("r1");
    expect(deps.listVisitors).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true });
    // The DNS access a stale list still showed is not in the set: only the token's access now and the shown scopes.
    expect(r.ok && [...r.scopes].sort()).toEqual(["domains.read:*", "secrets.read:fern.com:dev"]);
  });

  it("refuses when the server's request no longer matches the shown scopes, and hands back the server's version to show", async () => {
    const now = card({ scopes: ["secrets.read:fern.com:dev", "secrets.read:fern.com:preview"] });
    const r = await scopesToSign("r1", ["secrets.read:fern.com:dev"], io(now, list([])));
    expect(r).toEqual({ ok: false, reason: "changed", card: now });
    // Order and duplicates do not count as a change.
    expect((await scopesToSign("r1", ["b:x", "a:y", "a:y"], io(card({ scopes: ["a:y", "b:x"] }), list([])))).ok).toBe(true);
  });

  it("refuses a request that was decided meanwhile, and a token that was revoked meanwhile", async () => {
    expect(await scopesToSign("r1", ["secrets.read:fern.com:dev"], io(card({ state: "declined" }), list([])))).toMatchObject({ ok: false, reason: "request_unavailable" });
    expect(await scopesToSign("r1", ["secrets.read:fern.com:dev"], io(card(), list([], { revoked_at: "2026-09-30T00:00:00.000Z" })))).toMatchObject({ ok: false, reason: "binding_unavailable" });
    expect(await scopesToSign("r1", ["secrets.read:fern.com:dev"], io(card(), { ...list([]), visitors: [] }))).toMatchObject({ ok: false, reason: "binding_unavailable" });
  });

  it("the approval card builds the widen request from scopesToSign only, and takes no scopes from its caller", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../ui/ApprovalCard.tsx"), "utf8");
    expect(src).toContain("scopesToSign(");
    expect(src).not.toMatch(/currentScopes/);
    const visitors = fs.readFileSync(path.resolve(__dirname, "../ui/Visitors.tsx"), "utf8");
    expect(visitors).not.toMatch(/currentScopes/);
  });
});
