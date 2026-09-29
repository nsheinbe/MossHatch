# Skeptic verification: tech-fonts-csp-headers

Verifier lens: skeptic (try to refute load-bearing claims from primary sources opened independently).
Date: 2026-09-29. Work dir (raw fetches, probes, builds): research/vskeptic-fcsp/ (scripts in t/, own Vite build in vb/).
Environment: curl -sSL with browser UA via the session proxy; Playwright 1.56.1 with Chromium 141.0.7390.37 (full "chromium" channel plus the default headless shell); no TLS verification disabled; web search budget was exhausted, so "recent change" checks were done by fetching changelogs/registries directly.

Overall: the dossier holds up. Every load-bearing claim I re-derived was reproduced; two small numeric/wording corrections, three gaps (CSP items that would bite once GLB/drei are used), and one previously "unverified" item (Reporting-Endpoints relative URL / report-to over HTTPS) is now resolved in Chromium.

## Claim-by-claim

### C1. All three fonts SIL OFL 1.1, no Reserved Font Name declared - CONFIRMED
- Fetched 2026-09-29: raw.githubusercontent.com/google/fonts/main/ofl/{youngserif,atkinsonhyperlegiblenext,atkinsonhyperlegible}/OFL.txt (HTTP 200). Headers: "Copyright 2023 The Young Serif Project Authors ...", "Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors ...", "Copyright 2020 Braille Institute of America, Inc."; each "licensed under the SIL Open Font License, Version 1.1"; `grep -c "with Reserved Font Name"` = 0 in all three. Upstream YoungSerif@master OFL.txt via jsDelivr: identical header, 0 RFN.
- google/fonts METADATA.pb: youngserif license "OFL", date_added 2023-08-30, source commit d307c79...; AHN date_added 2025-01-07; AH date_added 2021-04-30.
- OFL condition 2 (in the licence text itself) says copyright + licence "can be included either as stand-alone text files, human-readable headers or in the appropriate machine-readable metadata fields within text or binary files" - so name-table records satisfy it. Note: the dossier cites FAQ 4.2.2 for the name-table point, but 4.2.2 is guidance for authors applying the OFL; the redistributor duty is licence condition 2. Conclusion unchanged.

### C2. OFL FAQ 2.1 (self-hosting allowed) and 2.6 (subsetting = modification, allowed) - CONFIRMED
- https://openfontlicense.org/ofl-faq/ fetched: 2.1 "The referenced fonts can be hosted on the same server as other site assets and content ... This is recommended and explicitly allowed by the licensing model because it is distribution."; 2.6 "Yes. Removing any parts of the font when delivering a webfont ... is considered modification. This is permitted by the OFL but would not normally allow the use of RFNs."

