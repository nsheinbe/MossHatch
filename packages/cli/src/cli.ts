import fs from "node:fs";
import type { Writable } from "node:stream";
import { Api, ApiFailure, CLIENT_ID, type Fetch } from "./api.ts";
import { encodeDotenv, encodeShell, parseDotenv, unportableNames, DotenvError, ShellNulError } from "./dotenv.ts";
import { OutRefused, writeSecretFile } from "./files.ts";
import { HELP, VERSION } from "./help.ts";
import { runChild } from "./run.ts";
import type { TokenStore } from "./store.ts";

/**
 * `mosshatch`: login, logout, whoami, pull, push, run (PLAN 4.5 CLI). Everything the outside world touches comes in
 * through `Io`, so tests run the real code against the in-process API with no network. Values are never printed unless
 * `--stdout` is given, and never logged; errors say what happened in plain words and name no value.
 */

export const EXIT = { ok: 0, failed: 1, usage: 2, reserved: 3, auth: 4, unavailable: 75, forbidden: 77 } as const;
export const DEFAULT_API = "https://mosshatch.com";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface Io {
  fetch: Fetch;
  store: TokenStore;
  env: Record<string, string | undefined>;
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable;
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  readStdin(): Promise<string>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

interface Args { cmd: string; pos: string[]; flags: Map<string, string | true>; rest: string[] }

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["env", "out", "format"]);
const BOOL_FLAGS = new Set(["stdout", "local-only", "no-mask", "help", "version"]);

export function parseArgs(argv: string[]): Args {
  const dd = argv.indexOf("--");
  const head = dd >= 0 ? argv.slice(0, dd) : argv;
  const rest = dd >= 0 ? argv.slice(dd + 1) : [];
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const a = head[i]!;
    if (a === "-h") { flags.set("help", true); continue; }
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    // A token is never accepted as an argument: argv is visible to every process on the machine.
    if (/token/i.test(k)) throw new UsageError("Tokens are never passed on the command line. Set MOSSHATCH_TOKEN in the environment, or run mosshatch login.");
    if (VALUE_FLAGS.has(k)) {
      const v = inline ?? head[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`--${k} needs a value.`);
      flags.set(k, v);
    } else if (BOOL_FLAGS.has(k)) { if (inline !== undefined) throw new UsageError(`--${k} takes no value.`); flags.set(k, true); }
    else throw new UsageError(`Unknown option --${k}. Run mosshatch help.`);
  }
  return { cmd: pos.shift() ?? "help", pos, flags, rest };
}

const say = (w: Writable, s: string) => { w.write(s.endsWith("\n") ? s : s + "\n"); };

function explain(e: ApiFailure): { code: number; text: string } {
  switch (e.code) {
    case "not_signed_in": case "unauthorized": return { code: EXIT.auth, text: "You are not signed in, or your sign-in has ended. Run mosshatch login." };
    case "scope_missing": case "scope_conflict": case "forbidden_principal": return { code: EXIT.forbidden, text: "This sign-in does not allow that. Sign in again and approve the environment you need." };
    case "vault_unavailable": return { code: EXIT.unavailable, text: "The vault is unavailable right now. Nothing was read or written. Try again in a minute." };
    case "not_found": return { code: EXIT.failed, text: "That domain or environment was not found in your account." };
    case "invalid_name": return { code: EXIT.reserved, text: "The server refused a name: it is malformed or on the reserved list. Nothing was written." };
    case "rate_limited": return { code: EXIT.failed, text: "Too many requests. Wait a minute and try again." };
    case "network": return { code: EXIT.failed, text: "Could not reach Mosshatch. Check your connection." };
    case "too_large": return { code: EXIT.failed, text: "A value is larger than 16 KiB." };
    case "invalid_value": return { code: EXIT.failed, text: "A value is empty or has characters that cannot be stored." };
    default: return { code: EXIT.failed, text: `The request failed (${e.status} ${e.code}).` };
  }
}

const ENV_RE = /^(dev|preview|prod)$/;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
function target(a: Args): { domain: string; env: string } {
  const domain = (a.pos[0] ?? "").toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(domain)) throw new UsageError("Name a domain, for example: mosshatch pull example.com --env dev --out .env.local");
  const env = String(a.flags.get("env") ?? "dev");
  if (!ENV_RE.test(env)) throw new UsageError("--env is dev, preview or prod.");
  return { domain, env };
}

interface Reserved { names: string[]; prefixes: string[] }
async function reservedList(api: Api): Promise<Reserved> {
  const r = await api.call("GET", "/api/v1/vault/reserved-names");
  return { names: (r.json.names as string[]).map((n) => n.toUpperCase()), prefixes: (r.json.prefixes as string[]).map((n) => n.toUpperCase()) };
}
const isReserved = (list: Reserved, name: string) => { const n = name.toUpperCase(); return list.names.includes(n) || list.prefixes.some((p) => n.startsWith(p)); };

async function readSecrets(api: Api, domain: string, env: string): Promise<{ name: string; value: string }[]> {
  const r = await api.authed("POST", `/api/v1/domains/${encodeURIComponent(domain)}/secrets/${env}/read`, {});
  return (r.secrets as { name: string; value: string }[]).map((s) => ({ name: s.name, value: s.value }));
}

