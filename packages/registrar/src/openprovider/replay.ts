import type { OpHttpRequest, OpHttpResponse, OpHttpTransport } from "./transport.ts";
import { encodeJson, JsonNum, obj, parseJson, SECRET_KEYS, type Json } from "./wire.ts";

/**
 * Record and replay for the Openprovider adapter. Fixtures are recorded from the live sandbox (`source: "recorded-sandbox"`, dated) and scrubbed
 * before they are written: no token, password, authorization code, customer handle or personal data of the account holder survives.
 *
 *  - The login request's username and password become `<redacted>`; the login reply's token becomes `<redacted-token>`. The bearer header is
 *    never recorded.
 *  - Every key in SECRET_KEYS (auth_code, internal_auth_code, ...) is replaced; a reset reply's code becomes a distinct placeholder so replayed
 *    issues still differ from each other.
 *  - Customer handles (for example `AB123456-US`) become `HANDLE-<n>` everywhere (paths, bodies, replies), consistently within one fixture.
 *  - The reseller record keeps only `balance` and `reserved_balance`. Emails other than the test registrants' `@example.test`/`@example.com`
 *    become `redacted@example.invalid`; `reseller_id` becomes 0.
 */
export interface Exchange { at: string; method: OpHttpRequest["method"]; path: string; body?: Json; status: number; response: Json | string }
export interface Fixture { source: "recorded-sandbox"; recordedOn: string; baseUrl: string; note?: string; names: string[]; exchanges: Exchange[] }

const HANDLE = /\b[A-Z]{2}\d{6}-[A-Z]{2}\b/g;
const TEST_EMAIL = /@example\.(test|com)$/i;

export class Scrubber {
  private handles = new Map<string, string>();
  private codes = 0;
  handle(h: string): string { let v = this.handles.get(h); if (!v) { v = `HANDLE-${this.handles.size + 1}`; this.handles.set(h, v); } return v; }
  text(s: string): string { return s.replace(HANDLE, (h) => this.handle(h)); }
  /** `request` scrubs a request body: secrets become a fixed placeholder so the replayed request compares equal (no counters). */
  json(v: Json, key = "", request = false): Json {
    if (v instanceof JsonNum) return key === "reseller_id" ? new JsonNum("0") : v;
    if (Array.isArray(v)) return v.map((x) => this.json(x, key, request));
    if (v && typeof v === "object") {
      const out: { [k: string]: Json } = {};
      for (const [k, x] of Object.entries(v)) {
        if (SECRET_KEYS.has(k) && typeof x === "string") out[k] = k === "auth_code" && !request ? `REDACTED-CODE-${++this.codes}` : k === "token" ? "<redacted-token>" : "<redacted>";
        else if (k === "username" && typeof x === "string") out[k] = "<redacted>";
        else if ((k === "email" || k === "verification_email_name") && typeof x === "string" && x && !TEST_EMAIL.test(x)) out[k] = "redacted@example.invalid";
        else out[k] = this.json(x, k, request);
      }
      return out;
    }
    return typeof v === "string" ? this.text(v) : v;
  }
  /** The reseller record carries the account holder's name, address, phone and email: keep the two amounts only. */
  reseller(v: Json): Json {
    const o = obj(v); const d = obj(o?.data);
    if (!o || !d) return this.json(v);
    return this.json({ code: o.code ?? new JsonNum("0"), desc: o.desc ?? "", data: { balance: d.balance ?? new JsonNum("0"), reserved_balance: d.reserved_balance ?? new JsonNum("0") } });
  }
}

function relPath(url: string, base: string): string { return url.startsWith(base) ? url.slice(base.length) : url; }
function parseOr(text: string): Json | string { try { return parseJson(text); } catch { return text; } }

/** Wraps a live transport, scrubs every exchange and keeps it for `fixture()`. */
export class RecordingTransport implements OpHttpTransport {
  readonly exchanges: Exchange[] = [];
  readonly scrub = new Scrubber();
  constructor(private inner: OpHttpTransport, private base: string, private clock: () => Date = () => new Date()) {}
  async request(req: OpHttpRequest): Promise<OpHttpResponse> {
    const at = this.clock().toISOString();
    const res = await this.inner.request(req);
    const path = this.scrub.text(relPath(req.url, this.base).split("?")[0]!) + (req.url.includes("?") ? "?" + this.scrub.text(req.url.split("?")[1]!) : "");
    const body = req.body !== undefined ? this.scrub.json(parseJson(req.body), "", true) : undefined;
    const parsed = parseOr(res.body);
    const response = typeof parsed === "string" ? parsed : path === "/resellers" ? this.scrub.reseller(parsed) : this.scrub.json(parsed);
    this.exchanges.push({ at, method: req.method, path, ...(body !== undefined ? { body } : {}), status: res.status, response });
    return res;
  }
  fixture(names: string[], note?: string): Fixture {
    return { source: "recorded-sandbox", recordedOn: this.exchanges[0]?.at.slice(0, 10) ?? "", baseUrl: this.base, ...(note ? { note } : {}), names, exchanges: this.exchanges };
  }
}
export function fixtureText(f: Fixture): string {
  return JSON.stringify(JSON.parse(encodeJson(f)), null, 1) + "\n";
}
export function loadFixture(text: string): Fixture { return JSON.parse(text) as Fixture; }

/**
 * Plays a fixture back strictly in order. Each request must match the recorded method, path and (scrubbed) body, or the replay fails loudly: a
 * change in what the adapter sends needs a fresh recording, never a silently reused answer. `onExchange` lets a test move a fake clock to the
 * recorded time.
 */
export class ReplayTransport implements OpHttpTransport {
  private i = 0;
  private readonly scrub = new Scrubber();
  constructor(private f: Fixture, private opts: { onExchange?: (at: Date) => void } = {}) {}
  get remaining() { return this.f.exchanges.length - this.i; }
  async request(req: OpHttpRequest): Promise<OpHttpResponse> {
    const x = this.f.exchanges[this.i];
    const path = relPath(req.url, this.f.baseUrl);
    const body = req.body !== undefined ? encodeJson(this.scrub.json(parseJson(req.body), "", true)) : undefined;
    const want = x?.body !== undefined ? JSON.stringify(x.body) : undefined;
    if (!x || x.method !== req.method || x.path !== path || want !== (body !== undefined ? JSON.stringify(JSON.parse(body)) : undefined)) {
      throw new Error(`replay mismatch at exchange ${this.i}: expected ${x ? `${x.method} ${x.path}` : "end of fixture"}, got ${req.method} ${path}`);
    }
    this.i++;
    this.opts.onExchange?.(new Date(x.at));
    return { status: x.status, body: typeof x.response === "string" ? x.response : JSON.stringify(x.response) };
  }
}
