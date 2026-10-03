import { fundingAdmissionControl, withFundingAdmissionControl } from "./funding-control.ts";
import { RegistrarError, type RegistrarPort } from "@mosshatch/registrar/port";
import { registrarSpendLimitFromEnv } from "../golive/registration-policy.ts";
import { MemoryPaidOperationLock, RedisPaidOperationLock, serializePaidOperations } from "./paid-operation.ts";
import { MemoryKillSwitch, type SwitchState } from "@mosshatch/registrar/opensrs";
import { openproviderFromEnv, parseRegistrarRouting, type OpHttpTransport } from "@mosshatch/registrar/openprovider";
import { modeFromEnv } from "../config/modeguard.ts";
import { openproviderGuardReasons } from "../config/openprovider-guard.ts";
import type { Mode } from "../ports.ts";
import { registrarScopeReasons } from "./scope.ts";
import { createRegistrarRpc, MemoryNonceStore, type NonceStore, type RpcResponse } from "./server.ts";
import { MemoryDailyCounter, RedisDailyCounter, RedisNonceStore, redisConfigFromEnv, redisRest, type DailyCounter } from "./shared-store.ts";

/**
 * The `registrar` Vercel project (apps/registrar): the only process that holds the reseller credentials (PLAN 4.3b, threat rows 29
 * and 30, ST-117/118). It serves the signed RPC (`createRegistrarRpc`) over the Openprovider adapter and nothing else: no database,
 * no Stripe key, no vault, no web routes. `web` holds only `REGISTRAR_RPC_SECRET` and reaches this through `registrarFromEnv`.
 *
 * Environment (Production scope, Sensitive, in the `registrar` project only):
 *   MH_SCOPE=registrar, MH_REGISTRAR_MODE=live, MH_REGISTRAR_PROVIDER=openprovider, OPENPROVIDER_ENV=production,
 *   OPENPROVIDER_USERNAME, OPENPROVIDER_PASSWORD, REGISTRAR_RPC_SECRET (32+ characters; the same value as in `web`),
 *   optional REGISTRAR_RPC_SECRET_PREVIOUS (rotation overlap), MH_REGISTRAR_KILL_SWITCH (open | writes_paused | all_paused),
 *   MH_REGISTRAR_DAILY_SPEND_OPS (paid operations per UTC day across all instances; default 5 when live), and the shared store
 *   UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN), required when live (shared-store.ts).
 *
 * A misconfigured project still answers: an unsigned or badly signed call gets the usual 401, a signed call gets 503 with the reason
 * code (never a value), so `web`'s boot can name what is missing (`openprovider_credentials_missing` and the rest below).
 */
export type RegistrarServeReason =
  | "registrar_scope_missing" | "registrar_rpc_secret_missing" | "registrar_mode_invalid" | "registrar_provider_unsupported"
  | "openprovider_credentials_missing" | "live_outside_production" | "registrar_config_invalid" | "registrar_shared_store_missing" | string;

export interface RegistrarServeDeps {
  /** Tests pass a fake; production uses fetch. */
  transport?: OpHttpTransport;
  clock?: { now(): Date };
  nonces?: NonceStore;
  /** The daily count of paid operations. Defaults to the shared store when configured, else per instance. */
  spendCounter?: DailyCounter;
  /** The shared store's fetch (tests pass a fake Redis). */
  redisFetch?: typeof fetch;
  /** Codes only. Production writes one JSON line per event to the function log. */
  log?: (line: Record<string, unknown>) => void;
}

const PAID = new Set(["register", "renew", "startTransferIn", "restore"]);

/**
 * A cap on paid operations a UTC day: a second fuse behind web's database-backed `limits.daily_registrations` and the spend fuse, with the
 * Openprovider balance as the hard limit behind both. With the shared store the count covers every instance; the in-memory counter
 * (sandbox, tests) bounds one instance. A counter that cannot answer refuses the operation (fail closed).
 */
