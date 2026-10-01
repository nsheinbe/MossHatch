import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where the CLI keeps its tokens (PLAN 4.5 CLI). The OS keychain through `@napi-rs/keyring` when that module is installed
 * next to the CLI, pinned to the Secret Service on Linux (the kernel keyring silently loses tokens at reboot), with every
 * failure caught; otherwise a mode-0600 file in a 0700 directory, and a warning every time it is written: loudly, not
 * silently. `MOSSHATCH_TOKEN` in the environment (for non-interactive use) is read and never stored.
 * Deviation (review): the published package declares no dependencies (ST-141), so the module is not installed by
 * `npm i -g @mosshatch/cli` and the file is what a plain install uses; the login warning and the help say so.
 */

export interface Saved { api: string; access_token: string; refresh_token?: string; expires_at?: string }
export interface TokenStore {
  kind: "keychain" | "file" | "env";
  load(): Promise<Saved | null>; save(s: Saved): Promise<void>; clear(): Promise<void>; where(): string;
  /** Run `fn` holding this store's refresh lock, so two commands never present the same refresh token (a reuse revokes it). */
  lock?<T>(fn: () => Promise<T>): Promise<T>;
}

/** A holder that died leaves its lock behind; a refresh takes well under this. */
const LOCK_STALE_MS = 30_000;

/**
 * An exclusive lock file (O_EXCL, never followed through a symlink) in the state directory. Real time, not the injected
 * clock: it orders real processes. A lock older than 30 seconds is taken over.
 */
export async function withLockFile<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "refresh.lock");
  let fd: number | null = null;
  while (fd === null) {
    try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try { if (Date.now() - fs.lstatSync(file).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(file); continue; } } catch { continue; }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try { return await fn(); }
  finally { fs.closeSync(fd); try { fs.unlinkSync(file); } catch { /* already gone */ } }
}

export function stateDir(env: Record<string, string | undefined>): string {
  const base = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(env.HOME ?? os.homedir(), ".local", "state");
  return path.join(base, "mosshatch");
}

export class FileStore implements TokenStore {
  readonly kind = "file" as const;
  /** Why the keychain is not used, when this store is the fallback: the module is not installed, or no keychain answered. */
  constructor(private dir: string, readonly fallbackReason?: "module_missing" | "keychain_unavailable") {}
  private get file() { return path.join(this.dir, "credentials.json"); }
  where() { return this.file; }
  lock<T>(fn: () => Promise<T>): Promise<T> { return withLockFile(this.dir, fn); }
  async load(): Promise<Saved | null> {
    try {
      const st = fs.lstatSync(this.file);
      if (!st.isFile() || (st.mode & 0o077) !== 0) return null;   // a symlink or a file others can read is not trusted
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as Saved;
    } catch { return null; }
  }
  async save(s: Saved): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    const tmp = path.join(this.dir, `.credentials.${process.pid}.${Date.now()}.tmp`);
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(fd, JSON.stringify(s)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
  }
  async clear(): Promise<void> { try { fs.unlinkSync(this.file); } catch { /* already gone */ } }
}

interface KeyringEntry { getPassword(): string | null; setPassword(p: string): void; deletePassword(): boolean }
type KeyringModule = { Entry: new (service: string, account: string, opts?: unknown) => KeyringEntry };

export class KeychainStore implements TokenStore {
  readonly kind = "keychain" as const;
  /** `file` is the fallback file store of the same state directory: its lock orders refreshes, and `clear` removes any
   * sign-in an earlier run left there when the keychain was not usable. */
  constructor(private entry: KeyringEntry, private file?: FileStore) {}
  where() { return "the system keychain"; }
  async load() { try { const v = this.entry.getPassword(); return v ? JSON.parse(v) as Saved : null; } catch { return null; } }
  async save(s: Saved) { this.entry.setPassword(JSON.stringify(s)); }
  async clear() { try { this.entry.deletePassword(); } catch { /* nothing stored */ } await this.file?.clear(); }
  lock<T>(fn: () => Promise<T>): Promise<T> { return this.file ? this.file.lock(fn) : fn(); }
}

/** Try the keychain; any failure (module missing, no Secret Service, locked) falls back to the file store, which says why. */
export async function defaultStore(env: Record<string, string | undefined>): Promise<TokenStore> {
  let mod: KeyringModule;
  try {
    const name = "@napi-rs/keyring";
    mod = (await import(/* @vite-ignore */ name)) as KeyringModule;
  } catch {
    return new FileStore(stateDir(env), "module_missing");
  }
  try {
    const entry = new mod.Entry("mosshatch", "cli", process.platform === "linux" ? { linux: { store: "secret-service" } } : undefined);
    entry.getPassword();   // probe: throws when no usable store exists
    return new KeychainStore(entry, new FileStore(stateDir(env)));
  } catch {
    return new FileStore(stateDir(env), "keychain_unavailable");
  }
}
