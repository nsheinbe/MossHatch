// ST-139 / ST-140: install scripts disabled, lockfile integrity present, every workflow action pinned to a full commit SHA.
import fs from "node:fs"; import path from "node:path";
let bad = 0; const fail = (m) => { console.error("supply-chain:", m); bad++; };
if (!/^ignore-scripts=true$/m.test(fs.readFileSync(".npmrc", "utf8"))) fail(".npmrc must set ignore-scripts=true");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
for (const [name, p] of Object.entries(lock.packages ?? {})) {
  if (!name || p.link || !name.includes("node_modules/")) continue;
  if (!p.integrity && !p.resolved?.startsWith("file:")) fail(`no integrity hash: ${name}`);
  if (p.resolved && !/^https:\/\/registry\.npmjs\.org\//.test(p.resolved)) fail(`unexpected registry for ${name}: ${p.resolved}`);
}
const wf = ".github/workflows";
for (const f of fs.existsSync(wf) ? fs.readdirSync(wf) : []) {
  for (const m of fs.readFileSync(path.join(wf, f), "utf8").matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
    if (m[1].startsWith("./")) continue;
    if (!/@[0-9a-f]{40}$/.test(m[1])) fail(`${f}: action not pinned to a commit SHA: ${m[1]}`);
  }
}
if (bad) process.exit(1); console.log("supply-chain: ok");
