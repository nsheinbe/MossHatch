import { describe, expect, it } from "vitest";
import { RegistrarError, type RegistrarPort } from "@mosshatch/registrar/port";
import { MemoryPaidOperationLock, RedisPaidOperationLock, serializePaidOperations } from "./paid-operation.ts";
import { fundingAdmissionControl, requireFundingAdmission, withFundingAdmissionControl } from "./funding-control.ts";
import { connectRegistrarRpc } from "./client.ts";
import { createRegistrarRpc, MemoryNonceStore } from "./server.ts";
import type { RedisCommand } from "./shared-store.ts";

const clock = { now: () => new Date("2026-10-03T00:00:00Z") };
const funds = { minor: 40_000n, currency: "usd" as const, source: "live" as const };
function sharedRedis(): RedisCommand {
  const rows = new Map<string, string>();
  return async (args) => {
    if (args[0] === "SET") { const key = String(args[1]); if (rows.has(key)) return null; rows.set(key, String(args[2])); return "OK"; }
    if (args[0] === "EVAL") { const key = String(args[3]); if (rows.get(key) !== String(args[4])) return 0; rows.delete(key); return 1; }
    throw new Error("unsupported command");
  };
}
describe("funding admission uses the paid vendor boundary", () => {
  it("independent instances cannot start any paid operation while a fresh funding observation is reserved for admission", async () => {
    const redis = sharedRedis();
    let writes = 0;
    const adapter = {
      getFundingStatus: async () => funds,
      register: async () => { writes++; return { status: "registered" }; },
      renew: async () => { writes++; return { status: "renewed" }; },
      startTransferIn: async () => { writes++; return { status: "pending_registry" }; },
      restore: async () => { writes++; return { status: "restored" }; },
      getBalance: async () => ({ available: funds }),
    } as unknown as RegistrarPort;
    const admission = fundingAdmissionControl(adapter, new RedisPaidOperationLock(redis, "owner"), clock);
    const otherLock = new RedisPaidOperationLock(redis, "owner");
    const paid = serializePaidOperations(adapter, otherLock);
    const lease = await admission.beginFundingAdmission();
    expect(lease.available).toEqual(funds);
    for (const operation of [() => paid.register({} as never), () => paid.renew("moonfern.com", 1, 2027), () => paid.startTransferIn({} as never), () => paid.restore("moonfern.com")])
      await expect(operation()).rejects.toMatchObject({ code: "registrar_paid_operation_busy" });
    expect(writes).toBe(0);
    expect(await paid.getBalance()).toEqual({ available: funds });
    await otherLock.release("a-different-owner");
    await expect(admission.beginFundingAdmission()).rejects.toMatchObject({ code: "registrar_paid_operation_busy" });
    await admission.endFundingAdmission(lease.token);
    await paid.register({} as never);
    expect(writes).toBe(1);
  });
  it("a failed read releases the lease and leaves all vendor writes untouched", async () => {
    const lock = new MemoryPaidOperationLock(clock);
    const control = fundingAdmissionControl({ getFundingStatus: async () => { throw new RegistrarError("unavailable", "offline", { retryable: true, outcomeUnknown: false }); } } as unknown as RegistrarPort, lock, clock);
    await expect(control.beginFundingAdmission()).rejects.toMatchObject({ kind: "unavailable" });
    expect(await lock.acquire()).not.toBeNull();
  });
  it("a missing funding control fails closed", () => {
    expect(() => requireFundingAdmission({} as RegistrarPort)).toThrowError("funding admission unavailable");
  });
  it("funding controls cross only the authenticated signed RPC and preserve typed money/date and owner fencing", async () => {
    const lock = new MemoryPaidOperationLock(clock);
    const adapter = { capabilities: () => ({ mode: "live", funding: true }), getFundingStatus: async () => funds } as unknown as RegistrarPort;
    const secret = "funding-test-secret-not-real-0123456789";
    const rpc = createRegistrarRpc({ port: withFundingAdmissionControl(adapter, fundingAdmissionControl(adapter, lock, clock)), secrets: [secret], clock, nonces: new MemoryNonceStore() });
    const unsigned = await rpc({ method: "POST", path: "/rpc/v1/beginFundingAdmission", body: '{"args":[]}', headers: {} });
    expect(unsigned.status).toBe(401);
    const client = await connectRegistrarRpc({ secret, clock, send: rpc });
    const control = requireFundingAdmission(client);
    const lease = await control.beginFundingAdmission();
    expect(lease.available).toEqual(funds);
    expect(lease.expiresAt).toBeInstanceOf(Date);
    await control.endFundingAdmission("00000000-0000-4000-8000-000000000000");
    await expect(control.beginFundingAdmission()).rejects.toMatchObject({ code: "registrar_paid_operation_busy" });
    await control.endFundingAdmission(lease.token);
    expect((await control.beginFundingAdmission()).available).toEqual(funds);
  });
});
