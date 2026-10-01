// Fails the build if a secret-shaped string, a required server variable's value, or a debug-only marker reaches a client bundle.
// Usage: node scripts/scan-client-bundle.mjs <dir>... [--require-env=A,B] [--forbid=str,str]
import fs from "node:fs"; import path from "node:path";
export const PATTERNS = [
  ["stripe secret key", /\b(sk|rk)_(live|test)_[0-9A-Za-z]{16,}/],
  ["stripe webhook secret", /\bwhsec_[0-9A-Za-z]{16,}/],
  ["aws access key id", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ["postgres url with password", /postgres(?:ql)?:\/\/[^\s:@/"']+:[^\s@/"']{4,}@/],
  ["bearer token literal", /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/],
  ["github token", /\bgh[pousr]_[0-9A-Za-z]{30,}/],
  ["resend key", /\bre_[0-9A-Za-z]{20,}\b/],
  ["mosshatch token", /\bmh_(?:live|dev|test)_[0-9A-Za-z]{16,}/],
];
export function scanText(text, opts = {}) {
  const hits = [];
  for (const [name, re] of PATTERNS) { const m = re.exec(text); if (m) hits.push(`${name}: ${m[0].slice(0, 12)}…`); }
  for (const f of opts.forbid ?? []) if (f && text.includes(f)) hits.push(`forbidden string: ${f}`);
  for (const v of opts.values ?? []) if (v.length >= 8 && text.includes(v)) hits.push("a server variable's value");
  return hits;
}
function* walk(d) {
  if (fs.statSync(d).isFile()) { yield d; return; } for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else if (!/\.(woff2?|png|jpg|ico)$/.test(e.name)) yield p; } }
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dirs = args.filter((a) => !a.startsWith("--"));
  const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=")?.split(",").filter(Boolean) ?? [];
  const required = opt("require-env");
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) { console.error(`scan: required variable(s) not visible in this build: ${missing.join(", ")}`); process.exit(2); }
  const values = required.map((k) => process.env[k]);
  let bad = 0;
  for (const d of dirs) {
    if (!fs.existsSync(d)) { console.error(`scan: ${d} does not exist`); process.exit(2); }
    for (const f of walk(d)) { const hits = scanText(fs.readFileSync(f, "utf8"), { forbid: opt("forbid"), values }); for (const h of hits) { console.error(`scan: ${f}: ${h}`); bad++; } }
  }
  if (bad) process.exit(1);
  console.log(`scan: clean (${dirs.join(", ")})`);
}
