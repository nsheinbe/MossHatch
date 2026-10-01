import { describe, expect, it } from "vitest";
import { RegistrarError, type RegistrarPort } from "@mosshatch/registrar/port";
import { PRODUCTION_URL, type OpHttpRequest, type OpHttpTransport } from "@mosshatch/registrar/openprovider";
import { registrarRpcFromEnv, registrarServeReasons, spendCapped } from "./serve.ts";
import { registrarFromEnv, registrarRpcBootReason } from "../domains/boot-wiring.ts";
import { NotConfigured } from "../boot.ts";

/**
 * The `registrar` project (apps/registrar) end to end, offline: web's signed RPC client -> the registrar handler -> the Openprovider adapter
 * -> a fake Openprovider. No network. The live Openprovider endpoint has never been called; these tests prove which URL the live adapter
 * would call and that every boundary refuses what it should.
 */
const SECRET = "s".repeat(40);
const LIVE = {
  MH_SCOPE: "registrar", MH_MODE: "production", VERCEL_ENV: "production", MH_REGISTRAR_MODE: "live", MH_REGISTRAR_PROVIDER: "openprovider",
  OPENPROVIDER_ENV: "production", OPENPROVIDER_USERNAME: "reseller@example.test", OPENPROVIDER_PASSWORD: "pw-not-real", REGISTRAR_RPC_SECRET: SECRET,
};

/** A fake Openprovider: login, prices (.com non-member 11.98 / 16.98) and the reseller balance. Records every request. */
function fakeOpenprovider(): OpHttpTransport & { sent: OpHttpRequest[] } {
  const sent: OpHttpRequest[] = [];
  return {
    sent,
    async request(r) {
      sent.push(r);
      const u = new URL(r.url);
      const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ code: 0, desc: "", data }) });
      if (u.pathname.endsWith("/auth/login")) return ok({ token: "t".repeat(32), reseller_id: 1 });
      if (u.pathname.endsWith("/domains/prices")) {
        const op = u.searchParams.get("operation");
        return ok({ is_premium: false, price: { reseller: { price: op === "renew" ? 16.98 : 11.98, currency: "USD" } } });
      }
      if (u.pathname.endsWith("/resellers")) return ok({ balance: 20, reserved_balance: 0 });
      if (u.pathname.endsWith("/domains") && r.method === "GET") return ok({ results: [{ id: 7, domain: { name: "moonfern", extension: "com" }, status: "ACT" }], total: 1 });
      return { status: 404, body: JSON.stringify({ code: 999, desc: "unexpected" }) };
    },
  };
}

/** web's fetch, wired straight to the registrar project's handler. */
const fetchTo = (handler: (r: Request) => Promise<Response>): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
const WEB = { MH_MODE: "production", VERCEL_ENV: "production", REGISTRAR_RPC_URL: "https://registrar.mosshatch.com", REGISTRAR_RPC_SECRET: SECRET };

describe("registrar project configuration (reason codes)", () => {
  it("a complete live environment has no reasons", () => {
    expect(registrarServeReasons(LIVE)).toMatchObject({ reasons: [], live: true, mode: "production" });
  });
  it("names each missing or wrong piece", () => {
    const r = (over: Record<string, string | undefined>) => registrarServeReasons({ ...LIVE, ...over }).reasons;
    expect(r({ MH_SCOPE: undefined })).toContain("registrar_scope_missing");
    expect(r({ REGISTRAR_RPC_SECRET: "short" })).toContain("registrar_rpc_secret_missing");
    expect(r({ OPENPROVIDER_USERNAME: undefined })).toContain("openprovider_credentials_missing");
    expect(r({ OPENPROVIDER_PASSWORD: "" })).toContain("openprovider_credentials_missing");
    expect(r({ MH_REGISTRAR_PROVIDER: "opensrs" })).toContain("registrar_provider_unsupported");
    expect(r({ MH_REGISTRAR_MODE: "mock" })).toContain("registrar_mode_invalid");
    // Mode guard on this side: the live adapter only in a production deployment with VERCEL_ENV=production.
    expect(r({ VERCEL_ENV: "preview" })).toContain("live_outside_production");
    expect(r({ VERCEL_ENV: undefined })).toContain("live_outside_production");
    expect(r({ MH_MODE: "staging", VERCEL_ENV: "preview" })).toEqual(expect.arrayContaining(["live_outside_production", "openprovider_production_credentials_outside_production"]));
    // Sandbox credentials are refused in production, and production credentials need live mode.
    expect(r({ OPENPROVIDER_ENV: "sandbox" })).toEqual(expect.arrayContaining(["openprovider_sandbox_credentials_in_production"]));
    expect(r({ MH_REGISTRAR_MODE: "sandbox" })).toContain("openprovider_env_registrar_mode_mismatch");
  });
});

