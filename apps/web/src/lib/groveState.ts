import { deriveCreatureState, type CreatureState, type DomainFacts } from "@mosshatch/core";

/** What GET /api/v1/domains returns for one domain (the fields the grove reads). Money and dates are strings. */
export interface DomainSummary {
  id: string; fqdn: string; tld: string;
  /** The server's derived state; the web app re-derives it from the adapter fields below and shows the server's word if they ever disagree. */
  state: CreatureState; state_text: string; adapter_state: string; locked: boolean;
  expires_at: string | null; days_to_expiry: number | null; auto_renew: boolean; age_days: number;
  renewal: { price_minor: string | null; years: number | null; charge_at: string | null; auto_renew: boolean };
  confirmed: boolean;
}
export interface EggSummary { order_id: string; fqdn: string; state: "egg"; order_state: string }

/**
 * Adapter-derived fields -> the facts `deriveCreatureState` takes. The server holds the transfer, DNS-write and attention inputs
 * (they come from its own records), and reports their outcome as `state`; those three states are carried back in as the matching fact.
 */
export function factsFromSummary(d: DomainSummary): DomainFacts {
  const days = d.days_to_expiry ?? 9999;
  const expired = days < 0 || d.adapter_state === "expired" || d.adapter_state === "redemption" || d.adapter_state === "pending_delete";
  return {
    registering: d.adapter_state === "pending",
    daysToExpiry: days,
    expiredPhase: d.adapter_state === "redemption" ? "redemption" : d.adapter_state === "pending_delete" ? "pending_delete" : expired ? "grace" : undefined,
    transferLock: d.locked,
    transferInFlight: d.state === "traveling" ? "out" : undefined,
    attentionReason: d.state === "attention" ? d.state_text : undefined,
    dnsWriteInFlight: d.state === "shedding",
    ageDays: d.age_days,
    autoRenew: d.auto_renew,
  };
}

export const eggFacts = (): DomainFacts => ({ registering: true, daysToExpiry: 365, transferLock: false, ageDays: 0 });

export function stateOf(d: DomainSummary): { state: CreatureState; text: string } {
  const out = deriveCreatureState(factsFromSummary(d));
  return { state: out.state, text: out.text };
}

export const STATE_WORD: Record<CreatureState, string> = {
  thriving: "healthy", drowsy: "drowsy", sleeping: "sleeping", shedding: "spreading", attention: "needs you", traveling: "traveling", armored: "locked", egg: "registering",
};
