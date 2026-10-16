import { requireFundingAdmission } from "./funding-control.ts";
import { z } from "zod";
import { RegistrarError, type DnsRecord, type RegistrarPort, type TransferAwayStatus } from "@mosshatch/registrar/port";
import { decodeJson, encodeJson, RPC_HEADERS, RPC_PATH_PREFIX, verifySignature } from "./sign.ts";

/**
 * Signed RPC, web -> registrar (plan 4.3b "Deployment topology", threat rows 29 and 30; ST-118). The `registrar` project holds the one reseller key;
 * `web` holds only the shared RPC secret. A call is accepted only when: the secret is configured (fail closed), the HMAC over
 * method + path + body hash + timestamp + nonce verifies, the timestamp is inside the window, the nonce has not been seen, and the command is
 * on the explicit allow-list below with arguments that validate. Every authentication failure gets the same 401 body, so the reason is not an oracle;
 * the reason goes to `onReject` as a code (never a value).
 */
export type RejectReason = "not_configured" | "bad_method_or_path" | "missing_headers" | "bad_timestamp" | "outside_window" | "bad_signature" | "replayed_nonce" | "body_too_large" | "command_not_allowed" | "bad_request" | "nonce_store_unavailable";

export interface NonceStore {
  /** True the first time a nonce is claimed, false on a replay. Entries must be kept until `expiresAtMs`. */
  claim(nonce: string, expiresAtMs: number, nowMs: number): boolean | Promise<boolean>;
}
export class MemoryNonceStore implements NonceStore {
  private seen = new Map<string, number>();
  claim(nonce: string, expiresAtMs: number, nowMs: number): boolean {
    for (const [k, exp] of this.seen) if (exp <= nowMs) this.seen.delete(k);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, expiresAtMs); return true;
  }
  get size() { return this.seen.size; }
}

const fqdn = z.string().min(3).max(253).regex(/^[A-Za-z0-9.-]+$/);
const registrant = z.object({ name: z.string().min(1).max(200), email: z.string().min(3).max(320), phone: z.string().min(3).max(40), street: z.string().min(1).max(200), city: z.string().min(1).max(100), region: z.string().min(1).max(100), postalCode: z.string().min(1).max(20), country: z.string().length(2) }).strict();
const dnsRecord = z.object({ type: z.enum(["A", "AAAA", "CNAME", "MX", "SRV", "TXT"]), name: z.string().max(253), value: z.string().min(1).max(1024), priority: z.number().int().min(0).max(65535).optional(), weight: z.number().int().min(0).max(65535).optional(), port: z.number().int().min(0).max(65535).optional() }).strict();
const ds = z.object({ keyTag: z.number().int().min(0).max(65535), algorithm: z.number().int().min(0).max(255), digestType: z.number().int().min(0).max(255), digest: z.string().regex(/^[0-9a-fA-F]{20,128}$/) }).strict();
const years = z.number().int().min(1).max(10);
const dnskey = z.object({ flags: z.number().int().min(0).max(65535), algorithm: z.number().int().min(1).max(255), publicKey: z.string().regex(/^[A-Za-z0-9+/=\s]{20,4096}$/), protocol: z.number().int().min(0).max(255).optional() }).strict();
/** An optional port method. A provider without it answers `not_supported`: a rejection, with nothing sent. */
function optional<K extends "addDnskey" | "getRegistrantVerification" | "resendRegistrantVerification">(p: RegistrarPort, k: K): NonNullable<RegistrarPort[K]> {
  const f = p[k];
  if (typeof f !== "function") throw new RegistrarError("rejected", "not supported by this registrar", { retryable: false, outcomeUnknown: false, code: "not_supported" });
  return f.bind(p) as NonNullable<RegistrarPort[K]>;
}
const tstatus = z.enum(["pending_admin", "pending_owner", "pending_registry", "completed", "cancelled"]);

type Cmd = { args: z.ZodTypeAny; run: (p: RegistrarPort, a: never[]) => Promise<unknown> | unknown };
const cmd = <S extends z.ZodTuple<any, any>>(args: S, run: (p: RegistrarPort, a: z.infer<S>) => Promise<unknown> | unknown): Cmd => ({ args, run: run as never });

