import { describe, expect, it, vi } from "vitest";
import { RegistrarError, type RegistrarPort } from "../port.ts";
import { MockRegistrarPort } from "../mock-port.ts";
import { MemoryKillSwitch, type AdapterAlert, type KillSwitch } from "../opensrs/guards.ts";
import { MemoryOpenproviderCredentials, OpenproviderAdapter, type OpenproviderLogEvent } from "./adapter.ts";
import { OPERATIONS, checkOperation } from "./allowlist.ts";
import { dsFromDnskey, dsMatchesKey, keyTag } from "./dnssec.ts";
import { RoutedRegistrar, parseRegistrarRouting, selectRegistrar } from "./select.ts";
import { PRODUCTION_URL, SANDBOX_URL, type OpHttpRequest, type OpHttpTransport } from "./transport.ts";
import { minorFromText, parseAmsterdam, parseJson, parseUtc } from "./wire.ts";

const CANARY = "Cnry9!QzT7x$";
type Step = { status?: number; body: unknown } | Error;
/** Answers requests in order; a login is answered automatically unless `loginAnswers` is given. Records what was sent. */
function scripted(steps: Step[], o: { loginAnswers?: Step[] } = {}): OpHttpTransport & { sent: OpHttpRequest[]; logins: number } {
  const queue = [...steps]; const logins = [...(o.loginAnswers ?? [])];
  const t = {
    sent: [] as OpHttpRequest[], logins: 0,
    async request(r: OpHttpRequest) {
      t.sent.push(r);
      const step = r.url.endsWith("/auth/login") ? (t.logins++, logins.shift() ?? { body: { code: 0, data: { token: `tok-${t.logins}`, reseller_id: 1 } } }) : queue.shift();
      if (!step) throw new Error("script exhausted");
      if (step instanceof Error) throw step;
      return { status: step.status ?? 200, body: typeof step.body === "string" ? step.body : JSON.stringify(step.body) };
    },
  };
  return t;
}
const ok = (data: unknown) => ({ body: { code: 0, desc: "", data } });
const fail = (status: number, code: number, desc = "x") => ({ status, body: { code, desc } });
const listHit = (id = 7, name = "abc", ext = "com", extra: Record<string, unknown> = {}) => ok({ results: [{ id, domain: { name, extension: ext }, status: "ACT", ...extra }], total: 1 });

function rig(steps: Step[], over: { killSwitch?: KillSwitch; mode?: "sandbox" | "live"; deployment?: "staging" | "production"; loginAnswers?: Step[]; now?: () => Date } = {}) {
  const transport = scripted(steps, over.loginAnswers ? { loginAnswers: over.loginAnswers } : {});
  const logs: OpenproviderLogEvent[] = []; const alerts: AdapterAlert[] = [];
  let t = new Date("2026-09-30T12:00:00Z").getTime();
  const clock = { now: over.now ?? (() => new Date(t)) };
  const adapter = new OpenproviderAdapter({ mode: over.mode ?? "sandbox", deployment: over.deployment ?? "staging", transport, killSwitch: over.killSwitch ?? new MemoryKillSwitch(),
    credentials: new MemoryOpenproviderCredentials({ username: "reseller@example.test", password: "pw-not-real" }), clock, log: (e) => logs.push(e), onAlert: (a) => alerts.push(a) });
  return { adapter, transport, logs, alerts, advance: (ms: number) => { t += ms; } };
}
const dump = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Error ? { ...x, name: x.name, message: x.message, stack: x.stack, opts: (x as RegistrarError).opts } : typeof x === "bigint" ? x.toString() : x));