export async function runCli(argv: string[], io: Io): Promise<number> {
  let a: Args;
  try { a = parseArgs(argv); } catch (e) { say(io.stderr, (e as Error).message); return EXIT.usage; }
  if (a.flags.has("version")) { say(io.stdout, VERSION); return EXIT.ok; }
  if (a.cmd === "help" || a.flags.has("help")) { io.stdout.write(HELP); return EXIT.ok; }
  const api = new Api({ base: io.env.MOSSHATCH_API_URL ?? DEFAULT_API, fetch: io.fetch, store: io.store, envToken: io.env.MOSSHATCH_TOKEN || undefined, now: io.now });
  try {
    switch (a.cmd) {
      case "login": return await login(api, io);
      case "logout": return await logout(api, io, a);
      case "whoami": return await whoami(api, io);
      case "pull": return await pull(api, io, a);
      case "push": return await push(api, io, a);
      case "run": return await run(api, io, a);
      default: say(io.stderr, `Unknown command "${a.cmd.slice(0, 20)}". Run mosshatch help.`); return EXIT.usage;
    }
  } catch (e) {
    if (e instanceof UsageError) { say(io.stderr, e.message); return EXIT.usage; }
    if (e instanceof ApiFailure) { const x = explain(e); say(io.stderr, x.text); return x.code; }
    say(io.stderr, "Something went wrong. Nothing more was done.");
    return EXIT.failed;
  }
}

// ---- login and logout -------------------------------------------------------------------------------------------------

async function login(api: Api, io: Io): Promise<number> {
  if (io.env.MOSSHATCH_TOKEN) { say(io.stderr, "MOSSHATCH_TOKEN is set, so this shell already has a token. Unset it to sign in."); return EXIT.usage; }
  const start = await api.call("POST", "/api/v1/oauth/device/code", { client_id: CLIENT_ID, client_name: "mosshatch-cli", client_version: VERSION });
  const d = start.json as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
  say(io.stderr, `To sign in, open ${d.verification_uri} in a browser where you are signed in to Mosshatch, and type this code:\n\n    ${d.user_code}\n\nOnly type it if you started this sign-in yourself, just now. Waiting for your approval...`);
  let interval = Math.max(5, d.interval) * 1000;
  const deadline = io.now() + d.expires_in * 1000;
  while (io.now() < deadline) {
    await io.sleep(interval);
    const r = await api.raw("POST", "/api/v1/oauth/token", { grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: CLIENT_ID });
    if (r.status === 200) {
      await api.save(r.json);
      const where = io.store.where();
      if (io.store.kind === "file") {
        // Say which: a plain npm install has no keychain module at all, which is not the same as a keychain that did not answer.
        const why = (io.store as { fallbackReason?: string }).fallbackReason === "module_missing" ? "no system keychain is in use (this install does not include the keychain module)" : "no system keychain is available";
        say(io.stderr, `Warning: ${why}, so your sign-in is saved in ${where}, readable only by you. Anyone who can read that file can use it until it expires or you run mosshatch logout.`);
      }
      say(io.stderr, `Signed in. This computer can: ${String(r.json.scope).split(" ").join(", ")}.`);
      return EXIT.ok;
    }
    const code = r.json?.error?.code;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") { interval = Math.max(interval + 5000, Number(r.json.error.interval ?? 0) * 1000); continue; }
    if (code === "access_denied") { say(io.stderr, "The sign-in was denied. Nothing was saved."); return EXIT.auth; }
    if (code === "expired_token") break;
    say(io.stderr, "The sign-in failed. Nothing was saved. Run mosshatch login to try again."); return EXIT.auth;
  }
  say(io.stderr, "The code expired before it was approved. Run mosshatch login to get a new one.");
  return EXIT.auth;
}

async function logout(api: Api, io: Io, a: Args): Promise<number> {
  const s = await io.store.load();
  if (s && !a.flags.has("local-only")) {
    // RFC 7009: revoke the refresh token (which revokes the whole grant) before forgetting it here.
    for (const t of [s.refresh_token, s.access_token]) if (t) await api.raw("POST", "/api/v1/oauth/revoke", { token: t, client_id: CLIENT_ID }).catch(() => undefined);
  }
  await io.store.clear();
  say(io.stderr, s ? (a.flags.has("local-only") ? "Forgotten on this computer. The sign-in still works until it expires; revoke it on mosshatch.com." : "Signed out. The sign-in is revoked.") : "You were not signed in.");
  return EXIT.ok;
}

async function whoami(api: Api, io: Io): Promise<number> {
  const r = await api.authed("GET", "/api/v1/whoami");
  const b = r.binding as { kind: string; name: string; scopes: string[]; expires_at: string; grant_expires_at: string };
  say(io.stdout, `Signed in with a ${b.kind === "cli" ? "command-line sign-in" : "token"} named "${b.name}".\nIt can: ${b.scopes.join(", ")}\nIt ends: ${b.grant_expires_at}`);
  return EXIT.ok;
}

