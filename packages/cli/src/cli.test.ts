import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { makePerson, makeVaultKit, putSecret, type Person, type VaultKit } from "../../api/src/vault/testkit.ts";
import { writeSecret } from "../../api/src/vault/secrets.ts";
import { commit, prepare } from "../../api/src/stepup/testkit.ts";
import { ACTION_HEADER } from "../../api/src/stepup/gate.ts";
import { runCli, EXIT, type Io } from "./cli.ts";
import { FileStore, KeychainStore } from "./store.ts";
import { encodeDotenv, encodeShell, parseDotenv } from "./dotenv.ts";
import { masker } from "./run.ts";

/**
 * The CLI against the in-process API: the real router, the real vault and a virtual passkey, reached through an injected
 * fetch. No network is used. Child processes for `run` are real (node).
 */

let k: VaultKit;
let tmp: string;
beforeAll(async () => { k = await makeVaultKit(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cli-")); }, 120_000);
afterAll(async () => { await k?.drop(); fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(async () => { await k.app.db.owner.query("delete from rate_counters"); });

class Sink extends Writable {
  text = "";
  isTTY = false;
  override _write(chunk: Buffer, _e: string, cb: () => void) { this.text += chunk.toString("utf8"); cb(); }
}

interface Harness { io: Io; out: Sink; err: Sink; dir: string; store: FileStore }
let seq = 0;
function harness(o: { env?: Record<string, string>; stdin?: string; onSleep?: (h: Harness) => Promise<void>; tty?: boolean } = {}): Harness {
  const dir = path.join(tmp, `h${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const out = new Sink(), err = new Sink();
  const store = new FileStore(path.join(dir, "state", "mosshatch"));
  const h: Harness = {
    out, err, dir, store,
    io: {
      fetch: (url, init) => k.app.router!.dispatch(k.app.ctx, new Request(url, init)),
      store,
      env: { MOSSHATCH_API_URL: k.app.ctx.config.origin, PATH: process.env.PATH ?? "", HOME: dir, ...(o.env ?? {}) },
      stdout: out, stderr: err, stdoutIsTTY: !!o.tty, stdinIsTTY: false,
      readStdin: async () => o.stdin ?? "",
      sleep: async (ms) => { k.app.clock.advance(ms); if (o.onSleep) await o.onSleep(h); },
      now: () => k.app.clock.now().getTime(),
    },
  };
  return h;
}

/** Approve whatever code the CLI printed, as the person in their browser, with their passkey. */
async function approveFromTerminal(p: Person, h: Harness, input: Record<string, unknown> = {}) {
  const code = /\n {4}([A-Z]{4}-[A-Z]{4})\n/.exec(h.err.text)?.[1];
  if (!code || (h as { approved?: boolean }).approved) return;
  (h as { approved?: boolean }).approved = true;
  const look = await k.app.call("POST", "/api/v1/oauth/device/lookup", { cookie: p.user.cookie, body: { user_code: code } });
  expect(look.status, look.text).toBe(200);
  const prep = await prepare(k.app, p.user, { type: "device.approve", target_id: look.json.request_id, user_input: { user_code: code, ...input } });
  const done = await commit(k.app, p.user, prep.json.action_id, p.key.auth.get(prep.json.webauthn_options));
  expect(done.status).toBe(200);
  expect((await k.app.call("POST", "/api/v1/oauth/device/approve", { cookie: p.user.cookie, body: {}, headers: { [ACTION_HEADER]: prep.json.action_id } })).status).toBe(200);
}

async function signedIn(p: Person, input: Record<string, unknown> = {}): Promise<Harness> {
  const h = harness({ onSleep: (x) => approveFromTerminal(p, x, input) });
  expect(await runCli(["login"], h.io), h.err.text).toBe(EXIT.ok);
  return h;
}
const again = (h: Harness, o: { tty?: boolean; stdin?: string } = {}): Harness => {
  const n = harness({ ...o });
  n.io.store = h.store; n.store = h.store;
  n.io.env = { ...h.io.env };
  return n;
};

describe("login, whoami, logout", () => {
  it("login is the device flow: the code is shown, approved with a passkey, and the token is kept in a 0600 file with a loud warning", async () => {
    const p = await makePerson(k, "cli-login");
    const h = await signedIn(p);
    expect(h.err.text).toContain(`${k.app.ctx.config.origin}/device`);
    expect(h.err.text).toMatch(/Warning: no system keychain/);
    expect(h.err.text).toContain("secrets.read:*:dev");
    const file = h.store.where();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.access_token).toMatch(/^mh_cli_/);
    expect(h.err.text + h.out.text).not.toContain(saved.access_token);
    expect(h.err.text + h.out.text).not.toContain(saved.refresh_token);
    const w = again(h);
    expect(await runCli(["whoami"], w.io)).toBe(EXIT.ok);
    expect(w.out.text).toContain("command-line sign-in");
    // The access token lasts 60 minutes; the CLI refreshes it without a new login.
    k.app.clock.advance(61 * 60_000);
    const w2 = again(h);
    expect(await runCli(["whoami"], w2.io), w2.err.text).toBe(EXIT.ok);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).access_token).not.toBe(saved.access_token);
  });

  it("logout revokes on the server first, then forgets: the old token fails on the next request", async () => {
    const p = await makePerson(k, "cli-logout");
    const h = await signedIn(p);
    const saved = JSON.parse(fs.readFileSync(h.store.where(), "utf8"));
    const o = again(h);
    expect(await runCli(["logout"], o.io)).toBe(EXIT.ok);
    expect(fs.existsSync(h.store.where())).toBe(false);
    const r = await k.app.call("GET", "/api/v1/whoami", { authorization: `Bearer ${saved.access_token}`, browser: false });
    expect(r.status).toBe(401);
    expect(await runCli(["whoami"], again(h).io)).toBe(EXIT.auth);
  });

  it("a token is never taken as an argument; MOSSHATCH_TOKEN works for scripts and is not stored", async () => {
    const h = harness();
    expect(await runCli(["whoami", "--token", "mh_cli_x"], h.io)).toBe(EXIT.usage);
    expect(await runCli(["whoami", "--access-token=mh_cli_x"], h.io)).toBe(EXIT.usage);
    const p = await makePerson(k, "cli-envtok");
    const s = await signedIn(p);
    const tok = JSON.parse(fs.readFileSync(s.store.where(), "utf8")).access_token;
    const e = harness({ env: { MOSSHATCH_TOKEN: tok } });
    expect(await runCli(["whoami"], e.io)).toBe(EXIT.ok);
    expect(fs.existsSync(e.store.where())).toBe(false);
  });

  it("review: two commands refreshing at once share one refresh; both succeed and the sign-in survives", async () => {
    const p = await makePerson(k, "cli-race");
    const h = await signedIn(p);
    k.app.clock.advance(61 * 60_000);
    const a = again(h), b = again(h);
    const codes = await Promise.all([runCli(["whoami"], a.io), runCli(["whoami"], b.io)]);
    expect(codes, a.err.text + b.err.text).toEqual([EXIT.ok, EXIT.ok]);
    const bad = (await k.app.db.owner.query("select count(*)::int n from audit_log where chain_id = $1 and action in ('binding.refresh_reuse', 'binding.revoked')", [p.user.userId])).rows[0].n;
    expect(bad).toBe(0);
    expect(await runCli(["whoami"], again(h).io)).toBe(EXIT.ok);
  });

  it("review: a refresh refused for a server reason (503, 429) keeps the saved sign-in; only invalid_grant forgets it", async () => {
    const p = await makePerson(k, "cli-503");
    const h = await signedIn(p);
    k.app.clock.advance(61 * 60_000);
    for (const status of [503, 429, 500]) {
      const x = again(h);
      const real = x.io.fetch;
      x.io.fetch = async (url, init) => url.endsWith("/api/v1/oauth/token") ? new Response(JSON.stringify({ error: { code: status === 429 ? "rate_limited" : "unavailable" } }), { status }) : real(url, init);
      expect(await runCli(["whoami"], x.io)).not.toBe(EXIT.ok);
      expect(x.err.text).not.toContain("not signed in");
      expect(fs.existsSync(h.store.where()), String(status)).toBe(true);
    }
    expect(await runCli(["whoami"], again(h).io)).toBe(EXIT.ok);
    // A revoked sign-in answers invalid_grant: that one is forgotten.
    const saved = JSON.parse(fs.readFileSync(h.store.where(), "utf8"));
    expect((await k.app.call("POST", "/api/v1/oauth/revoke", { body: { token: saved.refresh_token }, browser: false })).status).toBe(200);
    expect(await runCli(["whoami"], again(h).io)).toBe(EXIT.auth);
    expect(fs.existsSync(h.store.where())).toBe(false);
  });

  it("review: logout also removes a sign-in file left from an earlier fallback when the keychain is in use", async () => {
    const h = harness();
    const file = new FileStore(path.join(h.dir, "state", "mosshatch"));
    await file.save({ api: k.app.ctx.config.origin, access_token: "mh_cli_leftover" });
    let stored: string | null = JSON.stringify({ api: k.app.ctx.config.origin, access_token: "mh_cli_inkeychain" });
    const entry = { getPassword: () => stored, setPassword: (v: string) => { stored = v; }, deletePassword: () => { stored = null; return true; } };
    h.io.store = new KeychainStore(entry, file);
    expect(await runCli(["logout", "--local-only"], h.io)).toBe(EXIT.ok);
    expect(stored).toBeNull();
    expect(fs.existsSync(file.where())).toBe(false);
  });

  it("help is plain and states the honest limits", async () => {
    const h = harness();
    expect(await runCli(["help"], h.io)).toBe(EXIT.ok);
    for (const s of ["cannot cover every variable", "same user, and by root", "best effort", "Prefer \"run\"", "never overwrites"]) expect(h.out.text).toContain(s);
  });
});

describe("ST-90: pull needs --out or --stdout, and --out refuses symlinks and .git", () => {
  it("with neither flag it exits 2 and reads nothing", async () => {
    const p = await makePerson(k, "st90");
    await putSecret(k, p, "dev", "A", "one");
    const h = await signedIn(p);
    const before = (await k.app.db.owner.query("select count(*)::int n from audit_log where action = 'secret.read' and chain_id = $1", [p.user.userId])).rows[0].n;
    const x = again(h);
    expect(await runCli(["pull", p.domain.fqdn, "--env", "dev"], x.io)).toBe(2);
    expect(await runCli(["pull", p.domain.fqdn, "--env", "dev", "--out", "a", "--stdout"], again(h).io)).toBe(2);
    expect((await k.app.db.owner.query("select count(*)::int n from audit_log where action = 'secret.read' and chain_id = $1", [p.user.userId])).rows[0].n).toBe(before);
    expect(x.out.text).toBe("");
  });

  it("--out creates a new 0600 file, never overwrites, refuses a symlink and anything under .git", async () => {
    const p = await makePerson(k, "st90b");
    await putSecret(k, p, "dev", "API_KEY", "value-one");
    const h = await signedIn(p);
    const file = path.join(h.dir, ".env.local");
    const x = again(h);
    expect(await runCli(["pull", p.domain.fqdn, "--env", "dev", "--out", file], x.io), x.err.text).toBe(EXIT.ok);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toBe('API_KEY="value-one"\n');
    expect(x.out.text).toBe(""); expect(x.err.text).not.toContain("value-one");
    expect(await runCli(["pull", p.domain.fqdn, "--out", file], again(h).io)).toBe(2);
    const victim = path.join(h.dir, "victim.txt"); fs.writeFileSync(victim, "keep");
    const link = path.join(h.dir, "link.env"); fs.symlinkSync(victim, link);
    expect(await runCli(["pull", p.domain.fqdn, "--out", link], again(h).io)).toBe(2);
    expect(fs.readFileSync(victim, "utf8")).toBe("keep");
    const dangling = path.join(h.dir, "dangling.env"); fs.symlinkSync(path.join(h.dir, "nowhere.env"), dangling);
    expect(await runCli(["pull", p.domain.fqdn, "--out", dangling], again(h).io)).toBe(2);
    expect(fs.existsSync(path.join(h.dir, "nowhere.env"))).toBe(false);
    fs.mkdirSync(path.join(h.dir, "repo", ".git", "hooks"), { recursive: true });
    for (const t of [path.join(h.dir, "repo", ".git", "config.env"), path.join(h.dir, "repo", ".GIT", "x"), path.join(h.dir, "repo", ".git", "hooks", "post-checkout")]) {
      expect(await runCli(["pull", p.domain.fqdn, "--out", t], again(h).io), t).toBe(2);
    }
    fs.symlinkSync(path.join(h.dir, "repo", ".git"), path.join(h.dir, "gitlink"));
    expect(await runCli(["pull", p.domain.fqdn, "--out", path.join(h.dir, "gitlink", "sneaky")], again(h).io)).toBe(2);
    expect(fs.existsSync(path.join(h.dir, "repo", ".git", "sneaky"))).toBe(false);
    const s = again(h);
    expect(await runCli(["pull", p.domain.fqdn, "--stdout"], s.io)).toBe(EXIT.ok);
    expect(s.out.text).toBe('API_KEY="value-one"\n');
  });
});

describe("ST-89: reserved names in run and pull; hostile values round-trip", () => {
  const hostile = ["line1\nline2", 'say "hi"', "back\\slash", "$(touch pwned)", "`id`", "a # not a comment", "k=v=w", "cr\rhere", "${HOME}", "'single'", "tab\there", "ünïcødé ✓", " leading and trailing "];

  it("the dotenv writer and parser round-trip every hostile value, NUL included; the shell format is safe to source", () => {
    const entries = [...hostile, "nul\0byte"].map((value, i) => ({ name: `V${i}`, value }));
    expect(parseDotenv(encodeDotenv(entries))).toEqual(entries);
    const shellEntries = hostile.map((value, i) => ({ name: `S${i}`, value }));
    const dir = fs.mkdtempSync(path.join(tmp, "sh-"));
    const file = path.join(dir, "vars.sh");
    fs.writeFileSync(file, encodeShell(shellEntries));
    for (const [i, value] of hostile.entries()) {
      const got = execFileSync("sh", ["-c", `. "${file}"; printf '%s' "$S${i}"`], { cwd: dir, encoding: "utf8" });
      expect(got).toBe(value);
    }
    expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
    expect(() => encodeShell([{ name: "X", value: "a\0b" }])).toThrow();
  });

  it("review: pull's dotenv file reads back unchanged through node --env-file", () => {
    // Everything Node can hold: it drops a carriage return, and no environment can hold NUL.
    const portable = [...hostile.filter((v) => !v.includes("\r")), `it's $HOME and "quoted" \\`, 'multi\nline with $ and \\ and "', "ends with a backslash\\", "back`tick and 'quote'"];
    const entries = portable.map((value, i) => ({ name: `N${i}`, value }));
    const dir = fs.mkdtempSync(path.join(tmp, "envfile-"));
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, encodeDotenv(entries));
    const out = execFileSync(process.execPath, [`--env-file=${file}`, "-e", "process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^N\\d+$/.test(k)))))"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    const got = JSON.parse(out) as Record<string, string>;
    for (const e of entries) expect(got[e.name], JSON.stringify(e.value)).toBe(e.value);
    expect(parseDotenv(encodeDotenv(entries))).toEqual(entries);
  });

  it("review: pull names the values other dotenv readers cannot load, and points to run", async () => {
    const p = await makePerson(k, "st89cr");
    await putSecret(k, p, "dev", "PLAIN", "fine");
    await putSecret(k, p, "dev", "WITH_CR", "cr\rhere");
    const h = await signedIn(p);
    const out = path.join(h.dir, "cr.env");
    const x = again(h);
    expect(await runCli(["pull", p.domain.fqdn, "--env", "dev", "--out", out], x.io), x.err.text).toBe(EXIT.ok);
    expect(x.err.text).toContain("WITH_CR"); expect(x.err.text).not.toContain("PLAIN");
    expect(x.err.text).toContain("mosshatch run");
    expect(x.err.text).not.toContain("cr\rhere");
    expect(parseDotenv(fs.readFileSync(out, "utf8"))).toEqual([{ name: "PLAIN", value: "fine" }, { name: "WITH_CR", value: "cr\rhere" }]);
  });

  it("push then pull through the API returns every hostile value unchanged", async () => {
    const p = await makePerson(k, "st89rt");
    const h = await signedIn(p);
    const entries = hostile.map((value, i) => ({ name: `H${i}`, value }));
    const src = path.join(h.dir, "in.env");
    fs.writeFileSync(src, encodeDotenv(entries));
    const pu = again(h);
    expect(await runCli(["push", p.domain.fqdn, "--env", "dev", src], pu.io), pu.err.text).toBe(EXIT.ok);
    for (const e of entries) expect(pu.err.text).not.toContain(e.value.trim() || "\u0000");
    const out = path.join(h.dir, "out.env");
    expect(await runCli(["pull", p.domain.fqdn, "--env", "dev", "--out", out], again(h).io)).toBe(EXIT.ok);
    const back = parseDotenv(fs.readFileSync(out, "utf8"));
    expect(back.sort((x, y) => x.name.localeCompare(y.name))).toEqual(entries.sort((x, y) => x.name.localeCompare(y.name)));
  });

  it("run refuses a legacy stored reserved name, and pull omits it", async () => {
    const p = await makePerson(k, "st89res");
    await putSecret(k, p, "dev", "GOOD", "fine");
    // Stored before the name joined the list: written below the route's name check, as old data would be.
    await writeSecret(k.app.ctx, p.user.userId, { kind: "user", id: p.user.userId }, p.domain.id, "dev", "NODE_OPTIONS", Buffer.from("--require /tmp/evil.js"));
    const h = await signedIn(p);
    const marker = path.join(h.dir, "ran");
    const r = again(h);
    expect(await runCli(["run", p.domain.fqdn, "--env", "dev", "--", process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], r.io)).toBe(EXIT.reserved);
    expect(fs.existsSync(marker)).toBe(false);
    expect(r.err.text).toContain("NODE_OPTIONS");
    const s = again(h);
    expect(await runCli(["pull", p.domain.fqdn, "--stdout"], s.io)).toBe(EXIT.ok);
    expect(s.out.text).toBe('GOOD="fine"\n');
    expect(s.err.text).toContain("Left out 1 reserved name: NODE_OPTIONS");
  });

  it("push refuses reserved names in any case before sending anything", async () => {
    const p = await makePerson(k, "st89push");
    const h = await signedIn(p);
    for (const name of ["LD_PRELOAD", "ld_preload", "Path", "node_options", "DYLD_insert_libraries"]) {
      const x = again(h, { stdin: `OK=1\n${name}=x\n` });
      expect(await runCli(["push", p.domain.fqdn, "--env", "dev", "-"], x.io), name).toBe(EXIT.reserved);
    }
    const names = await k.app.call("GET", `/api/v1/domains/${p.domain.fqdn}/secrets/dev`, { cookie: p.user.cookie });
    expect(names.json.secrets).toEqual([]);
  });
});

describe("run: environment only, exit codes, signals and masking", () => {
  it("injects the secrets into the child only, returns its exit code, and removes MOSSHATCH_TOKEN from the child", async () => {
    const p = await makePerson(k, "run1");
    await putSecret(k, p, "dev", "GREETING", "hello-from-the-nest");
    const h = await signedIn(p);
    const tok = JSON.parse(fs.readFileSync(h.store.where(), "utf8")).access_token;
    const x = again(h, { tty: true });
    x.io.env.MOSSHATCH_TOKEN = tok;
    const code = await runCli(["run", p.domain.fqdn, "--", process.execPath, "-e", "process.exit(process.env.GREETING === 'hello-from-the-nest' && !process.env.MOSSHATCH_TOKEN ? 7 : 1)"], x.io);
    expect(code).toBe(7);
    expect(await runCli(["run", p.domain.fqdn, "--", process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"], again(h).io)).toBe(128 + 15);
    expect(await runCli(["run", p.domain.fqdn, "--", "/definitely/not/a/command"], again(h).io)).toBe(127);
    expect(await runCli(["run", p.domain.fqdn], again(h).io)).toBe(EXIT.usage);
  });

  it("when output is not a terminal, values printed by the child are masked (also across chunk boundaries)", async () => {
    const p = await makePerson(k, "run2");
    await putSecret(k, p, "dev", "TOKEN_LIKE", "sekrit-value-123456");
    const h = await signedIn(p);
    const x = again(h);
    expect(await runCli(["run", p.domain.fqdn, "--", process.execPath, "-e", "process.stdout.write('v=' + process.env.TOKEN_LIKE + '\\n'); process.stderr.write(process.env.TOKEN_LIKE)"], x.io)).toBe(0);
    expect(x.out.text).toBe("v=********\n"); expect(x.err.text).not.toContain("sekrit");
    const m = masker(["abcdefgh"]);
    let got = ""; m.on("data", (c) => { got += c.toString(); });
    for (const part of ["xx abc", "defg", "h yy"]) m.write(part);
    m.end(); await new Promise((r) => m.on("end", r));
    expect(got).toBe("xx ******** yy");
  });

  it("review: the masker passes ordinary output through at once and holds back only a possible start of a value", async () => {
    const secret = `s3cr3t_${"Q".repeat(40)}${crypto.randomBytes(8).toString("hex")}`;
    const m = masker([secret, "-----BEGIN PRIVATE KEY-----\n" + "A".repeat(1700)]);
    let got = "";
    m.on("data", (c) => { got += c.toString(); });
    const settle = () => new Promise((r) => setImmediate(r));
    m.write("Ready on http://localhost:3000\n"); await settle();
    expect(got).toBe("Ready on http://localhost:3000\n");
    m.write("Password? "); await settle();
    expect(got).toBe("Ready on http://localhost:3000\nPassword? ");
    // A value split across writes is still masked: only the part that could start it waits.
    m.write(`key=${secret.slice(0, 12)}`); await settle();
    expect(got.endsWith("key=")).toBe(true);
    m.write(`${secret.slice(12)} done\n`); await settle();
    expect(got).toBe("Ready on http://localhost:3000\nPassword? key=******** done\n");
    m.end(); await new Promise((r) => m.on("end", r));
    expect(got).not.toContain(secret.slice(0, 12));
  });

  it("a prod run with a dev and preview grant is refused (77), and an unavailable vault exits 75", async () => {
    const p = await makePerson(k, "run3");
    await putSecret(k, p, "prod", "P", "prod-value");
    const h = await signedIn(p);
    expect(await runCli(["run", p.domain.fqdn, "--env", "prod", "--", process.execPath, "-e", "0"], again(h).io)).toBe(EXIT.forbidden);
    const saved = (k.app.ctx.services as Record<string, unknown>).vault;
    try {
      delete (k.app.ctx.services as Record<string, unknown>).vault;
      const x = again(h);
      expect(await runCli(["pull", p.domain.fqdn, "--stdout"], x.io)).toBe(EXIT.unavailable);
      expect(x.err.text).toContain("vault is unavailable");
      expect(x.out.text).toBe("");
    } finally { (k.app.ctx.services as Record<string, unknown>).vault = saved; }
  });
});

describe("ST-33: a scripted mosshatch run leaves the canary in no log or audit row", () => {
  it("the child gets the value; logs, audit rows, jobs, mail, the CLI's own output and the disk never see it", async () => {
    const p = await makePerson(k, "st33");
    const canary = `mh_test_canary_${crypto.randomBytes(12).toString("hex")}`;
    await putSecret(k, p, "dev", "RUN_CANARY", canary);
    const h = await signedIn(p);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const before = new Set(fs.readdirSync(h.dir, { recursive: true }) as string[]);
    const x = again(h);
    const code = await runCli(["run", p.domain.fqdn, "--env", "dev", "--", process.execPath, "-e", "process.stdout.write(require('crypto').createHash('sha256').update(process.env.RUN_CANARY).digest('hex'))"], x.io);
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
    spies.forEach((s) => s.mockRestore());
    expect(code).toBe(0);
    expect(x.out.text).toBe(crypto.createHash("sha256").update(canary).digest("hex"));
    const after = (fs.readdirSync(h.dir, { recursive: true }) as string[]).filter((f) => !before.has(f));
    expect(after).toEqual([]);
    const stored = (await Promise.all(["audit_log", "jobs", "email_log", "alerts", "rate_counters", "bindings", "device_requests", "actions", "security_notice_queue"].map(async (t) => JSON.stringify((await k.app.db.owner.query(`select * from ${t}`)).rows)))).join("\n");
    const disk = fs.readFileSync(h.store.where(), "utf8");
    const hay = [logged, stored, disk, x.err.text, x.out.text, JSON.stringify(k.app.email.sent)].join("\n");
    expect(hay).not.toContain(canary); expect(hay).not.toContain(canary.slice(15));
    // The read itself is audited, by secret id and binding id only.
    const rows = (await k.app.db.owner.query("select actor_kind, detail from audit_log where chain_id = $1 and action = 'secret.read'", [p.user.userId])).rows;
    expect(rows.length).toBeGreaterThan(0); expect(rows[0].actor_kind).toBe("cli");
  });
});
