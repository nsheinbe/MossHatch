import crypto from "node:crypto";
import { RegistrarError, type RegistrarPort } from "@mosshatch/registrar/port";
import type { RedisCommand } from "./shared-store.ts";

const PAID = new Set(["register", "renew", "startTransferIn", "restore"]);
/** Greater than the registrar function's 800-second maximum; a dead process releases capacity through expiry. */
export const PAID_OPERATION_LEASE_MS = 900_000;
export interface PaidOperationLock { acquire(): Promise<string | null>; release(token: string): Promise<void> }
export class MemoryPaidOperationLock implements PaidOperationLock {
  private active: string | null = null;
  private expiresAt = 0;
  constructor(private clock: { now(): Date } = { now: () => new Date() }) {}
  async acquire(): Promise<string | null> {
    if (this.active !== null && this.clock.now().getTime() < this.expiresAt) return null;
    this.expiresAt = this.clock.now().getTime() + PAID_OPERATION_LEASE_MS;
    return this.active = crypto.randomUUID();
  }
  async release(token: string): Promise<void> { if (this.active === token) this.active = null; }
}
const RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
/** Every instance using the same reseller and Redis store shares one paid-operation boundary. No account identifier is stored. */
export class RedisPaidOperationLock implements PaidOperationLock {
  private key: string;
  constructor(private redis: RedisCommand, reseller: string) {
    this.key = "mh:rpc:paid:" + crypto.createHash("sha256").update(reseller.trim().toLowerCase()).digest("hex");
  }
  async acquire(): Promise<string | null> {
    const token = crypto.randomUUID();
    return (await this.redis(["SET", this.key, token, "NX", "PX", PAID_OPERATION_LEASE_MS])) === "OK" ? token : null;
  }
  async release(token: string): Promise<void> { await this.redis(["EVAL", RELEASE, 1, this.key, token]); }
}

/**
 * The adapter's debit check observes the global balance, so register/renew/transfer/restore must not overlap across instances.
 * Busy work returns to the durable job retry path instead of consuming a daily spend slot or waiting inside this RPC.
 * An uncertain or accepted-pending upstream operation keeps the lease until expiry; reads/reconciliation remain available.
 */
export function serializePaidOperations(port: RegistrarPort, lock: PaidOperationLock, onReleaseFailure: () => void = () => undefined): RegistrarPort {
  return new Proxy(port, {
    get(target, prop, recv) {
      const value = Reflect.get(target, prop, recv);
      if (typeof prop !== "string" || !PAID.has(prop) || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        let token: string | null;
        try { token = await lock.acquire(); }
        catch { throw new RegistrarError("unavailable", "paid operation lock unavailable", { retryable: true, outcomeUnknown: false, code: "registrar_shared_store_unavailable" }); }
        if (token === null) throw new RegistrarError("rate_limited", "another paid operation is in progress", { retryable: true, outcomeUnknown: false, code: "registrar_paid_operation_busy" });
        let uncertain = false;
        try {
          const result = await (value as (...args: unknown[]) => Promise<unknown>).apply(target, args);
          const status = (result as { status?: string } | null)?.status;
          uncertain = status === "accepted_pending" || (prop === "startTransferIn" && (status === "pending_registry" || status === "pending_owner"));
          return result;
        } catch (error) {
          uncertain = !(error instanceof RegistrarError) || error.outcomeUnknown;
          throw error;
        } finally {
          if (!uncertain) { try { await lock.release(token); } catch { onReleaseFailure(); } }
        }
      };
    },
  });
}