describe("Openprovider allow-list", () => {
  it("refuses operations, keys and shapes the adapter does not need, before anything is sent", () => {
    const refused = (f: () => unknown) => { try { f(); return null; } catch (e) { return (e as RegistrarError).code; } };
    expect(refused(() => checkOperation("GET_AUTHCODE" as never, {}))).toBe("operation_not_allowed");
    expect([...OPERATIONS.values()].some((r) => r.path.endsWith("/authcode") && r.method === "GET")).toBe(false); // never read a stored code back
    expect(refused(() => checkOperation("UPDATE_DOMAIN", { params: { id: 7 }, body: { auth_code: "x" } }))).toBe("body_key_not_allowed");
    expect(refused(() => checkOperation("UPDATE_DOMAIN", { params: { id: 7 }, body: { reset_auth_code: true } }))).toBe("body_key_not_allowed");
    expect(refused(() => checkOperation("UPDATE_DOMAIN", { params: { id: "7/../../resellers" }, body: { is_locked: true } }))).toBe("path_parameter_invalid");
    expect(refused(() => checkOperation("UPDATE_ZONE", { params: { name: "a.com" }, body: { records: { add: [], remove: [] } } }))).toBe("one_record_operation");
    expect(refused(() => checkOperation("UPDATE_ZONE", { params: { name: "a.com" }, body: { records: { replace: [] } } }))).toBe("one_record_operation");
    expect(refused(() => checkOperation("CREATE_DOMAIN", { body: { domain: { name: "a", extension: "com" }, period: 1, unit: "y", owner_handle: "H", admin_handle: "H", tech_handle: "H", billing_handle: "H", autorenew: "on", name_servers: [], comments: "mh:x" } }))).toBe("autorenew_must_be_off");
    expect(refused(() => checkOperation("TRANSFER_DOMAIN", { body: { domain: { name: "a", extension: "com" }, period: 1, unit: "y", auth_code: "", owner_handle: "H", admin_handle: "H", tech_handle: "H", billing_handle: "H", autorenew: "off", comments: "mh:x" } }))).toBe("body_key_missing");
    expect(refused(() => checkOperation("LIST_DOMAINS", { query: { full_name: "a.com", with_api_history: "true" } }))).toBe("query_key_not_allowed");
  });
  it("ST-107: a billed order without an explicit period is refused before sending", () => {
    const base = { domain: { name: "abc", extension: "com" }, unit: "y", owner_handle: "H", admin_handle: "H", tech_handle: "H", billing_handle: "H", autorenew: "off", name_servers: [], comments: "mh:x" };
    for (const period of [undefined, 0, 11, 1.5, "1"]) expect(() => checkOperation("CREATE_DOMAIN", { body: (period === undefined ? { ...base } : { ...base, period: period as never }) as never })).toThrow(RegistrarError);
    expect(() => checkOperation("RENEW_DOMAIN", { params: { id: 7 }, body: {} })).toThrow(/refused/);
    expect(checkOperation("CREATE_DOMAIN", { body: { ...base, period: 1 } }).path).toBe("/domains");
  });
  it("ST-107: the adapter refuses a missing or short term before any request", async () => {
    const r = rig([]);
    await expect(r.adapter.quote("abc.com", undefined as never)).rejects.toMatchObject({ code: "period_required" });
    await expect(r.adapter.quote("abc.ai", 1)).rejects.toMatchObject({ code: "invalid_period" });
    await expect(r.adapter.checkAvailability("abc.xyz")).rejects.toMatchObject({ code: "unsupported_tld" });
    expect(r.transport.sent).toHaveLength(0);
  });
});

