import crypto from "node:crypto";
import { NONCE_RE, partnerUser, sha256hex, signRequest, type SlateStatus, type SlateStep } from "./slate.ts";

/**
 * An in-repo fake of Slate's partner API (tests, local development, e2e: MH_FAKE_LAUNCHER=1). It is the server side of the contract
 * in slate.ts: it verifies the partner id, the timestamp window, nonce reuse and the signature over the exact bytes, and answers in
 * the documented shapes, including what Slate's team reported once its side was built (2026-10-01): the partner-user header is
 * required on every request (422), an unfunded wallet answers 503 `partner_unfunded`, caps apply at quote time too (429), a build
 * reads `queued` until it is dispatched, cancel works only before dispatch (`refunded`; 409 after), a build failing after dispatch
 * reports `failed` with `charged_minor: 0`, a revision needs a ready base and both base and instruction (409 / 422), bodies over 64 KB
 * are 422, and Slate may charge less than it quoted. A build moves one step each time it is read, so polling drives it to `ready`.
 * Preview URLs are signed and expire after 10 minutes (`?exp&sig`), like Slate's; the dev server serves the pages under `previewBase`.
 */

const STEPS: Omit<SlateStep, "state">[] = [
  { id: "read", label: "Reading the brief" },
  { id: "layout", label: "Laying out the pages" },
  { id: "write", label: "Writing the words" },
  { id: "paint", label: "Painting the colours" },
  { id: "polish", label: "Final polish" },
];

interface FakeBuild {
  id: string; user: string; quoteId: string; status: SlateStatus; step: number; price: number; charged: number;
  brief: { name?: string; oneLiner?: string; palette?: Record<string, string>; tone?: string } ; instruction?: string; version: number; fail?: boolean;
}

export interface FakeSlateOptions {
  partnerId: string;
  secret: string;
  userKey: string;
  /** Where the dev server serves preview pages, e.g. `http://localhost:5174/__dev/slate/preview`. */
  previewBase: string;
  now?: () => Date;
  websitePriceMinor?: number;
  revisionPriceMinor?: number;
}

export class FakeSlate {
  readonly builds = new Map<string, FakeBuild>();
  readonly quotes = new Map<string, { user: string; price: number; expires: number; body: Record<string, unknown> }>();
  readonly idem = new Map<string, string>();
  private seen = new Set<string>();
  /** Requests received (method, path, verified), for tests. */
  readonly log: { method: string; path: string; ok: boolean }[] = [];
  /** Test controls. */
  failNextBuild = false;
  capped = false;
  unfunded = false;
  failQuote: string | null = null;
  /** Charge this fraction of the quote when a build is ready (Slate charges at most its quote). */
  chargeRatio = 1;
  constructor(private o: FakeSlateOptions) {}

  private now() { return (this.o.now?.() ?? new Date()).getTime(); }
  private err(status: number, code: string) { return Response.json({ error: { code, message: code.replace(/_/g, " ") } }, { status }); }

