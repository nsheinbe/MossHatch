import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, TEST_ORIGIN, type TestApp } from "../testing/app.ts";
import { buildRouter } from "../routes.ts";
import { listRecurringJobs } from "../jobs/engine.ts";
import { getJobDef } from "../jobs/registry.ts";
import { CSP_REPORT_GLOBAL_LIMIT, CSP_REPORT_KEEP_DAYS, CSP_REPORT_LIMIT, CSP_REPORT_MAX_BYTES, CSP_REPORT_PATH, sweepCspReports } from "./report.ts";

/**
 * PLAN 4.3a (Reporting-Endpoints row) and D-015: the CSP report endpoint. Every report is attacker-controlled; only the directive,
 * the blocked resource's origin (or a CSP keyword) and the document path without its query are kept, counted per day.
 * ST-14 (the route class exists and answers with the API header set), ST-16 (no canary from a report is stored or logged).
 */

let app: TestApp;
beforeAll(async () => { app = await createTestApp(buildRouter()); }, 120_000);
afterAll(async () => { await app?.drop(); });
beforeEach(async () => {
  await app.db.owner.query("delete from csp_reports");
  await app.db.owner.query("delete from rate_counters where bucket like 'csp.%'");
});

let ipN = 0;
/** A fresh /24 per call unless one is given, so the per-network limit does not interfere with other cases. */
const freshIp = () => `198.51.${(++ipN) % 250}.7`;
async function send(body: string | ReadableStream<Uint8Array>, o: { type?: string; ip?: string; headers?: Record<string, string>; method?: string } = {}) {
  const h = new Headers({ "content-type": o.type ?? "application/csp-report", "x-forwarded-for": o.ip ?? freshIp(), ...(o.headers ?? {}) });
  const init: RequestInit & { duplex?: "half" } = { method: o.method ?? "POST", headers: h };
  if (init.method !== "GET") { init.body = body; if (typeof body !== "string") init.duplex = "half"; }
  const res = await app.router!.dispatch(app.ctx, new Request(TEST_ORIGIN + CSP_REPORT_PATH, init));
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, json, text, headers: res.headers };
}
const rows = async () => (await app.db.owner.query("select to_char(day, 'YYYY-MM-DD') as day, directive, blocked, document_path, disposition, count from csp_reports order by directive, blocked, document_path")).rows;
const legacy = (r: Record<string, unknown>) => JSON.stringify({ "csp-report": r });

const CANARY = "mhcanary7Qx2Lr9";
const fullLegacy = {
  "document-uri": `${TEST_ORIGIN}/device?user_code=${CANARY}-query#frag-${CANARY}`,
  referrer: `https://referrer.example/${CANARY}-referrer`,
  "violated-directive": "script-src-elem",
  "effective-directive": "script-src-elem",
  "original-policy": `default-src 'none'; report-uri /api/csp-report; x-${CANARY}-policy`,
  disposition: "enforce",
  "blocked-uri": `https://user:${CANARY}-pw@evil.example:8443/x/${CANARY}-path.js?token=${CANARY}-token#h`,
  "line-number": 12, "column-number": 34, "status-code": 200,
  "source-file": `${TEST_ORIGIN}/assets/main.js?${CANARY}-src`,
  "script-sample": `alert("${CANARY}-sample")`,
};

