/**
 * Encoders for `pull` and the parser for `push` (PLAN 4.5 CLI). Every value is quoted, so none can end its line, open a
 * substitution or be read as a comment, and each gets the first form that the common readers (Node's --env-file, the
 * dotenv package, docker compose) and this parser all read back unchanged:
 *   1. `"value"` when it holds no backslash, double quote, `$`, newline, carriage return or NUL;
 *   2. `"a\nb"` when its only such character is a newline (every reader turns `\n` into a newline);
 *   3. `'value'`, literal, when it holds no single quote, carriage return or NUL (newlines stay raw inside);
 *   4. a backtick-quoted literal when it holds a single quote but no backtick, carriage return or NUL;
 *   5. otherwise the escaped double-quoted form below, which only this parser reads back (`unportableNames` lists them).
 * Review deviation from PLAN 4.5: the plan's single escaped double-quoted form is read wrongly by Node and dotenv (they do
 * not unescape `\\`, `\"` or `\$`), so it is now the last resort. `--format shell` single-quotes, for `. file` in a
 * POSIX shell. Hostile values round-trip unchanged (ST-89).
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Which of the forms above a value takes (5 is readable by this parser only). */
export function dotenvForm(v: string): 1 | 2 | 3 | 4 | 5 {
  const special = /[\\"$\n\r\0]/.test(v);
  if (!special) return 1;
  if (!/[\\"$\r\0]/.test(v)) return 2;
  if (!/['\r\0]/.test(v)) return 3;
  if (!/[`\r\0]/.test(v)) return 4;
  return 5;
}

/** Names whose values only `mosshatch push` reads back from a dotenv file (a carriage return, a NUL, or every quote kind). */
export function unportableNames(entries: readonly { name: string; value: string }[]): string[] {
  return entries.filter((e) => dotenvForm(e.value) === 5).map((e) => e.name);
}

export function encodeDotenvValue(v: string): string {
  const form = dotenvForm(v);
  if (form === 1) return `"${v}"`;
  if (form === 2) return `"${v.replace(/\n/g, "\\n")}"`;
  if (form === 3) return `'${v}'`;
  if (form === 4) return `\`${v}\``;
  let out = '"';
  for (const ch of v) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "$") out += "\\$";
    else if (ch === "\0") out += "\\0";
    else out += ch;
  }
  return out + '"';
}

export function encodeDotenv(entries: readonly { name: string; value: string }[]): string {
  return entries.map((e) => { if (!NAME.test(e.name)) throw new Error("bad name"); return `${e.name}=${encodeDotenvValue(e.value)}\n`; }).join("");
}

/** POSIX single quotes: nothing inside is special except the quote itself, written as '\''. NUL cannot live in a shell string. */
export function encodeShell(entries: readonly { name: string; value: string }[]): string {
  return entries.map((e) => {
    if (!NAME.test(e.name)) throw new Error("bad name");
    if (e.value.includes("\0")) throw new ShellNulError();
    return `export ${e.name}='${e.value.replace(/'/g, "'\\''")}'\n`;
  }).join("");
}
export class ShellNulError extends Error { constructor() { super("A value contains a NUL byte, which a shell cannot hold. Use the dotenv format."); } }

export class DotenvError extends Error { constructor(public line: number) { super(`line ${line} is not NAME=value`); } }

/** Parse dotenv text: `NAME="escaped"`, `NAME='literal'`, NAME=`literal`, `NAME=plain` (trailing ` #comment` dropped), `export ` allowed. */
export function parseDotenv(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const src = text.replace(/^\uFEFF/, "");
  let i = 0, line = 1;
  const n = src.length;
  while (i < n) {
    // Skip blank lines and comments.
    let j = i;
    while (j < n && (src[j] === " " || src[j] === "\t")) j++;
    if (j >= n) break;
    if (src[j] === "\n" || src[j] === "\r") { i = j + (src[j] === "\r" && src[j + 1] === "\n" ? 2 : 1); line++; continue; }
    if (src[j] === "#") { while (j < n && src[j] !== "\n") j++; i = j + 1; line++; continue; }
    if (src.startsWith("export ", j)) j += 7;
    const eq = src.indexOf("=", j);
    const nl = src.indexOf("\n", j);
    if (eq < 0 || (nl >= 0 && nl < eq)) throw new DotenvError(line);
    const name = src.slice(j, eq).trim();
    if (!NAME.test(name)) throw new DotenvError(line);
    let k = eq + 1, value = "";
    if (src[k] === '"') {
      k++;
      let closed = false;
      while (k < n) {
        const ch = src[k]!;
        if (ch === "\\" && k + 1 < n) {
          const e = src[k + 1]!;
          value += e === "n" ? "\n" : e === "r" ? "\r" : e === "0" ? "\0" : e === "t" ? "\t" : e;
          k += 2; continue;
        }
        if (ch === '"') { closed = true; k++; break; }
        if (ch === "\n") line++;
        value += ch; k++;
      }
      if (!closed) throw new DotenvError(line);
    } else if (src[k] === "'" || src[k] === "`") {
      const end = src.indexOf(src[k]!, k + 1);
      if (end < 0) throw new DotenvError(line);
      value = src.slice(k + 1, end);
      line += (value.match(/\n/g) ?? []).length;
      k = end + 1;
    } else {
      const end = src.indexOf("\n", k);
      value = src.slice(k, end < 0 ? n : end).replace(/\r$/, "").replace(/\s+#.*$/, "").trim();
      k = end < 0 ? n : end;
    }
    // Only spaces or a comment may follow a quoted value.
    while (k < n && (src[k] === " " || src[k] === "\t")) k++;
    if (k < n && src[k] === "#") while (k < n && src[k] !== "\n") k++;
    if (k < n && src[k] === "\r") k++;
    if (k < n && src[k] !== "\n") throw new DotenvError(line);
    out.push({ name, value });
    i = k + 1; line++;
  }
  return out;
}
