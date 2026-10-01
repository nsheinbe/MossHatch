import { describe, expect, it } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { PERSISTED_KEYS } from "./index";

const src = path.resolve(__dirname, "..");
function files(d: string): string[] { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".test.ts") ? [path.join(d, e.name)] : []); }
const all = files(src);
const read = (f: string) => fs.readFileSync(f, "utf8");

describe("store contract (ST-37)", () => {
  it("persists only calm, sound and rehideSeconds", () => expect([...PERSISTED_KEYS]).toEqual(["calm", "sound", "rehideSeconds"]));
  it("bans dangerouslySetInnerHTML and string-built HTML", () => {
    for (const f of all) { const t = read(f); expect(t, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write/); }
  });
  it("keeps three.js inside src/world and the debug entry", () => {
    for (const f of all) { if (f.includes(`${path.sep}world${path.sep}`) || f.endsWith("debug.tsx")) continue; expect(read(f), f).not.toMatch(/from "three/); }
  });
  it("keeps the store free of world and network imports", () => {
    const t = read(path.join(src, "store", "index.ts"));
    expect(t).not.toMatch(/world|fetch\(|XMLHttpRequest|localStorage|sessionStorage/);
  });
  it("uses no eval or Function constructor (CSP has no unsafe-eval)", () => {
    for (const f of all) expect(read(f), f).not.toMatch(/\beval\(|new Function\(/);
  });
});
