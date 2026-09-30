import { describe, expect, it } from "vitest";
import { RegistrarError, type RegistrarPort } from "../port.ts";
import { MockRegistrarPort } from "../mock-port.ts";
import { makeRegisterRequest } from "../contract.ts";
import { ALLOWED_COMMANDS, checkCommand } from "./allowlist.ts";
import { HORIZON_URL, LIVE_URL, OpenSrsAdapter, parseMinor, type HttpTransport } from "./adapter.ts";
import { FakeHorizonTransport, opsReply } from "./fake-horizon.ts";
import { DOCUMENTED_FIXTURES } from "./fixtures.ts";
import { MemoryCredentials, MemoryKillSwitch, type AdapterAlert, type KillSwitch } from "./guards.ts";
import { opsSignature } from "./sign.ts";
import { decodeOps, encodeOps } from "./xml.ts";

const KEY = "k".repeat(32);
let n = 0;
function rig(over: { killSwitch?: KillSwitch; mode?: "sandbox" | "live"; deployment?: "staging" | "production" } = {}) {
  const mock = new MockRegistrarPort();
  const transport = new FakeHorizonTransport(mock, { username: "reseller1", apiKey: KEY });
  const creds = new MemoryCredentials({ username: "reseller1", apiKey: KEY });
  const ks = new MemoryKillSwitch();
  const alerts: AdapterAlert[] = []; const logs: unknown[] = [];
  const adapter = new OpenSrsAdapter({ mode: over.mode ?? "sandbox", deployment: over.deployment ?? "staging", credentials: creds, transport, killSwitch: over.killSwitch ?? ks, clock: mock.clock, onAlert: (a) => alerts.push(a), log: (e) => logs.push(e) });
  return { mock, transport, creds, ks, alerts, logs, adapter, fresh: (tld = "com") => `free-${++n}.${tld}` };
}
const scripted = (responses: (string | { status: number; body: string } | Error)[]): HttpTransport & { sent: number } => {
  const t = { sent: 0, async post() { const r = responses[Math.min(t.sent++, responses.length - 1)]!; if (r instanceof Error) throw r; return typeof r === "string" ? { status: 200, body: r } : r; } };
  return t;
};
const bare = (t: HttpTransport) => new OpenSrsAdapter({ mode: "sandbox", deployment: "staging", credentials: new MemoryCredentials({ username: "u", apiKey: KEY }), transport: t, killSwitch: new MemoryKillSwitch() });

describe("OPS codec and signature", () => {
  it("round-trips nested values with escaping and empty arrays", () => {
    const attrs = { domain: "a.com", records: { A: [{ subdomain: "www", ip_address: "1.2.3.4" }], MX: [] }, text: 'a<b>&"c\'', n: 2, f: true };
    const back = decodeOps(encodeOps("SET_DNS_ZONE", "DOMAIN", attrs));
    expect(back).toMatchObject({ protocol: "XCP", action: "SET_DNS_ZONE", object: "DOMAIN" });
    expect(back.attributes).toEqual({ domain: "a.com", records: { A: [{ subdomain: "www", ip_address: "1.2.3.4" }], MX: [] }, text: 'a<b>&"c\'', n: "2", f: "1" });
  });
  it("refuses entity declarations and control characters", () => {
    expect(() => decodeOps(`<!DOCTYPE x [<!ENTITY a "b">]><dt_assoc/>`)).toThrow();
    expect(() => encodeOps("LOOKUP", "DOMAIN", { domain: "a\u0001.com" })).toThrow();
  });
  it("X-Signature is md5(md5(xml + key) + key) (known-answer vector)", () => {
    expect(opsSignature("<x/>", "key")).toBe("5253b622e134b5ef112e49d8ae7f36b0");
  });
  it("parses money without floating point", () => {
    expect(parseMinor("14.50")).toBe(1450n); expect(parseMinor("111")).toBe(11100n); expect(parseMinor("0.5")).toBe(50n);
    expect(() => parseMinor("14.505")).toThrow(); expect(() => parseMinor("1e3")).toThrow(); expect(() => parseMinor("-1")).toThrow();
  });
  it("sends the documented headers to the Horizon host in sandbox and the live host only in production live mode", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const t: HttpTransport = { async post(r) { seen.push({ url: r.url, headers: r.headers }); return { status: 200, body: opsReply(210, { status: "available" }) }; } };
    await bare(t).checkAvailability("abc.com", { noCache: true });
    expect(seen[0]!.url).toBe(HORIZON_URL);
    expect(seen[0]!.headers).toMatchObject({ "Content-Type": "text/xml", "X-Username": "u" });
    expect(seen[0]!.headers["X-Signature"]).toMatch(/^[0-9a-f]{32}$/);
    const live = new OpenSrsAdapter({ mode: "live", deployment: "production", credentials: new MemoryCredentials({ username: "u", apiKey: KEY }), transport: t, killSwitch: new MemoryKillSwitch() });
    await live.checkAvailability("abc.com");
    expect(seen[1]!.url).toBe(LIVE_URL);
  });
});

