import { describe, expect, it } from "vitest";
import { deriveCreatureState, type CreatureState } from "@mosshatch/core";
import { eggFacts, factsFromSummary, stateOf, type DomainSummary } from "./groveState";

/**
 * Adapter fixtures in the shape GET /api/v1/domains returns, one per creature state. Each says which state the app must show,
 * and the server's own derived `state` must agree (the two derivations are the same rule).
 */
const base: DomainSummary = {
  id: "00000000-0000-4000-8000-000000000001", fqdn: "moonfern.com", tld: "com", state: "thriving", state_text: "Healthy. Nothing needs you.", adapter_state: "active", locked: false,
  expires_at: "2027-06-01T00:00:00.000Z", days_to_expiry: 240, auto_renew: false, age_days: 400,
  renewal: { price_minor: "1499", years: 1, charge_at: null, auto_renew: false }, confirmed: true,
};
const fx = (over: Partial<DomainSummary>): DomainSummary => ({ ...base, ...over });

const FIXTURES: [CreatureState, DomainSummary][] = [
  ["thriving", fx({})],
  ["armored", fx({ locked: true, state: "armored", state_text: "Transfer lock on" })],
  ["drowsy", fx({ days_to_expiry: 12, state: "drowsy", state_text: "Expires in 12 days. Auto-renew is off." })],
  ["sleeping", fx({ days_to_expiry: -6, adapter_state: "expired", state: "sleeping", state_text: "Expired. You can still renew it." })],
  ["shedding", fx({ state: "shedding", state_text: "Your DNS change is spreading" })],
  ["attention", fx({ state: "attention", state_text: "The renewal payment failed. Renew now or update your card before the name expires." })],
  ["traveling", fx({ state: "traveling", state_text: "Transfer in progress", locked: false })],
  ["egg", fx({ adapter_state: "pending", state: "egg", state_text: "Registering" })],
];

describe("grove states from adapter fixtures (Phase 3)", () => {
  it.each(FIXTURES)("%s is reachable from its fixture and matches the server", (want, d) => {
    expect(stateOf(d).state).toBe(want);
    expect(d.state).toBe(want);
  });
  it("covers all eight creature states", () => {
    expect(new Set(FIXTURES.map(([s]) => s)).size).toBe(8);
    expect(new Set(FIXTURES.map(([s]) => s))).toEqual(new Set(["thriving", "armored", "drowsy", "sleeping", "shedding", "attention", "traveling", "egg"]));
  });
  it("an order in flight is an egg", () => expect(deriveCreatureState(eggFacts()).state).toBe("egg"));
  it("redemption and pending delete stay asleep, with the phase in the words", () => {
    expect(stateOf(fx({ days_to_expiry: -40, adapter_state: "redemption" })).text).toMatch(/redemption/i);
    expect(stateOf(fx({ days_to_expiry: -70, adapter_state: "pending_delete" })).text).toMatch(/cannot be restored/i);
  });
  it("carries no value beyond the facts it needs", () => {
    expect(Object.keys(factsFromSummary(base)).sort()).toEqual(["ageDays", "attentionReason", "autoRenew", "daysToExpiry", "dnsWriteInFlight", "expiredPhase", "registering", "transferInFlight", "transferLock"]);
  });
  it("AUD-O4: inside the renewal window the words follow auto-renew, as the server's do", () => {
    expect(stateOf(fx({ days_to_expiry: 12 })).text).toBe("Expires in 12 days. Auto-renew is off.");
    expect(stateOf(fx({ days_to_expiry: 12, auto_renew: true })).text).toBe("Renews in 12 days");
  });
});
