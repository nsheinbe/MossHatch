import type { Card } from "./data.ts";

/**
 * hatchkind.com pages. Rules (threat row 42, ST-145, C-66, C-71):
 *   - no script of any kind; the CSP has no script-src at all;
 *   - the domain name is text, never a link, and no page links to it; the only absolute links go to the Mosshatch origin;
 *   - a card is `noindex` unless its owner opted in, and only opted-in cards appear in the gallery and the sitemap;
 *   - every card page carries a report link.
 */

export interface Site { cardsOrigin: string; webOrigin: string; sample: boolean }

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const longDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`; };

/** "a" or "an" before a species name. */
export const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");

export const cardPath = (c: Card) => `/${c.slug}/`;
export const imagePath = (c: Card) => (c.image ? `/img/${c.image.sha256.slice(0, 24)}.png` : `/img/${c.slug}.svg`);

interface PageOpts { title: string; description: string; path: string; indexable: boolean; body: string; og?: { image: string; alt: string } }

export function page(site: Site, o: PageOpts): string {
  const robots = o.indexable ? "" : `<meta name="robots" content="noindex" />\n`;
  const canonical = o.indexable ? `<link rel="canonical" href="${site.cardsOrigin}${o.path}" />\n` : "";
  const og = o.og ? `<meta property="og:title" content="${esc(o.title)}" />\n<meta property="og:image" content="${site.cardsOrigin}${o.og.image}" />\n<meta property="og:image:alt" content="${esc(o.og.alt)}" />\n` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<meta name="referrer" content="no-referrer" />
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}" />
${robots}${canonical}${og}<link rel="stylesheet" href="/cards.css" />
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site"><a class="wordmark" href="/">Hatchkind</a><nav aria-label="Site"><a href="/">Gallery</a> <a href="/about/">About</a></nav></header>
<main id="main">
${site.sample ? `<p class="sample" role="note">Sample cards for a preview build. These names use the reserved .example domain.</p>\n` : ""}${o.body}
</main>
<footer class="site">
<p>Hatchkind shows creatures hatched from domain names registered at <a href="${site.webOrigin}/">Mosshatch</a>. It sets no cookies and runs no scripts.</p>
<p><a href="${site.webOrigin}/report.html#cards">Report a card</a> · <a href="${site.webOrigin}/legal/abuse-dmca.html">Take-down and DMCA</a> · <a href="${site.webOrigin}/legal/privacy.html">Privacy</a> · <a href="${site.webOrigin}/security.html">Security</a></p>
</footer>
</body>
</html>
`;
}

export function cardPage(site: Site, c: Card): string {
  const alt = `Portrait of the creature for ${c.slug}, ${article(c.species)} ${c.species}`;
  const w = c.image?.width ?? 512, h = c.image?.height ?? 640;
  const body = `<article class="card">
<img class="portrait" src="${imagePath(c)}" alt="${esc(alt)}" width="${w}" height="${h}" />
<div class="facts">
<h1><span class="fqdn">${esc(c.slug)}</span></h1>
<p class="species">${esc(c.species)}, ${esc(c.rarity)}</p>
<h2>Traits</h2>
<ul class="traits">${c.traits.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
<p>Hatched on <time datetime="${esc(c.hatched_on)}">${esc(longDate(c.hatched_on))}</time>.</p>
</div>
</article>
<p class="note">The creature is computed from the name. The card says nothing about any website at that name, and Hatchkind never links to it.</p>
<p><a class="report" href="${site.webOrigin}/report.html#cards">Report this card</a></p>`;
  return page(site, {
    title: `${c.slug}, ${article(c.species)} ${c.species} · Hatchkind`, description: `The creature that hatched from ${c.slug}: ${article(c.rarity)} ${c.rarity} ${c.species}.`,
    path: cardPath(c), indexable: c.indexable, body, og: { image: imagePath(c), alt },
  });
}

export function galleryPage(site: Site, cards: Card[]): string {
  const listed = cards.filter((c) => c.indexable);
  const items = listed.map((c) => `<li><a href="${cardPath(c)}"><img src="${imagePath(c)}" alt="" width="${c.image?.width ?? 512}" height="${c.image?.height ?? 640}" loading="lazy" /><span class="fqdn">${esc(c.slug)}</span><span class="species">${esc(c.species)}</span></a></li>`).join("\n");
  const body = `<h1>Every name hatches</h1>
<p class="lede">Each creature here hatched from a domain name registered at Mosshatch. Its owner chose to share it.</p>
${listed.length ? `<ul class="gallery">\n${items}\n</ul>` : `<p>No cards are listed yet.</p>`}`;
  return page(site, { title: "Hatchkind: the gallery", description: "Creatures hatched from domain names registered at Mosshatch.", path: "/", indexable: true, body });
}

export function aboutPage(site: Site): string {
  const body = `<h1>About Hatchkind</h1>
<p>When a domain is registered at Mosshatch, a creature hatches from its name. Its owner can publish a card for it here, and take the card down again in one step.</p>
<h2>What a card shows</h2>
<ul>
<li>The domain name, as text.</li>
<li>The creature's portrait and traits, computed from the name.</li>
<li>The date it hatched.</li>
</ul>
<p>A card never shows its owner's name or email, carries no text anyone typed, and has no link to the domain.</p>
<h2>Search engines</h2>
<p>Cards are hidden from search engines unless the owner asks for them to be listed. Only listed cards appear in the gallery.</p>
<h2>Reports</h2>
<p>To report a card, <a href="${site.webOrigin}/report.html#cards">follow the report steps</a>. You need no account. A card that breaks the rules is taken down first and looked into second.</p>`;
  return page(site, { title: "About Hatchkind", description: "What Hatchkind cards are, what they show and how to report one.", path: "/about/", indexable: true, body });
}

export function errorPage(site: Site, code: 404 | 500): string {
  const body = code === 404
    ? `<h1>No card here</h1>\n<p>There is no card at this address. It may never have been published, or its owner took it down.</p>\n<p><a href="/">Go to the gallery</a></p>`
    : `<h1>The gallery is resting</h1>\n<p>Something went wrong on our side. Try again in a minute.</p>\n<p><a href="/">Go to the gallery</a></p>`;
  return page(site, { title: code === 404 ? "No card here · Hatchkind" : "Something went wrong · Hatchkind", description: "Hatchkind", path: `/${code}.html`, indexable: false, body });
}

export function sitemap(site: Site, cards: Card[]): string {
  const urls = ["/", "/about/", ...cards.filter((c) => c.indexable).map(cardPath)];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${esc(site.cardsOrigin + u)}</loc></url>`).join("\n")}\n</urlset>\n`;
}

export const robots = (site: Site) => `User-agent: *\nAllow: /\nSitemap: ${site.cardsOrigin}/sitemap.xml\n`;