describe("response handling against documented fixtures (source: documented, never recorded)", () => {
  it("labels every fixture documented", () => { expect(DOCUMENTED_FIXTURES.every((f) => f.source === "documented")).toBe(true); });
  it("maps the documented codes to typed errors", async () => {
    const reg = () => bare(scripted([opsReply(200, { price: "14.50", is_registry_premium: "0" }), opsReply(200, { price: "14.50" }), opsReply(200, { balance: "100.00", hold_balance: "0.00" }), DOCUMENTED_FIXTURES.find((f) => f.name.startsWith("insufficient"))!.xml])).register(makeRegisterRequest("abc.com"));
    await expect(reg()).rejects.toMatchObject({ kind: "insufficient_funds", code: "440" });
    const w = (code: number) => bare(scripted([opsReply(200, { price: "14.50" }), opsReply(200, { price: "14.50" }), opsReply(200, { balance: "100.00", hold_balance: "0.00" }), opsReply(code, {})])).register(makeRegisterRequest("abc.com"));
    await expect(w(486)).rejects.toMatchObject({ kind: "unknown", outcomeUnknown: true, retryable: false });
    await expect(w(705)).rejects.toMatchObject({ kind: "unknown", outcomeUnknown: true });
    await expect(w(300)).rejects.toMatchObject({ kind: "rate_limited", retryable: true, outcomeUnknown: false });
    await expect(w(485)).rejects.toMatchObject({ kind: "rejected", code: "485" });
    await expect(w(702)).rejects.toMatchObject({ kind: "unavailable", retryable: true });
  });
  it("forced_pending and 250 are accepted_pending, never registered", async () => {
    const t = (fx: string) => bare(scripted([opsReply(200, { price: "14.50" }), opsReply(200, { price: "14.50" }), opsReply(200, { balance: "100.00", hold_balance: "0.00" }), fx]));
    expect(await t(DOCUMENTED_FIXTURES[2]!.xml).register(makeRegisterRequest("abc.com"))).toMatchObject({ status: "accepted_pending", reason: "forced_pending" });
    expect(await t(DOCUMENTED_FIXTURES[3]!.xml).register(makeRegisterRequest("abc.com"))).toMatchObject({ status: "accepted_pending", reason: "async" });
  });
  it("lookup: 211 and 221 read as taken, 210 available; a transport failure on a read is retryable, on a write it is an unknown outcome", async () => {
    expect((await bare(scripted([DOCUMENTED_FIXTURES[0]!.xml])).checkAvailability("abc.com")).kind).toBe("taken");
    expect((await bare(scripted([DOCUMENTED_FIXTURES[1]!.xml])).checkAvailability("abc.com")).kind).toBe("available");
    await expect(bare(scripted([new Error("reset")])).checkAvailability("abc.com")).rejects.toMatchObject({ kind: "unavailable", retryable: true, outcomeUnknown: false });
    await expect(bare(scripted([new Error("reset")])).setLock("abc.com", true)).rejects.toMatchObject({ kind: "unknown", retryable: false, outcomeUnknown: true });
    await expect(bare(scripted([{ status: 503, body: "" }])).setLock("abc.com", true)).rejects.toMatchObject({ outcomeUnknown: true });
    await expect(bare(scripted(["not xml"])).checkAvailability("abc.com")).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("ST-107: every generated request carries explicit parameters", () => {
  it("SW_REGISTER, RENEW and GET_PRICE always send period; register and renew send handle=process; new orders send reg_type, lock, auto_renew=0 and a profile", async () => {
    const r = rig(); const f = r.fresh();
    await r.adapter.register(makeRegisterRequest(f, 1));
    const y = (await r.adapter.getDomain(f))!.expiresAt!.getUTCFullYear();
    await r.adapter.renew(f, 1, y);
    const ai = r.fresh("ai"); await r.adapter.register(makeRegisterRequest(ai, 2));
    for (const q of r.transport.requests.filter((x) => ["SW_REGISTER", "RENEW", "GET_PRICE"].includes(x.action))) {
      expect(Number(q.attributes.period), q.action).toBeGreaterThanOrEqual(1);
    }
    const regs = r.transport.requests.filter((x) => x.action === "SW_REGISTER");
    expect(regs).toHaveLength(2);
    for (const q of regs) expect(q.attributes).toMatchObject({ reg_type: "new", handle: "process", auto_renew: "0", f_lock_domain: "1" });
    expect(regs[0]!.attributes.period).toBe("1"); expect(regs[1]!.attributes.period).toBe("2");
    expect(String(regs[0]!.attributes.reg_username).length).toBeGreaterThanOrEqual(3);
    expect(r.transport.requests.find((x) => x.action === "RENEW")!.attributes).toMatchObject({ handle: "process", period: "1" });
    expect(r.transport.requests.every((x) => x.signatureOk)).toBe(true);
  });

  it("the adapter refuses to build a billed order without period (never reaches the wire), and the defaultPeriod2 fault fails a raw call that omits it", async () => {
    const r = rig(); const before = r.transport.requests.length;
    const call = (r.adapter as unknown as { call(a: string, o: string, at: object): Promise<unknown> }).call.bind(r.adapter);
    await expect(call("SW_REGISTER", "DOMAIN", { domain: "a-b.com", reg_type: "new", handle: "process", auto_renew: 0, f_lock_domain: 1, reg_username: "abc", reg_password: "x".repeat(12), contact_set: {} })).rejects.toMatchObject({ code: "attribute_missing" });
    await expect(call("RENEW", "DOMAIN", { domain: "a-b.com", currentexpirationyear: 2027, handle: "process", period: 0 })).rejects.toMatchObject({ code: "period_missing_or_invalid" });
    await expect(call("SW_REGISTER", "DOMAIN", { domain: "a-b.com", reg_type: "new", handle: "save", period: 1, auto_renew: 0, f_lock_domain: 1, reg_username: "abc", reg_password: "x".repeat(12), contact_set: {} })).rejects.toMatchObject({ code: "attribute_value_not_allowed" });
    expect(r.transport.requests.length).toBe(before);
    // Raw wire: an omitted period. Real OpenSRS would default to 2 and bill two years; the harness fault turns it into a failure.
    const raw = async (fault: "defaultPeriod2" | "silentDefault2") => {
      const rr = rig(); rr.transport.faults[fault] = true;
      const fq = rr.fresh();
      const xml = encodeOps("SW_REGISTER", "DOMAIN", { domain: fq, reg_type: "new", handle: "process", auto_renew: 0, f_lock_domain: 1, reg_username: "rawuser1", reg_password: "x".repeat(12), contact_set: { owner: { first_name: "A", last_name: "B", email: "a@b.test" } } });
      const res = await rr.transport.post({ url: HORIZON_URL, timeoutMs: 1, body: xml, headers: { "X-Username": "reseller1", "X-Signature": opsSignature(xml, KEY) } });
      return { rr, fq, code: decodeOps(res.body).response_code };
    };
    const strict = await raw("defaultPeriod2");
    expect(strict.code).toBe("465"); expect(await strict.rr.mock.getDomain(strict.fq)).toBeNull(); expect(strict.rr.mock.debits).toHaveLength(0);
    const silent = await raw("silentDefault2");
    expect(silent.code).toBe("200"); // the documented hazard: accepted, and billed for two years
    expect((await silent.rr.mock.getDomain(silent.fq))!.expiresAt!.getUTCFullYear()).toBe(silent.rr.mock.clock.now().getUTCFullYear() + 2);
  });

  it("a debit that differs from the quote pauses sales of that extension and alerts; an exact debit does not", async () => {
    const r = rig();
    await r.adapter.register(makeRegisterRequest(r.fresh("com"), 1));
    expect(r.adapter.isExtensionPaused("com")).toBe(false); expect(r.alerts).toEqual([]);
    r.transport.faults.overbillMinor = 1525n;
    await r.adapter.register(makeRegisterRequest(r.fresh("com"), 1)); // registered, but billed one year too many
    expect(r.adapter.isExtensionPaused("com")).toBe(true);
    expect(r.alerts).toEqual([{ kind: "debit_mismatch", detail: ".com" }]);
    const before = r.transport.requests.length;
    await expect(r.adapter.register(makeRegisterRequest(r.fresh("com"), 1))).rejects.toMatchObject({ code: "sales_paused" });
    expect(r.transport.requests.length).toBe(before); // nothing sent for a paused extension
    r.transport.faults.overbillMinor = 0n;
    await r.adapter.register(makeRegisterRequest(r.fresh("dev"), 1)); // other extensions keep selling
    expect(r.adapter.isExtensionPaused("dev")).toBe(false);
    r.adapter.resumeExtension("com");
    await r.adapter.register(makeRegisterRequest(r.fresh("com"), 1));
  });

  it("refuses a premium quote before registering (D-031)", async () => {
    const r = rig(); const f = "premium-abc.com";
    expect((await r.adapter.quote(f, 1)).isRegistryPremium).toBe(true);
    await expect(r.adapter.register(makeRegisterRequest(f))).rejects.toMatchObject({ code: "premium_refused" });
    expect(r.transport.requests.some((x) => x.action === "SW_REGISTER")).toBe(false);
  });
});

describe("ST-115: velocity fuse and command allow-list", () => {
  it("the sixth authorization code issue in an hour is refused, alerts, and sends nothing; the window then slides", async () => {
    const r = rig();
    const doms: string[] = [];
    for (let i = 0; i < 6; i++) { const f = r.fresh(); await r.adapter.register(makeRegisterRequest(f)); doms.push(f); }
    for (let i = 0; i < 5; i++) await r.adapter.issueAuthCode(doms[i]!); // across different customers' domains: one global budget
    const sent = r.transport.requests.length;
    const e = await r.adapter.issueAuthCode(doms[5]!).catch((x) => x);
    expect(e).toBeInstanceOf(RegistrarError);
    expect(e).toMatchObject({ kind: "rate_limited", code: "fuse_code_issue", retryable: false });
    expect(r.alerts).toContainEqual({ kind: "fuse_tripped", detail: "code_issue" });
    expect(r.transport.requests.length).toBe(sent);
    r.mock.advance(30 * 60_000);
    await expect(r.adapter.issueAuthCode(doms[5]!)).rejects.toMatchObject({ code: "fuse_code_issue" });
    r.mock.advance(31 * 60_000);
    expect((await r.adapter.issueAuthCode(doms[5]!)).code).toHaveLength(20);
  });

  it("re-randomising and re-locking are never fused (an attacker must not be able to block the defensive move)", async () => {
    const r = rig(); const f = r.fresh(); await r.adapter.register(makeRegisterRequest(f));
    for (let i = 0; i < 5; i++) await r.adapter.issueAuthCode(f);
    await expect(r.adapter.issueAuthCode(f)).rejects.toMatchObject({ code: "fuse_code_issue" });
    await r.adapter.rerandomizeAuthCode(f); await r.adapter.setLock(f, true);
    await expect(r.adapter.stopTransferAway(f)).resolves.toMatchObject({ relocked: true });
  });

  it("unlock 10, nameserver change 20 and contact change 10 an hour", async () => {
    const r = rig(); const f = r.fresh(); const req = makeRegisterRequest(f); await r.adapter.register(req);
    for (let i = 0; i < 10; i++) await r.adapter.setLock(f, false);
    await expect(r.adapter.setLock(f, false)).rejects.toMatchObject({ code: "fuse_unlock" });
    for (let i = 0; i < 20; i++) await r.adapter.setNameservers(f, [`ns1.d${i}.net`, `ns2.d${i}.net`]);
    await expect(r.adapter.setNameservers(f, ["ns1.z.net", "ns2.z.net"])).rejects.toMatchObject({ code: "fuse_ns_change" });
    for (let i = 0; i < 10; i++) await r.adapter.updateContact(f, { ...req.registrant, phone: `+1.555555010${i}` });
    await expect(r.adapter.updateContact(f, req.registrant)).rejects.toMatchObject({ code: "fuse_contact_change" });
    expect(r.alerts.map((a) => a.detail).sort()).toEqual(["contact_change", "ns_change", "unlock"]);
  });

  it("a command outside the allow-list is rejected before it is built, signed or sent", async () => {
    const r = rig(); const before = r.transport.requests.length;
    const call = (r.adapter as unknown as { call(a: string, o: string, at: object): Promise<unknown> }).call.bind(r.adapter);
    for (const [a, o, at] of [
      ["SEND_AUTHCODE", "DOMAIN", { domain: "a-b.com" }], ["DELETE", "DOMAIN", { domain: "a-b.com" }], ["SW_REGISTER", "DOMAIN_TRANSFER", {}], ["REVOKE", "DOMAIN", { domain: "a-b.com" }],
      ["SUBMIT", "BULK_CHANGE", {}], ["CANCEL_PENDING_ORDERS", "ORDER", { to_date: "2027-01-01" }], ["FORCE_DNS_NAMESERVERS", "DOMAIN", { domain: "a-b.com" }],
    ] as [string, string, object][]) await expect(call(a, o, at), a).rejects.toMatchObject({ kind: "rejected", code: "command_not_allowed" });
    // Allowed command, forbidden argument: the code is never read back, and a transfer-in cannot ride SW_REGISTER.
    await expect(call("GET", "DOMAIN", { domain: "a-b.com", type: "domain_auth_info" })).rejects.toMatchObject({ code: "attribute_value_not_allowed" });
    await expect(call("MODIFY", "DOMAIN", { domain: "a-b.com", data: "whois_privacy_state" })).rejects.toMatchObject({ code: "attribute_value_not_allowed" });
    await expect(call("SW_REGISTER", "DOMAIN", { domain: "a-b.com", reg_type: "transfer", period: 1, handle: "process", auto_renew: 0, f_lock_domain: 1, reg_username: "abc", reg_password: "x".repeat(12), contact_set: {}, auth_info: "x" })).rejects.toMatchObject({ code: "attribute_not_allowed" });
    await expect(call("LOOKUP", "DOMAIN", { domain: "A B.com" })).rejects.toMatchObject({ code: "domain_invalid" });
    expect(r.transport.requests.length).toBe(before);
    expect(ALLOWED_COMMANDS.has("SEND_AUTHCODE:DOMAIN")).toBe(false);
    expect(() => checkCommand("GET", "DOMAIN", { domain: "a-b.com", type: "all_info" })).not.toThrow();
  });

  it("every command is marked with how well the dossier supports it", () => {
    const unverified = [...ALLOWED_COMMANDS.values()].filter((c) => c.verified === "unverified").map((c) => c.action);
    expect(unverified).toEqual(["GET_DNSSEC_INFO"]);
  });
});

describe("ST-116: OpenSRS key rotation drill and kill switch, against the fake Horizon transport", () => {
  it("pause, generate a new key, update, smoke GET_BALANCE, lift", async () => {
    const r = rig();
    const f = r.fresh(); await r.adapter.register(makeRegisterRequest(f)); // normal operation
    // 1. pause writes
    r.ks.set("writes_paused");
    const writes = () => r.transport.requests.filter((x) => ["SW_REGISTER", "RENEW", "MODIFY"].includes(x.action)).length;
    const w0 = writes();
    await expect(r.adapter.register(makeRegisterRequest(r.fresh()))).rejects.toMatchObject({ kind: "unavailable", code: "kill_switch" });
    await expect(r.adapter.setLock(f, false)).rejects.toMatchObject({ code: "kill_switch" });
    expect(writes()).toBe(w0);
    expect(r.alerts).toContainEqual({ kind: "kill_switch_closed", detail: "write" });
    await r.adapter.getBalance(); // reads continue while writes are paused
    // 2. generate a new key at the provider: the previous key stops working at once (K1)
    const NEW_KEY = "n".repeat(32);
    r.transport.rotateKey(NEW_KEY);
    await expect(r.adapter.getBalance()).rejects.toMatchObject({ kind: "rejected", code: "401" });
    expect(r.alerts).toContainEqual({ kind: "auth_failed", detail: "http_401" });
    expect(r.transport.requests.at(-1)!.signatureOk).toBe(false);
    // 3. update the credential source (redeploy), 4. smoke GET_BALANCE with the new key while still paused
    r.creds.set({ username: "reseller1", apiKey: NEW_KEY });
    const bal = await r.adapter.getBalance();
    expect(bal.balance.minor).toBeGreaterThan(0n);
    expect(r.transport.requests.at(-1)).toMatchObject({ action: "GET_BALANCE", signatureOk: true });
    await expect(r.adapter.setLock(f, false)).rejects.toMatchObject({ code: "kill_switch" }); // still paused until the smoke result is accepted
    // 5. lift
    r.ks.set("open");
    await r.adapter.setLock(f, false);
    expect((await r.adapter.getDomain(f))!.locked).toBe(false);
    expect(await r.adapter.health()).toEqual({ status: "ok" });
  });

  it("the kill switch fails closed: an unreadable, throwing or unrecognised switch pauses reads and writes and sends nothing", async () => {
    for (const bad of [
      { read: () => { throw new Error("switch store down"); } },
      { read: async () => { throw new Error("timeout"); } },
      { read: () => "yes" as never },
      { read: () => undefined as never },
      { read: () => null as never },
      { read: () => "all_paused" as const },
    ] as KillSwitch[]) {
      const r = rig({ killSwitch: bad });
      await expect(r.adapter.getBalance()).rejects.toMatchObject({ code: "kill_switch" });
      await expect(r.adapter.checkAvailability("abc.com")).rejects.toMatchObject({ code: "kill_switch" });
      await expect(r.adapter.register(makeRegisterRequest(r.fresh()))).rejects.toMatchObject({ code: "kill_switch" });
      expect(r.transport.requests).toHaveLength(0);
      expect(await r.adapter.health()).toEqual({ status: "degraded" });
    }
  });

  it("missing credentials fail closed too", async () => {
    const r = rig(); r.creds.set({ username: "reseller1", apiKey: "" });
    await expect(r.adapter.getBalance()).rejects.toMatchObject({ code: "no_credentials" });
    expect(r.transport.requests).toHaveLength(0);
  });

  it("the live adapter cannot be built outside production, and sandbox never reaches the live host", async () => {
    expect(() => rig({ mode: "live", deployment: "staging" })).toThrow(RegistrarError);
    const r = rig(); await r.adapter.getBalance();
    expect(r.transport.urls.every((u) => u === HORIZON_URL)).toBe(true);
  });
});

describe("adapter reads and logs carry no domain names or attribute values", () => {
  it("logs hold action, object and codes only", async () => {
    const r = rig(); const f = r.fresh(); await r.adapter.register(makeRegisterRequest(f)); await r.adapter.issueAuthCode(f);
    const text = JSON.stringify(r.logs);
    expect(text).not.toContain(f);
    for (const e of r.logs as Record<string, unknown>[]) expect(Object.keys(e).sort().every((k) => ["event", "action", "object", "write", "httpStatus", "responseCode", "outcome"].includes(k))).toBe(true);
  });
  it("satisfies RegistrarPort", () => { const p: RegistrarPort = rig().adapter; expect(p.capabilities().mode).toBe("sandbox"); });
});
