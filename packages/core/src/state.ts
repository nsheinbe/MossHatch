export type CreatureState =
  | "egg" | "thriving" | "drowsy" | "sleeping"
  | "armored" | "shedding" | "attention" | "traveling";

/** What the registrar adapter (or the fixture) reports about a domain. */
export interface DomainFacts {
  /** Order paid, registration not yet confirmed by the registry. */
  registering?: boolean;
  /** Days until expiry; negative once expired. */
  daysToExpiry: number;
  /** Registry status once expired: "grace" | "redemption" | "pending_delete". */
  expiredPhase?: "grace" | "redemption" | "pending_delete";
  transferLock: boolean;
  dnsWriteInFlight?: boolean;
  transferInFlight?: "in" | "out";
  /** One specific thing the owner has to do, in plain words. */
  attentionReason?: string;
  /** Age in days since registration. */
  ageDays: number;
  /** Whether auto-renew is on. False says "Expires in…" instead of "Renews in…" (docs/AUDIT-2026-10-07.md O4); unknown reads as renewing. */
  autoRenew?: boolean;
}

export interface DerivedState {
  state: CreatureState;
  /** State color token name; a dot, never the only signal. */
  text: string;
  /** Independent flags that render on top of the main state. */
  locked: boolean;
}

export const RENEW_WINDOW_DAYS = 30;

/** Priority: egg, traveling, attention, sleeping, shedding, drowsy, armored, thriving. */
export function deriveCreatureState(f: DomainFacts): DerivedState {
  const locked = f.transferLock;
  if (f.registering) return { state: "egg", text: "Registering", locked };
  if (f.transferInFlight) return { state: "traveling", text: "Transfer in progress", locked };
  if (f.attentionReason) return { state: "attention", text: f.attentionReason, locked };
  if (f.daysToExpiry < 0) {
    const left =
      f.expiredPhase === "redemption" ? "In redemption. Restoring costs extra."
      : f.expiredPhase === "pending_delete" ? "Pending delete. It cannot be restored."
      : "Expired. You can still renew it.";
    return { state: "sleeping", text: left, locked };
  }
  if (f.dnsWriteInFlight) return { state: "shedding", text: "Your DNS change is spreading", locked };
  if (f.daysToExpiry <= RENEW_WINDOW_DAYS) {
    const n = `${f.daysToExpiry} ${f.daysToExpiry === 1 ? "day" : "days"}`;
    return { state: "drowsy", text: f.autoRenew === false ? `Expires in ${n}. Auto-renew is off.` : `Renews in ${n}`, locked };
  }
  if (locked) return { state: "armored", text: "Transfer lock on", locked };
  return { state: "thriving", text: "Healthy. Nothing needs you.", locked };
}

/** Moss cover 0..1 from age in days; saturates near four years. */
export function mossFromAge(ageDays: number): number {
  const years = Math.max(0, ageDays) / 365;
  return Math.min(1, Math.round((1 - Math.exp(-years / 1.6)) * 1000) / 1000);
}

export function ageInWords(ageDays: number): string {
  if (ageDays < 2) return "Newly hatched. Almost no moss yet.";
  if (ageDays < 60) return `${Math.floor(ageDays)} days old. A little moss.`;
  const months = Math.floor(ageDays / 30.44);
  if (months < 24) return `${months} months old. Moss on its back.`;
  return `${Math.floor(ageDays / 365)} years old. Well mossed.`;
}
