import { RegistrarError, type Money, type RegistrarPort } from "@mosshatch/registrar/port";
import { PAID_OPERATION_LEASE_MS, type PaidOperationLock } from "./paid-operation.ts";

export interface FundingAdmissionLease { token: string; available: Money | null; expiresAt: Date }
export interface FundingAdmissionControl {
  beginFundingAdmission(): Promise<FundingAdmissionLease>;
  endFundingAdmission(token: string): Promise<void>;
}
export type FundingRegistrar = RegistrarPort & Partial<FundingAdmissionControl>;

/** The same boundary protects both paid vendor writes and the uncached balance used by a funding admission. */
export function fundingAdmissionControl(port: RegistrarPort, lock: PaidOperationLock, clock: { now(): Date }): FundingAdmissionControl {
  return {
    async beginFundingAdmission() {
      const startedAt = clock.now().getTime();
      let token: string | null;
      try { token = await lock.acquire(); }
      catch { throw new RegistrarError("unavailable", "funding boundary unavailable", { retryable: true, outcomeUnknown: false, code: "registrar_shared_store_unavailable" }); }
      if (!token) throw new RegistrarError("rate_limited", "funding boundary busy", { retryable: true, outcomeUnknown: false, code: "registrar_paid_operation_busy" });
      const expiresAt = new Date(startedAt + PAID_OPERATION_LEASE_MS);
      try {
        const funds = await port.getFundingStatus();
        return { token, available: funds === "unsupported" ? null : funds, expiresAt };
      } catch (error) {
        // Reading funding never creates a paid upstream operation.
        await lock.release(token).catch(() => undefined);
        throw error;
      }
    },
    async endFundingAdmission(token) { await lock.release(token); },
  };
}

export function withFundingAdmissionControl(port: RegistrarPort, control: FundingAdmissionControl): FundingRegistrar {
  return new Proxy(port, {
    get(target, prop, recv) {
      if (prop === "beginFundingAdmission") return control.beginFundingAdmission.bind(control);
      if (prop === "endFundingAdmission") return control.endFundingAdmission.bind(control);
      const value = Reflect.get(target, prop, recv);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export function requireFundingAdmission(port: RegistrarPort): FundingAdmissionControl {
  const extended = port as FundingRegistrar;
  if (typeof extended.beginFundingAdmission !== "function" || typeof extended.endFundingAdmission !== "function")
    throw new RegistrarError("unavailable", "funding admission unavailable", { retryable: false, outcomeUnknown: false, code: "funding_admission_not_configured" });
  return extended as FundingAdmissionControl;
}