describe("ST-14, ST-16: POST /api/csp-report keeps the directive, the blocked origin and the document path, nothing else", () => {
  it("a legacy application/csp-report is reduced to four fields; no URL, query, credential, sample or referrer is stored or logged", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const res = await send(legacy(fullLegacy));
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
    spies.forEach((s) => s.mockRestore());
    expect(res.status, res.text).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await rows()).toEqual([{ day: app.clock.now().toISOString().slice(0, 10), directive: "script-src-elem", blocked: "https://evil.example:8443", document_path: "/device", disposition: "enforce", count: 1 }]);
    const stored = JSON.stringify((await app.db.owner.query("select * from csp_reports")).rows)
      + JSON.stringify((await app.db.owner.query("select * from audit_log")).rows) + JSON.stringify((await app.db.owner.query("select * from alerts")).rows);
    for (const hay of [stored, logged, res.text]) {
      expect(hay).not.toContain(CANARY);
      expect(hay).not.toContain("user_code");
      expect(hay).not.toContain("/x/");
    }
  });

  it("a Reporting API batch (application/reports+json) is counted per day; keywords and schemes stay coarse; other report types are ignored", async () => {
    const r = (blockedURL: string, extra: Record<string, unknown> = {}) => ({
      type: "csp-violation", age: 3, url: `${TEST_ORIGIN}/?oauth_request=${CANARY}`, user_agent: `UA-${CANARY}`,
      body: { documentURL: `${TEST_ORIGIN}/?oauth_request=${CANARY}`, blockedURL, effectiveDirective: "script-src-elem", disposition: "report", sample: `${CANARY}-sample`, sourceFile: `${TEST_ORIGIN}/assets/a.js`, lineNumber: 1, ...extra },
    });
    const batch = [
      r("inline"), r("inline"), r("eval"),
      r(`data:image/png;base64,${CANARY}`, { effectiveDirective: "img-src" }),
      r(`blob:${TEST_ORIGIN}/${CANARY}`, { effectiveDirective: "worker-src" }),
      r("trusted-types-sink", { effectiveDirective: "require-trusted-types-for" }),
      r(`wss://socket.example/${CANARY}?q=${CANARY}`, { effectiveDirective: "connect-src" }),
      { type: "deprecation", url: `${TEST_ORIGIN}/`, body: { id: CANARY, message: CANARY } },
    ];
    const res = await send(JSON.stringify(batch), { type: "application/reports+json" });
    expect(res.status, res.text).toBe(202);
    const got = await rows();
    expect(got.map((x) => [x.directive, x.blocked, x.document_path, x.disposition, x.count])).toEqual([
      ["connect-src", "wss://socket.example", "/", "report", 1],
      ["img-src", "data", "/", "report", 1],
      ["require-trusted-types-for", "trusted-types-sink", "/", "report", 1],
      ["script-src-elem", "eval", "/", "report", 1],
      ["script-src-elem", "inline", "/", "report", 2],
      ["worker-src", "blob", "/", "report", 1],
    ]);
    expect(JSON.stringify(got)).not.toContain(CANARY);
    // The same report again adds to the day's count instead of a new row.
    await send(JSON.stringify([r("inline")]), { type: "application/reports+json" });
    expect((await rows()).find((x) => x.blocked === "inline")!.count).toBe(3);
  });

  it("drops reports caused by browser extensions and reports about documents that are not ours", async () => {
    const cases = [
      { ...fullLegacy, "blocked-uri": "chrome-extension://abcdefghijklmnop/inject.js" },
      { ...fullLegacy, "blocked-uri": "moz-extension://1234-5678/content.js" },
      { ...fullLegacy, "blocked-uri": "safari-web-extension://ABCD/script.js" },
      { ...fullLegacy, "blocked-uri": "inline", "source-file": "chrome-extension://abcdefghijklmnop/content.js" },
      { ...fullLegacy, "blocked-uri": "inline", "source-file": "webkit-masked-url://hidden/" },
      { ...fullLegacy, "document-uri": `https://attacker.example/${CANARY}` },
      { ...fullLegacy, "document-uri": "about:blank" },
      { ...fullLegacy, "document-uri": "not a url" },
    ];
    for (const c of cases) expect((await send(legacy(c))).status).toBe(202);
    expect(await rows()).toEqual([]);
  });

  it("hostile field values are coarsened: an odd directive is 'other', an odd path is '/(other)', an odd scheme is 'other'", async () => {
    await send(legacy({ ...fullLegacy, "effective-directive": `script-src'; drop table ${CANARY}`, "violated-directive": "" }));
    await send(legacy({ ...fullLegacy, "document-uri": `${TEST_ORIGIN}/${"a".repeat(300)}` }));
    await send(legacy({ ...fullLegacy, "document-uri": `${TEST_ORIGIN}/%3Cscript%3E${CANARY}` }));
    await send(legacy({ ...fullLegacy, "blocked-uri": `javascript:alert('${CANARY}')` }));
    await send(legacy({ ...fullLegacy, "blocked-uri": `https://${"x".repeat(200)}.example/` }));
    await send(legacy({ ...fullLegacy, "effective-directive": ["img-src"], "blocked-uri": { a: CANARY }, disposition: `x${CANARY}` }));
    const got = await rows();
    expect(JSON.stringify(got)).not.toContain(CANARY);
    expect(got.map((x) => [x.directive, x.blocked, x.document_path, x.disposition, x.count])).toEqual([
      ["other", "https://evil.example:8443", "/device", "enforce", 1],
      // A very long path and an encoded one both land in "/(other)": two reports, one row.
      ["script-src-elem", "https://evil.example:8443", "/(other)", "enforce", 2],
      // Not a string where a string belongs: nothing is read from it.
      ["script-src-elem", "none", "/device", "enforce", 1],
      // A javascript: URL and an origin too long to be real are both just "other".
      ["script-src-elem", "other", "/device", "enforce", 2],
    ]);
  });
});

