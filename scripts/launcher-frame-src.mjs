#!/usr/bin/env node
// Set the one origin the launcher may frame Slate previews from (docs/LAUNCHER.md "Preview framing", D-061).
// vercel.json's CSP is static, so the origin is committed: this rewrites `frame-src` in vercel.json and the recorded addition in
// e2e/plan-headers.ts together (the header test compares them). The API bundles vercel.json and frames a preview only when its
// SLATE_PREVIEW_ORIGIN equals this value; otherwise the page links out to the preview instead.
//   node scripts/launcher-frame-src.mjs https://preview.slate.example     (an https origin, no path)
//   node scripts/launcher-frame-src.mjs none                              (back to frame-src 'none')
import fs from "node:fs";
const arg = process.argv[2] ?? "";
let value;
if (arg === "none") value = "'none'";
else {
  let u;
  try { u = new URL(arg); } catch { u = null; }
  if (!u || u.protocol !== "https:" || u.pathname !== "/" || u.search || u.hash || u.username || arg.includes("*")) {
    console.error("Usage: launcher-frame-src.mjs https://<preview host> | none   (an https origin, no path, no wildcard)"); process.exit(2);
  }
  value = u.origin;
}
const swap = (file, re, to) => {
  const s = fs.readFileSync(file, "utf8");
  if (!re.test(s)) { console.error(`${file}: no frame-src to update`); process.exit(1); }
  fs.writeFileSync(file, s.replace(re, to));
};
swap("vercel.json", /frame-src [^;"]+;/, `frame-src ${value};`);
swap("e2e/plan-headers.ts", /directive: "frame-src [^"]+"/, `directive: "frame-src ${value.replace(/"/g, '\\"')}"`);
console.log(`frame-src ${value} (vercel.json and e2e/plan-headers.ts). Set SLATE_PREVIEW_ORIGIN=${value === "'none'" ? "<unset>" : value} in the mosshatch project, then build.`);
