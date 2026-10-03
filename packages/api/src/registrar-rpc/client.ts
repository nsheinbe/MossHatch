import type { FundingRegistrar } from "./funding-control.ts";
import { randomBytes } from "node:crypto";
import { RegistrarError, type RegistrarCapabilities, type RegistrarPort } from "@mosshatch/registrar/port";
import { decodeJson, encodeJson, RPC_HEADERS, RPC_PATH_PREFIX, sign } from "./sign.ts";
import type { RpcCommandName } from "./server.ts";

export interface RpcSend { (req: { method: "POST"; path: string; headers: Record<string, string>; body: string }): Promise<{ status: number; body: string }> }

/**
 * The `web` side: a RegistrarPort whose every method is a signed call. `web` never holds the reseller key, only `secret`.
 * `capabilities()` is synchronous in the port, so the client is built after one signed `capabilities` call.
 */
export async function connectRegistrarRpc(o: { secret: string; send: RpcSend; clock?: { now(): Date }; nonce?: () => string }): Promise<RegistrarPort> {
  const clock = o.clock ?? { now: () => new Date() };
  const nonce = o.nonce ?? (() => randomBytes(18).toString("base64url"));
  const call = async <T>(name: RpcCommandName, args: unknown[] = []): Promise<T> => {
    const path = RPC_PATH_PREFIX + name; const body = encodeJson({ args });
    const timestamp = String(Math.floor(clock.now().getTime() / 1000)); const n = nonce();
    const res = await o.send({ method: "POST", path, body, headers: { "content-type": "application/json", [RPC_HEADERS.timestamp]: timestamp, [RPC_HEADERS.nonce]: n, [RPC_HEADERS.signature]: sign(o.secret, { method: "POST", path, body, timestamp, nonce: n }) } });
    let parsed: { result?: T; error?: { code?: string; kind?: RegistrarError["kind"]; retryable?: boolean; outcomeUnknown?: boolean } };
    try { parsed = decodeJson(res.body) as typeof parsed; } catch { throw new RegistrarError("unknown", "registrar call failed", { retryable: false, outcomeUnknown: true, code: `rpc_http_${res.status}` }); }
    if (res.status === 200 && parsed && "result" in parsed) return (parsed.result === null ? undefined : parsed.result) as T;
    const e = parsed?.error ?? {};
    // An auth failure on the RPC hop never reached the registrar, so nothing is unknown about the outcome.
    const rpcLevel = res.status === 401 || res.status === 404 || res.status === 400 || res.status === 413;
    throw new RegistrarError(e.kind ?? "unavailable", "registrar call failed", { retryable: e.retryable ?? false, outcomeUnknown: rpcLevel ? false : e.outcomeUnknown ?? res.status >= 500, code: e.code ?? `rpc_http_${res.status}` });
  };
  const caps = await call<RegistrarCapabilities>("capabilities");
  const port: FundingRegistrar = {
    beginFundingAdmission: () => call("beginFundingAdmission"),
    endFundingAdmission: (token) => call("endFundingAdmission", [token]),
    capabilities: () => caps,
    health: () => call("health"),
    checkAvailability: (f, opts) => call("checkAvailability", opts ? [f, opts] : [f]),
    quote: (f, y, k) => call("quote", k ? [f, y, k] : [f, y]),
    register: (r) => call("register", [r]),
    renew: (f, y, cy) => call("renew", [f, y, cy]),
    getDomain: async (f) => (await call<Awaited<ReturnType<RegistrarPort["getDomain"]>> | undefined>("getDomain", [f])) ?? null,
    getOrdersByDomain: (f) => call("getOrdersByDomain", [f]),
    cancelPendingOrder: (id) => call("cancelPendingOrder", [id]),
    getFundingStatus: () => call("getFundingStatus"),
    getBalance: () => call("getBalance"),
    setLock: (f, l) => call("setLock", [f, l]),
    setNameservers: (f, ns, opts) => call("setNameservers", opts ? [f, ns, opts] : [f, ns]),
    issueAuthCode: (f) => call("issueAuthCode", [f]),
    rerandomizeAuthCode: (f) => call("rerandomizeAuthCode", [f]),
    getDns: (f) => call("getDns", [f]),
    replaceZone: (f, r) => call("replaceZone", [f, r]),
    getDs: (f) => call("getDs", [f]),
    addDs: (f, d) => call("addDs", [f, d]),
    removeDs: (f, d) => call("removeDs", [f, d]),
    updateContact: (f, r) => call("updateContact", [f, r]),
    getTransfersAway: (opts) => call("getTransfersAway", opts ? [opts] : []),
    cancelTransfer: (f) => call("cancelTransfer", [f]),
    stopTransferAway: (f) => call("stopTransferAway", [f]),
    setAutoRenew: (f, e) => call("setAutoRenew", [f, e]),
    listDomains: (opts) => call("listDomains", opts ? [opts] : []),
    getDeletedDomains: () => call("getDeletedDomains"),
    restore: (f) => call("restore", [f]),
    checkTransferIn: (f) => call("checkTransferIn", [f]),
    startTransferIn: (r) => call("startTransferIn", [r]),
    getTransferInStatus: async (f) => (await call<Awaited<ReturnType<RegistrarPort["getTransferInStatus"]>> | undefined>("getTransferInStatus", [f])) ?? null,
    cancelTransferIn: (f) => call("cancelTransferIn", [f]),
  };
  return port;
}