describe("Openprovider guards", () => {
  it("refuses live outside production and sandbox inside production; hosts follow the mode", async () => {
    expect(() => rig([], { mode: "live", deployment: "staging" })).toThrow(expect.objectContaining({ code: "live_outside_production" }));
    expect(() => rig([], { mode: "sandbox", deployment: "production" })).toThrow(expect.objectContaining({ code: "sandbox_in_production" }));
    const s = rig([ok({ balance: 1, reserved_balance: 0 })]); await s.adapter.getBalance();
    expect(s.transport.sent.map((x) => x.url)).toEqual([`${SANDBOX_URL}/auth/login`, `${SANDBOX_URL}/resellers`]);
    const l = rig([ok({ balance: 1, reserved_balance: 0 })], { mode: "live", deployment: "production" }); await l.adapter.getBalance();
    expect(l.transport.sent[1]!.url).toBe(`${PRODUCTION_URL}/resellers`);
    expect((await l.adapter.getBalance().catch(() => null))).toBeNull(); // script exhausted: a read transport failure, not a crash
  });
  it("kill switch: writes_paused blocks writes but not reads; all_paused and an unreadable switch block everything", async () => {
    const ks = new MemoryKillSwitch("writes_paused");
    const r = rig([ok({ balance: 5, reserved_balance: 0 }), listHit()], { killSwitch: ks });
    expect((await r.adapter.getBalance()).balance.minor).toBe(500n);
    await expect(r.adapter.setLock("abc.com", false)).rejects.toMatchObject({ code: "kill_switch" }); // the id lookup (a read) passed, the write did not
    expect(r.transport.sent.filter((x) => x.method === "PUT")).toHaveLength(0);
    ks.set("all_paused");
    await expect(r.adapter.getBalance()).rejects.toMatchObject({ code: "kill_switch", retryable: true });
    const bad = rig([], { killSwitch: { read: () => { throw new Error("down"); } } });
    await expect(bad.adapter.getBalance()).rejects.toMatchObject({ code: "kill_switch" });
    expect(r.alerts.filter((a) => a.kind === "kill_switch_closed").length).toBe(2);
  });
  it("the code-issue fuse trips on the sixth code in an hour and says so", async () => {
    const steps: Step[] = [listHit()];
    for (let i = 0; i < 5; i++) steps.push(ok({ auth_code: `code-${i}`, success: true }));
    const r = rig(steps);
    for (let i = 0; i < 5; i++) expect((await r.adapter.issueAuthCode("abc.com")).code).toBe(`code-${i}`);
    await expect(r.adapter.issueAuthCode("abc.com")).rejects.toMatchObject({ kind: "rate_limited", code: "fuse_code_issue", retryable: false });
    expect(r.alerts).toContainEqual({ kind: "fuse_tripped", detail: "code_issue" });
    expect(r.transport.sent.filter((x) => x.url.endsWith("/authcode/reset"))).toHaveLength(5);
  });
  it("no credentials: unavailable before anything is sent", async () => {
    const t = scripted([]);
    const a = new OpenproviderAdapter({ mode: "sandbox", deployment: "local", transport: t, killSwitch: new MemoryKillSwitch(), credentials: new MemoryOpenproviderCredentials({ username: "", password: "" }) });
    await expect(a.getBalance()).rejects.toMatchObject({ kind: "unavailable", code: "no_credentials" });
    expect(t.sent).toHaveLength(0);
  });
});

describe("Openprovider token handling", () => {
  it("logs in once, reuses the token, and logs in again after the TTL", async () => {
    const r = rig([ok({ balance: 1 }), ok({ balance: 1 }), ok({ balance: 1 })]);
    await r.adapter.getBalance(); await r.adapter.getBalance();
    expect(r.transport.logins).toBe(1);
    expect(r.transport.sent[1]!.headers.Authorization).toBe("Bearer tok-1");
    r.advance(13 * 3_600_000);
    await r.adapter.getBalance();
    expect(r.transport.logins).toBe(2);
    const login = JSON.parse(r.transport.sent[0]!.body!); expect(login).toEqual({ username: "reseller@example.test", password: "pw-not-real", ip: "0.0.0.0" });
  });
  it("a 401 (code 196) re-logs in once and retries; a second 401 is auth_failed with an alert", async () => {
    const r = rig([fail(401, 196), ok({ balance: 2 }), fail(401, 196), fail(401, 196)]);
    expect((await r.adapter.getBalance()).balance.minor).toBe(200n);
    expect(r.transport.logins).toBe(2);
    await expect(r.adapter.getBalance()).rejects.toMatchObject({ kind: "rejected", code: "auth_failed" });
    expect(r.alerts).toContainEqual({ kind: "auth_failed", detail: "http_401" });
  });
  it("a failed login is auth_failed and never echoes the password or token", async () => {
    const r = rig([], { loginAnswers: [fail(401, 196, "Authentication/Authorization Failed")] });
    const e = await r.adapter.getBalance().catch((x) => x);
    expect(e).toMatchObject({ code: "auth_failed" });
    expect(dump([e, r.logs, r.alerts])).not.toContain("pw-not-real");
  });
});

