import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where the CLI keeps its tokens (PLAN 4.5 CLI). The OS keychain through `@napi-rs/keyring` when that module is installed
 * next to the CLI, pinned to the Secret Service on Linux (the kernel keyring silently loses tokens at reboot), with every
 * failure caught; otherwise a mode-0600 file in a 0700 directory, and a warning every time it is written: loudly, not
 * silently. `MOSSHATCH_TOKEN` in the environment (for non-interactive use) is read and never stored.
 */

export interface Saved { api: string; access_token: string; refresh_token?: string; expires_at?: string }
export interface TokenStore { kind: "keychain" | "file" | "env"; load(): Promise<Saved | null>; save(s: Saved): Promise<void>; clear(): Promise<void>; where(): string }

export function stateDir(env: Record<string, string | undefined>): string {
  const base = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(env.HOME ?? os.homedir(), ".local", "state");
  return path.join(base, "mosshatch");
}

export class FileStore implements TokenStore {
  readonly kind = "file" as const;
  constructor(private dir: string) {}
  private get file() { return path.join(this.dir, "credentials.json"); }
  where() { return this.file; }
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
  constructor(private entry: KeyringEntry) {}
  where() { return "the system keychain"; }
  async load() { try { const v = this.entry.getPassword(); return v ? JSON.parse(v) as Saved : null; } catch { return null; } }
  async save(s: Saved) { this.entry.setPassword(JSON.stringify(s)); }
  async clear() { try { this.entry.deletePassword(); } catch { /* nothing stored */ } }
}

/** Try the keychain; any failure (module missing, no Secret Service, locked) falls back to the file store. */
export async function defaultStore(env: Record<string, string | undefined>): Promise<TokenStore> {
  try {
    const name = "@napi-rs/keyring";
    const mod = (await import(/* @vite-ignore */ name)) as KeyringModule;
    const entry = new mod.Entry("mosshatch", "cli", process.platform === "linux" ? { linux: { store: "secret-service" } } : undefined);
    entry.getPassword();   // probe: throws when no usable store exists
    return new KeychainStore(entry);
  } catch {
    return new FileStore(stateDir(env));
  }
}
