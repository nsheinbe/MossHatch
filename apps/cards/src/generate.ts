import fs from "node:fs";
import path from "node:path";
import { CardDataError, fetchPortrait, validateExport, type Card } from "./data.ts";
import { aboutPage, cardPage, errorPage, galleryPage, imagePath, robots, sitemap, type Site } from "./render.ts";
import { portraitSvg } from "./portrait.ts";

export interface GenerateOpts {
  /** Where the page sources go (the Vite root). */
  siteDir: string;
  /** Files copied verbatim into the output (Vite's public dir). */
  publicDir: string;
  appDir: string;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

/** Load cards from the export, or the samples outside production. */
export async function loadCards(o: GenerateOpts): Promise<{ cards: Card[]; sample: boolean; portraits: Map<string, Buffer> }> {
  const url = o.env.CARDS_EXPORT_URL;
  if (!url) {
    if (o.env.VERCEL_ENV === "production") throw new CardDataError("CARDS_EXPORT_URL is required for a production build; the samples are for previews");
    const raw = JSON.parse(fs.readFileSync(path.join(o.appDir, "fixtures/cards.json"), "utf8"));
    return { cards: validateExport({ version: raw.version, cards: raw.cards }), sample: true, portraits: new Map() };
  }
  if (!url.startsWith("https://") && !url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) throw new CardDataError("CARDS_EXPORT_URL must be https");
  const f = o.fetch ?? fetch;
  const res = await f(url, { redirect: "error" });
  if (!res.ok) throw new CardDataError(`export ${res.status}`);
  const body = (await res.json()) as { version?: unknown; cards?: unknown };
  const cards = validateExport({ version: body.version, cards: body.cards });
  const portraits = new Map<string, Buffer>();
  for (const c of cards) portraits.set(c.slug, await fetchPortrait(c, f));
  return { cards, sample: false, portraits };
}

/** Write every page and asset source. Returns the HTML entry files for Vite. */
export async function generate(o: GenerateOpts): Promise<{ inputs: Record<string, string>; cards: Card[]; site: Site }> {
  const { cards, sample, portraits } = await loadCards(o);
  const site: Site = { cardsOrigin: (o.env.CARDS_ORIGIN ?? "https://hatchkind.com").replace(/\/$/, ""), webOrigin: (o.env.WEB_ORIGIN ?? "https://mosshatch.com").replace(/\/$/, ""), sample };
  fs.rmSync(o.siteDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(o.publicDir, "img"), { recursive: true });
  const inputs: Record<string, string> = {};
  const put = (rel: string, html: string) => {
    const file = path.join(o.siteDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
    inputs[rel.replace(/\/index\.html$|\.html$/, "").replace(/[^a-z0-9]+/gi, "_") || "index"] = file;
  };
  put("index.html", galleryPage(site, cards));
  put("about/index.html", aboutPage(site));
  put("404.html", errorPage(site, 404));
  put("500.html", errorPage(site, 500));
  for (const c of cards) {
    put(`${c.slug}/index.html`, cardPage(site, c));
    const img = path.join(o.publicDir, imagePath(c));
    if (c.image) fs.writeFileSync(img, portraits.get(c.slug)!);
    else fs.writeFileSync(img, portraitSvg(c));
  }
  fs.copyFileSync(path.join(o.appDir, "src/cards.css"), path.join(o.siteDir, "cards.css"));
  // Fonts come from the web app, so both origins ship the same subset files.
  const fonts = path.join(o.appDir, "../web/public/fonts");
  fs.mkdirSync(path.join(o.publicDir, "fonts"), { recursive: true });
  for (const f of fs.readdirSync(fonts)) fs.copyFileSync(path.join(fonts, f), path.join(o.publicDir, "fonts", f));
  fs.cpSync(path.join(o.appDir, "public"), o.publicDir, { recursive: true });
  fs.writeFileSync(path.join(o.publicDir, "sitemap.xml"), sitemap(site, cards));
  fs.writeFileSync(path.join(o.publicDir, "robots.txt"), robots(site));
  return { inputs, cards, site };
}
