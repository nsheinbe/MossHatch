import { spawn } from "node:child_process";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { Transform, type Writable } from "node:stream";

/**
 * `run`: the secrets go into the child's environment only. No shell (the command and its arguments pass unchanged), no
 * file. SIGTERM, SIGHUP and SIGQUIT are always forwarded; SIGINT only when not on a terminal (a terminal already sends it
 * to the whole foreground group). The exit code is the child's, or 128 + the signal number; 127 when the command is not
 * found and 126 when it cannot be run. When output is not a terminal, values are masked in it (best effort).
 */

export interface RunIo { stdout: Writable & { isTTY?: boolean }; stderr: Writable; stdoutIsTTY: boolean; stdinIsTTY: boolean }

const MASK = "********";

/**
 * The length of the longest tail of `s` that is the start of some value (and not a whole one): only that much can be the
 * first part of a value split across chunks, so only that much waits. Ordinary output passes at once.
 */
export function pendingTail(s: string, values: readonly string[]): number {
  let best = 0;
  for (const v of values) {
    for (let pos = Math.max(0, s.length - (v.length - 1)); pos < s.length - best; pos++) {
      if (s.charCodeAt(pos) === v.charCodeAt(0) && v.startsWith(s.slice(pos))) { best = s.length - pos; break; }
    }
  }
  return best;
}

/** Replace any secret value (4+ characters) in a stream, carrying across chunk boundaries only a tail that could start one. */
export function masker(values: readonly string[]): Transform {
  const vs = [...new Set(values.filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length);
  let carry = "";
  // A chunk can end inside a multi-byte character: decode across chunks, never chunk by chunk.
  const decoder = new StringDecoder("utf8");
  const scrub = (s: string) => { for (const v of vs) s = s.split(v).join(MASK); return s; };
  return new Transform({
    transform(chunk, _enc, cb) {
      const cleaned = scrub(carry + decoder.write(chunk as Buffer));
      const cut = cleaned.length - pendingTail(cleaned, vs);
      carry = cleaned.slice(cut);
      cb(null, cleaned.slice(0, cut));
    },
    flush(cb) { cb(null, scrub(carry + decoder.end())); },
  });
}

export async function runChild(cmd: string[], env: NodeJS.ProcessEnv, values: readonly string[], io: RunIo, o: { mask: boolean }): Promise<number> {
  const piped = o.mask && !io.stdoutIsTTY;
  const child = spawn(cmd[0]!, cmd.slice(1), { env, stdio: ["inherit", piped ? "pipe" : "inherit", piped ? "pipe" : "inherit"], shell: false });
  if (piped) {
    child.stdout!.pipe(masker(values)).pipe(io.stdout, { end: false });
    child.stderr!.pipe(masker(values)).pipe(io.stderr, { end: false });
  }
  const forward = (sig: NodeJS.Signals) => () => { try { child.kill(sig); } catch { /* already gone */ } };
  const sigs: NodeJS.Signals[] = ["SIGTERM", "SIGHUP", "SIGQUIT", ...(io.stdinIsTTY ? [] : (["SIGINT"] as NodeJS.Signals[]))];
  const handlers = sigs.map((s) => [s, forward(s)] as const);
  for (const [s, h] of handlers) process.on(s, h);
  // A terminal's Ctrl-C reaches the child directly; the wrapper waits for it rather than dying first.
  const ignoreInt = () => undefined;
  if (io.stdinIsTTY) process.on("SIGINT", ignoreInt);
  try {
    return await new Promise<number>((resolve) => {
      child.on("error", (e: NodeJS.ErrnoException) => resolve(e.code === "ENOENT" ? 127 : e.code === "EACCES" ? 126 : 1));
      child.on("close", (code, signal) => resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)));
    });
  } finally {
    for (const [s, h] of handlers) process.off(s, h);
    if (io.stdinIsTTY) process.off("SIGINT", ignoreInt);
  }
}