export function spendCapped(port: RegistrarPort, maxPerDay: number, clock: { now(): Date }, onTrip: () => void, counter: DailyCounter = new MemoryDailyCounter()): RegistrarPort {
  return new Proxy(port, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof prop !== "string" || !PAID.has(prop) || typeof v !== "function") return typeof v === "function" ? v.bind(target) : v;
      return async (...args: unknown[]) => {
        let used: number;
        try { used = await counter.take(clock.now().toISOString().slice(0, 10)); }
        catch { throw new RegistrarError("unavailable", "shared store unavailable", { retryable: true, outcomeUnknown: false, code: "registrar_shared_store_unavailable" }); }
        if (used > maxPerDay) { onTrip(); throw new RegistrarError("rate_limited", "daily spend cap reached", { retryable: false, outcomeUnknown: false, code: "registrar_daily_spend_cap" }); }
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** Answers every command with the configuration problem, after the signature has been checked by the RPC server. */
function refusingPort(code: string): RegistrarPort {
  const fail = () => { throw new RegistrarError("unavailable", "registrar is not configured", { retryable: false, outcomeUnknown: false, code }); };
  return new Proxy({} as RegistrarPort, { get: () => fail });
}

function killSwitchFromEnv(v: string | undefined): SwitchState {
  if (v === undefined || v === "" || v === "open") return "open";
  if (v === "writes_paused") return "writes_paused";
  return "all_paused"; // anything else fails closed
}

/** What is wrong with this registrar project's environment, as reason codes (pure). */
export function registrarServeReasons(env: Record<string, string | undefined>): { reasons: RegistrarServeReason[]; mode: Mode | null; live: boolean } {
  const reasons: RegistrarServeReason[] = [];
  if (env.MH_SCOPE !== "registrar") reasons.push("registrar_scope_missing");
  if (!env.REGISTRAR_RPC_SECRET || env.REGISTRAR_RPC_SECRET.length < 32 || (env.REGISTRAR_RPC_SECRET_PREVIOUS && env.REGISTRAR_RPC_SECRET_PREVIOUS.length < 32)) reasons.push("registrar_rpc_secret_missing");
  let mode: Mode | null = null;
  try { mode = modeFromEnv(env); } catch { reasons.push("registrar_config_invalid"); }
  const registrarMode = env.MH_REGISTRAR_MODE ?? "mock";
  if (registrarMode !== "sandbox" && registrarMode !== "live") reasons.push("registrar_mode_invalid");
  const live = registrarMode === "live";
  // The mode guard's rule for this side: the live adapter only in a production deployment, and only with VERCEL_ENV=production.
  if (live && (mode !== "production" || env.VERCEL_ENV !== "production")) reasons.push("live_outside_production");
  if (mode) {
    reasons.push(...registrarScopeReasons(env, mode));
    if (registrarMode === "sandbox" || registrarMode === "live") reasons.push(...openproviderGuardReasons(env, mode, registrarMode));
  }
  try {
    const routing = parseRegistrarRouting({ ...env, MH_REGISTRAR_MODE: registrarMode });
    const used = new Set([routing.defaultProvider, ...Object.values(routing.byTld)]);
    // Only the Openprovider adapter is served here: the OpenSRS adapter has never seen a real response (docs/registrar-parity.md).
    if ([...used].some((p) => p !== "openprovider")) reasons.push("registrar_provider_unsupported");
  } catch { reasons.push("registrar_provider_unsupported"); }
  if (!env.OPENPROVIDER_USERNAME || !env.OPENPROVIDER_PASSWORD) reasons.push("openprovider_credentials_missing");
  // Live selling needs the nonces and the daily cap shared by every instance (shared-store.ts).
  if (live && !redisConfigFromEnv(env)) reasons.push("registrar_shared_store_missing");
  return { reasons: [...new Set(reasons)], mode, live };
}

/** Build the registrar project's request handler from its environment. Never throws; a bad environment answers reason codes. */
export function registrarRpcFromEnv(env: Record<string, string | undefined>, deps: RegistrarServeDeps = {}): { handler: (request: Request) => Promise<Response>; reasons: RegistrarServeReason[] } {
  const clock = deps.clock ?? { now: () => new Date() };
  const log = deps.log ?? ((line) => console.info(JSON.stringify(line)));
  const { reasons, live, mode } = registrarServeReasons(env);
  const redisCfg = redisConfigFromEnv(env);
  const redis = redisCfg ? redisRest(redisCfg, deps.redisFetch ?? fetch) : null;
  const secrets = reasons.includes("registrar_rpc_secret_missing") ? [] : [env.REGISTRAR_RPC_SECRET!, ...(env.REGISTRAR_RPC_SECRET_PREVIOUS ? [env.REGISTRAR_RPC_SECRET_PREVIOUS] : [])];
  let port: RegistrarPort;
  const blocking = reasons.filter((r) => r !== "registrar_rpc_secret_missing");
  if (blocking.length) {
    port = refusingPort(blocking[0]!);
    log({ event: "registrar_not_configured", reasons: blocking });
  } else {
    try {
      // The adapter reads the deployment from MH_MODE; pass the mode derived above (MH_MODE, else VERCEL_ENV) so the two always agree.
      const adapter = openproviderFromEnv({ ...env, MH_MODE: mode ?? "local" }, {
        killSwitch: new MemoryKillSwitch(killSwitchFromEnv(env.MH_REGISTRAR_KILL_SWITCH)),
        ...(deps.transport ? { transport: deps.transport } : {}),
        onAlert: (a) => log({ event: "registrar_alert", kind: a.kind, detail: a.detail }),
        log: (e) => log({ ...e }),
      });
      const cap = registrarSpendLimitFromEnv(env, live);
      const counter = deps.spendCounter ?? (redis ? new RedisDailyCounter(redis) : new MemoryDailyCounter());
      const counted = cap === null ? adapter : spendCapped(adapter, cap, clock, () => log({ event: "registrar_alert", kind: "daily_spend_cap", detail: String(cap) }), counter);
      const paidLock = redis ? new RedisPaidOperationLock(redis, env.OPENPROVIDER_USERNAME ?? "") : new MemoryPaidOperationLock(clock);
      port = withFundingAdmissionControl(
        serializePaidOperations(counted, paidLock, () => log({ event: "registrar_alert", kind: "paid_lock_release_failed" })),
        fundingAdmissionControl(adapter, paidLock, clock),
      );
    } catch {
      port = refusingPort("registrar_config_invalid");
      log({ event: "registrar_not_configured", reasons: ["registrar_config_invalid"] });
    }
  }
  const rpc = createRegistrarRpc({ port, secrets, clock, nonces: deps.nonces ?? (redis ? new RedisNonceStore(redis) : new MemoryNonceStore()), onReject: (r) => log({ event: "registrar_rpc_reject", reason: r }) });
  return {
    reasons,
    async handler(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      const body = request.method === "POST" ? await request.text() : "";
      const res: RpcResponse = await rpc({ method: request.method, path: url.pathname, headers, body });
      return new Response(res.body, { status: res.status, headers: res.headers });
    },
  };
}
