import { deriveCreatureState, type CreatureState, type DomainFacts } from "@mosshatch/core";
import { DAY_MS, STALE_SYNC_MS, SYNC_ERROR_ATTENTION_MS, type DomainRow } from "./common.ts";

/**
 * The inputs `deriveCreatureState` needs, computed from adapter data (the synced domain row) and our own records (orders, actions, terms).
 * Nothing is stored: the state is a pure function of these, and `asOf` and `source` say how fresh the adapter truth is (PLAN creature state).
 */
export interface StateInputs {
  d: DomainRow;
  now: Date;
  /** A committed `domain.transfer_out` (or a Rescue order) for this domain in the last 7 days: the owner started the transfer. */
  ownerStartedTransfer: boolean;
  /** The renewal charge failed and the decline ladder is spent or running. */
  renewalPaymentFailed: boolean;
  /** An order for this name is authorized, registering or waiting on the registrar. */
  orderInFlight?: boolean;
  /** A DNS write is accepted but not visible at the authoritative nameservers yet (Shedding). */
  dnsWriteInFlight?: boolean;
}

export interface DomainStateView {
  state: CreatureState;
  text: string;
  locked: boolean;
  /** When the adapter last confirmed this state; null when it never did. */
  asOf: Date | null;
  source: "adapter" | "order";
  /** False when the last confirmation is older than the staleness bound: the sentence then says so instead of guessing. */
  confirmed: boolean;
  facts: DomainFacts;
}

const registryHold = (statuses: string[]) => statuses.some((s) => /hold$/i.test(s) && !/^client(transfer|update|delete|renew)prohibited$/i.test(s));

export function domainFacts(i: StateInputs): DomainFacts {
  const { d, now } = i;
  const days = d.expiresAt ? Math.floor((d.expiresAt.getTime() - now.getTime()) / DAY_MS) : 9999;
  const ageDays = d.registryCreatedAt ? Math.max(0, Math.floor((now.getTime() - d.registryCreatedAt.getTime()) / DAY_MS)) : 0;
  const expired = days < 0 || d.state === "expired" || d.state === "redemption" || d.state === "pending_delete";
  const expiredPhase = d.state === "redemption" ? "redemption" as const : d.state === "pending_delete" ? "pending_delete" as const : expired ? "grace" as const : undefined;
  const unrequestedTransfer = d.transferAway && !i.ownerStartedTransfer;
  // Sleeping outranks needs-attention (PLAN creature state 3 and 4), so no attention reason is passed for an expired name.
  let attention: string | undefined;
  if (!expired) {
    if (unrequestedTransfer) attention = "A transfer to another registrar started. You did not ask for it. Decline it in the email from the registrar, or press Stop this transfer.";
    else if (i.renewalPaymentFailed) attention = "The renewal payment failed. Renew now or update your card before the name expires.";
    else if (registryHold(d.registryStatuses)) attention = "The registry or registrar has put a hold on this domain.";
    else if (d.disputeLockState) attention = "A domain dispute lock is on. Contact changes and transfers are paused.";
    else if (d.syncError && d.syncErrorSince && now.getTime() - d.syncErrorSince.getTime() > SYNC_ERROR_ATTENTION_MS) attention = "We cannot confirm this domain's state right now.";
  }
  return {
    registering: d.state === "pending" || !!i.orderInFlight,
    daysToExpiry: days,
    expiredPhase,
    transferLock: d.locked,
    transferInFlight: d.transferAway && i.ownerStartedTransfer ? "out" : undefined,
    attentionReason: attention,
    dnsWriteInFlight: i.dnsWriteInFlight,
    ageDays,
    autoRenew: d.autoRenew,
  };
}

export function deriveDomainState(i: StateInputs): DomainStateView {
  const facts = domainFacts(i);
  const out = deriveCreatureState(facts);
  const confirmed = !!i.d.syncedAt && i.now.getTime() - i.d.syncedAt.getTime() <= STALE_SYNC_MS && !i.d.syncError;
  return { state: out.state, text: out.text, locked: out.locked, asOf: i.d.syncedAt, source: "adapter", confirmed, facts };
}
