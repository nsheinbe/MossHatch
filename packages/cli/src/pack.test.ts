import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** ST-141: the packed CLI has no install scripts, its dependency list equals the reviewed allow-list, and it is one file. */

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
/** The reviewed allow-list of runtime dependencies: none. The keychain module is optional and never bundled or declared. */
const ALLOWED_DEPENDENCIES: string[] = [];
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "preprepare", "postprepare", "prepack", "postpack"];

describe("ST-141: the packed CLI", () => {
  it("declares no install scripts and exactly the allowed dependencies", () => {
    for (const s of INSTALL_SCRIPTS) expect(pkg.scripts?.[s], s).toBeUndefined();
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(ALLOWED_DEPENDENCIES);
    for (const f of ["optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"]) expect(pkg[f], f).toBeUndefined();
    expect(pkg.private).toBeUndefined();
    expect(pkg.bin).toEqual({ mosshatch: "dist/mosshatch.mjs" });
    expect(pkg.publishConfig.provenance).toBe(true);
  });

  it("the tarball holds one bundled file, its SHA-256 and the manifest; the bundle imports only Node built-ins", () => {
    execFileSync(process.execPath, [path.join(pkgDir, "build.mjs")], { cwd: pkgDir, stdio: "pipe" });
    const bundle = fs.readFileSync(path.join(pkgDir, "dist/mosshatch.mjs"), "utf8");
    expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
    const sum = fs.readFileSync(path.join(pkgDir, "dist/mosshatch.mjs.sha256"), "utf8");
    expect(sum).toBe(`${crypto.createHash("sha256").update(bundle).digest("hex")}  mosshatch.mjs\n`);
    const imports = [...bundle.matchAll(/^import\s.*?from\s+"([^"]+)"/gm), ...bundle.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]!);
    for (const i of imports) expect(i, i).toMatch(/^node:/);
    expect(bundle).not.toMatch(/\brequire\(\s*["'](?!node:)/);
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: pkgDir, encoding: "utf8", env: { ...process.env, npm_config_offline: "true" } });
    const info = JSON.parse(out)[0] as { files: { path: string }[]; name: string };
    expect(info.name).toBe("@mosshatch/cli");
    expect(info.files.map((f) => f.path).sort()).toEqual(["dist/mosshatch.mjs", "dist/mosshatch.mjs.sha256", "package.json"]);
    // The built file runs and prints plain help.
    const help = execFileSync(process.execPath, [path.join(pkgDir, "dist/mosshatch.mjs"), "help"], { encoding: "utf8" });
    expect(help).toMatch(/^mosshatch 0\.1\.0/);
  });

  it("publishing refuses outside a tagged CI run", () => {
    let code = 0;
    try { execFileSync(process.execPath, [path.join(pkgDir, "build.mjs"), "--ci-only"], { cwd: pkgDir, stdio: "pipe", env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_REF: "" } }); } catch (e) { code = (e as { status: number }).status; }
    expect(code).toBe(1);
  });
});
