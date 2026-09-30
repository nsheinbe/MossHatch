import fs from "node:fs";
import path from "node:path";
import { CARDS_KEY_HEADER, CardDataError, SLUG_RE, validateExport, type Card } from "./data.ts";
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

/** A guard against a cursor that never ends: 10,000 pages of 1,000 cards. */
const MAX_PAGES = 10_000;

/** Load cards from the export (every page), or the samples outside production. Newest first, as the gallery shows them. */
export async function loadCards(o: GenerateOpts): Promise<{ cards: Card[]; sample: boolean }> {
  const url = o.env.CARDS_EXPORT_URL;
  if (!url) {
    // Keyed on a cards-only variable (set in the `cards` Vercel project's Production environment), never on VERCEL_ENV, so no other project trips it.
    if (o.env.MH_CARDS_PRODUCTION === "1") throw new CardDataError("CARDS_EXPORT_URL is required for a production cards build; the samples are for previews");
    const raw = JSON.parse(fs.readFileSync(path.join(o.appDir, "fixtures/cards.json"), "utf8"));
    return { cards: validateExport({ version: raw.version, cards: raw.cards }), sample: true };
  }
  if (!url.startsWith("https://") && !url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) throw new CardDataError("CARDS_EXPORT_URL must be https");
  const key = o.env.CARDS_EXPORT_KEY;
  if (!key) throw new CardDataError("CARDS_EXPORT_KEY is required with CARDS_EXPORT_URL");
  const f = o.fetch ?? fetch;
  const raw: unknown[] = [];
  let after: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new CardDataError("export: too many pages");
    const u = new URL(url);
    if (after !== null) u.searchParams.set("after", after);
    const res = await f(u.toString(), { redirect: "error", headers: { [CARDS_KEY_HEADER]: key } });
    if (!res.ok) throw new CardDataError(`export ${res.status}`);
    const body = (await res.json()) as { version?: unknown; cards?: unknown; next?: unknown };
    if (body.version !== 1 || !Array.isArray(body.cards)) throw new CardDataError("export: bad envelope");
    raw.push(...body.cards);
    if (body.next === null || body.next === undefined) break;
    // The cursor is a slug and only moves forward, so a bad answer cannot loop the build.
    if (typeof body.next !== "string" || !SLUG_RE.test(body.next) || (after !== null && body.next <= after)) throw new CardDataError("export: bad cursor");
    after = body.next;
  }
  const cards = validateExport({ version: 1, cards: raw });
  cards.sort((a, b) => (a.published_at === b.published_at ? (a.slug < b.slug ? -1 : 1) : a.published_at < b.published_at ? 1 : -1));
  return { cards, sample: false };
}

/** Write every page and asset source. Returns the HTML entry files for Vite. */
export async function generate(o: GenerateOpts): Promise<{ inputs: Record<string, string>; cards: Card[]; site: Site }> {
  const { cards, sample } = await loadCards(o);
  const site: Site = { cardsOrigin: (o.env.CARDS_ORIGIN ?? "https://hatchkind.com").replace(/\/$/, ""), webOrigin: (o.env.WEB_ORIGIN ?? "https://mosshatch.com").replace(/\/$/, ""), sample };
  // Start both from nothing: a card missing from this export must leave no page and no portrait behind (C-66, C-70).
  fs.rmSync(o.siteDir, { recursive: true, force: true });
  fs.rmSync(o.publicDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(o.publicDir, "img"), { recursive: true });
  const inputs: Record<string, string> = {};
  let pages = 0;
  const put = (rel: string, html: string) => {
    const file = path.join(o.siteDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
    // Keyed by the page's own path, which is unique ("a-b.com" and "a.b.com" stay apart). A clash would drop a page silently, so it throws.
    const key = rel.replace(/\/index\.html$|\.html$/, "");
    if (key in inputs) throw new CardDataError(`two pages share the entry ${key}`);
    inputs[key] = file;
    pages++;
  };
  put("index.html", galleryPage(site, cards));
  put("about/index.html", aboutPage(site));
  put("404.html", errorPage(site, 404));
  put("500.html", errorPage(site, 500));
  for (const c of cards) {
    put(`${c.slug}/index.html`, cardPage(site, c));
    // Computed from the name alone; the owner's uploaded snapshot is never fetched or served.
    fs.writeFileSync(path.join(o.publicDir, imagePath(c)), portraitSvg(c));
  }
  if (Object.keys(inputs).length !== pages) throw new CardDataError("entry count differs from page count");
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
