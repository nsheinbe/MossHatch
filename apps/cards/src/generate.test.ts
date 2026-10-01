import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "vite";
import { deriveCreatureSpec, portraitSvg } from "@mosshatch/core";
import { generate } from "./generate.ts";

/** Reproductions of the independent review of the hatchkind.com build (each failed on the code as reviewed). */

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT_URL = "https://mosshatch.test/api/v1/cards/public";
const KEY = "cards-export-key-for-tests-0123456789abcdef";
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Pixels an owner could upload: any PNG at all. The marker stands for rendered text or a QR code. */
const LURE = Buffer.concat([PNG_SIG, Buffer.from("PayPal: verify your account at https://lure.example/")]);
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

let tmp: string[] = [];
afterEach(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); tmp = []; });
function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cards-"));
  tmp.push(root);
  return { root, siteDir: path.join(root, "pages"), publicDir: path.join(root, "public") };
}
const card = (slug: string, o: Partial<Record<string, unknown>> = {}) => ({
  slug, species: "Ember Fox", family: "fox", rarity: "common", traits: ["common coat", "short ears", "long tail", "2 spots"], hatched_on: "2026-09-30",
  image: { url: `https://blob.test/${slug}.png`, sha256: sha(LURE), width: 256, height: 320 }, indexable: true, published_at: "2026-09-30T12:00:00.000Z", ...o,
});
/** A fake web API: the export (one page, or the pages given) behind the build key; every portrait URL answers with the lure or 404. */
function fakeFetch(pages: unknown[][], o: { missing?: string[] } = {}) {
  const calls: string[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith(EXPORT_URL)) {
      if (new Headers(init?.headers).get("x-mh-cards-key") !== KEY) return new Response('{"error":{"code":"unauthorized"}}', { status: 401 });
      const after = new URL(url).searchParams.get("after");
      const i = after === null ? 0 : Number(after.replace(/^page-(\d+)\.example$/, "$1"));
      return Response.json({ version: 1, cards: pages[i] ?? [], next: i + 1 < pages.length ? `page-${i + 1}.example` : null });
    }
    if (o.missing?.some((s) => url.includes(s))) return new Response("gone", { status: 404 });
    return new Response(new Uint8Array(LURE), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}
const env = { CARDS_EXPORT_URL: EXPORT_URL, CARDS_EXPORT_KEY: KEY, CARDS_ORIGIN: "https://hatchkind.test", WEB_ORIGIN: "https://mosshatch.test" };
const walk = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [];

describe("review: the public portrait is computed from the name", () => {
  it("review: uploaded pixels never reach hatchkind.com, and a portrait missing from storage cannot fail the build", async () => {
    const d = dirs();
    const { f, calls } = fakeFetch([[card("mossy-garden.com"), card("gone-blob.com", { family: "moth", species: "Lantern Moth" })]], { missing: ["gone-blob.com"] });
    await generate({ ...d, appDir, env, fetch: f });
    // Only the export is fetched; the stored upload is not.
    expect(calls.every((u) => u.startsWith(EXPORT_URL)), calls.join(" ")).toBe(true);
    for (const file of [...walk(d.publicDir), ...walk(d.siteDir)]) expect(fs.readFileSync(file).includes("verify your account"), file).toBe(false);
    expect(fs.readFileSync(path.join(d.publicDir, "img/mossy-garden.com.svg"), "utf8")).toBe(portraitSvg({ ...deriveCreatureSpec("mossy-garden.com"), species: "fox" }));
    expect(fs.readFileSync(path.join(d.publicDir, "img/gone-blob.com.svg"), "utf8")).toBe(portraitSvg({ ...deriveCreatureSpec("gone-blob.com"), species: "moth" }));
    const page = fs.readFileSync(path.join(d.siteDir, "mossy-garden.com/index.html"), "utf8");
    expect(page).toContain('src="/img/mossy-garden.com.svg"');
    expect(page).toContain('content="https://hatchkind.test/img/mossy-garden.com.svg"');
    expect(walk(d.publicDir).some((p) => p.endsWith(".png"))).toBe(false);
  });
});

describe("review: every build starts from an empty output", () => {
  it("review: a card gone from the export leaves no portrait behind in the public directory", async () => {
    const d = dirs();
    await generate({ ...d, appDir, env, fetch: fakeFetch([[card("first-build.com"), card("second-card.com")]]).f });
    expect(fs.readdirSync(path.join(d.publicDir, "img")).length).toBeGreaterThan(0);
    await generate({ ...d, appDir, env, fetch: fakeFetch([[]]).f });
    expect(fs.readdirSync(path.join(d.publicDir, "img"))).toEqual([]);
    expect(fs.existsSync(path.join(d.siteDir, "first-build.com"))).toBe(false);
  });
});

describe("review: names that differ only by '.' and '-' each get a page", () => {
  it("review: a-b.example and a.b.example both build, and the entry count equals the page count", async () => {
    const d = dirs();
    const out = await generate({ ...d, appDir, env, fetch: fakeFetch([[card("a-b.example"), card("a.b.example")]]).f });
    const files = Object.values(out.inputs);
    expect(files).toContain(path.join(d.siteDir, "a-b.example/index.html"));
    expect(files).toContain(path.join(d.siteDir, "a.b.example/index.html"));
    expect(new Set(files).size).toBe(walk(d.siteDir).filter((p) => p.endsWith(".html")).length);
    const outDir = path.join(d.root, "dist");
    await build({ configFile: false, logLevel: "silent", root: d.siteDir, publicDir: d.publicDir, appType: "mpa", build: { outDir, emptyOutDir: true, modulePreload: false, rollupOptions: { input: out.inputs } } });
    for (const slug of ["a-b.example", "a.b.example"]) expect(fs.readFileSync(path.join(outDir, slug, "index.html"), "utf8"), slug).toContain(`<span class="fqdn">${slug}</span>`);
  }, 60_000);
});

describe("review: the build reads the export with its key and follows every page", () => {
  it("review: all pages are read, newest first in the gallery; without the key the build stops", async () => {
    const d = dirs();
    const pages = [[card("page-a.example", { published_at: "2026-09-01T00:00:00.000Z" })], [card("page-b.example", { published_at: "2026-09-03T00:00:00.000Z" })], [card("page-c.example", { published_at: "2026-09-02T00:00:00.000Z" })]];
    const out = await generate({ ...d, appDir, env, fetch: fakeFetch(pages).f });
    expect(out.cards.map((c) => c.slug)).toEqual(["page-b.example", "page-c.example", "page-a.example"]);
    await expect(generate({ ...d, appDir, env: { ...env, CARDS_EXPORT_KEY: undefined }, fetch: fakeFetch(pages).f })).rejects.toThrow(/CARDS_EXPORT_KEY/);
  });
});