### C3. Google Fonts serves Young Serif as Regular 400 only - CONFIRMED
- css2?family=Young+Serif -> HTTP 200, only `font-weight: 400`, gstatic path /s/youngserif/v2/. Requests `Young+Serif:wght@300..700`, `:wght@700`, `:ital@1` all return HTTP 400. METADATA.pb lists one font (YoungSerif-Regular.ttf, weight 400), subsets latin, latin-ext.
- Upstream README (jsDelivr, master) changelog lines "27 Feb 2025 ... allowing the generation of a variable version" and "19 May 2026 ... Added real Italics" confirmed; upstream is an unpinned moving branch (jsDelivr flat listing shows YoungSerif-Regular.ttf 225,584 B and variable 263,700 B, differing from the analyst's downloaded 275,208 / 272,892 - consistent with their "moving target" warning).

### C4. Atkinson Hyperlegible Next: variable wght 200-800 - CONFIRMED
- ahn METADATA.pb: `axes { tag: "wght" min_value: 200.0 max_value: 800.0 }`; Google CSS returns `font-weight: 200 800` from gstatic /atkinsonhyperlegiblenext/v7/. Font name table: "Version 2.001".

### C5. Google-served latin woff2 byte sizes - CONFIRMED (byte-exact)
- Measured by curl on the CSS-listed URLs: Young Serif latin 26,992 (latin-ext 17,268); Atkinson 400 latin 17,208, 700 latin 17,524; Atkinson Next variable latin 33,996 (latin-ext 19,092). Sum of the pair the analyst compares (26,992 + 17,208 + 17,524 = 61,724; the dossier's 60,988 = 26,992 + 33,996) -> the "pair" is Young Serif + Atkinson Next variable = 60,988 B. Correct.

### C6. Subset sizes and the 36% saving - CONFIRMED with a 12-byte correction
- Rebuilt with fonttools 4.66.1 + brotli 1.2.0 using the dossier's exact LATIN/FEAT strings from google/fonts main files (YoungSerif-Regular.ttf 106,608 B; AtkinsonHyperlegibleNext[wght].ttf 114,552 B - both match the dossier's sizes).
  - Young Serif unhinted subset: 18,440 B (exact match). Hinted: 27,256 B (exact match).
  - AHN clamped wght=400:700 via `fontTools.varLib.instancer`, subset: 20,368 B (dossier says 20,356; +12 B, likely instancer name-table pruning/flags). Total 38,808 B vs 60,988 B = -36.4% (unchanged).
  - name IDs 0/13/14 survive in both subsets with `--name-IDs='*'`; instanced axis is 400..700.
  - cmap check on Google's TTFs: none of U+2190-2193, 2197, 2713, 2715 in Young Serif (567 cmap entries) or AHN (362) -> SVG icons advice holds.
- Vite copied the woff2 files as 18,440 and 20,368 bytes into dist/assets (own build).

### C7. Vite 8.3.1 production HTML has no inline code; preload rewriting; assetsInlineLimit - CONFIRMED (own build)
- Built a Vite 8.3.1 + React 19.3.0 + three 0.186.1 app with a lazy chunk and CSS @font-face. dist/index.html contained only `<link rel=preload ... href="/assets/young-serif-400-latin-<hash>.woff2" crossorigin>` (rewritten from /src/fonts/...; same hashed URL as in the emitted CSS), one `<script type="module" crossorigin src>` and one `<link rel="stylesheet" crossorigin>`. No inline script/style.
- With Vite's default (assetsInlineLimit 4096) a 60-byte SVG referenced from CSS was emitted as `data:image/svg+xml,...`; with `assetsInlineLimit: 0` it stayed a file. Fonts (18-20 KB) are never inlined.
- npm registry today: vite 8.3.1, react/react-dom 19.3.0, three 0.186.1, @react-three/fiber 9.8.1 are all still `latest` (react, react-dom, R3F show time.modified 2026-09-29, i.e. moving today).

### C8. The final enforced CSP needs no nonce/unsafe-inline/unsafe-eval; React style props OK; three WebGL OK; Trusted Types report-only quiet - CONFIRMED (own run)
- Served my Vite build from a Node server with the exact 304-char CSP string plus `Content-Security-Policy-Report-Only: require-trusted-types-for 'script'; trusted-types`, CORP/COOP same-origin, nosniff and the dossier's Permissions-Policy. Chromium 141 (SwiftShader): lazy-loaded chunk created a WebGLRenderer, a ShaderMaterial and a MeshStandardMaterial -> `renderer.info.programs.length == 2`, `gl.getError() == 0`, `securitypolicyviolation` events = 0 (enforced and report-only), `<h1 style={{color}}>` computed rgb(1,2,3), the preloaded Young Serif face status "loaded". No console warnings.
- three@0.186.1 tarball: `grep eval(|new Function(` in src/ and build/ = none; only examples/jsm/libs/chevrotain.module.min.js has eval. DRACOLoader.js:426 and KTX2Loader.js:329 `URL.createObjectURL(new Blob(...))` confirmed.
- MDN sources fetched (mdn/content main): style-src-attr "Style properties that are set directly on the element's style property will not be blocked"; script-src 'wasm-unsafe-eval' "more specific than 'unsafe-eval'"; frame-ancestors "does not fall back to the default-src setting ... default-src 'none' still allows the resource to be embedded by anyone".
- OWASP CSP cheat sheet line 316 contains the quoted `default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; frame-ancestors 'self'; form-action 'self';`.

### C9. form-action 'self' blocks form POST + 303 to another origin in Chromium; fetch + location.assign works - CONFIRMED (own run)
- Own two-origin test (localhost:5490 app, 127.0.0.1:5491 "Stripe"): page with `form-action 'self'` auto-submits form POST /go; server logged POST /go and answered 303 to the other origin; the other origin never saw /checkout; page stayed; console "Refused to send form data to 'http://localhost:5490/go' because it violates ... form-action 'self'". `fetch('/api/session')` -> `{url}` -> `location.assign(url)` navigated under both `form-action 'self'` and `form-action 'none'`.
- MDN form-action page (mdn/content main) still carries the warning: "Firefox 57 doesn't block the redirects whereas Chrome 63 does". CSP3 editor's draft (w3c.github.io/webappsec-csp): form-action pre-navigation check acts only "If navigation type is 'form-submission'". Firefox/Safari behaviour not testable here (only Chromium installed).
- Stripe quickstart (docs.stripe.com/checkout/quickstart.md) still has `res.redirect(303, session.url)` (Node), `redirect(checkout_session.url, code=303)` (Python), `NextResponse.redirect(session.url, 303)`, and `<form action="/create-checkout-session" method="POST">`. Stripe security guide "Checkout" CSP list = connect-src/frame-src/script-src https://checkout.stripe.com and img-src https://*.stripe.com (the doc scopes it to Checkout generally; the analyst's inference that a redirect-only flow needs none of it is reasonable, not stated by Stripe).

### C10. SameSite=Strict is withheld on every request of a cross-site-initiated navigation; Lax sent; Lax+POST only for unspecified - CONFIRMED (own run) 
- Own test (Chromium 141; cookies s_strict=Strict, s_lax=Lax, s_none_spec=no attribute; cross-site = 127.0.0.1 -> localhost):
  - JS `location.href` from other origin: Sec-Fetch-Site cross-site, cookies received `s_lax, s_none_spec` (Strict absent).
  - link click: same. Other origin 303 to app: same. 303 -> /hop -> 302 /landing: both hops cross-site, Strict absent on both.
  - address-bar navigation: Sec-Fetch-Site none, all three cookies sent.
  - cross-site POST form: only `s_none_spec` sent (Lax+POST 2-minute exception); Lax not sent.
- RFC 6265bis: datatracker API says rev 22, state "RFC Ed Queue", no RFC number yet (still a draft as of 2026-09-29). ietf.org archive draft-22 text confirms both quotes: "Same-site cookies in \"Strict\" enforcement mode will not be sent along with top-level navigations which are triggered from a cross-site document context." and the 8.8.2 "not one, but two cookies ... The latter could be marked as SameSite=Strict, and its absence would prompt a reauthentication step".
- Fetch Metadata spec 4.1 (w3c.github.io/webappsec-fetch-metadata): "walks the request's entire url list, and will send cross-site if any URL in the list is cross-site".
- BCD 8.1.3: SameSite Lax_default = Chrome 80 only (Firefox behind flag, Safari false); `__Host-`/`__Secure-` prefixes Chrome 49 / Firefox 50 / Safari 13; `__Host-Http-` Chrome 140 / Firefox 143 / Safari false.
- OWASP session sheet line 137 confirms the conflict the analyst flagged ("SameSite=Strict (preferred) or SameSite=Lax").

### C11. Referrer-Policy: no-referrer -> Origin: null on same-origin form POST in Chromium - CONFIRMED (own run)
- Auto-submitted same-origin form POST: `no-referrer` -> Origin `null`, no Referer; `strict-origin-when-cross-origin` and `same-origin` -> Origin http://localhost:5490.

### C12. Permissions-Policy: Chromium-only; 'bluetooth' unrecognized; publickey-credentials-get default self - CONFIRMED
- Header `camera=(), bluetooth=(), publickey-credentials-get=(self), browsing-topics=()` -> Chromium 141 console: "Error with Permissions-Policy header: Unrecognized feature: 'bluetooth'." (no warning for browsing-topics). BCD: Permissions-Policy header Chrome 85, Firefox false, Safari false. MDN publickey-credentials-get: "The default allowlist for `publickey-credentials-get` is `self`."

### C13. Cache.put() stores Cache-Control: no-store responses - CONFIRMED
- Own run: fetch('/secret') with `Cache-Control: no-store` -> cache.put -> cache.match returned "TOP-SECRET". Service Worker spec (w3c.github.io/ServiceWorker) Cache.put steps reject only non-http(s)/non-GET, status 206, Vary `*`, disturbed/locked body; the spec text has 0 occurrences of "no-store". OWASP HTML5 sheet line 152 still says "Send Cache-Control: no-store on those responses so the Cache API will not retain them." -> the conflict the analyst reported is real; trust spec/test.

### C14. Trusted Types support and Baseline date - CONFIRMED
- BCD 8.1.3 (npm, modified 2026-09-24): require-trusted-types-for and trusted-types = Chrome 83, Edge 83, Firefox 148, Safari 26. web-features 3.40.0: trusted-types baseline "low", baseline_low_date 2026-02-24 (matches MDN "since February 2026").

### C15. CSP report-to/report-uri support and delivery - CONFIRMED with an important resolution of two "unverified" items
- BCD: CSP report-to Chrome 70 / Edge 79 / Safari 16.4 / Firefox 149; report-uri deprecated (Chrome 25, Firefox 23, Safari 7); Reporting-Endpoints Chrome 96 / Firefox 130 / Safari 16.4.
- W3C Reporting API 3.2/3.3: each Reporting-Endpoints entry "is interpreted as a URI-reference" and the endpoint URL is parsed "with base URL set to response's url" -> relative URLs are valid by spec; MUST be potentially trustworthy.
- Own Chromium 141 tests (self-generated cert trusted through --ignore-certificate-errors-spki-list, full Chromium via channel "chromium"):
  - HTTPS + `Reporting-Endpoints: csp="/api/csp-report"` (RELATIVE) + `report-to csp`: report delivered in 0.6 s, `POST`, `Content-Type: application/reports+json`, body a JSON array with `body.blockedURL/effectiveDirective/disposition`. Same for an absolute HTTPS URL.
  - With both `report-uri /api/csp-report; report-to csp` present, ONLY the reports+json POST was sent (report-uri copy ignored), matching MDN.
  - Plain http://localhost (a potentially trustworthy origin per spec): no delivery in 30 s in full Chromium; the analyst's non-delivery over http therefore stands as a Chromium behaviour.
  - Playwright's default headless shell delivered nothing even over HTTPS in 100-140 s, so a negative result from that binary is not evidence about the browser.
- Consequence: the "unverified: whether a relative URL is accepted" item is resolved for Chromium 141 - use a relative `csp="/api/csp-report"`; this also avoids hard-coding APP_ORIGIN on Vercel preview deployments. Firefox 149+/Safari not tested.

### C16. Vercel HSTS default and override; docs move - CONFIRMED (URL changed)
- vercel.com/docs/security/encryption is now https://vercel.com/docs/cdn-security/encryption (redirect, HTTP 200 with -L; `.md` variant of the old path is 404). Text: "*.vercel.app ... support HSTS automatically and are preloaded: max-age=63072000; includeSubDomains; preload"; "Custom domains use HSTS, but only for the particular subdomain: max-age=63072000"; and "You can modify the Strict-Transport-Security header by configuring custom response headers in your project. You can set the max-age parameter to a different value." (this documents that an explicit header in vercel.json is the supported override; runtime duplicate-vs-replace still not observed).
- vercel.com/docs/headers/security-headers -> now /docs/cdn-security/security-headers; "Before enforcing a CSP, start with the Content-Security-Policy-Report-Only header." still present.
- hstspreload.org (fetched): "While HSTS is recommended, HSTS preloading is not recommended."; requirements max-age >= 31536000, includeSubDomains, preload. API: `dev` and `app` status "preloaded"; `com`, `ai`, `io`, `studio` "unknown".
- Vercel changelog Atom feed (2025-09 to 2026-09-29) scanned for header/CSP/cookie/rewrite/cache items: nothing that changes these conclusions (only "Optimized CDN caching ... immutable static assets", 2026-07-17, which targets framework-defined immutable files such as Next.js 16.3+, not Vite /assets).

### C17. Vercel: function Cache-Control overrides vercel.json; default `public, max-age=0, must-revalidate`; headers apply to static files, functions, wildcard - CONFIRMED
- docs/caching/cdn-cache.md line 81: "if you return `Cache-Control` headers in a Vercel Function, it will override the headers defined for the same route in `vercel.json` or `next.config.js`."; docs/caching/cache-control-headers.md line 45 default `cache-control: public, max-age=0, must-revalidate`; line 62 "For content that must never be cached, use `no-store`"; vercel.json.md line 403 "This example configures custom response headers for static files, Vercel functions, and a wildcard that matches all routes."; line 1104 "precedence is given to the filesystem prior to rewrites being applied".

### C18. Clear-Site-Data semantics - CONFIRMED
- MDN (mdn/content main): "cookies ... This affects the entire registered domain, including subdomains."; "storage" list includes service worker registrations `unregister`. BCD Clear-Site-Data Chrome 61 / Firefox 63 / Safari 17.

### C19. OWASP CSRF/Headers quotes - CONFIRMED
- CSRF sheet line 171 "a fallback to standard origin verification headers is a mandatory requirement for any Fetch Metadata implementation"; line 197 "reject non-safe methods ... when Sec-Fetch-Site: cross-site"; line 26 "Do not use GET requests for state changing operations."; HTTP Headers sheet: Referrer-Policy strict-origin-when-cross-origin, HSTS sample `max-age=63072000; includeSubDomains; preload`, COOP same-origin, CORP same-site, COEP require-corp (analyst chose CORP same-origin and skips COEP: defensible).

### C20. npm alternative packages - CONFIRMED
- @fontsource/young-serif 5.3.0, @fontsource/atkinson-hyperlegible 5.3.0, @fontsource-variable/atkinson-hyperlegible-next 5.3.0: license OFL-1.1; @fontsource-variable/young-serif: E404.

## Things I could not re-check
- Firefox and Safari behaviour (only Chromium 141 available): SameSite on Stripe return, form-action redirects, Trusted Types, report-to.
- Vercel runtime behaviour (header merge order, STS duplication, Sec-Fetch-* reaching functions): needs a live deployment; I did not deploy anything.
- Braille Institute pages: bot challenge (headless Chromium returned no body); not worked around. Claims of "150 languages" for Atkinson Hyperlegible Next remain unverified.
- Real-GPU WebGL; legacy Windows GDI rendering of unhinted TrueType.

## Missed / additions (with evidence)
1. connect-src also needs `blob:` if GLB models with embedded textures are loaded. Own Chromium test under `connect-src 'self'`: `fetch(blobURL)` and thus `createImageBitmap(await fetch(blobURL))` are refused ("Refused to connect to 'blob:http://...'"); allowed only with `connect-src 'self' blob:`; `fetch('data:...')` also refused unless `connect-src data:` (the dossier's data: item was "inferred, not tested" - now tested). three@0.186.1 GLTFLoader.js lines 2633-2660 use `ImageBitmapLoader` (except Safari <17 / Firefox <98) and line 3368 `URL.createObjectURL(blob)` for bufferView images; ImageBitmapLoader.js:173 uses `fetch(url)`. The dossier's directive table mentions img-src blob: for GLTF textures and connect-src data: only.
2. If @react-three/drei (10.7.9 is current on npm) is adopted, its defaults break this CSP: Gltf.js `decoderPath = 'https://www.gstatic.com/draco/versioned/decoders/1.5.5/'`, useEnvironment.js `https://raw.githack.com/pmndrs/drei-assets/...`, MatcapTexture/NormalTexture/Ktx2 use cdn.jsdelivr.net, and troika-three-text 0.52.5 (drei `Text`) fetches fallback font data from `https://cdn.jsdelivr.net/gh/lojjic/unicode-font-resolver@v1.0.1/packages/data` (option `unicodeFontsURL`) and troika-worker-utils 0.53.0 spawns Blob workers (`new Worker(URL.createObjectURL(new Blob(...)))`; needs `worker-src blob:`). tech-webgl-three.md already references drei's PerformanceMonitor, so drei is a plausible dependency.
3. Reporting-Endpoints can be a relative URL (spec + Chromium 141 test) - drop the APP_ORIGIN placeholder; and in Chromium the report-uri copy is not sent when report-to is honoured, so /api/csp-report must accept `application/reports+json` (array of reports) as the dossier already advises.
4. Vercel docs restructured: security/encryption and headers/security-headers moved under /docs/cdn-security/; update citations.
5. Device Bound Session Credentials: BCD 8.1.3 lists Secure-Session-Registration/-Challenge/-Response/-Skipped and Sec-Secure-Session-Id headers as Chrome 147 (Firefox/Safari false; web-features `device-bound-session-credentials` baseline false). Optional Chromium-only hardening for the __Host- session cookie; no effect on the recommendations.
6. Vercel documents that STS is overridable through custom response headers (see C16) - partially answers the analyst's "explicit STS replaces or duplicates" question; runtime confirmation still needed on a preview deployment.
7. Permissions-Policy `payment=()` (in the draft) would also disable the Payment Request API for an embedded Stripe iframe if Embedded Checkout / Elements is adopted later (reasoned from the feature's purpose; not tested).
8. Minor: dossier's AHN subset size 20,356 B reproduces as 20,368 B with the recipe as written.
