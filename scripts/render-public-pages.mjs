// Pre-renders the public pages of apps/web (legal documents, commitments, security policy, report, 404 and 500) from the fragments in
// apps/web/pages into complete static HTML under apps/web/public. The output is deterministic (no dates, no build ids), because each
// legal document's version is the SHA-256 of its file (packages/api/src/account/documents.ts).
// Usage: node scripts/render-public-pages.mjs [--check]   --check fails when the committed output is stale (the web build runs it).
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SRC = path.join(root, "apps/web/pages");
export const OUT = path.join(root, "apps/web/public");
export const WEB_ORIGIN = "https://mosshatch.com";

const BANNERS = {
  counsel: "<strong>Draft awaiting counsel.</strong> Counsel has not drafted or approved this text. It is a placeholder, not the final document, and not legal advice.",
  review: "<strong>Draft awaiting counsel.</strong> We wrote this page and counsel has not reviewed its wording yet. It is not legal advice.",
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function parseFragment(text) {
  const meta = {};
  let body = text;
  for (;;) {
    const m = /^<!-- ([a-z]+): (.*?) -->\n/.exec(body);
    if (!m) break;
    meta[m[1]] = m[2]; body = body.slice(m[0].length);
  }
  if (!meta.title) throw new Error("fragment without a title");
  return { meta, body: body.trim() };
}

/** Clean URL of an output path: legal/index.html -> /legal/, security.html -> /security. */
export const cleanPath = (rel) => "/" + rel.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "");

export function renderPage(rel, { meta, body }) {
  const banner = meta.draft && meta.draft !== "none" ? `<p class="draft-banner" role="note">${BANNERS[meta.draft]}</p>\n` : "";
  const robots = meta.robots ? `<meta name="robots" content="${esc(meta.robots)}" />\n` : "";
  const canonical = meta.robots?.includes("noindex") ? "" : `<link rel="canonical" href="${WEB_ORIGIN}${cleanPath(rel)}" />\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>${esc(meta.title)} · Mosshatch</title>
<meta name="description" content="${esc(meta.description ?? "")}" />
${robots}${canonical}<link rel="stylesheet" href="/commitments.css" />
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site">
<a class="wordmark" href="/">Mosshatch</a>
<nav aria-label="Site"><a href="/fees.html">Fees</a> <a href="/commitments.html">Commitments</a> <a href="/legal/index.html">Legal</a> <a href="/security.html">Security</a> <a href="/report.html">Report abuse</a></nav>
</header>
<main id="main">
${banner}${body}
</main>
<footer class="site">
<p>Mosshatch is a domain reseller, not an ICANN-accredited registrar. See <a href="/legal/registrant-rights.html">registrar of record and your rights</a>.</p>
<p>Contact <a href="mailto:support@mosshatch.com">support@mosshatch.com</a>. Report abuse to <a href="mailto:abuse@mosshatch.com">abuse@mosshatch.com</a>. Security reports to <a href="mailto:security@mosshatch.com">security@mosshatch.com</a>.</p>
</footer>
</body>
</html>
`;
}

export function listFragments(dir = SRC, base = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFragments(dir, rel));
    else if (e.name.endsWith(".html")) out.push(rel);
  }
  return out.sort();
}

export function renderAll() {
  return new Map(listFragments().map((rel) => [rel, renderPage(rel, parseFragment(fs.readFileSync(path.join(SRC, rel), "utf8")))]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  const stale = [];
  for (const [rel, html] of renderAll()) {
    const dest = path.join(OUT, rel);
    const cur = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;
    if (cur === html) continue;
    if (check) { stale.push(rel); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, html);
    console.log(`pages: wrote ${rel}`);
  }
  if (stale.length) { console.error(`pages: stale output, run npm run pages: ${stale.join(", ")}`); process.exit(1); }
  if (check) console.log("pages: public pages are current");
}
