import { describe, expect, it, vi } from "vitest";

const CANARY = "Cnry9QzT7xLm2Kp4Wd8V";
vi.mock("../authcode.ts", () => ({ randomAuthCode: () => "Cnry9QzT7xLm2Kp4Wd8V" }));

import { RegistrarError } from "../port.ts";
import { makeRegisterRequest } from "../contract.ts";
import { MockRegistrarPort } from "../mock-port.ts";
import { OpenSrsAdapter } from "./adapter.ts";
import { FakeHorizonTransport } from "./fake-horizon.ts";
import { MemoryCredentials, MemoryKillSwitch } from "./guards.ts";

/** Everything a failing or succeeding call can leave behind, serialised including non-enumerable error fields. */
const dump = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Error ? { ...x, name: x.name, message: x.message, stack: x.stack, opts: (x as RegistrarError).opts } : typeof x === "bigint" ? x.toString() : x));

/** `skip` names object keys not to descend into (the injected transport is the wire, not the adapter's state). */
function deepHas(root: unknown, needle: string, skip: string[] = [], seen = new Set<unknown>(), depth = 0): boolean {
  if (typeof root === "string") return root.includes(needle);
  if (!root || typeof root !== "object" || seen.has(root) || depth > 8) return false;
  seen.add(root);
  const vals = root instanceof Map ? [...root.values()] : root instanceof Set ? [...root] : Object.entries(root).filter(([k]) => !skip.includes(k)).map(([, v]) => v);
  return vals.some((v) => deepHas(v, needle, skip, seen, depth + 1));
}

describe("ST-22 (port level): a transfer authorization code appears in no log, alert, error or retained state", () => {
  it("Horizon adapter: returned once, absent from logs, alerts, errors on every failure path, and from adapter state", async () => {
    const mock = new MockRegistrarPort();
    const transport = new FakeHorizonTransport(mock, { username: "r", apiKey: "k".repeat(32) });
    const logs: unknown[] = [], alerts: unknown[] = [], errors: unknown[] = [];
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const ks = new MemoryKillSwitch();
    const adapter = new OpenSrsAdapter({ mode: "sandbox", deployment: "staging", credentials: new MemoryCredentials({ username: "r", apiKey: "k".repeat(32) }), transport, killSwitch: ks, clock: mock.clock, log: (e) => logs.push(e), onAlert: (a) => alerts.push(a) });
    const f = "free-canary.com"; await adapter.register(makeRegisterRequest(f));
    const grab = async (p: Promise<unknown>) => { try { return await p; } catch (e) { errors.push(e); return e; } };

    const issued = await adapter.issueAuthCode(f);
    expect(issued.code).toBe(CANARY); // the caller gets it once
    // failure paths after the code was generated
    transport.faults.dropAfterApplyNext = 1;
    const e1 = await grab(adapter.issueAuthCode(f)); // applied upstream, connection lost
    expect(e1).toMatchObject({ kind: "unknown", outcomeUnknown: true });
    transport.faults.dropNext = 1; await grab(adapter.issueAuthCode(f));
    for (let i = 0; i < 6; i++) await grab(adapter.issueAuthCode(f)); // trips the fuse
    ks.set("writes_paused"); await grab(adapter.issueAuthCode(f)); ks.set("open");
    await grab(adapter.issueAuthCode("free-not-ours.com")); // upstream rejects
    await grab(adapter.rerandomizeAuthCode("free-not-ours.com"));
    await adapter.rerandomizeAuthCode(f);

    for (const [name, v] of [["logs", logs], ["alerts", alerts], ["errors", errors]] as const) expect(dump(v), name).not.toContain(CANARY);
    expect(deepHas(adapter, CANARY, ["transport"]), "adapter state").toBe(false);
    expect(consoleSpies.every((s) => s.mock.calls.length === 0)).toBe(true);
    // The wire is the only place it appears: exactly the MODIFY domain_auth_info requests that set it.
    const carrying = transport.requests.filter((x) => JSON.stringify(x.attributes).includes(CANARY));
    expect(carrying.length).toBeGreaterThan(0);
    expect(carrying.every((x) => x.action === "MODIFY" && x.attributes.data === "domain_auth_info")).toBe(true);
    // Nothing is ever read back: no GET for the code exists on the wire.
    expect(transport.requests.some((x) => x.action === "GET" && x.attributes.type === "domain_auth_info")).toBe(false);
    consoleSpies.forEach((s) => s.mockRestore());
  });

  it("MockRegistrarPort: keeps only a hash, and a timeout after applying does not leak the code", async () => {
    const mock = new MockRegistrarPort(); const f = "free-canary2.com";
    await mock.register(makeRegisterRequest(f));
    mock.faults.set("timeoutAfterAccept", { times: 1 });
    const err = await mock.issueAuthCode(f).catch((e) => e);
    expect(err).toBeInstanceOf(RegistrarError); expect(dump(err)).not.toContain(CANARY);
    const { code } = await mock.issueAuthCode(f);
    expect(code).toBe(CANARY);
    expect(mock.authCodeMatches(f, CANARY)).toBe(true);
    expect(deepHas(mock, CANARY)).toBe(false); // stored as a hash only
    expect(dump(mock.domainRecord(f))).not.toContain(CANARY);
    expect(dump(await mock.getDomain(f))).not.toContain(CANARY);
    expect(dump(mock.orders)).not.toContain(CANARY);
  });
});
