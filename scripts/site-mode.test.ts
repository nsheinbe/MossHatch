import { describe, expect, it } from "vitest";
import { BANNER, INVITE_BANNER, bannerKind, siteMode, transformHome, transformPage } from "./site-mode.mjs";

const page = `<!doctype html>\n<html lang="en">\n<head><title>Fees · Mosshatch</title></head>\n<body>\n<main>Fees</main>\n</body>\n</html>`;

describe("static page banner by build", () => {
  it("picks the banner from the build's environment", () => {
    expect(bannerKind({})).toBe("demo");
    expect(bannerKind({ VITE_SITE_MODE: "demo", VITE_API_ENABLED: "1" })).toBe("demo");
    expect(bannerKind({ VITE_SITE_MODE: "invite", VITE_API_ENABLED: "1" })).toBe("invite");
    // An invite build with no API behind it is the plain demo: nobody can have been let in.
    expect(bannerKind({ VITE_SITE_MODE: "invite" })).toBe("demo");
    expect(bannerKind({ VITE_API_ENABLED: "1" })).toBe("none");
    expect(siteMode({ VITE_SITE_MODE: "invite", VITE_API_ENABLED: "1" })).toBe("demo");
  });

  it("the invite build's static pages carry a banner that is true for visitors and for invited accounts", () => {
    const out = transformPage(page, "demo", "fees.html", "invite");
    expect(out).toContain(INVITE_BANNER);
    expect(out).not.toContain("isn't open yet");
    expect(out).toContain('data-site="demo"');
    expect(out).not.toMatch(/<script/i);
    expect(transformHome(`<html lang="en"><head><title>x</title><meta name="description" content="x" /></head><body></body></html>`, "demo", "invite")).toContain(INVITE_BANNER);
  });

  it("the demo build keeps the preview banner and the live build has none", () => {
    expect(transformPage(page, "demo", "fees.html")).toContain(BANNER);
    expect(transformPage(page, "live", "fees.html")).not.toContain('id="demo-banner"');
  });
});
