// Every ST-nn defined in PLAN.md 4.6 must be due in a phase of section 5 (ST-140 companion: CI job named in the plan).
import fs from "node:fs";
const plan = fs.readFileSync("docs/PLAN.md", "utf8");
const defined = new Set([...plan.matchAll(/^- (ST-\d+) /gm)].map((m) => m[1]));
const sec5 = plan.slice(plan.indexOf("## 5. Phases 1 to 6"), plan.indexOf("## 6."));
const due = new Set();
for (const line of sec5.split("\n")) {
  if (!line.startsWith("**Exit criteria.**")) continue;
  const text = line.replace(/\(Phase.*?\)/g, "");
  for (const m of text.matchAll(/ST-(\d+)(?:\s+to\s+ST-(\d+))?/g)) { const a = +m[1], b = m[2] ? +m[2] : a; for (let i = a; i <= b; i++) due.add(`ST-${String(i).padStart(2, "0")}`); }
}
const missing = [...defined].filter((id) => !due.has(id));
const unknown = [...due].filter((id) => !defined.has(id));
console.log(`ST ids defined ${defined.size}, due in a phase ${due.size}`);
if (missing.length || unknown.length) { console.error("missing from phases:", missing.join(", ") || "none", "| not defined:", unknown.join(", ") || "none"); process.exit(1); }