describe("the endpoint refuses what is not a CSP report", () => {
  it("wrong content type is 415, broken JSON is 400, an unknown shape is 400, a wrong method is 405; none of them stores anything", async () => {
    expect((await send(legacy(fullLegacy), { type: "text/plain" })).status).toBe(415);
    expect((await send(legacy(fullLegacy), { type: "application/x-www-form-urlencoded" })).status).toBe(415);
    const broken = await send(`{"csp-report": {"blocked-uri": "${CANARY}`);
    expect(broken.status).toBe(400);
    expect(broken.text).not.toContain(CANARY);
    for (const b of ["{}", "[]", "null", "42", `"${CANARY}"`, JSON.stringify({ "csp-report": "x" }), JSON.stringify([1, "a", null])]) {
      const res = await send(b);
      expect([202, 400], b).toContain(res.status);
      expect(res.text).not.toContain(CANARY);
    }
    expect((await send(JSON.stringify({ "csp-report": "x" }))).status).toBe(400);
    expect((await send("{}")).status).toBe(400);
    expect((await send("", { method: "GET" })).status).toBe(405);
    expect(await rows()).toEqual([]);
  });

  it("needs no credentials, and a stale or foreign session cookie does not change that (the report is anonymous)", async () => {
    const res = await send(legacy(fullLegacy), { headers: { cookie: "__Host-mh_session=not-a-real-session" } });
    expect(res.status, res.text).toBe(202);
    expect((await rows()).length).toBe(1);
  });

  it("caps the body at 8 KiB: by declared length, by actual size without a declared length, and exactly 8 KiB still passes", async () => {
    expect(CSP_REPORT_MAX_BYTES).toBe(8192);
    const pad = (n: number) => { const base = legacy({ ...fullLegacy, "script-sample": "" }); return base.slice(0, -2) + `,"z":"${"a".repeat(n - base.length - 7)}"}}`; };
    const exact = pad(CSP_REPORT_MAX_BYTES);
    expect(Buffer.byteLength(exact)).toBe(CSP_REPORT_MAX_BYTES);
    expect((await send(exact)).status).toBe(202);
    const over = pad(CSP_REPORT_MAX_BYTES + 1);
    expect(Buffer.byteLength(over)).toBe(CSP_REPORT_MAX_BYTES + 1);
    const big = await send(over);
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe("too_large");
    // Multi-byte characters count as bytes, not as characters.
    const wide = legacy({ ...fullLegacy, "script-sample": "é".repeat(4100) });
    expect(wide.length).toBeLessThan(CSP_REPORT_MAX_BYTES + 400);
    expect((await send(wide)).status).toBe(413);
    // Streamed with no Content-Length: the reader stops at the cap.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctl) { pulled++; if (pulled > 64) { ctl.close(); return; } ctl.enqueue(new TextEncoder().encode("a".repeat(1024))); },
    });
    const streamed = await send(stream);
    expect(streamed.status).toBe(413);
    expect(pulled).toBeLessThan(20);
    // A lying Content-Length larger than the cap is refused before reading.
    expect((await send(legacy(fullLegacy), { headers: { "content-length": String(CSP_REPORT_MAX_BYTES * 4) } })).status).toBe(413);
    expect((await rows()).map((x) => x.count)).toEqual([1]);
  });

  it("is rate limited per network through the shared limiter, and overall, with Retry-After; refused reports store nothing", async () => {
    const ip = "203.0.113.9";
    for (let i = 0; i < CSP_REPORT_LIMIT.max; i++) expect((await send(legacy(fullLegacy), { ip })).status).toBe(202);
    const refused = await send(legacy(fullLegacy), { ip });
    expect(refused.status).toBe(429);
    expect(refused.json.error.code).toBe("rate_limited");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await rows())[0]!.count).toBe(CSP_REPORT_LIMIT.max);
    // The counter is the shared Postgres limiter, keyed by an HMAC (never the address).
    const counters = (await app.db.owner.query("select encode(key_hash, 'hex') as k, bucket, count from rate_counters where bucket like 'csp.%'")).rows;
    expect(counters.some((c) => c.bucket === CSP_REPORT_LIMIT.bucket)).toBe(true);
    expect(JSON.stringify(counters)).not.toContain("203.0.113");
    // Another network may still report ...
    expect((await send(legacy(fullLegacy), { ip: "192.0.2.1" })).status).toBe(202);
    // ... until the global cap, which bounds a flood from many networks.
    let ok = 0, limited = 0;
    for (let i = 0; i < CSP_REPORT_GLOBAL_LIMIT.max + 5; i++) {
      const s = (await send(legacy(fullLegacy), { ip: `10.${Math.floor(i / 250)}.${i % 250}.1` })).status;
      if (s === 202) ok++; else if (s === 429) limited++;
    }
    expect(ok + CSP_REPORT_LIMIT.max + 1).toBe(CSP_REPORT_GLOBAL_LIMIT.max);
    expect(limited).toBeGreaterThan(0);
    // A new window opens again.
    app.clock.advance(CSP_REPORT_LIMIT.windowSeconds * 1000);
    expect((await send(legacy(fullLegacy), { ip })).status).toBe(202);
  });
});

