// Site mode for the static parts of the web build (the same rule as apps/web/src/lib/site.ts): `demo` is the public preview, `live`
// only when VITE_API_ENABLED=1 and VITE_SITE_MODE is not "demo". Used by the Vite config (index.html) and scripts/site-pages.mjs
// (every other page in dist) for the permanent preview banner, titles, canonical URLs and share tags.
export const WEB_ORIGIN = "https://mosshatch.com";
export const SHARE_IMAGE = { path: "/og.png", width: 1200, height: 630, alt: "The Mosshatch grove at dusk: creatures by a pond under lanterns" };

export function siteMode(env = process.env) {
  return env.VITE_SITE_MODE !== "demo" && env.VITE_API_ENABLED === "1" ? "live" : "demo";
}

export const HOME = {
  demo: { title: "Mosshatch — every domain hatches a creature. Join the waitlist.", description: "Mosshatch isn't open yet. Type a name, watch it hatch into a one-of-a-kind creature, and join the waitlist. This preview registers nothing and charges nothing." },
  live: { title: "Mosshatch: every name hatches", description: "Find a domain name and watch it hatch. Every domain you own is a living creature in a grove at dusk." },
};

export const BANNER = `<aside id="demo-banner" class="demo-banner" aria-label="Preview notice"><p><strong>Mosshatch isn't open yet.</strong> This is a preview — nothing you hatch is registered or charged.</p><a class="demo-banner-cta" href="/waitlist" data-waitlist="banner">Join the waitlist</a></aside>`;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Open Graph and Twitter card tags for an indexable page. */
export function shareTags({ title, description, url }) {
  const img = WEB_ORIGIN + SHARE_IMAGE.path;
  return [
    `<meta property="og:type" content="website" />`, `<meta property="og:site_name" content="Mosshatch" />`,
    `<meta property="og:title" content="${esc(title)}" />`, `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`, `<meta property="og:image" content="${img}" />`,
    `<meta property="og:image:width" content="${SHARE_IMAGE.width}" />`, `<meta property="og:image:height" content="${SHARE_IMAGE.height}" />`,
    `<meta property="og:image:alt" content="${esc(SHARE_IMAGE.alt)}" />`, `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`, `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${img}" />`, `<meta name="twitter:image:alt" content="${esc(SHARE_IMAGE.alt)}" />`,
  ].join("\n");
}

/** Mark the page as demo and put the banner first in <body> (after a skip link when there is one). Idempotent. */
export function injectBanner(html) {
  if (html.includes('id="demo-banner"')) return html;
  let out = html.replace(/<html lang="en"(?![^>]*data-site)/, '<html lang="en" data-site="demo"');
  const skip = /(<body>\s*<a class="skip"[^>]*>[^<]*<\/a>)/;
  out = skip.test(out) ? out.replace(skip, `$1\n${BANNER}`) : out.replace(/<body>/, `<body>\n${BANNER}`);
  return out;
}

/** index.html: title, description, canonical and share tags for the mode, and in demo mode the banner. */
export function transformHome(html, mode) {
  const m = HOME[mode];
  let out = html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(m.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(m.description)}" />\n  <link rel="canonical" href="${WEB_ORIGIN}/" />\n  ${shareTags({ title: m.title, description: m.description, url: WEB_ORIGIN + "/" }).replace(/\n/g, "\n  ")}`);
  if (mode === "demo") out = injectBanner(out);
  return out;
}

/** The two hand-written public pages carry no description or canonical URL in their source (their bytes are document versions). */
export const HAND_WRITTEN = {
  "fees.html": { title: "Fees, renewals and notices · Mosshatch", description: "What each action costs per extension at Mosshatch, how auto-renew and refunds work, and the notices we send.", path: "/fees" },
  "commitments.html": { title: "Our commitments · Mosshatch", description: "What Mosshatch promises about your searches, who sees them, how availability is checked, and money.", path: "/commitments" },
};

/** Any other page: share tags when it has a canonical URL (indexable pages only), and in demo mode the banner. */
export function transformPage(html, mode, rel = "") {
  let out = html;
  const hw = HAND_WRITTEN[rel];
  if (hw && !out.includes('rel="canonical"')) {
    out = out.replace(/<title>[^<]*<\/title>/, `<title>${esc(hw.title)}</title>\n  <meta name="description" content="${esc(hw.description)}" />\n  <link rel="canonical" href="${WEB_ORIGIN}${hw.path}" />`);
  }
  const canonical = /<link rel="canonical" href="([^"]+)" \/>/.exec(out);
  if (canonical && !out.includes('property="og:title"')) {
    const title = unesc(/<title>([^<]*)<\/title>/.exec(out)?.[1] ?? "Mosshatch");
    const description = unesc(/<meta name="description" content="([^"]*)" \/>/.exec(out)?.[1] ?? "");
    out = out.replace(canonical[0], `${canonical[0]}\n${shareTags({ title, description, url: canonical[1] })}`);
  }
  if (mode === "demo") out = injectBanner(out);
  return out;
}
