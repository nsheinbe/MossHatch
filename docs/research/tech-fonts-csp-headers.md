# Fonts, strict CSP, headers and cookie/CSRF design for Mosshatch

Vite + React + TypeScript + three.js on Vercel, Stripe-hosted Checkout by redirect (no Stripe.js on our pages). Research date and access date for every source: **2026-09-29**. Analyst: Claude (research subagent). Evidence, probe apps and raw fetches: `working-directory/research/fcsp/`.

## TL;DR

- **Fonts are all SIL OFL 1.1 with no Reserved Font Name declared**, so self-hosting and subsetting are allowed (OFL FAQ 2.1 and 2.6); ship the OFL text and keep the copyright/licence name records. Recommended payload: Young Serif 400 (18,440 B) + Atkinson Hyperlegible Next variable clamped to wght 400-700 (20,356 B) = **38,796 B woff2**, 36% smaller than Google's own prebuilt latin pair (60,988 B). Young Serif on Google Fonts is Regular-400 only; upstream master (v6.002, wght 300-700 + italics) is unpinned.
- **Font loading**: preload both files with `crossorigin`, `font-display: swap`, metric-matched local() fallbacks (computed values in 2.5), `font-synthesis-weight: none` for the single-weight display face; arrows/check marks are not in any of these fonts, so use SVG icons.
- **CSP needs no nonce, hash, `'unsafe-inline'` or `'unsafe-eval'`**: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; ...` (full string in 3.1). Verified in Chromium 141 with Vite 8.3.1 + React 19.3.0 + three 0.186.1 (+ @react-three/fiber 9.8.1): shaders compile, React `style={{}}` works (CSSOM, so no `style-src-attr 'unsafe-inline'`), zero violations.
- **The three.js paths that need extras are the WASM/Blob-worker decoders (Draco, KTX2, meshopt)**: `worker-src blob:` (Blob workers) and `'wasm-unsafe-eval'` (never `'unsafe-eval'`); three core and shaders need neither. **Trusted Types** (Chrome 83 / Firefox 148 / Safari 26) is feasible: the baseline app had zero violations; roll out via Report-Only first.
- **Stripe redirect trap**: `form-action 'self'` blocks Stripe's own quickstart pattern (form POST answered by `303` to `session.url`) in Chromium (verified: POST reached the server, redirect refused). Use `fetch` -> JSON `{url}` -> `location.assign(url)`; no CSP directive restricts that.
- **SameSite=Strict is not sent on any request of a cross-site-initiated navigation** (JS redirect, link click, 303, even a later same-site 302 hop) - verified in Chromium and stated by RFC 6265bis; a same-origin `fetch` from the landed page does send it. **Recommendation: `__Host-` + `Secure; HttpOnly; Path=/; SameSite=Lax` session cookie**, optional second `SameSite=Strict` "write" cookie (RFC 6265bis 8.8.2), CSRF by `Sec-Fetch-Site: same-origin` + `Origin` fallback + JSON + custom header, and passkey-bound approvals for money/secrets.
- **Headers**: keep Vercel's HSTS `max-age=63072000` (preload is "not recommended" by hstspreload.org; `.dev`/`.app` TLDs are already preloaded), `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (NOT `no-referrer`: Chromium then sends `Origin: null` on same-origin form POSTs), Permissions-Policy (Chromium-only enforcement; prune unknown tokens such as `bluetooth`), COOP/CORP `same-origin`, `no-store` set inside the function, `Clear-Site-Data: "cookies", "storage"` on logout.
- **Service workers**: `Cache.put()` stores `Cache-Control: no-store` responses (spec + Chromium test; OWASP's HTML5 sheet says otherwise), so ship no service worker in Phase 0.
- **Final CSP string and vercel.json draft** are in sections 3.1 and 7; the exact string was run against the probe apps together with the full header set.

## 0. Method and environment

- Live fetches with `curl -sSL` through the session proxy, plus headless Chromium (Playwright `chromium-1194`, UA `HeadlessChrome/141.0.7390.37`, SwiftShader software GL). **Only Chromium is installed**: Firefox and Safari behaviour comes from specs, MDN and `@mdn/browser-compat-data` 8.1.3 (published 2026-09-24), not from runs.
- `github.com` and `api.github.com` are not reachable from this session (add_repo required), so repo files were read via `raw.githubusercontent.com` and the jsDelivr mirror. `brailleinstitute.org` answers with a bot-challenge page ("Robot Challenge Screen") and was not fetched. `fonts.google.com` specimen pages are client-rendered and carry no licence text; Google's CSS API, `google/fonts` METADATA/OFL files and gstatic files were used instead.
- Versions installed for the probes (from npm today): vite 8.3.1, react/react-dom 19.3.0, three 0.186.1, @react-three/fiber 9.8.1, fonttools 4.66.1, brotli 1.2.0.
- Probe apps (React `style` prop, WebGL scene with two GLSL programs, canvas snapshots as blob/data URLs, blob worker, eval/Function/WebAssembly, fontface loading) live in `fcsp/app`; cookie/redirect/Referrer tests in `fcsp/ss`. Every claim marked "verified" below was observed there.

## 1. Decisions at a glance

| Topic | Decision | Confidence |
|---|---|---|
| Display font | Young Serif Regular 400, Google-released v3.003 file, subset + unhinted, 18,440 B | high |
| Body/UI font | Atkinson Hyperlegible Next variable, wght clamped 400-700, subset, 20,356 B (original Atkinson = fallback option, 2 static files 22,228 B) | high |
| Font loading | preload both, `font-display: swap`, fallback faces with `size-adjust` | high (mechanics), medium (override numbers) |
| CSP | `script-src 'self'`, `style-src 'self'`, `img-src 'self' blob:`, `default-src 'none'`; no unsafe-* | high |
| Trusted Types | Report-Only now, enforce after a quiet period | medium-high |
| Stripe hand-off | JSON + `location.assign`; keep `form-action 'self'` | high |
| Session cookie | `__Host-` + HttpOnly + Secure + Path=/ + SameSite=Lax (Strict "write" cookie optional) | high |
| CSRF | Sec-Fetch-Site + Origin + JSON + custom header + passkey-bound approvals | high |
| Service worker | none in Phase 0 | high |

## 2. Fonts

### 2.1 Sources and licence

| Family | Official source | Licence | Notes |
|---|---|---|---|
| Young Serif | Designer Bastien Sozeau / NoirBlancRouge. Upstream repo `noirblancrouge/YoungSerif`; Google Fonts (added 2023-08-30) | SIL OFL 1.1, "Copyright 2023 The Young Serif Project Authors", no RFN | GF METADATA: single font `YoungSerif-Regular.ttf`, weight 400, subsets latin/latin-ext. NBR page: "Young Serif is a variable old style serif typeface ... open source and licensed under OFL". |
| Atkinson Hyperlegible | Braille Institute; repo `googlefonts/atkinson-hyperlegible`; Google Fonts (2021-04-30) | SIL OFL 1.1, "Copyright 2020 Braille Institute of America, Inc.", no RFN | 4 static fonts: 400/700 x roman/italic, 27 languages |
| Atkinson Hyperlegible Next | Braille Institute et al.; repo `googlefonts/atkinson-hyperlegible-next`; Google Fonts (2025-01-07); v2.001 released 2024-11-20 | SIL OFL 1.1, "Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors", no RFN | variable wght 200-800 roman + italic; static OTF/TTF/woff2 for 7 weights in repo |

Sources (accessed 2026-09-29): https://raw.githubusercontent.com/google/fonts/main/ofl/youngserif/METADATA.pb , https://raw.githubusercontent.com/google/fonts/main/ofl/youngserif/OFL.txt , https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible/main/README.md , https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/main/README.md , https://raw.githubusercontent.com/google/fonts/main/ofl/atkinsonhyperlegiblenext/METADATA.pb , https://noirblancrouge.com/fonts/young-serif/ .

**What the licence lets us do** (OFL 1.1 text, same in all four files): "Permission is hereby granted, free of charge, to any person obtaining a copy of the Font Software, to use, study, copy, merge, embed, modify, redistribute, and sell modified and unmodified copies of the Font Software, subject to the following conditions: 1) Neither the Font Software nor any of its individual components, in Original or Modified Versions, may be sold by itself. 2) ... provided that each copy contains the above copyright notice and this license. 3) No Modified Version of the Font Software may use the Reserved Font Name(s) unless explicit written permission is granted ... 5) The Font Software, modified or unmodified, in part or in whole, must be distributed entirely under this license".
- Self-hosting: OFL FAQ 2.1 - "The referenced fonts can be hosted on the same server as other site assets and content ... This is recommended and explicitly allowed by the licensing model because it is distribution." (https://openfontlicense.org/ofl-faq/)
- Subsetting: OFL FAQ 2.6 - "Removing any parts of the font when delivering a webfont to a browser, including unused glyphs and smart font code, is considered modification. This is permitted by the OFL but would not normally allow the use of RFNs."
- **No Reserved Font Name is declared** in any of the four OFL.txt files I fetched (`grep -c "with Reserved Font Name"` = 0), so the subset may keep the family name. Re-check the copyright header on each font update: if an RFN ever appears, rename the subset family.
- Obligation checklist: ship `OFL.txt` (or the name-table licence fields) with the files; our subset keeps nameID 0 (copyright), 13 and 14 (licence text/URL) because it is built with `--name-IDs='*'` (verified with fontTools). The fonts may not be sold on their own.

### 2.2 Formats, weights, variable availability

| Family | Where | Weights / axes | Formats available | Comment |
|---|---|---|---|---|
| Young Serif | Google Fonts CSS API today | **400 only**, `font-weight: 400`, v2 | woff2 latin/latin-ext | Google file is v3.003 (644 glyphs, ttfautohint-hinted) |
| Young Serif | upstream master (moving) | fvar **wght 300-700** (Light default; instances Light/Regular/Medium/SemiBold/Bold) + real italics; v6.002; 922 cmap entries; small caps `smcp/c2sc`; arrows U+2190-2193 present | TTF, OTF, variable TTF, woff2 in repo | Changelog: "27 Feb 2025 ... variable version"; "19 May 2026 ... Added real Italics". Not on Google Fonts. Downloaded variable TTF was 272,892 B while the jsDelivr listing said 263,700 B => branch moved; pin a commit before adopting. |
| Atkinson Hyperlegible | Google Fonts / repo | 400, 700, italics (static) | TTF, OTF, woff2 | 342 cmap entries |
| Atkinson Hyperlegible Next | Google Fonts (v7) / repo | **variable wght 200-800**, roman + italic files; 362 cmap entries; features `case frac ordn pnum sups tnum` | variable TTF/woff2, 7 static weights as OTF/TTF/woff2 | Google serves `font-weight: 200 800`. README says "increased to six" weights but the repo ships seven (conflict noted). |

### 2.3 Sizes (all measured today; woff2 bytes)

| Family | File | Bytes | Role |
|---|---|---|---|
| Young Serif | Google v3.003 Regular TTF (source for subsetting) | 106,608 |  |
| Young Serif | Google-served woff2, latin (gstatic v2) | 26,992 |  |
| Young Serif | Google-served woff2, latin-ext | 17,268 |  |
| Young Serif | subset, Google latin range, hinted | 27,256 |  |
| Young Serif | **subset, Google latin range, `--no-hinting`** | 18,440 | RECOMMENDED |
| Young Serif | subset, tight ASCII+Latin-1, `--no-hinting` | 17,728 | alt |
| Young Serif | subset, tight, minimal features | 16,432 | alt |
| Young Serif | subset, latin-ext range, `--no-hinting` (lazy add-on) | 10,896 | optional |
| Young Serif | upstream master v6.002 Regular TTF | 275,208 |  |
| Young Serif | upstream master v6.002 Regular woff2 (repo prebuilt, all glyphs) | 81,600 |  |
| Young Serif | upstream master v6.002 variable TTF (wght 300-700) | 272,892 |  |
| Young Serif | subset of upstream v6.002 Regular, tight, unhinted | 18,060 | alt |
| Young Serif | subset of upstream v6.002 variable, tight, unhinted | 29,136 | alt |
| Atkinson Hyperlegible | Google Regular TTF | 54,348 |  |
| Atkinson Hyperlegible | Google-served woff2 latin 400 (gstatic v12) | 17,208 |  |
| Atkinson Hyperlegible | Google-served woff2 latin 700 | 17,524 |  |
| Atkinson Hyperlegible | repo prebuilt woff2 Regular (all glyphs) | 23,196 |  |
| Atkinson Hyperlegible | repo prebuilt woff2 Bold (all glyphs) | 23,776 |  |
| Atkinson Hyperlegible | subset 400, Google latin range, unhinted | 11,000 | alt (original family) |
| Atkinson Hyperlegible | subset 700, Google latin range, unhinted | 11,228 | alt (original family) |
| Atkinson Hyperlegible Next | repo variable TTF (wght 200-800) | 114,552 |  |
| Atkinson Hyperlegible Next | repo prebuilt variable woff2 (all glyphs) | 48,188 |  |
| Atkinson Hyperlegible Next | repo prebuilt static woff2 Regular / Bold (all glyphs) | 24,896 / 25,928 |  |
| Atkinson Hyperlegible Next | Google-served variable woff2 latin (gstatic v7) | 33,996 |  |
| Atkinson Hyperlegible Next | subset, variable 200-800, tight | 32,120 |  |
| Atkinson Hyperlegible Next | subset, variable clamped 400-700, tight | 18,996 | alt |
| Atkinson Hyperlegible Next | **subset, variable clamped 400-700, Google latin range** | 20,356 | RECOMMENDED |
| Atkinson Hyperlegible Next | subset, variable clamped 400-700, latin-ext range (lazy add-on) | 11,600 | optional |
| Atkinson Hyperlegible Next | subset, static 400 / 700, tight | 11,056 / 11,644 |  |

Payload comparison for the two families we need: **Google prebuilt latin pair 60,988 B -> ours 38,796 B (-36.4%)**; tight ASCII+Latin-1 variant 36,724 B; latin-ext lazy add-on 10,896 B (Young Serif) + 11,600 B (Atkinson Next). What actually moved the numbers: unhinting Young Serif (27,256 -> 18,440 B; the Google TTF carries ttfautohint `fpgm/prep/cvt`), clamping the Atkinson Next wght axis to the range we use (33,944 -> 20,356 B). Atkinson Next is already unhinted so `--no-hinting` gives ~0.

### 2.4 Subsetting recipe (reproducible)

```bash
pip install fonttools brotli      # installed fonttools 4.66.1 + brotli 1.2.0 from PyPI without trouble
# Sources (pin by commit hash in the repo):
#   google/fonts   ofl/youngserif/YoungSerif-Regular.ttf                      (Google v3.003)
#   googlefonts/atkinson-hyperlegible-next  fonts/variable/AtkinsonHyperlegibleNext[wght].ttf
LATIN="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"   # Google's own "latin" unicode-range
FEAT="kern,liga,calt,ccmp,locl,mark,mkmk,tnum,pnum,lnum,onum,case,zero,frac,ordn,sups,subs,dnom,numr"
fonttools varLib.instancer "AtkinsonHyperlegibleNext[wght].ttf" wght=400:700 -o AHN-400-700.ttf
pyftsubset YoungSerif-Regular.ttf --unicodes="$LATIN" --layout-features="$FEAT" --flavor=woff2 \
  --name-IDs='*' --no-hinting --notdef-outline --output-file=young-serif-400-latin.woff2
pyftsubset AHN-400-700.ttf        --unicodes="$LATIN" --layout-features="$FEAT" --flavor=woff2 \
  --name-IDs='*' --no-hinting --notdef-outline --output-file=atkinson-next-var-400-700-latin.woff2
```
- `--name-IDs='*'` is what keeps the OFL copyright/licence records (default keeps only IDs 0-6, dropping 13/14).
- Domain names in IDN scripts, emoji and symbols fall back per character to the next family; the creature UI should not rely on these fonts for them. Optional lazy `latin-ext` files use Google's latin-ext range and are declared **before** the latin face (later faces win on overlap, as in Google's own CSS).
- Glyph gaps (fontTools cmap check): none of Young Serif (Google v3.003), Atkinson, Atkinson Next has U+2190-2193, U+2197 (arrows), U+2713 (check), U+2715 (cross); Atkinson lacks U+2318 too. Use inline SVG for UI glyphs.
- Not tested: rendering of unhinted TrueType outlines on legacy Windows GDI text rendering; check before dropping hinting for that audience.

### 2.5 font-display and first paint

```html
<!-- index.html : Vite 8.3.1 rewrites these hrefs to the same hashed /assets URLs the CSS uses (verified by build) -->
<link rel="preload" href="/src/fonts/young-serif-400-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/src/fonts/atkinson-next-var-400-700-latin.woff2" as="font" type="font/woff2" crossorigin>
```
```css
@font-face{font-family:"Young Serif";font-weight:400;font-style:normal;font-display:swap;
  src:url("./fonts/young-serif-400-latin.woff2") format("woff2");
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Atkinson Hyperlegible Next";font-weight:400 700;font-style:normal;font-display:swap;
  src:url("./fonts/atkinson-next-var-400-700-latin.woff2") format("woff2");
  unicode-range:/* same as above */ U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
/* metric-matched fallbacks: values COMPUTED by me (section below), verify visually */
@font-face{font-family:"Young Serif Fallback";src:local("Times New Roman");size-adjust:125.75%;ascent-override:83.18%;descent-override:29.11%;line-gap-override:0%}
@font-face{font-family:"Atkinson Fallback";src:local("Arial");size-adjust:100.05%;ascent-override:98.35%;descent-override:31.58%;line-gap-override:0%}
:root{--font-display:"Young Serif","Young Serif Fallback",Georgia,serif;
      --font-body:"Atkinson Hyperlegible Next","Atkinson Fallback",system-ui,sans-serif}
h1,h2,h3,.domain-name{font-family:var(--font-display);font-weight:400;font-synthesis-weight:none}
body{font-family:var(--font-body)}
```
- **Why `swap`**: MDN - "swap: Gives the font face an extremely small block period and an infinite swap period." Text paints immediately in the fallback, then swaps; with a same-origin 18-20 KB preloaded file the swap normally lands within the first frames. `optional` would avoid any shift but may never show the brand faces on a cold first visit, which defeats the purpose for a brand-led product.
- **Preload needs `crossorigin`** even for same-origin fonts: MDN - "font and fetch preloading requires the crossorigin attribute to be set".
- **Fallback metrics** (my calculation with fontTools: letter-frequency-weighted mean advance width of the web font vs the Liberation clone of the local fallback (metric-compatible with Arial / Times New Roman), overrides = web font hhea metrics / size-adjust): Atkinson Next vs Arial: size-adjust 100.05%, ascent 98.35%, descent 31.58%, line-gap 0%; Young Serif vs Times New Roman: 125.75%, 83.18%, 29.11%, 0%. Browser support (BCD 8.1.3): `size-adjust` Chrome 92 / Firefox 92 / Safari 17; `ascent-override` family Chrome 87 / Firefox 89 / **not in Safari**. `local("Arial")`/`local("Times New Roman")` are absent on some Linux/Android systems, in which case the next family in the stack is used and the tuning is moot.
- `font-synthesis-weight: none` (Chrome 97, Firefox 111, Safari 16.4) stops the browser from faux-bolding the single-weight Young Serif.
- If the app shell is a client-rendered SPA the first paint waits for JS anyway; put the site name and a skeleton in the static `index.html` so real (fallback-font) text is visible before the bundle runs.

### 2.6 Alternative: npm packages

`@fontsource/young-serif@5.3.0`, `@fontsource/atkinson-hyperlegible@5.3.0`, `@fontsource-variable/atkinson-hyperlegible-next@5.3.0` are OFL-1.1 (npm view, modified 2026-07-19) and contain the same Google-derived latin/latin-ext woff2 (byte-identical sizes to gstatic: 26,992 / 17,208 / 33,996). They are convenient but 36% larger than our subset, and `@fontsource-variable/young-serif` does not exist (404). Recommendation: keep the pip/fonttools recipe in a `scripts/fonts.sh`, commit the two woff2 files and the OFL texts.


## 3. Content Security Policy

### 3.1 Final policy (enforced) and the Report-Only companion

```
Content-Security-Policy:
  default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests; report-uri /api/csp-report; report-to csp

Content-Security-Policy-Report-Only:
  require-trusted-types-for 'script'; trusted-types; report-uri /api/csp-report; report-to csp

Reporting-Endpoints: csp="https://APP_ORIGIN/api/csp-report"
```
Single-line enforced string (304 characters): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests; report-uri /api/csp-report; report-to csp`

This exact string was served together with the rest of the header set from section 7 to the probe apps in Chromium 141. Observed: fonts loaded, WebGL2 rendered two GLSL programs, `style={{color}}` applied, blob snapshot image decoded; the only violations were the ones I planted on purpose (`setAttribute('style')`, blob Worker, `eval`, `new Function`, WebAssembly, `data:` image). The @react-three/fiber build produced zero violations and zero console warnings apart from a three.js deprecation notice. Precedent: OWASP's tightest example is `default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; frame-ancestors 'self'; form-action 'self';` (CSP Cheat Sheet, accessed today). Vercel's docs say to start with Report-Only: "Before enforcing a CSP, start with the Content-Security-Policy-Report-Only header." (https://vercel.com/docs/headers/security-headers)

### 3.2 Directive by directive

| Directive | Value | Needed / why | Evidence |
|---|---|---|---|
| `default-src` | `'none'` | Deny anything not listed; `frame-ancestors`, `base-uri`, `form-action` do not fall back to it, so they are set explicitly | MDN frame-ancestors: "does not fall back to the default-src setting. A policy that declares default-src 'none' still allows the resource to be embedded by anyone." |
| `script-src` | `'self'` | **No nonce or hash needed.** Vite 8.3.1 `dist/index.html` has one external `<script type="module" crossorigin src>` and one `<link rel="stylesheet" crossorigin>`; the modulepreload polyfill is inside the bundle. Nonces need a fresh value per response (Vite: "Ensure that you replace the placeholder with a unique value for each request"), impossible on static hosting. Keep every script external (a dark-mode "flash" script must be a file, not inline). | own build + Chromium run; https://vite.dev/guide/features.html |
| `style-src` | `'self'` | External CSS only; inline `<style>` blocked. Also the fallback for `style-src-elem` and `style-src-attr`. | MDN style-src-attr: "If this directive is absent, the user agent will look for the style-src directive" |
| `style-src-attr` | *(unset)* - **no `'unsafe-inline'`** | React DOM 19.3.0 writes styles through CSSOM (`style.setProperty(...)`, `style[name]=...`), which CSP does not block. Blocked: `style="..."` in markup, `el.setAttribute('style', ..)`, `el.style.cssText = ..`. Watch for CSS-in-JS that injects `<style>` (would need a nonce) and any static `style=""` in `index.html`. | MDN: "Style properties that are set directly on the element's style property will not be blocked"; react-dom `setValueForStyle`; Chromium run: React colour applied, `setAttribute` outline not applied + one `style-src-attr` violation |
| `img-src` | `'self' blob:` | `blob:` for `canvas.toBlob()` + `URL.createObjectURL()` card snapshots (three.js GLTF textures also arrive as blob URLs). `data:` is needed only for `canvas.toDataURL()` or if Vite inlines small assets (default `build.assetsInlineLimit` 4096) - set `assetsInlineLimit: 0` and keep `data:` out. | Chromium: blob image decoded only when `blob:` listed; Vite docs: "Allowing data: for related directives (e.g. img-src, font-src), or, disabling it by setting build.assetsInlineLimit: 0 is necessary." |
| `font-src` | `'self'` | Self-hosted woff2 (loaded in the run) | own run |
| `connect-src` | `'self'` | Same-origin `/api`. If the API moves to another origin add exactly that origin. `data:` only if GLTFs with embedded base64 buffers are loaded, because three's `FileLoader` uses `fetch()` for every URL (read from `src/loaders/FileLoader.js`, not tested). Nothing for Stripe (redirect) or WebAuthn. | source read |
| `worker-src` | `'self'` | Falls back to child-src, then script-src, then default-src, so set it explicitly. Add `blob:` **only** if Draco/KTX2 loaders (or fflate) create Blob workers. | MDN worker-src; three r186 `DRACOLoader.js` line 426 and `KTX2Loader.js` line 329 `URL.createObjectURL(new Blob([...]))`; Chromium: blob Worker refused until `worker-src ... blob:` |
| `manifest-src` | `'self'` | Only matters if a PWA manifest is linked; with `default-src 'none'` it would otherwise be blocked (reasoned from the fallback rules, not run) | - |
| `base-uri` | `'none'` | No `<base>` needed; MDN: "If this value is absent, then any URI is allowed." | MDN base-uri |
| `object-src` | `'none'` | MDN: "it is recommended to restrict this fetch-directive (e.g., explicitly set object-src 'none' if possible)." | MDN object-src |
| `form-action` | `'self'` | See 3.8: keep `'self'` and avoid form-POST + 303 hand-off to Stripe | Chromium run; MDN warning |
| `frame-ancestors` | `'none'` | Anti-clickjacking; "Setting this directive to 'none' is similar to X-Frame-Options: deny". Cannot be delivered via `<meta>`, so it must be a header. | MDN frame-ancestors |
| `frame-src`, `media-src`, `child-src` | *(unset -> `'none'`)* | Nothing embedded. Embedded Stripe Checkout later would need Stripe's list (`frame-src`/`script-src`/`connect-src https://checkout.stripe.com`, `img-src https://*.stripe.com`) | https://docs.stripe.com/security/guide.md |
| `upgrade-insecure-requests` | present | Belt-and-braces with HSTS (not load-bearing, not separately tested) | - |
| `report-uri` + `report-to` | `/api/csp-report` + `csp` | See 3.7 | MDN |
| `require-trusted-types-for 'script'; trusted-types` | Report-Only first | See 3.6 | MDN, own run |

### 3.3 Vite-specific rules

1. `build.assetsInlineLimit: 0` (default 4096 turns small assets into `data:` URIs; fonts we ship are 18-20 KB anyway).
2. Do not set `html.cspNonce` (needs per-request substitution); do not inline anything in `index.html`. Move any pre-paint theme script into `public/theme.js` and load it as `<script src>`.
3. `vite dev` (HMR, injected `<style>`) will violate this policy; apply the production CSP only in `vercel.json`, not in dev.
4. Dynamic `import()` chunks and `modulepreload` links are governed by `script-src 'self'` and just work (probe build).

### 3.4 Does three.js / WebGL need `'unsafe-eval'`?

**No.** Evidence:
- `three@0.186.1`: `src/` and `build/three.module.js`, `three.core.js`, `three.webgpu.js` contain no `eval(` and no `new Function(` (grep). The `examples/jsm/libs` decoders (Draco, Basis, meshopt, zstd) also have none (only `chevrotain.module.min.js`, a parser library outside the renderer, has one `eval(`).
- Chromium 141 run under `script-src 'self'`: `new THREE.WebGLRenderer`, a `ShaderMaterial` and a `MeshStandardMaterial` -> `renderer.info.programs.length === 2`, `gl.getError() === 0`, zero `securitypolicyviolation` events; same for `@react-three/fiber` 9.8.1 `<Canvas>`. GLSL compilation goes through the GL driver, not JS `eval`.
- Where the old "add unsafe-eval" advice comes from: a 2023 three.js forum thread (maintainer donmccurdy) about a Draco-compressed GLTF: "Your CSP must include: script-src 'self' 'unsafe-eval'; connect-src 'self' https://www.gstatic.com/;". The error was `WebAssembly.instantiate(): Refused to compile or instantiate WebAssembly module because 'unsafe-eval' is not an allowed source`. Today the narrower keyword applies; MDN: "'wasm-unsafe-eval' ... is more specific than 'unsafe-eval'". In my run `script-src 'self' 'wasm-unsafe-eval'` allowed `WebAssembly.instantiate`, still refused `eval()` and `new Function()`, and (with `worker-src 'self' blob:`) allowed a Blob worker.

| three.js feature | Extra CSP | Note |
|---|---|---|
| Procedural creatures, shaders, textures from `'self'` | none | baseline |
| Card snapshot | `img-src blob:` (`data:` for `toDataURL`) | |
| DRACOLoader / KTX2Loader (WASM + Blob worker); meshopt decoder (WASM only) | `script-src 'wasm-unsafe-eval'`, `worker-src blob:` | Host decoders yourself (`setDecoderPath('/draco/')`); under Trusted Types `new Worker(url)` is a sink and needs a `createScriptURL` policy |
| GLTF with base64 buffers | `connect-src data:` (inferred) | Prefer `.glb` served from `'self'` |

### 3.5 Inline styles and React

The question "do React inline style attributes force `style-src-attr 'unsafe-inline'`?" has the answer **no for a client-rendered SPA**. `react-dom-client.production.js` (19.3.0) `setValueForStyles` assigns `node.style[name] = value` or `style.setProperty(name, value)`; it never calls `setAttribute("style")` or `cssText`. MDN: the policy "would also block any styles applied in JavaScript by setting the style attribute directly, or by setting cssText", but "Style properties that are set directly on the element's style property will not be blocked". Test result under `style-src 'self'`: `getComputedStyle(h1).color === "rgb(10, 20, 30)"` from `style={{color:'rgb(10, 20, 30)'}}` with **no** violation, whereas `setAttribute('style', ...)` produced one `style-src-attr` violation and no style. `style-src-attr` is Chrome 75 / Firefox 108 / Safari 15.4 (BCD). Server-rendered HTML with `style=""` attributes would break this (not our case).

### 3.6 Trusted Types

- Support: Chrome/Edge 83, **Firefox 148, Safari 26** (BCD 8.1.3); MDN labels `require-trusted-types-for` "Baseline 2026 - Newly available - Since February 2026".
- Feasibility: react-dom 19.3.0 production has `innerHTML =` in exactly two places (for `dangerouslySetInnerHTML` and to create `<script>` elements); `three` core has no HTML sinks. Running React 19.3.0 + three 0.186.1 and the R3F build under `require-trusted-types-for 'script'; trusted-types` (empty list = no policies allowed) produced **no violations**. Sinks that did fire in my probe were the ones I called on purpose: `new Worker(blobUrl)` ("This document requires 'TrustedScriptURL' assignment."), `eval`, `Function`.
- Rule set for the codebase: no `dangerouslySetInnerHTML`, no `innerHTML`/`insertAdjacentHTML`, no `eval`/`new Function`, no string `Worker(url)` unless routed through one named policy (`trusted-types mh-worker`). Enforce in CI with an ESLint ban.
- Rollout: ship as `Content-Security-Policy-Report-Only` (already in the draft), watch `/api/csp-report` for a release cycle, then merge the two directives into the enforced header. OWASP and Vercel both advise report-only first.

### 3.7 Reporting

- MDN: "The report-to directive is intended to replace report-uri, and browsers that support report-to ignore the report-uri directive. However, until report-to is broadly supported you can specify both". BCD 8.1.3: `report-to` Chrome 70, Safari 16.4, **Firefox 149**; `report-uri` is flagged deprecated but works everywhere. MDN marks `report-to` "Baseline 2026 Newly available (March 2026)". Ship both for now.
- `Reporting-Endpoints` must name an HTTPS URL: "non-secure endpoints are ignored". Use an absolute `https://<production host>/api/csp-report`. I did not verify that a relative URL is accepted there (unverified); `report-uri` accepted the relative `/csp-report` in Chromium.
- Local test (http, so `report-to` could not fire): `report-uri` delivered 7 reports within 5 s as `Content-Type: application/csp-report` with `{"csp-report": {"violated-directive": ..., "blocked-uri": ...}}`; the `report-to` variant delivered nothing, as MDN predicts for a non-secure endpoint. HTTPS delivery of `application/reports+json` remains to be checked on a preview deployment.
- Handler: accept both content types, cap body size, rate-limit, drop reports whose `blocked-uri` is `chrome-extension:` etc., and treat content as attacker-controlled (MDN: "Violation reports should be considered attacker-controlled data").

### 3.8 Stripe Checkout redirect and `form-action`

- Stripe's quickstart (hosted page) uses `<form action="/create-checkout-session" method="POST">` and `res.redirect(303, session.url)`, with `success_url: .../success?session_id={CHECKOUT_SESSION_ID}` in the Next.js variant. Stripe's CSP table for Checkout (`connect-src`, `frame-src`, `script-src https://checkout.stripe.com`, `img-src https://*.stripe.com`) applies to embedded/Stripe.js use; a plain redirect loads nothing from Stripe into our pages (inference; navigation is not governed by CSP fetch directives and CSP3 has no `navigate-to`).
- **Verified in Chromium 141** (two local origins): page with `form-action 'self'`: form POST to `/go` (server logged the POST) answered `303 Location: http://127.0.0.1:5291/checkout` -> console "Refused to send form data to 'http://localhost:5290/go' because it violates ... form-action 'self'", page stays put (the Stripe session would already exist server-side). With `form-action 'self' http://127.0.0.1:5291` it navigates. `fetch('/api/session')` -> `{url}` -> `location.assign(url)` navigates under `form-action 'self'` and even under `form-action 'none'`.
- MDN warns this is engine-dependent: "Firefox 57 doesn't block the redirects whereas Chrome 63 does". CSP3 defines the pre-navigation check only for navigation type "form-submission".
- Design: `POST /api/checkout` (JSON, guarded, passkey approval already collected) returns `{"url": "https://checkout.stripe.com/..."}`; the client calls `location.assign(url)`. If a plain form is ever used, add `https://checkout.stripe.com` to `form-action`.


## 4. Response headers

| Header | Value | Why / evidence |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000` (Vercel default on custom domains, host only). Later: add `includeSubDomains` after auditing subdomains; add `preload` only deliberately | Vercel: "Custom domains use HSTS, but only for the particular subdomain. Strict-Transport-Security: max-age=63072000;" (https://vercel.com/docs/security/encryption). hstspreload.org requirements: valid certificate; HTTP->HTTPS redirect on the same host; all subdomains on HTTPS; header on the base domain with `max-age` >= 31536000, `includeSubDomains`, `preload`; and its own advice "While HSTS is recommended, HSTS preloading is not recommended." Removal takes months. **`.dev` and `.app` are already preloaded as TLDs** (hstspreload.org API: `"name": "dev", "status": "preloaded"`; same for `app`), so a mosshatch.dev / .app apex needs no submission; `.com/.ai/.io/.studio` do. OWASP's sample is `max-age=63072000; includeSubDomains; preload`. |
| `X-Content-Type-Options` | `nosniff` | OWASP: "Set the Content-Type header correctly throughout the site." Blocks MIME-confusion of user-influenced content. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | OWASP recommends exactly this; it is also the browser default. Cross-site requests see only the origin, so the Stripe return URL's `session_id` is not leaked in Referer to third parties. **Do not use `no-referrer` if any real `<form>` posts to the API with an Origin check**: Chromium 141 test - under `no-referrer` a same-origin form POST arrived with `Origin: null` (fetch() POST/DELETE still sent `Origin: http://localhost:5390`); under `same-origin`, `strict-origin-when-cross-origin` and `origin` the form sent the real origin. |
| `Permissions-Policy` | `publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), display-capture=(), xr-spatial-tracking=()` | MDN: "The default allowlist for publickey-credentials-get is self." so the entry documents intent rather than opening anything. **Enforced only by Chromium** (BCD 8.1.3: Firefox/Safari `false` for the header and for each directive) - defence in depth against injected scripts, not a cross-browser control. `bluetooth` and (deprecated) `browsing-topics` were dropped: Chromium 141 logged "Error with Permissions-Policy header: Unrecognized feature: 'bluetooth'." Add `accelerometer=() gyroscope=()` only if the creatures do not use device tilt. |
| `Cross-Origin-Opener-Policy` | `same-origin` | OWASP: isolates the browsing context group. No popup-based flows are planned (passkeys and Stripe redirect are same-tab). |
| `Cross-Origin-Resource-Policy` | `same-origin` | OWASP shows `same-site`; `same-origin` is stricter. Fonts/JS/CSS loaded fine under it. A public share-card image route that others embed must send `Cross-Origin-Resource-Policy: cross-origin` from its own function (function headers override vercel.json). COEP is not needed (no SharedArrayBuffer). |
| `X-Frame-Options` | `DENY` | Legacy twin of `frame-ancestors 'none'` (OWASP: CSP obsoletes it). |
| `Cache-Control` | HTML: Vercel default `public, max-age=0, must-revalidate`; `/assets/*`: `public, max-age=31536000, immutable`; `/api/*` and every secret-reveal/session response: `no-store` set **inside the function** | MDN: "The no-store response directive indicates that any caches of any kind (private or shared) should not store this response." Vercel: "For content that must never be cached, use no-store." and "if you return Cache-Control headers in a Vercel Function, it will override the headers defined for the same route in vercel.json". OWASP Session Management: "it is highly recommended to include the Cache-Control: no-store directive in responses containing session IDs". |
| `Clear-Site-Data` (logout only) | `"cookies", "storage"` | See 5.5. |
| `Content-Security-Policy*`, `Reporting-Endpoints` | section 3 | |

## 5. Cookies, CSRF, CORS

### 5.1 Cookie rules

- `__Host-` prefix: MDN - "must be set with the Secure attribute by a secure page (HTTPS). In addition, they must not have a Domain attribute specified, and the Path attribute must be set to /." Supported since Chrome 49, Firefox 50, Safari 13. The stricter `__Host-Http-` (forces HttpOnly) is Chrome 140+/Firefox 143+ only, not Safari, so use plain `__Host-` plus HttpOnly. OWASP: `__Host-` is "Recommended for session IDs", and warns never to set a Domain (subdomains share it).
- Always set `SameSite` explicitly: BCD shows Lax-by-default only in Chrome 80 / Edge 86 (Firefox flag, Safari none); OWASP: "do not rely on the browser-default value, which varies across browsers and versions." Chrome's default-Lax "Lax+POST" 2-minute exception (MDN) applies only when SameSite is unspecified - another reason to be explicit.
- `HttpOnly` mandatory; keep tokens out of localStorage (OWASP Session Management). Session ID from a CSPRNG (OWASP Session Management: "at least `64 bits` of entropy"; 256 bits used here), rotated at login/passkey step-up, absolute + idle timeout server-side.

```
Set-Cookie: __Host-mh_sid=<256-bit base64url>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800
# optional hardening, RFC 6265bis 8.8.2 "write" cookie, required on every non-GET request:
Set-Cookie: __Host-mh_w=<256-bit base64url>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800
```

### 5.2 SameSite=Strict vs the return from Stripe Checkout (verified)

Spec (RFC 6265bis draft-22, in the RFC Editor queue): "Same-site cookies in "Strict" enforcement mode will not be sent along with top-level navigations which are triggered from a cross-site document context." and 8.8.2: "Developers can avoid this confusion by adopting a session management system that relies on not one, but two cookies: one conceptually granting "read" access, another granting "write" access. The latter could be marked as SameSite=Strict, and its absence would prompt a reauthentication step before executing any non-idempotent action." OWASP CSRF sheet: with Strict a user following a link "will not be able to access the project because GitHub will not receive a session cookie"; Lax "provides a reasonable balance".

Test setup (Chromium 141): our app on `http://localhost:5190`, "Stripe" on `http://127.0.0.1:5191` (different host = cross-site). Cookies set by our app: `sid_strict` (SameSite=Strict), `sid_lax` (Lax), `sid_default` (no SameSite attribute). What our server received:

| How the user lands back on our site | Sec-Fetch-Site | Strict | Lax | unspecified (Chrome default) |
|---|---|---|---|---|
| Script `location.href = ourUrl` on the Stripe origin (closest match to a post-payment redirect; Stripe's own redirect code was not inspected) | cross-site | **not sent** | sent | sent |
| Stripe origin answers `303` to ourUrl (after a script navigation) | cross-site | **not sent** | sent | sent |
| `303` to our `/hop`, which `302`s to `/landing` (two hops on our origin) | cross-site on both hops | **not sent on either hop** | sent | sent |
| User clicks a link on the Stripe origin (`Sec-Fetch-User: ?1`) | cross-site | **not sent** | sent | sent |
| Cross-site `<form method=POST>` to our URL | cross-site | not sent | not sent | sent (Lax+POST, cookie < 2 min old) |
| Address-bar/bookmark navigation (browser-initiated) | none | sent | sent | sent |
| **Then** a same-origin `fetch('/api/me')` from the landed page | same-origin | **sent** | sent | sent |

Consequences: (1) the HTML request for `success_url` never carries a Strict cookie, so a server-side "if no session -> redirect to login" on that route would log everyone out; (2) an SPA that serves a static shell and reads the session with its first `fetch('/api/me')` works fine with Strict; (3) redirect chains do not launder the initiator (Fetch Metadata spec: `Sec-Fetch-Site` "will send cross-site if any URL in the list is cross-site"). Firefox and Safari follow the same spec text; I could not run them here (unverified by test).

**Recommendation.** Session cookie = `__Host-` + `Secure; HttpOnly; Path=/; SameSite=Lax`. Reasons: the Stripe return, e-mail (Resend) confirmation links and any deep link keep working without extra code; all mutating calls are non-GET, which Lax never sends cross-site (the 2-minute Lax+POST exception does not apply when SameSite is explicit); CSRF is then closed by the checks in 5.3, and money/secret operations additionally need a fresh passkey assertion bound to the action, so a forged request cannot complete them. If you want Strict's extra guarantee, add the RFC 8.8.2 second cookie (`__Host-mh_w`, Strict) and require it on non-GET calls; never make the `success_url` HTML, or any server-side redirect, depend on a Strict cookie. Strict-only sessions are viable only if every authenticated read happens through same-origin `fetch` after a static shell loads.

### 5.3 CSRF defences for the cookie-authenticated JSON API

OWASP CSRF sheet: use Fetch Metadata "together with the fallback options described below", "a fallback to standard origin verification headers is a mandatory requirement for any Fetch Metadata implementation", "Treat cross-site as untrusted for state-changing actions. By default, reject non-safe methods (POST / PUT / PATCH / DELETE) when Sec-Fetch-Site: cross-site", allow `none` only for user-driven navigations, and "Do not use GET requests for state changing operations." `Sec-Fetch-Site` support (BCD): Chrome 76, Firefox 90, Safari 16.4; sent only to potentially trustworthy URLs (HTTPS/localhost). Observed in Chromium: our own `fetch` POST/GET arrive with `Sec-Fetch-Site: same-origin`, POST/DELETE fetches also carry `Origin`, GET fetches do not.

```ts
// api/_lib/guard.ts - call first in every non-GET cookie-authenticated handler
const APP_ORIGIN = process.env.APP_ORIGIN!;               // "https://mosshatch.example"
export function guardMutation(req: Request): Response | null {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return null;   // and never mutate on GET
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs !== null && sfs !== "same-origin") return deny("fetch-metadata");  // "none" is navigation-only; "same-site" = sibling subdomain, also rejected
  if (req.headers.get("origin") !== APP_ORIGIN) return deny("origin");       // mandatory fallback; also rejects "null"
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return new Response(null, { status: 415 });
  if (req.headers.get("x-mh-client") !== "web") return deny("custom-header");
  return null;                                                              // then: cookie auth, then passkey step-up for money/secrets
}
const deny = (why: string) => new Response(JSON.stringify({ error: "forbidden", why }), { status: 403, headers: { "content-type": "application/json", "cache-control": "no-store" } });
```
- Layers: (a) `SameSite=Lax` cookie; (b) `Sec-Fetch-Site` + `Origin`; (c) JSON-only body and a custom header - both force a CORS preflight from other origins (MDN CORS: a cross-origin request with a custom header or non-safelisted `Content-Type` "is preflighted") which a same-origin-only API refuses; (d) no state change on GET; (e) passkey-bound approval for anything that costs money or reveals/exports secrets (the assertion covers a server challenge that encodes the action, so the cookie alone is never enough). The custom header is defence in depth only; it relies on the same-origin policy, as OWASP notes.
- Agent tokens: `Authorization: Bearer` routes (`/api/agent/*`) are not ambient credentials, so they are not CSRF-able; they must ignore cookies and cookie routes must ignore bearer tokens, so neither can be confused for the other.
- Add `Vary: Origin, Sec-Fetch-Site` only if a response is ever made cacheable; API responses are `no-store`.

### 5.4 CORS

- Same-origin SPA + API: send **no** `Access-Control-*` headers; answer `OPTIONS` with 204 and none of them. MDN: "When responding to a credentialed requests request, the server must specify an origin ... instead of specifying the * wildcard", so a wildcard cannot expose the cookie API anyway; never reflect arbitrary `Origin`.
- Agents: non-browser agents do not use CORS. If a browser-hosted agent needs `/api/agent/*`, allow-list its exact origin, allow only `Authorization`/`Content-Type`, send no `Access-Control-Allow-Credentials`, and add `Vary: Origin`.
- OWASP's CORS cheat sheet path returned 404 from GitHub raw, so CORS guidance is cited from MDN only.

### 5.5 Logout

Server-side: delete the session row first (the real logout). Response: `Set-Cookie: __Host-mh_sid=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` (same for `__Host-mh_w`) and `Clear-Site-Data: "cookies", "storage"`. Facts (MDN): the header is HTTPS-only; `"cookies"` "affects the entire registered domain, including subdomains"; `"storage"` clears localStorage/sessionStorage/IndexedDB and unregisters service workers; supported Chrome 61, Firefox 63, Safari 17 (BCD). `"cache"` is only partially implemented in Chromium and BCD notes it "may cause seconds-long hangs", and secret responses are `no-store` anyway, so `"cache"` is optional (OWASP's example includes it: `Clear-Site-Data: "cache", "cookies", "storage"`). Keep the explicit `Set-Cookie` expiry because Safari < 17 ignores the header.

## 6. Service workers

- Do not ship one in Phase 0. If a PWA shell is added later: register from the same origin only, restrict scope, precache the hashed `/assets/*` files only, deny-list `/api/*`, non-GET and navigation requests, and ship an unregister kill-switch (OWASP HTML5 sheet). `Clear-Site-Data: "storage"` unregisters workers on logout.
- **`Cache-Control: no-store` does not stop the Cache API.** Service Worker spec `Cache.put()` steps reject only non-GET/non-http(s), status 206 and `Vary: *`; the header is never consulted. Chromium 141 test: `fetch('/secret')` (server sent `Cache-Control: no-store`), `cache.put('/secret', res)`, `cache.match('/secret')` returned `TOP-SECRET-VALUE`. OWASP's HTML5 Security sheet says "Send Cache-Control: no-store on those responses so the Cache API will not retain them" - that statement is not borne out by the spec or Chromium (conflict reported; trust the spec/test). A generic "cache everything" Workbox runtime route would persist revealed secrets in Cache Storage.
- `worker-src 'self'` in the CSP already allows a same-origin worker file.

## 7. `vercel.json` draft (headers + SPA rewrite)

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Content-Security-Policy",
          "value": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests; report-uri /api/csp-report; report-to csp"
        },
        {
          "key": "Content-Security-Policy-Report-Only",
          "value": "require-trusted-types-for 'script'; trusted-types; report-uri /api/csp-report; report-to csp"
        },
        {
          "key": "Reporting-Endpoints",
          "value": "csp=\"https://APP_ORIGIN/api/csp-report\""
        },
        {
          "key": "Strict-Transport-Security",
          "value": "max-age=63072000"
        },
        {
          "key": "X-Content-Type-Options",
          "value": "nosniff"
        },
        {
          "key": "Referrer-Policy",
          "value": "strict-origin-when-cross-origin"
        },
        {
          "key": "Permissions-Policy",
          "value": "publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), display-capture=(), xr-spatial-tracking=()"
        },
        {
          "key": "Cross-Origin-Opener-Policy",
          "value": "same-origin"
        },
        {
          "key": "Cross-Origin-Resource-Policy",
          "value": "same-origin"
        },
        {
          "key": "X-Frame-Options",
          "value": "DENY"
        }
      ]
    },
    {
      "source": "/assets/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    },
    {
      "source": "/api/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "no-store"
        }
      ]
    }
  ]
}
```

Notes on this file:
- Verified: this exact header set was served to the probe apps (Chromium 141) with zero unexpected violations/warnings after removing `bluetooth`/`browsing-topics` from Permissions-Policy. JSON validity checked with Python `json`.
- Rule design: the three `source` rules set **disjoint header names** (rule 1 security headers, rule 2 `Cache-Control` for hashed assets, rule 3 `Cache-Control` for `/api`), so the order in which Vercel merges overlapping rules does not matter (merge order for duplicate keys is not documented in what I read: unverified). Vercel doc for the filesystem-first rewrite: "precedence is given to the filesystem prior to rewrites being applied", so `/api/*` functions and `/assets/*` files win over the SPA fallback.
- Vercel: "This example configures custom response headers for static files, Vercel functions, and a wildcard that matches all routes." Headers returned by a function override the vercel.json values, so set `Cache-Control: no-store` in reveal/session handlers as well. Replace `APP_ORIGIN` with the production host. `Reporting-Endpoints` is HTTPS-only.
- Not tested on a live Vercel deployment: whether the explicit `Strict-Transport-Security` replaces or duplicates the platform default; whether Vercel forwards `Sec-Fetch-*` to functions (docs are silent).


## 8. Findings table (source of truth for the structured summary)

Every row: claim, value, primary URL, access date, exact quote or description of my own test, confidence. Rows marked "own test" are observations from the probes in `fcsp/`.

| # | Claim | Value | Source (URL) | Accessed | Exact quote / evidence | Confidence |
|---|---|---|---|---|---|---|
| F1 | Young Serif is licensed under SIL OFL 1.1 (copyright 'The Young Serif Project Authors'); OFL.txt identical in upstream and in google/fonts | SIL OFL 1.1 | https://raw.githubusercontent.com/google/fonts/main/ofl/youngserif/OFL.txt | 2026-09-29 | This Font Software is licensed under the SIL Open Font License, Version 1.1. | high |
| F2 | Atkinson Hyperlegible (original) is OFL 1.1, copyright Braille Institute of America, Inc.; free for anyone to use | SIL OFL 1.1 | https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible/main/README.md | 2026-09-29 | The Braille Institute has made this free for anyone to use, under the SIL Open Font License. | high |
| F3 | Atkinson Hyperlegible Next is OFL 1.1, copyright 'The Atkinson Hyperlegible Next Project Authors' | SIL OFL 1.1 | https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/main/OFL.txt | 2026-09-29 | Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors (https://github.com/googlefonts/atkinson-hyperlegible-next) | high |
| F4 | OFL 1.1 permits use, embedding, modification, redistribution and bundling with software, provided the copyright notice and licence travel with each copy and the font is not sold by itself | conditions 1-5 | https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/main/OFL.txt | 2026-09-29 | may be bundled, redistributed and/or sold with any software, provided that each copy contains the above copyright notice and this license. | high |
| F5 | OFL FAQ explicitly allows self-hosting fonts as webfonts via @font-face on your own server | allowed | https://openfontlicense.org/ofl-faq/ | 2026-09-29 | The referenced fonts can be hosted on the same server as other site assets and content, or loaded from a separate webfont service. This is recommended and explicitly allowed by the licensing model because it is distribution. | high |
| F6 | Subsetting a webfont is a Modified Version: permitted, but Reserved Font Names cannot be used in the modified font's name | permitted; RFN rule applies | https://openfontlicense.org/ofl-faq/ | 2026-09-29 | Yes. Removing any parts of the font when delivering a webfont to a browser, including unused glyphs and smart font code, is considered modification. This is permitted by the OFL but would not normally allow the use of RFNs. | high |
| F7 | None of the four fetched OFL.txt files declares a Reserved Font Name (0 occurrences of 'with Reserved Font Name'), so a subset needs no rename; keep copyright + licence text with the files | 0 RFNs declared | https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible/main/OFL.txt | 2026-09-29 | "Reserved Font Name" refers to any names specified as such after the copyright statement(s). | high |
| F8 | Google Fonts still serves Young Serif as a single static weight 400 (v2); no variable/other weights on Google Fonts today | wght 400 only | https://fonts.googleapis.com/css2?family=Young+Serif&family=Atkinson+Hyperlegible+Next:wght@200..800&family=Atkinson+Hyperlegible:wght@400;700&display=swap | 2026-09-29 | font-family: 'Young Serif'; font-style: normal; font-weight: 400; | high |
| F9 | Upstream Young Serif master (v6.002, not on Google Fonts) adds a wght 300-700 variable font and true italics; branch is a moving target (jsDelivr listing sizes differed from downloaded files), so pin a commit if adopted | fvar wght 300..700 (Light default) | https://cdn.jsdelivr.net/gh/noirblancrouge/YoungSerif@master/README.md | 2026-09-29 | 27 Feb 2025 (Bastien Sozeau) - Added a light weight master and two other italic masters for each weight allowing the generation of a variable version. | medium |
| F10 | Atkinson Hyperlegible Next is a variable font, wght 200-800, upright and italic, on Google Fonts (v7) and in the official repo; repo also ships static woff2 for seven weights | wght 200..800 | https://raw.githubusercontent.com/google/fonts/main/ofl/atkinsonhyperlegiblenext/METADATA.pb | 2026-09-29 | axes { tag: "wght" min_value: 200.0 max_value: 800.0 } | high |
| F11 | Source conflict: Next README says weights 'increased to six' but the repo ships seven (ExtraLight, Light, Regular, Medium, SemiBold, Bold, ExtraBold) and fvar spans 200-800 | 6 (README) vs 7 (files) | https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/main/README.md | 2026-09-29 | the two previous weights has increased to six, all in upright and italic | medium |
| F12 | Original Atkinson Hyperlegible is static only: Regular/Bold x roman/italic, 27 languages, 335 glyphs per font | 4 static fonts | https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible/main/README.md | 2026-09-29 | Four fonts, including two weights (regular, bold, italics, italics bold) | high |
| F13 | Google-prebuilt latin woff2 sizes (measured): Young Serif 26,992 B; Atkinson 400 17,208 B; Atkinson 700 17,524 B; Atkinson Next variable 33,996 B | 26,992 / 17,208 / 17,524 / 33,996 B | https://fonts.gstatic.com/s/youngserif/v2/3qTpojO2nS2VtkB3KtkQZ1t93kY.woff2 | 2026-09-29 | measured with curl -w %{size_download} | high |
| F14 | My pyftsubset build (fonttools 4.66.1 + brotli 1.2.0, Google's latin unicode-range, unhinted): Young Serif 400 = 18,440 B; Atkinson Hyperlegible Next variable clamped to wght 400-700 = 20,356 B; total 38,796 B vs 60,988 B for Google's prebuilt latin pair (-36.4%). A tighter ASCII+Latin-1 set gives 17,728 + 18,996 = 36,724 B | 38,796 B total | https://pypi.org/project/fonttools/ | 2026-09-29 | own measurement (commands in section 2.4) | high |
| F15 | Hinting removal is what shrinks Young Serif (ttfautohint bytecode): 27,256 B -> 18,440 B (-32%); Atkinson Next variable is already unhinted (33,948 -> 33,944 B); clamping its wght axis from 200-800 to 400-700 saves 40% (33,944 -> 20,356 B) | -32% / ~0% / -40% | https://pypi.org/project/fonttools/ | 2026-09-29 | own measurement (section 2.4) | high |
| F16 | Glyph coverage gap: Young Serif (Google v3.003), Atkinson and Atkinson Next contain none of the arrows U+2190-2193/2197, U+2713 check, U+2715 cross; use SVG icons | missing glyphs | https://pypi.org/project/fonttools/ | 2026-09-29 | own cmap check with fontTools | high |
| F17 | Subset files keep name records 0 (copyright) and 13/14 (licence) when built with --name-IDs='*' | kept | https://openfontlicense.org/ofl-faq/ | 2026-09-29 | own check; OFL FAQ: 'Put your copyright and the OFL text ... into your font files (the copyright and license fields).' | high |
| F18 | font-display: swap = 'extremely small block period and an infinite swap period'; preload of fonts needs crossorigin even when same-origin | swap + preload crossorigin | https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/preload | 2026-09-29 | font and fetch preloading requires the crossorigin attribute to be set | high |
| F19 | Vite 8.3.1 rewrites <link rel=preload href=/src/fonts/x.woff2> to the same hashed /assets/x-HASH.woff2 URL that the CSS @font-face uses (no double download) | verified by build | https://vite.dev/guide/features.html | 2026-09-29 | own build test (dist2/index2.html + CSS) | high |
| F20 | size-adjust is supported in Chrome 92, Firefox 92, Safari 17; ascent/descent/line-gap-override in Chrome 87, Firefox 89, not in Safari (preview only) | BCD 8.1.3 | https://www.npmjs.com/package/@mdn/browser-compat-data | 2026-09-29 | css.at-rules.font-face.size-adjust: safari 17; ascent-override: safari 'preview' | high |
| F21 | Alternative distribution via npm (all OFL-1.1, modified 2026-07-19): @fontsource/young-serif 5.3.0, @fontsource/atkinson-hyperlegible 5.3.0, @fontsource-variable/atkinson-hyperlegible-next 5.3.0 ship Google-derived latin/latin-ext woff2 with the same byte sizes as gstatic; @fontsource-variable/young-serif does not exist (404) | 5.3.0 | https://www.npmjs.com/package/@fontsource/young-serif | 2026-09-29 | license = 'OFL-1.1' (npm view @fontsource/young-serif) | high |
| F22 | Vite 8.3.1 production index.html contains no inline script/style: only <script type=module crossorigin src> and <link rel=stylesheet crossorigin href>; modulepreload polyfill lives inside the JS bundle, so script-src 'self' needs no nonce/hash | no inline code | https://vite.dev/guide/features.html | 2026-09-29 | When html.cspNonce is set, Vite adds a nonce attribute with the specified value to any <script> and <style> tags, as well as <link> tags for stylesheets and module preloading. | high |
| F23 | Vite nonces need a unique per-request value, impossible on static hosting; avoid by keeping all code external | nonce not used | https://vite.dev/guide/features.html | 2026-09-29 | Ensure that you replace the placeholder with a unique value for each request. | high |
| F24 | Vite inlines assets < 4096 B as data: URIs by default; either allow data: in img-src/font-src or set build.assetsInlineLimit: 0 | default 4096 | https://vite.dev/config/build-options.html | 2026-09-29 | Imported or referenced assets that are smaller than this threshold will be inlined as base64 URLs | high |
| F25 | React inline style props do not need style-src-attr 'unsafe-inline': React DOM 19.3.0 applies them through CSSOM (style.setProperty / style[name]=), which CSP does not block; markup style="" and setAttribute('style') are blocked. Verified in Chromium 141 under style-src 'self' | no unsafe-inline | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src-attr | 2026-09-29 | Style properties that are set directly on the element's style property will not be blocked, allowing users to safely manipulate styles via JavaScript | high |
| F26 | three.js core needs no 'unsafe-eval': three@0.186.1 src/ and build/*.js contain no eval() or new Function(); a WebGL2 scene with ShaderMaterial + MeshStandardMaterial (2 GLSL programs) and @react-three/fiber 9.8.1 ran with zero CSP violations under script-src 'self' (headless Chromium 141, SwiftShader) | 0 violations | https://discourse.threejs.org/t/how-to-set-content-security-policy-for-usegltfs/51398 | 2026-09-29 | own test; forum (maintainer): the 'unsafe-eval' error there was for WebAssembly.instantiate of Draco-compressed GLTF, not shaders | high |
| F27 | Draco/KTX2 loaders build a Blob worker (worker-src blob:) and use WebAssembly ('wasm-unsafe-eval' is enough; eval/new Function stay blocked); three r186 DRACOLoader line 426 and KTX2Loader line 329 call URL.createObjectURL(new Blob(...)) | worker-src blob: + wasm-unsafe-eval | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src | 2026-09-29 | The 'wasm-unsafe-eval' source expression is more specific than 'unsafe-eval' which permits both compilation (and instantiation) of WebAssembly and, for example, the use of the eval operation in JavaScript. | high |
| F28 | worker-src falls back to child-src, then script-src, then default-src | fallback chain | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src | 2026-09-29 | the user agent will first look for the child-src directive, then the script-src directive, then finally for the default-src directive, when governing worker execution. | high |
| F29 | Card snapshot: canvas.toBlob + URL.createObjectURL needs img-src blob:; canvas.toDataURL needs img-src data:. Both were blocked under img-src 'self' and allowed when listed | blob: required; data: optional | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/img-src | 2026-09-29 | own test in Chromium 141 (blobimg naturalWidth 200 only when listed) | high |
| F30 | frame-ancestors does not fall back to default-src; 'none' is the CSP equivalent of X-Frame-Options: DENY | frame-ancestors 'none' | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors | 2026-09-29 | A policy that declares default-src 'none' still allows the resource to be embedded by anyone. | high |
| F31 | object-src 'none' and base-uri restrictions are recommended; base-uri and form-action do not fall back to default-src | object-src 'none'; base-uri 'none' | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/object-src | 2026-09-29 | it is recommended to restrict this fetch-directive (e.g., explicitly set object-src 'none' if possible). | high |
| F32 | form-action 'self' blocks the 303 redirect of a same-origin form POST to a cross-origin URL in Chromium (POST reached our server, redirect to checkout.stripe.com-style host was refused); fetch()+JSON+location.assign is unaffected; Firefox behaviour differs per MDN | Chromium blocks; location.assign OK | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/form-action | 2026-09-29 | Whether form-action should block redirects after a form submission is debated and browser implementations of this aspect are inconsistent (e.g., Firefox 57 doesn't block the redirects whereas Chrome 63 does). | high |
| F33 | CSP3 form-action pre-navigation check applies only to navigation type 'form-submission'; navigate-to is not in the spec text | form-submission only | https://w3c.github.io/webappsec-csp/ | 2026-09-29 | If navigation type is "form-submission": If the result of executing ... "Does Not Match", return "Blocked". | high |
| F34 | Stripe's hosted-Checkout quickstart posts an HTML form and answers with a 303 redirect to session.url; success_url can carry {CHECKOUT_SESSION_ID} | form POST + 303 | https://docs.stripe.com/checkout/quickstart.md | 2026-09-29 | res.redirect(303, session.url); | high |
| F35 | Stripe lists CSP directives for Checkout as connect-src/frame-src/script-src https://checkout.stripe.com and img-src https://*.stripe.com (embedded / Stripe.js use); our redirect-only integration loads nothing from Stripe on our pages | not needed for redirect (inferred) | https://docs.stripe.com/security/guide.md | 2026-09-29 | #### Checkout - `connect-src`, `https://checkout.stripe.com` - `frame-src`, `https://checkout.stripe.com` - `script-src`, `https://checkout.stripe.com` - `img-src`, `https://*.stripe.com` | medium |
| F36 | Trusted Types (require-trusted-types-for / trusted-types) ships in Chrome 83, Firefox 148, Safari 26; MDN marks it Baseline 2026 newly available since February 2026 | Chrome 83 / FF 148 / Safari 26 | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/require-trusted-types-for | 2026-09-29 | Since February 2026, this feature works across the latest devices and browser versions. | high |
| F37 | Trusted Types is feasible for this stack: react-dom 19.3.0 production has innerHTML only for dangerouslySetInnerHTML and <script> creation; three has none; React+three and R3F ran with require-trusted-types-for 'script'; trusted-types (no policies) with zero violations. new Worker(url), eval and Function are sinks (violations seen) | 0 violations on baseline app | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/trusted-types | 2026-09-29 | The require-trusted-types-for directive must be set to enable enforcement of trusted types | high |
| F38 | report-to replaces report-uri, but report-uri is still needed until report-to is broadly supported; Firefox added CSP report-to in 149; Reporting-Endpoints URLs must be secure | use both | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/report-to | 2026-09-29 | The report-to directive is intended to replace report-uri, and browsers that support report-to ignore the report-uri directive. | high |
| F39 | Local test: report-uri delivered 7 reports within 5 s (Content-Type application/csp-report); report-to to an http:// endpoint delivered none, consistent with MDN ('non-secure endpoints are ignored'); HTTPS delivery not tested | report-uri OK; report-to untested on HTTPS | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Reporting-Endpoints | 2026-09-29 | non-secure endpoints are ignored | medium |
| F40 | Vercel advises deploying CSP as Content-Security-Policy-Report-Only first | report-only first | https://vercel.com/docs/headers/security-headers | 2026-09-29 | Before enforcing a CSP, start with the Content-Security-Policy-Report-Only header. | high |
| F41 | OWASP's tightest example policy for an app with same-origin resources matches our shape | default-src 'none' baseline | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Content_Security_Policy_Cheat_Sheet.md | 2026-09-29 | Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; frame-ancestors 'self'; form-action 'self'; | high |
| F42 | HSTS preload requires max-age >= 31536000, includeSubDomains and preload on the base domain, HTTPS on all subdomains; hstspreload.org itself says preloading is not recommended and is hard to undo | 31536000 + includeSubDomains + preload | https://hstspreload.org/ | 2026-09-29 | While HSTS is recommended, HSTS preloading is not recommended. | high |
| F43 | Vercel sends HSTS max-age=63072000 by default on custom domains (host only, no includeSubDomains/preload); *.vercel.app is preloaded; you can override via custom headers | max-age=63072000 | https://vercel.com/docs/security/encryption | 2026-09-29 | Custom domains use HSTS, but only for the particular subdomain. | high |
| F44 | The .dev and .app TLDs are themselves on the HSTS preload list (hstspreload.org status API) | status: preloaded | https://hstspreload.org/api/v2/status?domain=dev | 2026-09-29 | "name": "dev", "status": "preloaded" | high |
| F45 | X-Content-Type-Options: nosniff on every response; set correct Content-Type | nosniff | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/HTTP_Headers_Cheat_Sheet.md | 2026-09-29 | X-Content-Type-Options: nosniff | high |
| F46 | Referrer-Policy strict-origin-when-cross-origin is the OWASP recommendation and the browser default. Do not use no-referrer if Origin checks guard <form> posts: in Chromium a same-origin form POST then sends Origin: null (fetch() POST still sends the real Origin) | strict-origin-when-cross-origin | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/HTTP_Headers_Cheat_Sheet.md | 2026-09-29 | Referrer-Policy: strict-origin-when-cross-origin | high |
| F47 | publickey-credentials-get defaults to 'self'; the Permissions-Policy header is enforced only by Chromium (Firefox/Safari 'false' in BCD 8.1.3); Chromium 141 warns 'Unrecognized feature: bluetooth', so unknown tokens must be pruned | publickey-credentials-get=(self) | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/publickey-credentials-get | 2026-09-29 | The default allowlist for publickey-credentials-get is self. | high |
| F48 | COOP same-origin and CORP (same-origin/same-site) are OWASP-recommended; COEP is not needed | COOP same-origin; CORP same-origin | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/HTTP_Headers_Cheat_Sheet.md | 2026-09-29 | Cross-Origin-Opener-Policy: same-origin | high |
| F49 | Cache-Control: no-store means no cache of any kind may store the response; Vercel Function responses default to public, max-age=0, must-revalidate, and a Cache-Control set in the function overrides vercel.json for that route | no-store | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control | 2026-09-29 | The no-store response directive indicates that any caches of any kind (private or shared) should not store this response. | high |
| F50 | Vercel: 'if you return Cache-Control headers in a Vercel Function, it will override the headers defined for the same route in vercel.json' | function wins | https://vercel.com/docs/caching/cdn-cache | 2026-09-29 | if you return Cache-Control headers in a Vercel Function, it will override the headers defined for the same route in vercel.json or next.config.js. | high |
| F51 | vercel.json headers apply to static files, Vercel Functions and wildcard routes | applies to all | https://vercel.com/docs/project-configuration/vercel-json.md | 2026-09-29 | This example configures custom response headers for static files, Vercel functions, and a wildcard that matches all routes. | high |
| F52 | Clear-Site-Data 'cookies' clears the whole registered domain incl. subdomains; 'storage' also unregisters service workers; header needs HTTPS; 'cache' is only partially implemented in Chromium (BCD notes hangs) | "cookies", "storage" | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Clear-Site-Data | 2026-09-29 | This affects the entire registered domain, including subdomains. | high |
| F53 | __Host- cookies must be Secure, set from HTTPS, have no Domain and Path=/; __Host- supported since Chrome 49, Firefox 50, Safari 13; __Host-Http- only Chrome 140+/Firefox 143+ (not Safari) | __Host- prefix | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie | 2026-09-29 | they must not have a Domain attribute specified, and the Path attribute must be set to /. | high |
| F54 | Lax-by-default exists only in Chrome 80 / Edge 86 (Firefox behind a flag, Safari none), so always set SameSite explicitly | explicit SameSite | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Session_Management_Cheat_Sheet.md | 2026-09-29 | do not rely on the browser-default value, which varies across browsers and versions. | high |
| F55 | Spec: SameSite=Strict cookies are not sent with top-level navigations triggered from a cross-site document | Strict withheld | https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/ | 2026-09-29 | Same-site cookies in "Strict" enforcement mode will not be sent along with top-level navigations which are triggered from a cross-site document context. | high |
| F56 | Chromium 141 test (cross-site = 127.0.0.1 -> localhost): every cross-site-initiated navigation (JS location, link click, 303, 303 then same-site 302 hop) arrived WITHOUT the Strict cookie and WITH the Lax cookie; the following same-origin fetch('/api/me') carried all cookies; cross-site POST carried only the unspecified-SameSite cookie (Lax+POST 2-minute rule) | Strict absent, Lax present | https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/ | 2026-09-29 | own test (section 5.2 table) | high |
| F57 | Chrome's default-Lax 'Lax+POST' exception (send on cross-site POST within 2 minutes) applies only when SameSite is unspecified | 2 minutes | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie | 2026-09-29 | cookies are also included in POST requests, as long as they were set no more than two minutes before the request was made. | high |
| F58 | RFC 6265bis (draft-22, in the RFC Editor queue) recommends a two-cookie design: a Lax 'read' cookie and a Strict 'write' cookie whose absence forces re-authentication | Lax read + Strict write | https://www.ietf.org/archive/id/draft-ietf-httpbis-rfc6265bis-22.txt | 2026-09-29 | The latter could be marked as SameSite=Strict, and its absence would prompt a reauthentication step before executing any non-idempotent action. | high |
| F59 | OWASP CSRF: use Fetch Metadata with a mandatory Origin fallback; reject non-safe methods when Sec-Fetch-Site is cross-site; allow 'none' only for user-driven navigations; never GET for state changes | Sec-Fetch-Site + Origin | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.md | 2026-09-29 | Because some legacy browsers do not send Sec-Fetch-* headers, a fallback to standard origin verification headers is a mandatory requirement for any Fetch Metadata implementation. | high |
| F60 | Sec-Fetch-Site supported in Chrome 76, Firefox 90, Safari 16.4; the header value is 'cross-site' if any URL in a redirect chain is cross-site | BCD 8.1.3 | https://w3c.github.io/webappsec-fetch-metadata/ | 2026-09-29 | will send cross-site if any URL in the list is cross-site to the request’s current URL | high |
| F61 | Cross-origin JSON POSTs and custom headers force a CORS preflight (application/json is not a CORS-safelisted content type), so a same-origin-only API blocks them; credentialed CORS can never use the * wildcard | preflight | https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS | 2026-09-29 | Since the request uses a Content-Type of text/xml, and since a custom header is set, this request is preflighted. | high |
| F62 | Cache.put() stores responses that carry Cache-Control: no-store (spec rejects only non-GET, 206 and Vary:*); verified in Chromium 141. OWASP's HTML5 sheet claims no-store stops the Cache API - that is not what the spec or Chromium does | no-store not honoured by cache.put | https://w3c.github.io/ServiceWorker/ | 2026-09-29 | If innerResponse’s status is 206, return a promise rejected with a TypeError. | high |

## 9. Compliance and hardening checklist

| # | Item | Requirement | Applies to | Source | How Mosshatch meets it |
|---|---|---|---|---|---|
| C1 | Ship the OFL text and copyright with every font copy | OFL condition 2: each copy contains the copyright notice and the licence (files or name-table fields) | Young Serif, Atkinson Hyperlegible (Next) woff2 files | https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/main/OFL.txt | Build with --name-IDs='*' (keeps nameID 0/13/14) and publish OFL-YoungSerif.txt / OFL-Atkinson.txt next to the fonts plus a /legal/fonts notice |
| C2 | Never sell the fonts by themselves | OFL condition 1 | Anything that would package the fonts as a product (theme/template download) | https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/main/OFL.txt | Fonts are bundled inside the web app only; no font download product |
| C3 | Do not use a Reserved Font Name in a Modified Version | OFL condition 3 (only if an RFN is declared) | Subset/instanced files | https://openfontlicense.org/ofl-faq/ | No RFN is declared in any of the four OFL.txt files (grep = 0); re-check the header line on every font update and rename the family if one appears |
| C4 | Enforced CSP with default-src 'none' after a Report-Only soak | Start with Content-Security-Policy-Report-Only, then enforce | All HTML responses | https://vercel.com/docs/headers/security-headers | Ship both headers from vercel.json; run Report-Only for the Trusted Types policy until the report endpoint is quiet |
| C5 | No inline script or style; no data: in script-src | Vite: data: only for img/font, never script; keep build.assetsInlineLimit 0 | index.html and Vite config | https://vite.dev/guide/features.html | Verified Vite 8.3.1 output has no inline code; theme-flash logic must be an external script; set assetsInlineLimit: 0 |
| C6 | Session cookie: __Host- prefix, Secure, HttpOnly, Path=/, no Domain, explicit SameSite | OWASP Session Management + MDN Set-Cookie prefix rules | Vercel function that sets the session | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie | Set-Cookie: __Host-mh_sid=<id>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=<n> |
| C7 | Logout invalidates server-side and clears client state | Clear-Site-Data on logout (cookies, storage) plus Set-Cookie Max-Age=0 | POST /api/logout | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Clear-Site-Data | Delete the session row, send Clear-Site-Data: "cookies", "storage" and an expiring Set-Cookie (older Safari ignores the header) |
| C8 | CSRF defence for every non-GET request to the cookie API | Sec-Fetch-Site same-origin, Origin fallback, JSON content type, custom header, no state-changing GET | All /api routes except bearer-only agent routes | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.md | Shared guard() in every mutating function; money and secret operations additionally require a fresh passkey assertion bound to the action |
| C9 | Sensitive responses are never cached | Cache-Control: no-store on secrets and session-bearing responses, set inside the function (functions override vercel.json) | /api/*, secret reveal, session endpoints | https://vercel.com/docs/caching/cdn-cache | vercel.json sets no-store on /api/(.*) and each reveal handler sets it again |
| C10 | HSTS for at least one year; preload is optional | hstspreload.org: max-age >= 31536000, includeSubDomains, preload, all subdomains on HTTPS | Production hostname | https://hstspreload.org/ | Keep Vercel's max-age=63072000 default; add includeSubDomains after auditing subdomains; skip preload unless the domain is not already covered (.dev/.app TLDs are preloaded) |
| C11 | nosniff and correct Content-Type everywhere | X-Content-Type-Options: nosniff | All responses | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/HTTP_Headers_Cheat_Sheet.md | Global header rule; API sets application/json explicitly |
| C12 | Do not set Referrer-Policy: no-referrer if forms post with Origin checks | Chromium sends Origin: null on same-origin form POST under no-referrer | Global Referrer-Policy | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/HTTP_Headers_Cheat_Sheet.md | Use strict-origin-when-cross-origin (Stripe success URLs carry session_id, so cross-origin Referer stays origin-only) |
| C13 | Permissions-Policy limited to what the app uses | Disable unneeded features; keep publickey-credentials-get for self | Global header | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/publickey-credentials-get | publickey-credentials-get=(self), publickey-credentials-create=(self), camera/microphone/geolocation/payment/usb/serial/hid/midi/display-capture/xr=() (Chromium-only enforcement) |
| C14 | COOP/CORP isolation | Cross-Origin-Opener-Policy: same-origin; Cross-Origin-Resource-Policy: same-origin | Global header | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/HTTP_Headers_Cheat_Sheet.md | Global rule; a future public share-card image route sets CORP cross-origin in its own function response |
| C15 | No CORS on the cookie API | Credentialed CORS must name an origin, never * | /api/* | https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS | Same-origin only: no Access-Control-* headers; OPTIONS returns 204 without them; agent bearer routes use Authorization and ignore cookies |
| C16 | Service worker cannot cache secrets | Cache.put stores no-store responses; never cache /api, navigations or non-GET | Any future service worker | https://w3c.github.io/ServiceWorker/ | No service worker in Phase 0; if added: precache hashed assets only, deny-list /api, ship an unregister kill switch |
| C17 | Stripe Checkout redirect is not blocked by form-action | form-action 'self' blocks form POST + 303 redirect in Chromium | Checkout start flow | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/form-action | POST /api/checkout returns {url}; client calls location.assign(url); success_url lands on a static shell that fetches /api/me |
| C18 | CSP report endpoint treats reports as attacker-controlled | MDN: violation reports are attacker-controlled data | /api/csp-report | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/report-uri | Accept application/csp-report and application/reports+json, size-limit, rate-limit, sanitise before storing or showing |
| C19 | Trusted Types rollout | require-trusted-types-for 'script' in Report-Only first; no dangerouslySetInnerHTML | React code | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/require-trusted-types-for | Header already in the vercel.json draft as Report-Only; fold into the enforced CSP once quiet |

## 10. Unverified, conflicting or out of scope

**Unverified (and why)**
- Firefox and Safari behaviour of SameSite=Strict/Lax on the Stripe return, Sec-Fetch-Site, Trusted Types and CSP with the real app: only Chromium 141 (headless, SwiftShader) is installed; other engines are covered by specs, MDN and BCD 8.1.3 only. Safari ITP effects on a return from a third-party origin were not examined.
- `report-to` / `Reporting-Endpoints` delivery over HTTPS (local test was http, endpoint ignored by design) and whether a relative URL is accepted in `Reporting-Endpoints`.
- Vercel specifics not testable without a deployment: merge order of overlapping header rules, whether an explicit HSTS header replaces or duplicates the platform default, whether `Sec-Fetch-*` reach functions, behaviour of the `/(.*)` rewrite next to `/api`.
- WebGL was exercised on SwiftShader (software) in headless Chromium, not on real GPUs, not in Firefox/Safari.
- Braille Institute pages (bot challenge), github.com and api.github.com (session policy), fonts.google.com specimen/knowledge pages (client-rendered) were not readable; the Braille Institute's claims of "150 languages" and "seven weights" for Next appear only in a search snippet and were not fetched (font files and GF METADATA confirm the seven weights; language count unverified).
- Rendering of unhinted TrueType on legacy Windows GDI; visual QA of the computed fallback-font metric overrides (my calculation against Liberation clones of Arial/Times New Roman, not measured in the real system fonts).
- Upstream Young Serif v6.002 (variable + italics): branch is moving (listing vs file size mismatch), so its numbers are indicative; no tagged release was checked.
- Trusted Types with the real application code (only the React/three/R3F baseline was run).

**Conflicts between sources**
- Atkinson Hyperlegible Next weights: README "increased to six" vs seven files/fvar 200-800 (files win).
- OWASP HTML5 Security sheet ("no-store ... so the Cache API will not retain them") vs the Service Worker spec and a Chromium run (Cache.put stores it). Spec and test win.
- OWASP Session Management prefers `SameSite=Strict` for session cookies; MDN/RFC 6265bis/OWASP CSRF describe Strict as breaking top-level cross-site navigations and recommend Lax (or the two-cookie split). For a Stripe redirect product the Lax + extra checks position is the safer engineering choice; Strict-only works only with a static SPA shell.
- MDN BCD lists `bluetooth` under Permissions-Policy (Chrome 104+) but Chromium 141 headless logged it as unrecognised; treat the BCD list as an upper bound and check the console.
- hstspreload.org text says preloading "is not recommended" while OWASP's header sample includes `preload`.

**Needs a lawyer or accountant**
- OFL notice wording on the public legal page and whether shipping a subset (Modified Version, no RFN) needs anything beyond the OFL text - low risk and standard practice; counsel only if you rename, sell the fonts as part of a template product, or use the designers' / Braille Institute's names to promote your modified subsets (OFL condition 4).
- Whether strictly necessary session/CSRF cookies need consent text under ePrivacy/GDPR for your markets - not researched here.

## 11. Evidence files (scratchpad, not deliverables)

`fcsp/fonts/` (downloaded sources and every subset), `fcsp/app/` (Vite + React + three + R3F probes, `policies.json`, `run*.cjs`), `fcsp/ss/` (SameSite, form-action, Referrer-Policy, Cache-Storage tests), `fcsp/bcd/` (BCD 8.1.3 data + `q.py`), `fcsp/mdn*/`, `fcsp/owasp/`, `fcsp/specs/`, `fcsp/vercel/`, `fcsp/stripe/`, `fcsp/vercel.draft.json`.