describe("web -> registrar project -> Openprovider live (fake)", () => {
  it("the live adapter calls the production endpoint and web gets live (not sample) prices through the signed RPC", async () => {
    const op = fakeOpenprovider();
    const logs: Record<string, unknown>[] = [];
    const reg = registrarRpcFromEnv(LIVE, { transport: op, log: (l) => logs.push(l) });
    expect(reg.reasons).toEqual([]);
    const port = await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(reg.handler));
    expect(port!.capabilities().mode).toBe("live");
    const q = await port!.quote("moonfern.com", 1, "register");
    expect(q.wholesale).toMatchObject({ minor: 1198n, currency: "usd", source: "live" });
    expect(q.renewalWholesale.minor).toBe(1698n);
    expect(PRODUCTION_URL).toBe("https://api.openprovider.eu/v1");
    expect(op.sent.length).toBeGreaterThan(0);
    for (const s of op.sent) expect(s.url.startsWith(`${PRODUCTION_URL}/`)).toBe(true);
    // The credentials go to Openprovider's login and nowhere else, and never into a log line.
    expect(op.sent.filter((s) => (s.body ?? "").includes("pw-not-real")).map((s) => new URL(s.url).pathname)).toEqual(["/v1/auth/login"]);
    expect(JSON.stringify(logs)).not.toContain("pw-not-real");
  });
  it("a registrar project without Openprovider credentials makes web's boot name it, after the signature is checked", async () => {
    const reg = registrarRpcFromEnv({ ...LIVE, OPENPROVIDER_PASSWORD: undefined }, { transport: fakeOpenprovider(), log: () => undefined });
    const e = await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(reg.handler)).catch((x) => x);
    expect(e).toBeInstanceOf(NotConfigured);
    expect((e as NotConfigured).reason).toBe("openprovider_credentials_missing");
    // An unsigned caller learns nothing about the configuration.
    const anon = await reg.handler(new Request("https://registrar.mosshatch.com/rpc/v1/capabilities", { method: "POST", body: "{}" }));
    expect(anon.status).toBe(401);
    expect(await anon.text()).not.toContain("openprovider");
  });
  it("secrets that differ between the projects, a project without its secret, and an unreachable project are told apart", async () => {
    const other = registrarRpcFromEnv({ ...LIVE, REGISTRAR_RPC_SECRET: "o".repeat(40) }, { transport: fakeOpenprovider(), log: () => undefined });
    expect(((await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(other.handler)).catch((x) => x)) as NotConfigured).reason).toBe("registrar_rpc_secret_mismatch");
    const none = registrarRpcFromEnv({ ...LIVE, REGISTRAR_RPC_SECRET: undefined }, { transport: fakeOpenprovider(), log: () => undefined });
    expect(((await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(none.handler)).catch((x) => x)) as NotConfigured).reason).toBe("registrar_project_secret_missing");
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(((await registrarFromEnv(WEB, { registrarMode: "live" }, down).catch((x) => x)) as NotConfigured).reason).toBe("registrar_rpc_unreachable");
    expect(registrarRpcBootReason(new RegistrarError("unavailable", "x", { retryable: false, outcomeUnknown: false, code: "<script>" }))).toBe("registrar_rpc_unreachable");
  });
  it("the kill switch in the registrar project refuses writes (fails closed on an unknown value)", async () => {
    for (const v of ["writes_paused", "nonsense"]) {
      const reg = registrarRpcFromEnv({ ...LIVE, MH_REGISTRAR_KILL_SWITCH: v }, { transport: fakeOpenprovider(), log: () => undefined });
      const port = await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(reg.handler));
      await expect(port!.setLock("moonfern.com", false)).rejects.toMatchObject({ code: "kill_switch" });
    }
  });
});

describe("the registrar project's daily spend cap", () => {
  it("refuses paid operations past the cap and leaves reads alone", async () => {
    let calls = 0;
    const port = { register: async () => { calls++; return { ok: true }; }, getBalance: async () => "balance" } as unknown as RegistrarPort;
    let now = new Date("2026-10-01T10:00:00Z");
    let trips = 0;
    const capped = spendCapped(port, 2, { now: () => now }, () => { trips++; });
    await capped.register({} as never); await capped.register({} as never);
    await expect(capped.register({} as never)).rejects.toMatchObject({ code: "registrar_daily_spend_cap", kind: "rate_limited", outcomeUnknown: false });
    expect(await capped.getBalance()).toBe("balance");
    expect([calls, trips]).toEqual([2, 1]);
    now = new Date("2026-10-02T00:00:01Z");
    await capped.register({} as never);
    expect(calls).toBe(3);
  });
  it("MH_REGISTRAR_DAILY_SPEND_OPS=0 stops every paid operation", async () => {
    const reg = registrarRpcFromEnv({ ...LIVE, MH_REGISTRAR_DAILY_SPEND_OPS: "0" }, { transport: fakeOpenprovider(), log: () => undefined });
    const port = await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(reg.handler));
    await expect(port!.renew("moonfern.com", 1, 2027)).rejects.toMatchObject({ code: "registrar_daily_spend_cap" });
  });
});