/** The whole surface `web` may reach. Anything not listed here (including methods of the adapter it wraps) answers command_not_allowed. */
export const RPC_COMMANDS = {
  capabilities: cmd(z.tuple([]), (p) => p.capabilities()),
  health: cmd(z.tuple([]), (p) => p.health()),
  checkAvailability: cmd(z.tuple([fqdn]).rest(z.object({ noCache: z.boolean().optional() }).strict()), (p, a) => p.checkAvailability(a[0], a[1] ?? {})),
  quote: cmd(z.tuple([fqdn, years]).rest(z.enum(["register", "renew", "transfer"])), (p, a) => p.quote(a[0], a[1], a[2])),
  register: cmd(z.tuple([z.object({ fqdn, years, regUsername: z.string().min(3).max(20), regPassword: z.string().min(10).max(20), registrant }).strict()]), (p, a) => p.register(a[0])),
  renew: cmd(z.tuple([fqdn, years, z.number().int().min(2000).max(2200)]), (p, a) => p.renew(a[0], a[1], a[2])),
  getDomain: cmd(z.tuple([fqdn]), (p, a) => p.getDomain(a[0])),
  getOrdersByDomain: cmd(z.tuple([fqdn]), (p, a) => p.getOrdersByDomain(a[0])),
  cancelPendingOrder: cmd(z.tuple([z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)]), (p, a) => p.cancelPendingOrder(a[0])),
  beginFundingAdmission: cmd(z.tuple([]), (p) => requireFundingAdmission(p).beginFundingAdmission()),
  endFundingAdmission: cmd(z.tuple([z.string().uuid()]), (p, a) => requireFundingAdmission(p).endFundingAdmission(a[0])),
  getFundingStatus: cmd(z.tuple([]), (p) => p.getFundingStatus()),
  getBalance: cmd(z.tuple([]), (p) => p.getBalance()),
  setLock: cmd(z.tuple([fqdn, z.boolean()]), (p, a) => p.setLock(a[0], a[1])),
  setNameservers: cmd(z.tuple([fqdn, z.array(z.string().min(3).max(253)).min(2).max(13)]).rest(z.object({ targetSigned: z.boolean().optional() }).strict()), (p, a) => p.setNameservers(a[0], a[1], a[2] ?? {})),
  issueAuthCode: cmd(z.tuple([fqdn]), (p, a) => p.issueAuthCode(a[0])),
  rerandomizeAuthCode: cmd(z.tuple([fqdn]), (p, a) => p.rerandomizeAuthCode(a[0])),
  getDns: cmd(z.tuple([fqdn]), (p, a) => p.getDns(a[0])),
  replaceZone: cmd(z.tuple([fqdn, z.array(dnsRecord).max(500)]), (p, a) => p.replaceZone(a[0], a[1] as DnsRecord[])),
  getDs: cmd(z.tuple([fqdn]), (p, a) => p.getDs(a[0])),
  addDs: cmd(z.tuple([fqdn, ds]), (p, a) => p.addDs(a[0], a[1])),
  removeDs: cmd(z.tuple([fqdn, ds]), (p, a) => p.removeDs(a[0], a[1])),
  addDnskey: cmd(z.tuple([fqdn, dnskey]), (p, a) => optional(p, "addDnskey")(a[0], a[1])),
  getRegistrantVerification: cmd(z.tuple([fqdn]), (p, a) => optional(p, "getRegistrantVerification")(a[0])),
  resendRegistrantVerification: cmd(z.tuple([fqdn]), (p, a) => optional(p, "resendRegistrantVerification")(a[0])),
  updateContact: cmd(z.tuple([fqdn, registrant]), (p, a) => p.updateContact(a[0], a[1])),
  getTransfersAway: cmd(z.tuple([]).rest(z.object({ statuses: z.array(tstatus).max(5).optional(), since: z.date().optional() }).strict()), (p, a) => p.getTransfersAway((a[0] ?? {}) as { statuses?: TransferAwayStatus[]; since?: Date })),
  cancelTransfer: cmd(z.tuple([fqdn]), (p, a) => p.cancelTransfer(a[0])),
  stopTransferAway: cmd(z.tuple([fqdn]), (p, a) => p.stopTransferAway(a[0])),
  setAutoRenew: cmd(z.tuple([fqdn, z.boolean()]), (p, a) => p.setAutoRenew(a[0], a[1])),
  listDomains: cmd(z.tuple([]).rest(z.object({ cursor: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).optional() }).strict()), (p, a) => p.listDomains(a[0] ?? {})),
  getDeletedDomains: cmd(z.tuple([]), (p) => p.getDeletedDomains()),
  restore: cmd(z.tuple([fqdn]), (p, a) => p.restore(a[0])),
  // Phase 5 transfer-in. The authorization code crosses this hop once, inside the signed body, and is never logged or echoed.
  checkTransferIn: cmd(z.tuple([fqdn]), (p, a) => p.checkTransferIn(a[0])),
  startTransferIn: cmd(z.tuple([z.object({ fqdn, years, authCode: z.string().regex(/^[\x21-\x7e]{6,64}$/), regUsername: z.string().min(3).max(20), regPassword: z.string().min(10).max(20), registrant }).strict()]), (p, a) => p.startTransferIn(a[0])),
  getTransferInStatus: cmd(z.tuple([fqdn]), (p, a) => p.getTransferInStatus(a[0])),
  cancelTransferIn: cmd(z.tuple([fqdn]), (p, a) => p.cancelTransferIn(a[0])),
} satisfies Record<string, Cmd>;
export type RpcCommandName = keyof typeof RPC_COMMANDS;

