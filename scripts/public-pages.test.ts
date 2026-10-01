import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { renderAll, listFragments, parseFragment, SRC, OUT } from "./render-public-pages.mjs";

/** RFC 9116 parser: fields per line, comments ignored. */
function parseSecurityTxt(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z-]+): (.+)$/.exec(line);
    if (!m) throw new Error(`bad line: ${line}`);
    const k = m[1]!.toLowerCase();
    out.set(k, [...(out.get(k) ?? []), m[2]!]);
  }
  return out;
}

const DAY = 86_400_000;
const files = [
  { file: "apps/web/public/.well-known/security.txt", canonical: "https://mosshatch.com/.well-known/security.txt" },
  { file: "apps/cards/public/.well-known/security.txt", canonical: "https://hatchkind.com/.well-known/security.txt" },
];

describe("D-032 /.well-known/security.txt (RFC 9116) on both origins", () => {
  for (const { file, canonical } of files) {
    it(`${file}: Contact, Expires within a year, Policy, Canonical, Preferred-Languages`, () => {
      const f = parseSecurityTxt(fs.readFileSync(file, "utf8"));
      // RFC 9116 2.5.3 and 2.5.5: Contact at least once, Expires exactly once.
      expect(f.get("contact")?.length ?? 0).toBeGreaterThanOrEqual(1);
      for (const c of f.get("contact")!) expect(c).toMatch(/^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/);
      expect(f.get("expires")).toHaveLength(1);
      const expires = f.get("expires")![0]!;
      expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/);
      const left = Date.parse(expires) - Date.now();
      // In the future, less than a year away (RFC 9116 2.5.5 recommends under a year), and renewed at least 30 days before it lapses.
      expect(left, "Expires has passed or is within 30 days: renew security.txt").toBeGreaterThan(30 * DAY);
      expect(left, "Expires is more than a year away").toBeLessThanOrEqual(366 * DAY);
      expect(f.get("canonical")).toEqual([canonical]);
      expect(f.get("policy")).toEqual(["https://mosshatch.com/security"]);
      expect(f.get("preferred-languages")).toEqual(["en"]);
      for (const k of f.keys()) expect(["contact", "expires", "encryption", "acknowledgments", "preferred-languages", "canonical", "policy", "hiring", "csaf"]).toContain(k);
    });
  }

  it("the policy page it points to exists, offers safe harbor and is marked as awaiting counsel", () => {
    const html = fs.readFileSync("apps/web/public/security.html", "utf8");
    expect(html).toContain("Safe harbor");
    expect(html).toContain("mailto:security@mosshatch.com");
    expect(html).toContain("Draft awaiting counsel");
  });
});

describe("C-72 pre-rendered public pages", () => {
  it("the committed pages in apps/web/public equal a fresh render of apps/web/pages (so each document's hash is stable)", () => {
    const rendered: Map<string, string> = renderAll();
    expect(rendered.size).toBe(listFragments().length);
    for (const [rel, html] of rendered) expect(fs.readFileSync(path.join(OUT, rel), "utf8"), rel).toBe(html);
  });

  it("every page is complete static HTML with real content, no script, and a draft banner unless it is an index or error page", () => {
    for (const rel of listFragments() as string[]) {
      const { meta } = parseFragment(fs.readFileSync(path.join(SRC, rel), "utf8"));
      const html = fs.readFileSync(path.join(OUT, rel), "utf8");
      expect(html, rel).toMatch(/^<!doctype html>/);
      expect(html, rel).toMatch(/<h1>[^<]+<\/h1>/);
      expect(html, rel).not.toMatch(/<script/i);
      if (meta.draft !== "none") expect(html, rel).toContain("Draft awaiting counsel.");
      if (rel === "404.html" || rel === "500.html") expect(html).toContain('<meta name="robots" content="noindex" />');
    }
  });
});
