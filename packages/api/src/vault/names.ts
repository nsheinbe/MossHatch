/**
 * Secret names (PLAN 4.4 `secrets.name`, 4.6 rows 4 and 22). A name is normalised (Unicode NFKC, surrounding space
 * trimmed, ASCII letters upper-cased), then must match `^[A-Z][A-Z0-9_]{0,127}$`, must not look like a credential a
 * client-bundle scanner would flag (someone pasted a value into the name field), and must not be on the versioned reserved
 * list of variables that change how a program starts (compared case-insensitively). Every refusal is the same generic 422
 * and the input is never echoed, logged or audited: the audit row carries a reason code only.
 */

export const NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
export const RESERVED_NAMES_VERSION = 1;

/** Exact names. */
export const RESERVED_NAMES: readonly string[] = [
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "PWD", "OLDPWD", "TMPDIR", "IFS", "PS4", "ENV", "BASH_ENV", "PROMPT_COMMAND",
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_REPL_EXTERNAL_MODULE",
  "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PYTHONINSPECT", "PYTHONUSERBASE",
  "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "PERLLIB",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH",
  "GIT_SSH_COMMAND", "GIT_SSH", "GIT_ASKPASS", "GIT_EXEC_PATH", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "SSH_ASKPASS", "EDITOR", "VISUAL", "PAGER",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "FTP_PROXY",
  "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_REGISTRY", "NPM_CONFIG_PREFIX", "COREPACK_HOME", "BUN_INSTALL",
  "MOSSHATCH_TOKEN", "MOSSHATCH_API_URL",
];
/** Prefixes (any name that starts with one is reserved). */
export const RESERVED_PREFIXES: readonly string[] = ["LD_", "DYLD_", "GIT_CONFIG_", "BASH_FUNC_", "VERCEL_", "AWS_", "NPM_CONFIG_", "MOSSHATCH_"];

/** Credential shapes a client-bundle scanner flags, looked for in the raw input (a value pasted into the name field). */
const SCANNER_RULES: readonly RegExp[] = [
  /sk_(live|test)_/i, /rk_(live|test)_/i, /whsec_/i, /mh_(live|cli|clr)_/i, /mh_test_canary_/i,
  /gh[pousr]_[A-Za-z0-9]{8,}/, /github_pat_/i, /AKIA[0-9A-Z]{12,}/, /ASIA[0-9A-Z]{12,}/, /xox[abposr]-/i,
  /-----BEGIN/, /eyJ[A-Za-z0-9_-]{8,}\./, /re_[A-Za-z0-9]{16,}/, /npg_[A-Za-z0-9]{8,}/, /AIza[0-9A-Za-z_-]{20,}/,
];

export type NameRejection = "grammar" | "scanner" | "reserved" | "length";

export type NameResult = { ok: true; name: string } | { ok: false; reason: NameRejection };

export function isReserved(name: string): boolean {
  const n = name.toUpperCase();
  return RESERVED_NAMES.includes(n) || RESERVED_PREFIXES.some((p) => n.startsWith(p));
}

export function normalizeSecretName(raw: unknown): NameResult {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "grammar" };
  if (raw.length > 256) return { ok: false, reason: "length" };
  if (SCANNER_RULES.some((r) => r.test(raw))) return { ok: false, reason: "scanner" };
  const n = raw.normalize("NFKC").trim().replace(/[a-z]/g, (c) => c.toUpperCase());
  if (n.length > 128) return { ok: false, reason: "length" };
  if (!NAME_RE.test(n)) return { ok: false, reason: "grammar" };
  if (SCANNER_RULES.some((r) => r.test(n))) return { ok: false, reason: "scanner" };
  if (isReserved(n)) return { ok: false, reason: "reserved" };
  return { ok: true, name: n };
}