  /** The fetch the SlateHttp client is given. */
  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const raw = req.method === "GET" ? "" : await req.text();
    const h = req.headers;
    const ts = Number(h.get("x-slate-timestamp"));
    const nonce = h.get("x-slate-nonce") ?? "";
    const ok = h.get("x-slate-partner") === this.o.partnerId && Number.isInteger(ts) && Math.abs(this.now() / 1000 - ts) <= 300 && NONCE_RE.test(nonce)
      && !this.seen.has(nonce) && /^[0-9a-f]{64}$/.test(h.get("x-slate-partner-user") ?? "")
      && safeEq(h.get("x-slate-signature") ?? "", signRequest(this.o.secret, { ts, nonce, method: req.method, pathWithQuery: url.pathname + url.search, rawBody: raw }));
    this.log.push({ method: req.method, path: url.pathname, ok });
    if (!/^[0-9a-f]{64}$/.test(h.get("x-slate-partner-user") ?? "")) return this.err(422, "invalid_partner_user");
    if (!ok) return this.err(401, "bad_signature");
    if (Buffer.byteLength(raw) > 64 * 1024) return this.err(422, "body_too_large");
    this.seen.add(nonce);
    const user = h.get("x-slate-partner-user")!;
    if (this.unfunded && req.method === "POST") return this.err(503, "partner_unfunded");
    if (this.capped && req.method === "POST") return this.err(429, "partner_cap");
    const p = url.pathname.replace(/^.*\/api\/partner\/v1/, "");
    let body: Record<string, unknown> = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return this.err(400, "bad_json"); }

    if (req.method === "GET" && p === "/models") return Response.json({ models: [{ id: "slate-standard", label: "Standard" }] });
    if (req.method === "POST" && p === "/quote") {
      if (this.failQuote) { const c = this.failQuote; this.failQuote = null; return this.err(422, c); }
      if (body.kind !== "website" || !body.brief || typeof body.brief !== "object") return this.err(422, "invalid_brief");
      if ((body.base_build_id === undefined) !== (body.instruction === undefined)) return this.err(422, "base_and_instruction_together");
      if (body.base_build_id !== undefined) { const base = this.builds.get(String(body.base_build_id)); if (!base || base.user !== user || base.status !== "ready") return this.err(409, "base_not_ready"); }
      const price = body.instruction ? this.o.revisionPriceMinor ?? 60 : this.o.websitePriceMinor ?? 180;
      const quote_id = "q_" + crypto.randomBytes(9).toString("base64url");
      const expires = this.now() + 15 * 60_000;
      this.quotes.set(quote_id, { user, price, expires, body });
      return Response.json({ quote_id, kind: "website", model: typeof body.model === "string" ? body.model : "slate-standard", price_minor: price, currency: "USD", expires_at: new Date(expires).toISOString() });
    }
    if (req.method === "POST" && p === "/builds") {
      const key = `${user}:${String(body.idempotency_key)}`;
      const again = this.idem.get(key);
      if (again) { const b = this.builds.get(again)!; return Response.json({ build_id: b.id, status: b.status }, { status: 202 }); }
      const q = this.quotes.get(String(body.quote_id));
      if (!q || q.user !== user) return this.err(404, "quote_not_found");
      if (q.expires < this.now()) return this.err(410, "quote_expired");
      const id = "b_" + crypto.randomBytes(9).toString("base64url");
      const base = typeof q.body.base_build_id === "string" ? this.builds.get(q.body.base_build_id) : undefined;
      const b: FakeBuild = { id, user, quoteId: String(body.quote_id), status: "queued", step: -1, price: q.price, charged: 0, brief: q.body.brief as FakeBuild["brief"],
        instruction: typeof q.body.instruction === "string" ? q.body.instruction : undefined, version: (base?.version ?? 0) + 1, fail: this.failNextBuild };
      this.failNextBuild = false;
      this.builds.set(id, b); this.idem.set(key, id); this.quotes.delete(String(body.quote_id));
      return Response.json({ build_id: id, status: "queued" }, { status: 202 });
    }
    const m = /^\/builds\/([A-Za-z0-9_.:-]+)(\/export|\/cancel)?$/.exec(p);
    const b = m ? this.builds.get(m[1]!) : undefined;
    if (!m || !b || b.user !== user) return this.err(404, "not_found");
    if (req.method === "POST" && m[2] === "/cancel") {
      if (b.status !== "queued") return this.err(409, "already_dispatched");
      b.status = "refunded"; b.charged = 0;
      return Response.json(this.view(b));
    }
    if (req.method === "GET" && m[2] === "/export") {
      if (b.status !== "ready") return this.err(409, "not_ready");
      return new Response(JSON.stringify({ build_id: b.id, files: { "index.html": this.previewHtml(b.id) } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (req.method === "GET" && !m[2]) { this.advance(b); return Response.json(this.view(b)); }
    return this.err(405, "method_not_allowed");
  };

  private advance(b: FakeBuild) {
    if (b.status === "ready" || b.status === "failed" || b.status === "refunded") return;
    b.step++;
    if (b.step === 0) return;                                   // still queued on the first read
    if (b.step === 1) b.status = "building";                    // dispatched
    if (b.fail && b.step === 3) { b.status = "failed"; b.charged = 0; return; }
    if (b.step > STEPS.length) { b.status = "ready"; b.charged = Math.max(15, Math.min(b.price, Math.round(b.price * this.chargeRatio))); }
  }

  view(b: FakeBuild) {
    const at = b.step - 1;
    const steps = STEPS.map((s, i): SlateStep => ({ ...s, state: b.status === "ready" || i < at ? "done" : i === at && b.status === "building" ? "active" : b.status === "failed" && i === at ? "failed" : "pending" }));
    const exp = Math.floor(this.now() / 1000) + 600;
    return {
      build_id: b.id, status: b.status, steps, price_minor: b.price, charged_minor: b.charged,
      ...(b.status === "ready" ? { title: b.brief.name ?? "Your site", summary: b.instruction ? `Version ${b.version}: ${b.instruction}` : `First version of ${b.brief.name ?? "your site"}.`,
        preview_url: `${this.o.previewBase}/${this.o.partnerId}/${b.id}?exp=${exp}&sig=${crypto.createHmac("sha256", this.o.secret).update(`${b.id}.${exp}`).digest("hex").slice(0, 32)}` } : {}),
      ...(b.status === "failed" ? { error: "build_failed" } : b.status === "refunded" ? { error: "canceled" } : {}),
    };
  }

  /** The preview page for a ready build (served by the dev server; never by production). Every value is escaped. */
  previewHtml(id: string): string {
    const b = this.builds.get(id);
    if (!b) return "<!doctype html><title>Not found</title>";
    const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const pal = b.brief.palette ?? {};
    const col = (k: string, d: string) => (/^#[0-9a-f]{6}$/.test(pal[k] ?? "") ? pal[k] : d);
    const warm = b.instruction && /warm/i.test(b.instruction);
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(b.brief.name)}</title>`
      + `<style>body{margin:0;font:18px/1.5 Georgia,serif;background:${col("background", "#14121c")};color:${col("text", "#f4efe4")}}header{padding:56px 28px;background:linear-gradient(135deg,${col("primary", "#5b3fa0")},${warm ? "#d9822b" : col("accent", "#e0b04a")});color:#fff}h1{margin:0;font-size:2.4em}main{padding:28px}a{color:${col("accent", "#e0b04a")}}.v{opacity:.7;font-size:.8em}</style>`
      + `<header><h1>${esc(b.brief.name)}</h1><p>${esc(b.brief.oneLiner)}</p></header><main><p>${esc(b.brief.tone)}</p>${b.instruction ? `<p class="v">Revised: ${esc(b.instruction)}</p>` : ""}<p class="v">Fake Slate preview, version ${b.version}.</p></main></html>`;
  }
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The partner-user header the fake expects for an account (tests). */
export const fakePartnerUser = partnerUser;
export { sha256hex };
