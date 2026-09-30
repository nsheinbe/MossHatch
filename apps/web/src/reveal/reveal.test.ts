import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { SecretValue } from "./secretValue";
import { fetchReveal, RevealError, revealText } from "./fetchReveal";
import { canExtend, extend, firstWindow, REHIDE_CAP_SECONDS, runCommand, startRehide, tick, valueCopyAllowed } from "./rehide";

const CANARY = "mh_test_canary_7Qx2Lr9Vb4";
const SID = "0190f0f0-0000-7000-8000-000000000001";

const src = path.resolve(__dirname, "..");
function files(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".test.ts") ? [path.join(d, e.name)] : []);
}
const all = files(src);
const read = (f: string) => fs.readFileSync(f, "utf8");
const rel = (f: string) => path.relative(src, f).split(path.sep).join("/");

const res = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });
const fake = (r: Response | Error) => vi.fn(async () => { if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch;

afterEach(() => vi.restoreAllMocks());

describe("SecretValue (store contract layer 2, ST-37)", () => {
  it("prints, serialises and inspects as [secret]; only expose() reads it; drop() forgets it", () => {
    const v = new SecretValue(CANARY);
    expect(String(v)).toBe("[secret]");
    expect(`${v}`).toBe("[secret]");
    expect(JSON.stringify({ v })).toBe('{"v":"[secret]"}');
    expect(inspect(v)).not.toContain(CANARY);
    expect(Object.keys(v)).toEqual([]);
    expect(v.expose((x) => x)).toBe(CANARY);
    v.drop();
    expect(v.dropped).toBe(true);
    expect(() => v.expose((x) => x)).toThrow("dropped");
  });
});

describe("fetchReveal", () => {
  it("returns an opaque value for the one secret it asked for, with the action id and no cache", async () => {
    const f = fake(res(JSON.stringify({ secret_id: SID, name: "API_KEY", env: "dev", version: 1, value: CANARY })));
    const v = await fetchReveal(SID, "act-1", f);
    expect(v).toBeInstanceOf(SecretValue);
    expect(v.expose((x) => x)).toBe(CANARY);
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe(`/api/v1/secrets/${SID}/reveal`);
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect((init.headers as Record<string, string>)["X-MH-Action-Id"]).toBe("act-1");
  });

  it("ST-19: a truncated reveal response leaves no canary in the error, its stack or the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const bodies = [
      `{"secret_id":"${SID}","name":"API_KEY","env":"dev","version":1,"value":"${CANARY}`,       // cut inside the string
      `{"secret_id":"${SID}","value":"${CANARY}",`,                                              // cut after a field
      `${CANARY}"}`,                                                                             // garbage that V8 would quote
    ];
    for (const b of bodies) {
      let caught: unknown;
      try { await fetchReveal(SID, "act-1", fake(res(b))); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(RevealError);
      const e = caught as RevealError;
      expect(e.code).toBe("truncated");
      for (const s of [e.message, String(e.stack), JSON.stringify(e), inspect(e), revealText(e), String((e as { cause?: unknown }).cause)]) expect(s).not.toContain(CANARY);
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("refuses invalid UTF-8, a value for another secret, and a missing value", async () => {
    await expect(fetchReveal(SID, "a", fake(new Response(new Uint8Array([0x7b, 0xff, 0xfe]), { status: 200 })))).rejects.toMatchObject({ code: "truncated" });
    await expect(fetchReveal(SID, "a", fake(res(JSON.stringify({ secret_id: "other", value: CANARY }))))).rejects.toMatchObject({ code: "bad_response" });
    await expect(fetchReveal(SID, "a", fake(res(JSON.stringify({ secret_id: SID }))))).rejects.toMatchObject({ code: "bad_response" });
  });

  it("keeps only a known error code, and says plainly that nothing was shown", async () => {
    await expect(fetchReveal(SID, "a", fake(res('{"error":{"code":"step_up_required"}}', 403)))).rejects.toMatchObject({ code: "step_up_required", status: 403 });
    await expect(fetchReveal(SID, "a", fake(res('{"error":{"code":"rate_limited"}}', 429)))).rejects.toMatchObject({ code: "rate_limited" });
    const odd = (await fetchReveal(SID, "a", fake(res(`{"error":{"code":"${CANARY}"}}`, 500))).catch((e: unknown) => e)) as RevealError;
    expect(odd.code).toBe("error");
    expect(JSON.stringify(odd) + odd.message).not.toContain(CANARY);
    await expect(fetchReveal(SID, "a", fake(new TypeError("Failed to fetch")))).rejects.toMatchObject({ code: "network" });
    for (const c of ["step_up_required", "rate_limited", "secret_changed", "vault_unavailable", "not_found", "truncated", "network", "error"] as const) expect(revealText(new RevealError(c))).toMatch(/\.$/);
  });
});

describe("re-hide timing (PLAN 4.6 row 8, WCAG 2.2.1)", () => {
  it("starts at the person's seconds, clamped to 5..100", () => {
    expect(firstWindow(10)).toBe(10);
    expect(firstWindow(30)).toBe(30);
    expect(firstWindow(1)).toBe(5);
    expect(firstWindow(1000)).toBe(100);
    expect(firstWindow(Number.NaN)).toBe(10);
  });
  it("counts down to zero and never below", () => {
    let s = startRehide(5);
    for (let i = 0; i < 8; i++) s = tick(s);
    expect(s.left).toBe(0);
    expect(canExtend(s)).toBe(false);
  });
  it("Keep showing adds 30 seconds at a time and never past 100 in total", () => {
    let s = startRehide(10);
    s = extend(s); expect(s).toEqual({ left: 40, granted: 40 });
    s = extend(s); s = extend(s); expect(s.granted).toBe(REHIDE_CAP_SECONDS);
    expect(canExtend(s)).toBe(false);
    expect(extend(s)).toEqual(s);
  });
});

describe("ST-40: copy and clipboard", () => {
  it("the primary copy is the run command, which holds no value", () => {
    expect(runCommand("example.com", "prod")).toBe("mosshatch run example.com --env prod -- npm start");
  });
  it("copying a value is on for dev and preview and off for prod until the person turns it on", () => {
    expect(valueCopyAllowed("dev", false)).toBe(true);
    expect(valueCopyAllowed("preview", false)).toBe(true);
    expect(valueCopyAllowed("prod", false)).toBe(false);
    expect(valueCopyAllowed("prod", true)).toBe(true);
    expect(valueCopyAllowed("other", true)).toBe(false);
  });
  it("the page never reads the clipboard", () => {
    for (const f of all) expect(read(f), rel(f)).not.toMatch(/readText\s*\(|clipboard\.read\s*\(/);
  });
  it("the Nest offers the run-command copy and gates the value copy on the policy", () => {
    const nest = read(path.join(src, "ui", "NestTab.tsx")), reveal = read(path.join(src, "reveal", "Reveal.tsx"));
    expect(nest).toMatch(/writeText\(cmd\)/);
    expect(reveal).toMatch(/valueCopyAllowed\(s\.env, prodCopy\)/);
    expect(reveal).toMatch(/if \(!v \|\| !copyOk\) return;/);
  });
});

describe("reveal surface boundaries (PLAN 4.5 layer 3)", () => {
  it("store/ and world/ never import reveal/", () => {
    for (const f of all.filter((x) => /^(store|world)\//.test(rel(x)))) expect(read(f), rel(f)).not.toMatch(/from ["'][./]*\/?reveal\//);
  });
  it("only reveal/ calls the reveal route, and nothing in reveal/ logs or reports", () => {
    for (const f of all) {
      const t = read(f);
      if (rel(f).startsWith("reveal/")) { expect(t, rel(f)).not.toMatch(/\bconsole\.|reportError|sendBeacon/); continue; }
      expect(t, rel(f)).not.toMatch(/\/reveal[`"']/);
    }
  });
  it("the value reaches the DOM through one node's textContent, not React props, the store or storage", () => {
    const t = read(path.join(src, "reveal", "Reveal.tsx"));
    expect(t).toMatch(/node\.current\.textContent = value\.current\.expose\(\(v\) => v\)/);
    expect(t).toMatch(/node\.current\.textContent = ""/);
    expect(t).not.toMatch(/useState<SecretValue|useState<string>\(/);
    expect(t).not.toMatch(/localStorage|sessionStorage|history\.|location\.|aria-live/);
    for (const f of all.filter((x) => rel(x).startsWith("reveal/"))) expect(read(f), rel(f)).not.toMatch(/set\(\{/);
  });
  it("SecretValue is imported only inside reveal/", () => {
    for (const f of all.filter((x) => !rel(x).startsWith("reveal/"))) expect(read(f), rel(f)).not.toMatch(/secretValue/);
  });
});