export interface RpcRequest { method: string; path: string; headers: Record<string, string | undefined>; body: string }
export interface RpcResponse { status: number; headers: Record<string, string>; body: string }

export interface RegistrarRpcOptions {
  port: RegistrarPort;
  /** Current secret first; a previous one may follow during rotation. Every secret must be at least 32 characters or the handler refuses all calls. */
  secrets: string[];
  clock: { now(): Date };
  nonces: NonceStore;
  windowSeconds?: number;
  maxBodyBytes?: number;
  onReject?: (reason: RejectReason) => void;
}

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const reply = (status: number, v: unknown): RpcResponse => ({ status, headers: HEADERS, body: encodeJson(v) });
const UNAUTH = () => reply(401, { error: { code: "unauthorized" } });

export function createRegistrarRpc(opts: RegistrarRpcOptions): (req: RpcRequest) => Promise<RpcResponse> {
  const windowS = opts.windowSeconds ?? 60; const maxBody = opts.maxBodyBytes ?? 64 * 1024;
  const reject = (r: RejectReason, res: RpcResponse) => { try { opts.onReject?.(r); } catch { /* the hook must not change the outcome */ } return res; };
  return async (req) => {
    if (opts.secrets.length === 0 || opts.secrets.some((s) => typeof s !== "string" || s.length < 32)) return reject("not_configured", reply(503, { error: { code: "rpc_not_configured" } }));
    if (req.method.toUpperCase() !== "POST" || !req.path.startsWith(RPC_PATH_PREFIX)) return reject("bad_method_or_path", UNAUTH());
    if (Buffer.byteLength(req.body, "utf8") > maxBody) return reject("body_too_large", reply(413, { error: { code: "body_too_large" } }));
    const h = (k: string) => { const v = req.headers[k] ?? req.headers[k.toLowerCase()]; return typeof v === "string" ? v : undefined; };
    const ts = h(RPC_HEADERS.timestamp), nonce = h(RPC_HEADERS.nonce), sig = h(RPC_HEADERS.signature);
    if (!ts || !nonce || !sig) return reject("missing_headers", UNAUTH());
    if (!/^\d{10}$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return reject("bad_timestamp", UNAUTH());
    const nowMs = opts.clock.now().getTime();
    if (Math.abs(nowMs - Number(ts) * 1000) > windowS * 1000) return reject("outside_window", UNAUTH());
    const parts = { method: req.method, path: req.path, body: req.body, timestamp: ts, nonce };
    // Verify against every configured secret without short-circuiting on the first hit.
    let ok = false; for (const s of opts.secrets) ok = verifySignature(s, parts, sig) || ok;
    if (!ok) return reject("bad_signature", UNAUTH());
    // Claimed only after the signature verifies, so an unauthenticated caller cannot fill the store. Kept past the far edge of the window.
    // A store that cannot answer refuses the call (fail closed): accepting it would let a replay through on another instance.
    let fresh: boolean;
    try { fresh = await opts.nonces.claim(nonce, Number(ts) * 1000 + windowS * 1000 + 1000, nowMs); }
    catch { return reject("nonce_store_unavailable", reply(503, { error: { code: "registrar_shared_store_unavailable", kind: "unavailable", retryable: true, outcomeUnknown: false } })); }
    if (!fresh) return reject("replayed_nonce", UNAUTH());

    const name = req.path.slice(RPC_PATH_PREFIX.length);
    if (!Object.hasOwn(RPC_COMMANDS, name)) return reject("command_not_allowed", reply(404, { error: { code: "command_not_allowed" } }));
    const c = RPC_COMMANDS[name as RpcCommandName];
    let args: unknown[];
    try {
      const parsed = decodeJson(req.body) as { args?: unknown };
      const shaped = c.args.safeParse(parsed?.args ?? []);
      if (!shaped.success) return reject("bad_request", reply(400, { error: { code: "bad_request" } }));
      args = shaped.data as unknown[];
    } catch { return reject("bad_request", reply(400, { error: { code: "bad_request" } })); }
    try {
      const result = await c.run(opts.port, args as never[]);
      return reply(200, { result: result === undefined ? null : result });
    } catch (e) {
      if (e instanceof RegistrarError) {
        const status = e.kind === "rejected" ? 422 : e.kind === "rate_limited" ? 429 : e.kind === "unknown" ? 502 : 503;
        // Codes only: the message is fixed text and never crosses the boundary.
        return reply(status, { error: { code: e.code ?? "registrar_error", kind: e.kind, retryable: e.retryable, outcomeUnknown: e.outcomeUnknown } });
      }
      return reply(500, { error: { code: "internal" } });
    }
  };
}
