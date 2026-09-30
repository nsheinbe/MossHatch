import fs from "node:fs";
import path from "node:path";

/**
 * `pull --out`: the file is created with O_EXCL and mode 0600 (never overwritten, never followed through a symlink), and
 * a path inside a `.git` directory is refused (ST-90), checked on the path as given and on its resolved parent.
 */
export class OutRefused extends Error { constructor(public reason: "git" | "symlink" | "exists" | "parent") { super(reason); } }

const inGit = (p: string) => p.split(path.sep).some((s) => s.toLowerCase() === ".git");

export function writeSecretFile(target: string, contents: string): string {
  const abs = path.resolve(target);
  if (inGit(abs)) throw new OutRefused("git");
  let parent: string;
  try { parent = fs.realpathSync(path.dirname(abs)); } catch { throw new OutRefused("parent"); }
  if (inGit(parent)) throw new OutRefused("git");
  try { if (fs.lstatSync(abs).isSymbolicLink()) throw new OutRefused("symlink"); throw new OutRefused("exists"); }
  catch (e) { if (e instanceof OutRefused) throw e; /* ENOENT: good */ }
  const final = path.join(parent, path.basename(abs));
  let fd: number;
  try { fd = fs.openSync(final, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (e) { throw new OutRefused((e as NodeJS.ErrnoException).code === "ELOOP" ? "symlink" : "exists"); }
  try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return final;
}