describe("Openprovider error mapping", () => {
  const regSteps = (last: Step): Step[] => [
    ok({ price: { reseller: { price: 11.98, currency: "USD" } }, is_premium: false }), ok({ price: { reseller: { price: 16.98, currency: "USD" } }, is_premium: false }),
    ok({ balance: 100, reserved_balance: 0 }), ok({ handle: "TP000001-US" }), last];
  const register = (last: Step) => rig(regSteps(last)).adapter.register({ fqdn: "abc.com", years: 1, regUsername: "mhu1234", regPassword: "x", registrant: { name: "A B", email: "a@example.test", phone: "+1.5555550100", street: "1 St", city: "C", region: "OR", postalCode: "1", country: "US" } });
  it("a gateway timeout or a dropped connection after a write is an unknown outcome: reconcile, never resend", async () => {
    await expect(register({ status: 504, body: "<html>504 Gateway Time-out</html>" })).rejects.toMatchObject({ kind: "unknown", outcomeUnknown: true, retryable: false, code: "http_504" });
    await expect(register(new Error("socket hang up"))).rejects.toMatchObject({ kind: "unknown", outcomeUnknown: true, retryable: false, code: "transport" });
  });
  it("the same failures on a read are retryable and not unknown-outcome", async () => {
    await expect(rig([{ status: 504, body: "x" }]).adapter.getBalance()).rejects.toMatchObject({ kind: "unavailable", retryable: true, outcomeUnknown: false });
    await expect(rig([new Error("reset")]).adapter.getBalance()).rejects.toMatchObject({ kind: "unavailable", retryable: true, outcomeUnknown: false });
  });
  it("provider codes map to typed errors; only the number travels", async () => {
    const e = await register(fail(400, 346, "Reseller cannot add duplicate domain")).catch((x) => x);
    expect(e).toMatchObject({ kind: "rejected", code: "346", outcomeUnknown: false }); expect(e.message).not.toMatch(/duplicate/);
    await expect(register(fail(400, 999, "Insufficient balance on your account"))).rejects.toMatchObject({ kind: "insufficient_funds" });
    await expect(register({ status: 429, body: { code: 1, desc: "slow down" } })).rejects.toMatchObject({ kind: "rate_limited", retryable: true });
    await expect(register({ body: { code: 0, maintenance: true, data: {} } })).rejects.toMatchObject({ kind: "maintenance", retryable: true });
  });
  it("REQ after create is accepted_pending, never registered", async () => {
    expect(await register(ok({ id: 9, status: "REQ" }))).toEqual({ status: "accepted_pending", registrarOrderId: "9", reason: "async" });
  });
  it("a debit that differs from the quote pauses the extension and alerts", async () => {
    const r = rig([...regSteps(ok({ id: 9, status: "ACT", expiration_date: "2027-09-30 12:00:00" })), ok({ balance: 50, reserved_balance: 0 }), listHit(9)]);
    await r.adapter.register({ fqdn: "abc.com", years: 1, regUsername: "mhu1234", regPassword: "x", registrant: { name: "A B", email: "a@example.test", phone: "+1.5555550100", street: "1 St", city: "C", region: "OR", postalCode: "1", country: "US" } }).catch(() => undefined);
    expect(r.adapter.isExtensionPaused("com")).toBe(true);
    expect(r.alerts).toContainEqual({ kind: "debit_mismatch", detail: ".com" });
  });
});

describe("ST-22 (Openprovider): an authorization code appears in no log, alert, error or retained state", () => {
  it("returned once from the reset reply; stripped from domain reads; absent from logs, alerts, errors and the adapter", async () => {
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const domain = { id: 7, domain: { name: "abc", extension: "com" }, status: "ACT", auth_code: CANARY, internal_auth_code: CANARY, owner_handle: "", name_servers: [] };
    const r = rig([
      ok({ results: [domain], total: 1 }),                       // resolve id (list carries auth_code too: observed)
      ok({ auth_code: CANARY, success: true, type: "external" }), // reset
      ok(domain),                                                 // getDomain detail
      ok({ auth_code: CANARY }), fail(400, 366),                  // a failing reset with the code in an earlier reply
      { status: 504, body: JSON.stringify({ code: 0, data: { auth_code: CANARY } }) },
    ]);
    const issued = await r.adapter.issueAuthCode("abc.com");
    expect(issued.code).toBe(CANARY);
    await r.adapter.getDomain("abc.com");
    const errors: unknown[] = [];
    for (let i = 0; i < 3; i++) await r.adapter.issueAuthCode("abc.com").catch((e) => errors.push(e));
    const everything = dump({ logs: r.logs, alerts: r.alerts, errors, calls: consoleSpies.map((s) => s.mock.calls) });
    expect(everything).not.toContain(CANARY);
    const state = dump(Object.fromEntries(Object.entries(r.adapter).filter(([k]) => k !== "cfg")));
    expect(state).not.toContain(CANARY);
    for (const s of consoleSpies) s.mockRestore();
  });
});

