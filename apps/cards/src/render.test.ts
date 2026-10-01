import { describe, expect, it } from "vitest";
import { validateCard, validateExport, CardDataError, type Card } from "./data.ts";
import { cardPage, galleryPage, sitemap, errorPage, type Site } from "./render.ts";

const site: Site = { cardsOrigin: "https://hatchkind.test", webOrigin: "https://mosshatch.test", sample: false };
const base = { slug: "fern.example", species: "Ember Fox", family: "fox", rarity: "common", traits: ["common coat", "short ears", "long tail", "2 spots"], hatched_on: "2026-09-30", image: null, indexable: false, published_at: "2026-09-30T12:00:00.000Z" };

describe("ST-145 cards carry no free text or outbound links", () => {
  it("the export contract refuses any extra field, free-text traits, a non-https image and a hostile slug", () => {
    expect(validateCard(base, 0).slug).toBe("fern.example");
    const bad: [string, unknown][] = [
      ["caption", { ...base, caption: "Visit my shop" }],
      ["link", { ...base, link: "https://evil.example" }],
      ["trait", { ...base, traits: ["Click here to claim"] }],
      ["species", { ...base, species: "<b>Fox</b>" }],
      ["slug", { ...base, slug: "a<script>.example" }],
      ["image", { ...base, image: { url: "http://x.example/a.png", sha256: "a".repeat(64), width: 512, height: 640 } }],
      ["image key", { ...base, image: { url: "https://x.example/a.png", sha256: "a".repeat(64), width: 512, height: 640, alt: "hi" } }],
    ];
    for (const [what, raw] of bad) expect(() => validateCard(raw, 0), what).toThrow(CardDataError);
    expect(() => validateExport({ version: 1, cards: [base, base] })).toThrow(/duplicate/);
  });

  it("a card page shows the name as text, links only to the site and to Mosshatch, has no script, and is noindex until opted in", () => {
    const c = validateCard(base, 0) as Card;
    const html = cardPage(site, c);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('<span class="fqdn">fern.example</span>');
    for (const m of html.matchAll(/href="([^"]*)"/g)) expect(m[1]!.startsWith("/") || m[1]!.startsWith("#") || m[1]!.startsWith("https://mosshatch.test/"), m[1]).toBe(true);
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).toContain('href="https://mosshatch.test/report.html#cards"');
    const listed = cardPage(site, { ...c, indexable: true });
    expect(listed).not.toContain("noindex");
    expect(listed).toContain('<link rel="canonical" href="https://hatchkind.test/fern.example/" />');
  });

  it("only opted-in cards appear in the gallery and the sitemap; error pages are noindex", () => {
    const hidden = validateCard(base, 0);
    const shown = validateCard({ ...base, slug: "moss.example", indexable: true }, 1);
    const g = galleryPage(site, [hidden, shown]);
    expect(g).toContain('href="/moss.example/"'); expect(g).not.toContain("fern.example");
    const sm = sitemap(site, [hidden, shown]);
    expect(sm).toContain("https://hatchkind.test/moss.example/"); expect(sm).not.toContain("fern.example");
    expect(errorPage(site, 404)).toContain('content="noindex"');
  });
});