// ---- pull, push, run --------------------------------------------------------------------------------------------------

async function pull(api: Api, io: Io, a: Args): Promise<number> {
  const out = a.flags.get("out"), toStdout = a.flags.has("stdout");
  if ((out === undefined) === !toStdout) { say(io.stderr, out === undefined ? "Say where the values go: --out <new file> or --stdout. Nothing was read." : "Use --out or --stdout, not both."); return EXIT.usage; }
  const format = String(a.flags.get("format") ?? "dotenv");
  if (format !== "dotenv" && format !== "shell") throw new UsageError("--format is dotenv or shell.");
  const t = target(a);
  const list = await reservedList(api);
  const all = await readSecrets(api, t.domain, t.env);
  // A name stored before it joined the reserved list is left out, never written where a program would start with it.
  const omitted = all.filter((s) => isReserved(list, s.name)).map((s) => s.name);
  const keep = all.filter((s) => !isReserved(list, s.name));
  let text: string;
  try { text = format === "shell" ? encodeShell(keep) : encodeDotenv(keep); } catch (e) { if (e instanceof ShellNulError) { say(io.stderr, e.message); return EXIT.failed; } throw e; }
  if (omitted.length) say(io.stderr, `Left out ${omitted.length} reserved name${omitted.length === 1 ? "" : "s"}: ${omitted.join(", ")}. Rename ${omitted.length === 1 ? "it" : "them"} in your Nest.`);
  const unportable = format === "dotenv" ? unportableNames(keep) : [];
  if (unportable.length) say(io.stderr, `Note: ${unportable.join(", ")} ${unportable.length === 1 ? "holds" : "hold"} a carriage return, a NUL byte or every kind of quote, which other dotenv readers (node --env-file, the dotenv package) do not read back unchanged. mosshatch push reads this file as written; to give ${unportable.length === 1 ? "it" : "them"} to a program, use mosshatch run or --format shell.`);
  if (toStdout) { io.stdout.write(text); return EXIT.ok; }
  try {
    const file = writeSecretFile(String(out), text);
    say(io.stderr, `Wrote ${keep.length} secret${keep.length === 1 ? "" : "s"} from ${t.domain} (${t.env}) to ${file}, readable only by you. Keep it out of version control.`);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof OutRefused) {
      const why = { git: "it is inside a .git directory", symlink: "it is a symbolic link", exists: "a file is already there (pull never overwrites)", parent: "its folder does not exist" }[e.reason];
      say(io.stderr, `Refused to write ${String(out)}: ${why}. Nothing was written.`);
      return EXIT.usage;
    }
    throw e;
  }
}

async function push(api: Api, io: Io, a: Args): Promise<number> {
  const t = target(a);
  const src = a.pos[1] ?? "-";
  let text: string;
  if (src === "-") { if (io.stdinIsTTY) throw new UsageError("Give a dotenv file, or pipe one in with -."); text = await io.readStdin(); }
  else { try { text = fs.readFileSync(src, "utf8"); } catch { throw new UsageError(`Could not read ${src}.`); } }
  let entries;
  try { entries = parseDotenv(text); } catch (e) { if (e instanceof DotenvError) { say(io.stderr, `The file is not valid dotenv at line ${e.line}. Nothing was written.`); return EXIT.usage; } throw e; }
  if (entries.length === 0) { say(io.stderr, "The file has no NAME=value lines. Nothing was written."); return EXIT.usage; }
  const list = await reservedList(api);
  const bad = entries.filter((e) => isReserved(list, e.name)).map((e) => e.name);
  if (bad.length) { say(io.stderr, `Refused: ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} on the reserved list. Nothing was written.`); return EXIT.reserved; }
  const secrets: Record<string, string> = {};
  for (const e of entries) secrets[e.name] = e.value;
  const r = await api.authed("POST", `/api/v1/domains/${encodeURIComponent(t.domain)}/secrets/${t.env}/write`, { secrets });
  say(io.stderr, `Stored ${r.written.length} secret${r.written.length === 1 ? "" : "s"} in ${t.domain} (${t.env}): ${(r.written as { name: string; version: number }[]).map((w) => `${w.name} v${w.version}`).join(", ")}.`);
  return EXIT.ok;
}

async function run(api: Api, io: Io, a: Args): Promise<number> {
  if (a.rest.length === 0) throw new UsageError("Put the command after --, for example: mosshatch run example.com --env dev -- npm start");
  const t = target(a);
  const list = await reservedList(api);
  const secrets = await readSecrets(api, t.domain, t.env);
  const bad = secrets.filter((s) => isReserved(list, s.name)).map((s) => s.name);
  if (bad.length) { say(io.stderr, `Refused to run: ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} on the reserved list and could change how the command starts. Rename ${bad.length === 1 ? "it" : "them"} in your Nest.`); return EXIT.reserved; }
  const env: NodeJS.ProcessEnv = { ...io.env };
  delete env.MOSSHATCH_TOKEN;   // the child gets the secrets, not the token that read them
  for (const s of secrets) env[s.name] = s.value;
  return runChild(a.rest, env, secrets.map((s) => s.value), io, { mask: !a.flags.has("no-mask") });
}