describe("Openprovider wire", () => {
  it("money from JSON number text without floating point", () => {
    expect(parseJson('{"a":99884.06}')).toMatchObject({ a: { text: "99884.06" } });
    expect(minorFromText("11.98")).toBe(1198n); expect(minorFromText("218")).toBe(21800n); expect(minorFromText("23.9")).toBe(2390n); expect(minorFromText("-3.5")).toBe(-350n);
    expect(() => minorFromText("1e3")).toThrow(); expect(() => minorFromText("1.005")).toThrow();
  });
  it("dates: registry dates are UTC, order dates Europe/Amsterdam (observed two hours apart in CEST)", () => {
    expect(parseUtc("2027-09-30 21:16:55")!.toISOString()).toBe("2027-09-30T21:16:55.000Z");
    expect(parseAmsterdam("2026-09-30 23:16:54")!.toISOString()).toBe("2026-09-30T21:16:54.000Z");
    expect(parseAmsterdam("2026-12-01 12:00:00")!.toISOString()).toBe("2026-12-01T11:00:00.000Z");
    expect(parseUtc("0000-00-00 00:00:00")).toBeUndefined();
  });
  it("DS from DNSKEY matches the RFC 4509 and RFC 6605 examples", () => {
    const k5 = { flags: 256, protocol: 3, algorithm: 5, publicKey: "AQOeiiR0GOMYkDshWoSKz9XzfwJr1AYtsmx3TGkJaNXVbfi/2pHm822aJ5iI9BMzNXxeYCmZDRD99WYwYqUSdjMmmAphXdvxegXd/M5+X7OrzKBaMbCVdFLUUh6DhweJBjEVv5f2wwjM9XzcnOf+EPbtG9DMBmADjFDc2w/rljwvFw==" };
    expect(dsFromDnskey("dskey.example.com", k5)).toEqual({ keyTag: 60485, algorithm: 5, digestType: 2, digest: "d4b7d520e7bb5f0f67674a0cceb1e3e0614b93c4f9e99b8383f6a1e4469da50a" });
    expect(dsFromDnskey("dskey.example.com", k5, 1).digest).toBe("2bb183af5f22588179a53b0a98631fad1a292118");
    const k13 = { flags: 257, protocol: 3, algorithm: 13, publicKey: "GojIhhXUN/u4v54ZQqGSnyhWJwaubCvTmeexv7bR6edbkrSqQpF64cYbcB7wNcP+e+MAnLr+Wi9xMWyQLc8NAA==" };
    expect(keyTag(k13)).toBe(55648);
    expect(dsFromDnskey("example.net", k13).digest).toBe("b4c8c1fe2e7477127b27115656ad6256f424625bf5c1e2770ce6d6e37df61d17");
    expect(dsMatchesKey("EXAMPLE.net.", { keyTag: 55648, algorithm: 13, digestType: 2, digest: "B4C8C1FE2E7477127B27115656AD6256F424625BF5C1E2770CE6D6E37DF61D17" }, k13)).toBe(true);
  });
});

