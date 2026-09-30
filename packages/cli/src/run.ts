import { spawn } from "node:child_process";
import os from "node:os";
import { Transform, type Writable } from "node:stream";

/**
 * `run`: the secrets go into the child's environment only. No shell (the command and its arguments pass unchanged), no
 * file. SIGTERM, SIGHUP and SIGQUIT are always forwarded; SIGINT only when not on a terminal (a terminal already sends it
 * to the whole foreground group). The exit code is the child's, or 128 + the signal number; 127 when the command is not
 * found and 126 when it cannot be run. When output is not a terminal, values are masked in it (best effort).
 */

export interface RunIo { stdout: Writable & { isTTY?: boolean }; stderr: Writable; stdoutIsTTY: boolean; stdinIsTTY: boolean }

const MASK = "********";

/** Replace any secret value (4+ characters) in a stream, carrying a tail across chunk boundaries. */
export function masker(values: readonly string[]): Transform {
  const vs = [...new Set(values.filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length);
  const keep = Math.max(0, ...vs.map((v) => v.length)) - 1;
  let carry = "";
  const scrub = (s: string) => { for (const v of vs) s = s.split(v).join(MASK); return s; };
  return new Transform({
    transform(chunk, _enc, cb) {
      const text = carry + chunk.toString("utf8");
      if (keep <= 0) { cb(null, scrub(text)); return; }
      const cleaned = scrub(text);
      // Hold back a tail that could be the start of a value split across chunks.
      const cut = Math.max(0, cleaned.length - keep);
      carry = cleaned.slice(cut);
      cb(null, cleaned.slice(0, cut));
    },
    flush(cb) { cb(null, scrub(carry)); },
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
