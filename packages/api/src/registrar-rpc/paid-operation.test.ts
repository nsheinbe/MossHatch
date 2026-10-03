import { describe, expect, it } from "vitest";
import { RegistrarError, type RegistrarPort } from "@mosshatch/registrar/port";
import { MemoryPaidOperationLock, PAID_OPERATION_LEASE_MS, RedisPaidOperationLock, serializePaidOperations } from "./paid-operation.ts";
import type { RedisCommand } from "./shared-store.ts";

function redisFake() {
  const rows = new Map<string, string>();
  const command: RedisCommand = async (args) => {
    const [op, key] = args.map(String);
    if (op === "SET") { if (rows.has(key!)) return null; rows.set(key!, String(args[2])); return "OK"; }
    if (op === "EVAL") { const lockKey = String(args[3]); if (rows.get(lockKey) !== String(args[4])) return 0; rows.delete(lockKey); return 1; }
    throw new Error("unsupported fake command");
  };
  return { rows, command };
}

describe("shared paid registrar operation boundary", () => {
  it("two independent instances cannot overlap paid operations; reads continue and capacity returns after a known result", async () => {
    const shared = redisFake();
    let starts = 0, finish: (() => void) | undefined;
    const adapter = {
      register: async () => { starts++; await new Promise<void>((resolve) => { finish = resolve; }); return { status: "registered" }; },
      getBalance: async () => ({ available: 100 }),
    } as unknown as RegistrarPort;
    const one = serializePaidOperations(adapter, new RedisPaidOperationLock(shared.command, "reseller@example.test"));
    const two = serializePaidOperations(adapter, new RedisPaidOperationLock(shared.command, "reseller@example.test"));
    const first = one.register({} as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toBe(1);
    await expect(two.register({} as never)).rejects.toMatchObject({ code: "registrar_paid_operation_busy", retryable: true, outcomeUnknown: false });
    expect(starts).toBe(1);
    expect(await two.getBalance()).toEqual({ available: 100 });
    finish!(); await first;
    const second = two.register({} as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toBe(2);
    finish!(); await second;
    expect(shared.rows.size).toBe(0);
  });
  it("accepted transfers keep the shared lease across instances while status reads remain available", async () => {
    for (const status of ["pending_registry", "pending_owner"] as const) {
      const shared = redisFake();
      let paidCalls = 0;
      const adapter = {
        startTransferIn: async () => { paidCalls++; return { status, registrarOrderId: "123", ownerEmailSent: false }; },
        register: async () => { paidCalls++; return { status: "registered" }; },
        renew: async () => { paidCalls++; return { status: "renewed" }; },
        getTransferInStatus: async () => ({ status }),
      } as unknown as RegistrarPort;
      const one = serializePaidOperations(adapter, new RedisPaidOperationLock(shared.command, "reseller"));
      const two = serializePaidOperations(adapter, new RedisPaidOperationLock(shared.command, "reseller"));
      expect((await one.startTransferIn({} as never)).status).toBe(status);
      await expect(two.register({} as never)).rejects.toMatchObject({ code: "registrar_paid_operation_busy" });
      await expect(two.renew("moonfern.com", 1, 2027)).rejects.toMatchObject({ code: "registrar_paid_operation_busy" });
      expect(await two.getTransferInStatus("moonfern.com")).toEqual({ status });
      expect(paidCalls).toBe(1);
      expect(shared.rows.size).toBe(1);
    }
  });
  it("a late owner cannot release a replacement owner's lease", async () => {
    const shared = redisFake(), lock = new RedisPaidOperationLock(shared.command, "reseller");
    const old = await lock.acquire();
    expect(old).not.toBeNull();
    shared.rows.clear(); // the old process died and its Redis TTL expired
    const current = await lock.acquire();
    expect(current).not.toBe(old);
    await lock.release(old!);
    expect(await lock.acquire()).toBeNull();
    await lock.release(current!);
    expect(await lock.acquire()).not.toBeNull();
  });
  it("unknown or accepted-pending upstream outcomes retain the lease, then recover after expiry", async () => {
    let at = new Date("2026-10-03T00:00:00Z");
    for (const result of ["unknown", "pending"]) {
      const lock = new MemoryPaidOperationLock({ now: () => at });
      const adapter = { register: async () => {
        if (result === "unknown") throw new RegistrarError("unknown", "timeout", { outcomeUnknown: true, retryable: true });
        return { status: "accepted_pending" };
      } } as unknown as RegistrarPort;
      const guarded = serializePaidOperations(adapter, lock);
      await guarded.register({} as never).catch(() => undefined);
      await expect(guarded.register({} as never)).rejects.toMatchObject({ code: "registrar_paid_operation_busy" });
      at = new Date(at.getTime() + PAID_OPERATION_LEASE_MS + 1);
      expect(await lock.acquire()).not.toBeNull();
    }
  });
  it("a failed shared store starts no vendor operation", async () => {
    let calls = 0;
    const guarded = serializePaidOperations({ renew: async () => { calls++; } } as unknown as RegistrarPort,
      new RedisPaidOperationLock(async () => { throw new Error("redis unavailable"); }, "reseller"));
    await expect(guarded.renew("moonfern.com", 1, 2027)).rejects.toMatchObject({ code: "registrar_shared_store_unavailable", outcomeUnknown: false });
    expect(calls).toBe(0);
  });
  it("known provider rejection releases the lease", async () => {
    const lock = new MemoryPaidOperationLock();
    const guarded = serializePaidOperations({ register: async () => { throw new RegistrarError("rejected", "not available", { outcomeUnknown: false, retryable: false }); } } as unknown as RegistrarPort, lock);
    await expect(guarded.register({} as never)).rejects.toMatchObject({ kind: "rejected" });
    expect(await lock.acquire()).not.toBeNull();
  });
});
