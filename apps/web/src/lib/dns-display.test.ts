import { describe, expect, it } from "vitest";
import { dnsReviewText } from "./dns-display";

describe("ST-201 exact owner DNS review", () => {
  it("preserves long values, decomposed Unicode and literal escape text without hidden direction controls", () => {
    const original = `${"x".repeat(2048)}e\u0301\u202e\u2066\u200b\\u202e\"tail`;
    const shown = dnsReviewText(original);
    expect(JSON.parse(shown)).toBe(original);
    expect(shown).not.toContain("\u202e");
    expect(shown).not.toContain("\u2066");
    expect(shown).not.toContain("\u200b");
    expect(shown).toContain("\\u202e");
    expect(shown).toContain("tail");
  });

  it("makes newline, tab and C1 controls visible without treating record text as markup", () => {
    const original = "<script>bad()</script>\n\t\u0085";
    const shown = dnsReviewText(original);
    expect(JSON.parse(shown)).toBe(original);
    expect(shown).not.toMatch(/[\n\t\u0085]/);
  });
});
