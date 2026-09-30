import { api, ApiError } from "./api";

/**
 * The Nest read model and writes (PLAN 4.5 vault routes). Every response is parsed with a strict shape: unknown keys are refused,
 * and no field of the list can carry a value (store contract layer 1). Values go up in a PUT and never come back here; the reveal
 * lives in `src/reveal/` and nowhere else.
 */
export const ENVS = ["dev", "preview", "prod"] as const;
export type Env = (typeof ENVS)[number];
export interface SecretName { id: string; name: string; version: number; updated_at: string }
export interface Connection { id: string; service: string; status: string; connected_at: string }
export interface NestView { domain: string; envs: Record<Env, { count: number; secrets: SecretName[] }>; connections: Connection[] }
export interface ReservedNames { version: number; names: string[]; prefixes: string[] }

export class WireError extends Error { constructor() { super("wire"); this.name = "WireError"; } }

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
function exact(x: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isObj(x)) throw new WireError();
  const k = Object.keys(x);
  if (k.length !== keys.length || !k.every((y) => keys.includes(y))) throw new WireError();
  return x;
}
const str = (x: unknown): string => { if (typeof x !== "string") throw new WireError(); return x; };
const num = (x: unknown): number => { if (typeof x !== "number" || !Number.isFinite(x)) throw new WireError(); return x; };

function secretOf(x: unknown, env: Env): SecretName {
  const o = exact(x, ["id", "env", "name", "version", "updated_at"]);
  if (o.env !== env) throw new WireError();
  return { id: str(o.id), name: str(o.name), version: num(o.version), updated_at: str(o.updated_at) };
}

/** Strict parse of GET /domains/{fqdn}/nest. Exported for the contract test. */
export function parseNest(raw: unknown): NestView {
  const o = exact(raw, ["domain", "envs", "connections"]);
  const envs = exact(o.envs, ENVS);
  const out = {} as NestView["envs"];
  for (const e of ENVS) {
    const v = exact(envs[e], ["count", "secrets"]);
    if (!Array.isArray(v.secrets)) throw new WireError();
    out[e] = { count: num(v.count), secrets: v.secrets.map((s) => secretOf(s, e)) };
  }
  if (!Array.isArray(o.connections)) throw new WireError();
  const connections = o.connections.map((c) => { const x = exact(c, ["id", "service", "status", "connected_at"]); return { id: str(x.id), service: str(x.service), status: str(x.status), connected_at: str(x.connected_at) }; });
  return { domain: str(o.domain), envs: out, connections };
}

const enc = encodeURIComponent;
const D = (fqdn: string) => `/api/v1/domains/${enc(fqdn)}`;
export const getNest = async (fqdn: string): Promise<NestView> => parseNest(await api("GET", `${D(fqdn)}/nest`));
export async function getReserved(): Promise<ReservedNames> {
  const o = await api<Record<string, unknown>>("GET", "/api/v1/vault/reserved-names");
  const names = Array.isArray(o.names) ? o.names.filter((n): n is string => typeof n === "string") : [];
  const prefixes = Array.isArray(o.prefixes) ? o.prefixes.filter((n): n is string => typeof n === "string") : [];
  return { version: typeof o.version === "number" ? o.version : 0, names, prefixes };
}

/**
 * PUT a value. The shared client has no PUT, so this sends the same headers itself. The body is built here and dropped; the
 * answer is parsed strictly and never includes the value.
 */
export async function putSecret(fqdn: string, env: Env, name: string, value: string): Promise<{ id: string; name: string; version: number; created: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${D(fqdn)}/secrets/${enc(env)}/${enc(name)}`, {
      method: "PUT", credentials: "same-origin", cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-MH-Client": "web" }, body: JSON.stringify({ value }),
    });
  } catch { throw new ApiError(0, "network"); }
  let json: Record<string, unknown> = {};
  try { json = await res.json() as Record<string, unknown>; } catch { /* not JSON */ }
  if (!res.ok) { const e = isObj(json.error) ? json.error : {}; throw new ApiError(res.status, typeof e.code === "string" ? e.code : "error"); }
  const o = exact(json, ["id", "name", "env", "version"]);
  return { id: str(o.id), name: str(o.name), version: num(o.version), created: res.status === 201 };
}
export const deleteSecret = (fqdn: string, env: Env, name: string) => api<{ id: string; deleted: boolean; versions_destroyed: number }>("DELETE", `${D(fqdn)}/secrets/${enc(env)}/${enc(name)}`);

// ---- names -----------------------------------------------------------------------------------------------------------------------------

/** The server's normalisation (NFKC, trimmed, ASCII letters upper-cased), so the pre-check matches what the server will judge. */
export const normalizeName = (raw: string): string => raw.normalize("NFKC").trim().replace(/[a-z]/g, (c) => c.toUpperCase());
export const NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

/**
 * A plain reason for a name the server would refuse, or null. The server stays the judge (it answers one generic 422 and never
 * says why); this names the reason before sending so the person is not left guessing.
 */
export function nameProblem(raw: string, reserved: ReservedNames | null): string | null {
  const n = normalizeName(raw);
  if (!n) return "Enter a name, like DATABASE_URL.";
  if (n.length > 128) return "Names can be at most 128 characters.";
  if (!NAME_RE.test(n)) return "Use capital letters, digits and underscores, starting with a letter, like DATABASE_URL.";
  if (reserved) {
    if (reserved.names.includes(n)) return `${n} is reserved. It changes how programs start, so the Nest does not store it.`;
    const p = reserved.prefixes.find((x) => n.startsWith(x));
    if (p) return `Names that start with ${p} are reserved. They change how programs or tools behave, so the Nest does not store them.`;
  }
  return null;
}

/** Plain words for the codes the Nest routes answer with. Never echoes server text. */
export function explainNest(e: unknown): string {
  if (e instanceof WireError) return "The Nest answered in a shape we do not accept, so nothing is shown. Try again.";
  if (e instanceof ApiError) {
    switch (e.code) {
      case "invalid_name": return "The Nest refused that name. Names use capital letters, digits and underscores, and reserved names such as PATH or NODE_OPTIONS cannot be stored.";
      case "invalid_value": return "The value is empty or has characters the Nest cannot store unchanged.";
      case "too_large": return "The value is too large for the Nest.";
      case "rate_limited": return "Too many changes just now. Wait a minute, then try again.";
      case "write_conflict": return "Someone else changed this secret at the same moment. Look again, then retry.";
      case "vault_unavailable": return "The Nest cannot be changed right now. Nothing was saved.";
      case "not_found": return "That domain or secret is not in your account.";
      case "network": return "The connection failed. Check your network.";
    }
  }
  return "That did not work. Try again.";
}