describe("retention", () => {
  it(`rows older than ${CSP_REPORT_KEEP_DAYS} days are deleted by the daily csp.reports_sweep job`, async () => {
    const now = app.clock.now();
    const day = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10);
    for (const d of [0, CSP_REPORT_KEEP_DAYS, CSP_REPORT_KEEP_DAYS + 1, 400]) {
      await app.db.owner.query("insert into csp_reports (day, directive, blocked, document_path, disposition, count) values ($1,'img-src','data','/','enforce',1)", [day(d)]);
    }
    expect(await sweepCspReports(app.ctx)).toBe(2);
    expect((await rows()).map((x) => x.day).sort()).toEqual([day(CSP_REPORT_KEEP_DAYS), day(0)].sort());
    // The job is registered with the engine on a daily schedule, and its handler is the same sweep.
    expect(listRecurringJobs()).toContainEqual({ kind: "csp.reports_sweep", everySec: 86_400 });
    await app.db.owner.query("insert into csp_reports (day, directive, blocked, document_path, disposition, count) values ($1,'img-src','data','/x','enforce',1)", [day(90)]);
    await getJobDef("csp.reports_sweep")!.handler(app.ctx, {} as never);
    expect((await rows()).some((x) => x.document_path === "/x")).toBe(false);
  });
});

describe("the route table", () => {
  it("has exactly one CSP report route: anonymous, POST, outside /api/v1 as PLAN 4.5 lists it, with the 8 KiB cap declared", () => {
    const routes = buildRouter().routes.filter((r) => r.path.includes("csp"));
    expect(routes.map((r) => [r.method, r.path, r.principals, r.maxBodyBytes])).toEqual([["POST", "/api/csp-report", ["anonymous"], 8192]]);
  });
});
