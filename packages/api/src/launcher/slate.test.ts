import { describe, expect, it } from "vitest";
import { canonicalRequest, newNonce, NONCE_RE, partnerUser, sha256hex, signRequest, SlateError, SlateHttp } from "./slate.ts";
import { FakeSlate } from "./slate-fake.ts";

/**
 * The Slate partner contract (docs/LAUNCHER.md): signing exactly as specified, pinned by vectors computed independently with openssl
 * (`printf ... | openssl dgst -sha256 -hmac ...`), and the client against the in-repo fake server, which verifies every request.
 */

const SECRET = "test-partner-secret-0123456789abcdef0123";
const USER_KEY = "test-partner-user-key-0123456789abcdef01";
const USER = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const TS = 1759320000;
const NONCE = "AbCdEfGhIjKlMnOpQrStUvWx";

describe("signing (known vectors)", () => {
  it("hashes the raw body and signs ts, nonce, METHOD, path with query and the body hash, newline-joined", () => {
    const body = '{"quote_id":"q_123","idempotency_key":"abcdefghijklmnop"}';
    expect(sha256hex(body)).toBe("2cc126b7a0566a05c406abebac055997d465f15e8c8f6df3ed1a7fe2f9a12eac");
    expect(canonicalRequest({ ts: TS, nonce: NONCE, method: "post", pathWithQuery: "/api/partner/v1/builds", rawBody: body }))
      .toBe(`1759320000\nAbCdEfGhIjKlMnOpQrStUvWx\nPOST\n/api/partner/v1/builds\n2cc126b7a0566a05c406abebac055997d465f15e8c8f6df3ed1a7fe2f9a12eac`);
    expect(signRequest(SECRET, { ts: TS, nonce: NONCE, method: "POST", pathWithQuery: "/api/partner/v1/builds", rawBody: body }))
      .toBe("2224a55793216e057dc391fe209f2cd443fd3a761586d166a491ed4de32d56ac");
  });
  it("signs a GET with the empty-body hash and keeps the query in the path", () => {
    expect(sha256hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(signRequest(SECRET, { ts: TS, nonce: NONCE, method: "GET", pathWithQuery: "/api/partner/v1/builds/b_42?x=1", rawBody: "" }))
      .toBe("319e6de93bc9692f4b668dfb76e376a9412c66a20556d41dd6577b8ff9b2dd02");
  });
  it("sends a keyed HMAC of the user id, never the id, and 24 url-safe nonce characters", () => {
    expect(partnerUser(USER_KEY, USER)).toBe("e6f94df720c08c36f94d33bc24ba42ceedd6ec739444d124a0978691bc14d65a");
    for (let i = 0; i < 50; i++) expect(newNonce()).toMatch(NONCE_RE);
    expect(new Set(Array.from({ length: 200 }, newNonce)).size).toBe(200);
  });
});

describe("SlateHttp against the fake server", () => {
  const now = () => new Date(TS * 1000);
  const setup = () => {
    const fake = new FakeSlate({ partnerId: "mosshatch", secret: SECRET, userKey: USER_KEY, previewBase: "https://preview.example/p", now });
    const seen: Request[] = [];
    const client = new SlateHttp({ baseUrl: "https://slate.example/api/partner/v1", partnerId: "mosshatch", secret: SECRET, userKey: USER_KEY, now,
      fetch: async (r) => { seen.push(r.clone()); return fake.fetch(r); } });
    return { fake, client, seen };
  };
  const brief = { domain: "moonfern.com", name: "Moonfern", oneLiner: "Tea.", audience: "Tea people", goal: "Visit", pages: ["Home"], tone: "calm", palette: { primary: "#112233", accent: "#445566", background: "#000000", text: "#ffffff" } };

  it("sends every contract header with the exact values, and the fake verifies them", async () => {
    const { client, seen, fake } = setup();
    const q = await client.quote(USER, { kind: "website", brief });
    expect(q).toMatchObject({ kind: "website", price_minor: 180, currency: "usd" });
    const r = seen[0]!;
    expect(r.method).toBe("POST");
    expect(new URL(r.url).pathname).toBe("/api/partner/v1/quote");
    const h = r.headers;
    expect(h.get("x-slate-partner")).toBe("mosshatch");
    expect(h.get("x-slate-timestamp")).toBe(String(TS));
    expect(h.get("x-slate-nonce")).toMatch(NONCE_RE);
    expect(h.get("x-slate-partner-user")).toBe(partnerUser(USER_KEY, USER));
    expect(h.get("x-slate-partner-user")).not.toContain(USER);
    const raw = await r.text();
    expect(h.get("x-slate-signature")).toBe(signRequest(SECRET, { ts: TS, nonce: h.get("x-slate-nonce")!, method: "POST", pathWithQuery: "/api/partner/v1/quote", rawBody: raw }));
    expect(fake.log.every((l) => l.ok)).toBe(true);
  });

  it("runs quote, build, poll to ready, export and the 202 shape", async () => {
    const { client } = setup();
    const q = await client.quote(USER, { kind: "website", brief });
    const b = await client.createBuild(USER, { quote_id: q.quote_id, idempotency_key: "key-0123456789abcdef" });
    expect(b.status).toBe("queued");
    // Idempotent: the same key answers the same build.
    expect((await client.createBuild(USER, { quote_id: q.quote_id, idempotency_key: "key-0123456789abcdef" })).build_id).toBe(b.build_id);
    let s = await client.getBuild(USER, b.build_id);
    for (let i = 0; i < 10 && s.status !== "ready"; i++) s = await client.getBuild(USER, b.build_id);
    expect(s).toMatchObject({ status: "ready", title: "Moonfern", price_minor: 180, charged_minor: 180 });
    expect(s.steps.every((x) => x.state === "done")).toBe(true);
    expect(s.preview_url).toMatch(new RegExp(`^https://preview\\.example/p/mosshatch/${b.build_id}\\?exp=\\d+&sig=[0-9a-f]{32}$`));
    const ex = await client.exportBuild(USER, b.build_id);
    expect(ex.contentType).toBe("application/json");
    expect(ex.filename).toMatch(/^site-b_[A-Za-z0-9_-]+\.json$/);
  });

  it("maps Slate errors to codes: partner_cap on 429, a tampered request is refused, a foreign user sees nothing", async () => {
    const { client, fake } = setup();
    fake.capped = true;
    await expect(client.quote(USER, { kind: "website", brief })).rejects.toMatchObject({ status: 429, code: "partner_cap", definite: true });
    fake.capped = false;
    const q = await client.quote(USER, { kind: "website", brief });
    const b = await client.createBuild(USER, { quote_id: q.quote_id, idempotency_key: "key-0123456789abcdef" });
    await expect(client.getBuild("0190a1b2-0000-7000-8000-000000000000", b.build_id)).rejects.toMatchObject({ status: 404, code: "not_found" });
    // A body changed after signing fails the signature check.
    const tampered = new SlateHttp({ baseUrl: "https://slate.example/api/partner/v1", partnerId: "mosshatch", secret: SECRET, userKey: USER_KEY, now,
      fetch: async (r) => fake.fetch(new Request(r.url, { method: r.method, headers: r.headers, body: (await r.text()).replace("Moonfern", "Mo0nfern") })) });
    await expect(tampered.quote(USER, { kind: "website", brief })).rejects.toMatchObject({ status: 401, code: "bad_signature" });
    // A replayed nonce is refused.
    const fixed = new SlateHttp({ baseUrl: "https://slate.example/api/partner/v1", partnerId: "mosshatch", secret: SECRET, userKey: USER_KEY, now, nonce: () => NONCE, fetch: fake.fetch });
    await fixed.models(USER);
    await expect(fixed.models(USER)).rejects.toMatchObject({ code: "bad_signature" });
    // A wrong secret is refused.
    const wrong = new SlateHttp({ baseUrl: "https://slate.example/api/partner/v1", partnerId: "mosshatch", secret: SECRET + "x", userKey: USER_KEY, now, fetch: fake.fetch });
    await expect(wrong.models(USER)).rejects.toBeInstanceOf(SlateError);
  });

  it("matches what Slate reported: partner-user required, unfunded, revision rules, cancel before dispatch, 64 KB bodies", async () => {
    const { client, fake } = setup();
    // The header is required on every request, GET /models included.
    const bare = await fake.fetch(new Request("https://slate.example/api/partner/v1/models"));
    expect([bare.status, (await bare.json()).error.code]).toEqual([422, "invalid_partner_user"]);
    fake.unfunded = true;
    await expect(client.quote(USER, { kind: "website", brief })).rejects.toMatchObject({ status: 503, code: "partner_unfunded", definite: true });
    fake.unfunded = false;
    const q = await client.quote(USER, { kind: "website", brief });
    const b = await client.createBuild(USER, { quote_id: q.quote_id, idempotency_key: "key-0123456789abcdef" });
    // A revision needs a ready base, and base and instruction together.
    await expect(client.quote(USER, { kind: "website", brief, base_build_id: b.build_id, instruction: "warmer" })).rejects.toMatchObject({ status: 409, code: "base_not_ready", definite: true });
    await expect(client.quote(USER, { kind: "website", brief, base_build_id: b.build_id })).rejects.toMatchObject({ status: 422 });
    // Cancel works only before dispatch.
    await client.getBuild(USER, b.build_id);
    await client.getBuild(USER, b.build_id);
    await expect(client.cancel(USER, b.build_id)).rejects.toMatchObject({ status: 409, code: "already_dispatched" });
    // Bodies over 64 KB are refused before anything is sent.
    const sent = fake.log.length;
    await expect(client.quote(USER, { kind: "website", brief: { ...brief, notes: "x".repeat(70_000) } })).rejects.toMatchObject({ status: 422, code: "body_too_large" });
    expect(fake.log.length).toBe(sent);
    // A 503 `unavailable` is not definite: the confirm is retried with the same key.
    expect(new SlateError(503, "unavailable").definite).toBe(false);
  });

  it("treats transport failures as indefinite, and refuses a plain-http base URL", async () => {
    const down = new SlateHttp({ baseUrl: "https://slate.example/api/partner/v1", partnerId: "mosshatch", secret: SECRET, userKey: USER_KEY, fetch: async () => { throw new TypeError("fetch failed"); } });
    const e = await down.models(USER).catch((x) => x);
    expect(e).toMatchObject({ code: "slate_unreachable", definite: false });
    expect(() => new SlateHttp({ baseUrl: "http://slate.example/api", partnerId: "mosshatch", secret: SECRET, userKey: USER_KEY })).toThrow("slate_url_not_https");
  });

  it("rejects malformed Slate answers instead of trusting them", async () => {
    const bad = new SlateHttp({ baseUrl: "https://slate.example/api/partner/v1", partnerId: "mosshatch", secret: SECRET, userKey: USER_KEY,
      fetch: async () => Response.json({ quote_id: "q 1 <script>", kind: "website", model: "m", price_minor: -5, currency: "usd", expires_at: "soon" }) });
    await expect(bad.quote(USER, { kind: "website", brief })).rejects.toMatchObject({ code: "slate_bad_response" });
  });
});