describe("Openprovider DNS writes", () => {
  it("removes in one request and adds in another (never both), sending the stored form, then reads back", async () => {
    const zone = "abc.com";
    const dom = ok({ id: 7, domain: { name: "abc", extension: "com" }, status: "ACT", name_servers: [{ name: "ns1.openprovider.nl" }, { name: "ns2.openprovider.be" }, { name: "ns3.openprovider.eu" }] });
    const recs = (list: unknown[]) => ok({ results: list, total: list.length });
    const soa = { name: zone, type: "SOA", value: "ns1.openprovider.nl dns@openprovider.eu 1 2 3 4 5", ttl: 86400 };
    const before = [soa, { name: zone, type: "TXT", value: '"v=spf1 -all"', ttl: 900 }, { name: zone, type: "MX", value: "mail.example.net", prio: 10, ttl: 900 }, { name: `www.${zone}`, type: "A", value: "192.0.2.2", ttl: 900 }];
    const after = [soa, { name: zone, type: "TXT", value: '"v=spf1 -all"', ttl: 900 }, { name: zone, type: "A", value: "192.0.2.9", ttl: 900 }];
    const r = rig([listHit(7), dom, recs(before), ok({ success: true }), ok({ success: true }), dom, recs(after)]);
    const out = await r.adapter.replaceZone(zone, [{ type: "TXT", name: "", value: "v=spf1 -all" }, { type: "A", name: "", value: "192.0.2.9" }]);
    expect(out.records).toEqual([{ type: "A", name: "", value: "192.0.2.9" }, { type: "TXT", name: "", value: "v=spf1 -all" }]);
    const puts = r.transport.sent.filter((x) => x.method === "PUT").map((x) => JSON.parse(x.body!).records);
    expect(puts).toEqual([
      { remove: [{ name: "", type: "MX", value: "mail.example.net", ttl: 900, prio: 10 }, { name: "www", type: "A", value: "192.0.2.2", ttl: 900 }] },
      { add: [{ name: "", type: "A", value: "192.0.2.9", ttl: 900 }] },
    ]);
  });
  it("a write the provider accepted but did not apply is caught by the read-back", async () => {
    const dom = ok({ id: 7, domain: { name: "abc", extension: "com" }, status: "ACT", name_servers: [{ name: "ns1.openprovider.nl" }] });
    const r = rig([listHit(7), dom, ok({ results: [], total: 0 }), ok({ success: true }), dom, ok({ results: [], total: 0 })]);
    await expect(r.adapter.replaceZone("abc.com", [{ type: "A", name: "", value: "192.0.2.1" }])).rejects.toMatchObject({ code: "dns_readback_mismatch" });
  });
});

describe("registrar selection (MH_REGISTRAR_PROVIDER)", () => {
  it("parses whole and per-extension routing and refuses mixing the mock with real providers", () => {
    expect(parseRegistrarRouting({})).toEqual({ defaultProvider: "mock", byTld: {} });
    expect(parseRegistrarRouting({ MH_REGISTRAR_MODE: "sandbox" })).toEqual({ defaultProvider: "opensrs", byTld: {} });
    expect(parseRegistrarRouting({ MH_REGISTRAR_MODE: "sandbox", MH_REGISTRAR_PROVIDER: "openprovider" })).toEqual({ defaultProvider: "openprovider", byTld: {} });
    expect(parseRegistrarRouting({ MH_REGISTRAR_MODE: "live", MH_REGISTRAR_PROVIDER: "opensrs", MH_REGISTRAR_PROVIDER_BY_TLD: "com=openprovider, .dev=openprovider" })).toEqual({ defaultProvider: "opensrs", byTld: { com: "openprovider", dev: "openprovider" } });
    for (const env of [{ MH_REGISTRAR_PROVIDER: "godaddy" }, { MH_REGISTRAR_MODE: "sandbox", MH_REGISTRAR_PROVIDER: "mock" }, { MH_REGISTRAR_PROVIDER: "openprovider" }, { MH_REGISTRAR_MODE: "sandbox", MH_REGISTRAR_PROVIDER_BY_TLD: "com=openprovider,com=opensrs" }, { MH_REGISTRAR_MODE: "sandbox", MH_REGISTRAR_PROVIDER_BY_TLD: "com" }])
      expect(() => parseRegistrarRouting(env)).toThrow(expect.objectContaining({ code: "registrar_provider_invalid" }));
  });
  it("selects one adapter, or routes by extension", async () => {
    const a = new MockRegistrarPort(), b = new MockRegistrarPort();
    expect(selectRegistrar({}, { mock: () => a })).toBe(a);
    const routed = selectRegistrar({ MH_REGISTRAR_MODE: "sandbox", MH_REGISTRAR_PROVIDER: "opensrs", MH_REGISTRAR_PROVIDER_BY_TLD: "com=openprovider" }, { opensrs: () => a as RegistrarPort, openprovider: () => b as RegistrarPort }) as RoutedRegistrar;
    expect(routed).toBeInstanceOf(RoutedRegistrar);
    expect(routed.providerFor("x.com")).toBe("openprovider"); expect(routed.providerFor("x.io")).toBe("opensrs");
    await routed.checkAvailability("moonfern.com");
    expect(b.calls.checkAvailability).toBe(1); expect(a.calls.checkAvailability).toBe(0);
    expect(() => selectRegistrar({ MH_REGISTRAR_MODE: "sandbox", MH_REGISTRAR_PROVIDER: "openprovider" }, { opensrs: () => a })).toThrow(RegistrarError);
  });
});
