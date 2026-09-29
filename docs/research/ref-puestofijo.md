# Reference study: puestofijo.com (feel reference for Mosshatch)

Accessed 2026-09-29 (all fetches and renders on that date, UTC 20:13 to 20:30). Method: curl for HTML/assets/headers, headless Chromium (Playwright 1.56.1, Chromium 1194, software GL) for screenshots and runtime measurement, manual reading of the shipped JS/CSS chunks. Nothing was submitted to the site (the reserve dialog was opened, not confirmed).

## TL;DR

1. Reachable (HTTP 200, Vercel, Next.js prerender). It is NOT a registrar: it is a "live street-stall pickup" prototype for Los Angeles ("Dinner is six minutes away"), footer says "Prototype · no accounts · no payments taken". It is one site, not a family of sites.
2. What it does well: a full-viewport procedural three.js street scene (r186) behind real DOM copy, a 4-beat scroll story (Watch / Reserve / Walk / Collect), one strongly named place (Puesto de Rosa, a corner in Los Ángeles), warm short copy, reserve flow needs only a first name.
3. Cost is small: about 0.69 MB over 28 requests by 10 s; the whole 3D city is generated in code (608 KB JS raw, ~158 KB on the wire, lazy-loaded after hydration; no model/texture downloads). Fonts are 46% of transfer.
4. Brief check: "play before signup" VERIFIED; "plain warm copy" VERIFIED; "one strongly named place" VERIFIED for this one site ("these sites" plural: unverified); "live demo in the hero" PARTLY (hero is a live 3D scene plus a non-interactive, aria-hidden walkthrough; the playable demo is one click away at /stall/rosa); "in-brand message when WebGL is unavailable" NOT FOUND (it degrades silently to a CSS-painted scene, only a console.warn).
5. Problems to avoid: fabricated "N watching" counter (`viewerOpens + 3`, fallback 21), horizontal overflow at 390 px on the home page (clips the header button and HUD cards under mobile emulation), hero copy held until a ~4.5 s designed intro finishes, no-JS users stuck on the "Llegando..." veil, public unauthenticated API that lists draft/test rows.
6. Sound: none. Reduced motion: honoured in JS and CSS (partial). Not measurable here: real-GPU frame rate, real-phone behaviour, contrast ratios, screen-reader output.

## 1. Brief vs reality

| Brief claim | Verdict | Evidence (source, accessed 2026-09-29) |
|---|---|---|
| Sites share one strongly named place | Verified for this site; the plural "these sites" is unverified (only one domain examined) | https://puestofijo.com/ hero pill "PUESTO DE ROSA · EN VIVO", kicker "Los Ángeles · 2 stalls live now", mural in scene "de fijo · LOS ÁNGELES · DE AQUÍ", footer "puesto fijo (es) — a fixed stall, and a steady job. Colloquially, de fijo: for sure." |
| Play before signup | Verified | https://puestofijo.com/ "No signup wall between you and dinner."; reserve dialog on https://puestofijo.com/stall/rosa has one required field, "Name for the window" (placeholder "Jenna"), no email/card; footer "Prototype · no accounts · no payments taken" |
| Plain warm copy | Verified | see section 6 |
| Live demo in the hero | Partly | Hero is a live-rendered 3D scene and a scroll-driven story; the Reserve / Walk / Ticket cards in it are `aria-hidden="true"` and contain no buttons or links (DOM check), so they are illustrations. Real data appears only in the kicker count and the "Puesto de Rosa · en vivo" pill (fetched from https://puestofijo.com/api/stalls every 5 s, `setInterval(...,5e3)` in chunk 1eb64sfk64vzf.js). The playable flow is /stall/rosa. |
| In-brand message when WebGL unavailable | Not found as described | With WebGL disabled (`--disable-gpu --disable-3d-apis`, `webgl:false` confirmed) the hero shows a CSS gradient `.scene-fallback.is-on`; the only signal is `console.warn("Street scene unavailable, showing the painted fallback.")`. Stall page: `console.warn("Stall camera unavailable, using the painted stall.")` and a CSS-painted stall with rotating captions. No user-facing "your device can't show this" line. |

## 2. Fetch log and headers

- GET https://puestofijo.com/ -> `HTTP/2 200`, `server: Vercel`, `x-nextjs-prerender: 1`, `x-vercel-cache: HIT`, `cache-control: public, max-age=0, must-revalidate`, 28,880 bytes decoded (8,370 B on the wire, br). Title: `Puesto Fijo — dinner is six minutes away`. Meta description: "Watch a street vendor cook live, hold a plate at menu price, and walk over to collect it. Not shipped. Not delivered. Handed to you." `theme-color #140d09`, `html lang="en"`. No Open Graph or Twitter meta tags (grep count 0). `robots.txt` 200 ("Disallow: /api" etc.), `sitemap.xml` 200 (2 URLs: / and /privacy).
- Other pages read: /stall/rosa (200, 12,350 B), /host (200, 19,566 B), /privacy (200, 19,682 B, "Last updated September 28, 2026"). puestofijo.com itself was never blocked by the egress policy. Two transient proxy errors occurred (a 502 on one /api/stalls poll and on one lazy chunk during a no-WebGL run, and one SSL_ERROR_SYSCALL on /host that succeeded on retry); treat them as sandbox noise, not site evidence. During one command the proxy reported `brunhild.challenges.cloudflare.com:443 connect_rejected` (blocked by egress policy); no request to that host appears in any of my resource lists and the site is on Vercel, so it most likely came from another concurrent session. Recorded, not worked around.
- Privacy page states the stack: "The site runs on Vercel, and its data is kept in a Neon Postgres database in the United States." (https://puestofijo.com/privacy). This is the same hosting/database pair Mosshatch plans.

## 3. Tech stack and weight

Evidence: strings and versions read from the downloaded chunks under https://puestofijo.com/_next/static/immutable/chunks/.

| Item | Finding | Evidence |
|---|---|---|
| Framework | Next.js 16.3.5, prerendered, Turbopack chunk names | `"16.3.5"` in 1t-ipyzl97pdl.js; header `x-nextjs-prerender: 1`. npm latest `next` was 16.3.7 on 2026-09-29 (`npm view next version`) |
| React | 19.3.0-canary-cbb046ab-20260731 | string in 1t-ipyzl97pdl.js / 28fkf9f9btak4.js. npm latest `react` 19.3.0 |
| 3D | three.js r186 (`data-engine="three.js r186"` set on the canvas; `WebGLRenderer`, `antialias:true`, `powerPreference:"high-performance"`, pixel ratio `Math.min(devicePixelRatio,1.75)`, tone mapping constant 4) | chunk 3g3vr9-98_86h.js. npm latest `three` 0.186.1 |
| Not used | babylon, pixi, gsap, framer-motion, howler, react-three-fiber (0 grep hits), GLTFLoader/DRACO/KTX2 (0 hits) | grep over all chunks |
| Scroll | Lenis 1.3.26 smooth wheel scroll (`lerp:.085, wheelMultiplier:.9, smoothWheel:true`, `syncTouch` off), disabled when reduced motion | chunk 1eb64sfk64vzf.js; npm latest `lenis` 1.3.26 |
| Fonts | next/font self-hosted: Outfit (body), Fraunces (display serif), DM Mono (labels); 5 woff2 files | `<link rel="preload" as="font">` x5 in HTML |
| Analytics | Vercel Web Analytics via first-party path (`/e55a3972be3912f9/script.js`, refers to `/_vercel/insights/script.js`); privacy page: "does not use cookies" | script body, privacy page |
| 3D assets | none downloaded: signs/tickets are canvas-2D textures made in code ("2D canvas unavailable" guard), geometry built procedurally | no .glb/.gltf/.png/.jpg/.ktx in the resource list |

Measured load (Chromium, 1280x800, via sandbox proxy, 10 s after load, Resource Timing):

| Group | Files | Transferred | Decoded |
|---|---|---|---|
| HTML | 1 | 8.4 KB | 28.9 KB |
| CSS | 1 | 14.0 KB | 61.2 KB |
| JS (12 incl. analytics and one prefetched route chunk) | 12 | 338.6 KB | 1,179.9 KB |
| of which the three.js scene chunk 3g3vr9-98_86h.js | 1 | 158.5 KB | 607.8 KB |
| Fonts (woff2) | 5 | 321.5 KB | 320.0 KB |
| SVG mark | 1 | 0.7 KB | 0.4 KB |
| `/api/stalls` fetches | 2 | 3.3 KB | 12.3 KB |
| Next route prefetches (`_rsc`) | 6 | 8.1 KB | 14.6 KB |
| Total | 28 requests | 694,382 B (~678 KiB) | n/a |

An earlier run counted 31 resource entries and 691,242 B, consistent. `/api/stalls` is re-polled every 5 s (one poll returned a one-off 502 during the first run).
Timings are inflated and not representative (software GL, proxied network): first-contentful-paint 836 ms in one run, 1,412 ms in another; the scene chunk requests start at ~1.0 s (after hydration), i.e. not on the critical path.

## 4. First paint and load sequence

1. Server HTML contains all copy: h1 "Dinner is six minutes away.", every story panel, the waitlist form, footer (28.9 KB decoded). Header and a sunset-gradient veil paint first.
2. The veil (`.scene-veil`, gradient plus a glowing sun) carries the loading label `Llegando…` ("Arriving…", DM Mono, uppercase). See shots/ref-puestofijo-loading-600ms.png.
3. After hydration `import()` fetches the three.js chunk, builds the scene, then the veil fades (1.4 s transition) and the camera starts an intro. In code: `introSeconds = reducedMotion ? 0 : 6.2`; the `is-landed` class is set after `introSeconds * 0.72`, about 4.5 s after the scene is ready on a normal-motion WebGL device. CSS then starts the hero text animations only under `.is-landed` (`.is-landed .hero-title .line>span{animation:1.2s ... .2s forwards rise}`, sub/CTAs fade up with delays of .65 s, .85 s and 1.05 s), so the full hero copy settles roughly 6 s after the scene is ready. On WebGL failure or reduced motion `is-landed` is set immediately. Observed in the sandbox (software GL, main thread heavily loaded): veil gone at ~3.8 to 4.8 s, landed at ~7.2 s (normal) vs ~3.8 s (reduced). Real-GPU timing unverified.
4. Rendering pauses when the hero is off-screen (`IntersectionObserver` -> `setActive`). No `visibilitychange` handler (relies on rAF throttling).
5. Screenshot at 4 s (shots/ref-puestofijo-desktop-t4s-midreveal.png) shows the second headline line still half-masked: a visitor on a capable device sees an animated reveal, not an instant headline.

## 5. Hero, story and demo

- Hero: full-bleed low-poly evening street corner (palms, string lights, papel picado, a mural reading "de fijo · LOS ÁNGELES · DE AQUÍ", Rosa's striped-awning stall, small figures, traffic). H1 lines "Dinner is" / "*six minutes* away." (Fraunces serif, the italic phrase in marigold). CTAs: "Watch Puesto de Rosa" (primary, to /stall/rosa) and "Open your stall"; a small "PREVIEW · A glimpse of what Puesto Fijo will be. Join the waitlist" note.
- Scroll story (document height 8,999 px at 1280x800): the camera flies through the scene as a function of scroll progress; beats at progress thresholds .1/.3/.5/.72/.91 -> a floating rail "Watch / Reserve / Walk / Collect". Each beat has real DOM copy (h2 + p) plus an aria-hidden HUD card projected next to 3D anchors (a "phone" with the stream, a Reserve card with four pickup windows, a Walk card with a minutes counter and route line, a Ticket with a big pickup code "K2Q"). Screenshots: shots/ref-puestofijo-desktop-s020-reserve.png, shots/ref-puestofijo-desktop-s045-collect.png.
- Page transition: clicking a `/stall/...` link drops a striped "awning" curtain while the 3D camera "departs" into the stall, then routes (`dropCurtain(1150)`, `depart()`), reduced motion shortens to ~30 ms.
- Stall page (/stall/rosa): a second, tighter three.js camera on the same scene (`mode:"stall"`), header chips "LIVE", an elapsed timer and "N watching", the menu with "Reserve" buttons, and slots with counts. Screenshot: shots/ref-puestofijo-stall-rosa-desktop.png. The "stream" is a simulated placeholder (`streamMode:"placeholder"` in the API JSON) with rotating in-voice captions; hosts may switch to webcam.

## 6. Play before signup (what is actually required)

| Step | Requirement | Source |
|---|---|---|
| Watch the scene, scroll the story | none | https://puestofijo.com/ |
| Open a stall and reserve | click "Reserve" -> `role="dialog" aria-modal="true"`: pick window, quantity, type a first name ("Name for the window"), total shown "$6.29" (5.50 + 0.79 hold) | https://puestofijo.com/stall/rosa (dialog opened, not submitted; shots/ref-puestofijo-reserve-step.png). Dialog text: "Charged only when you pick it up. Release it, or don't make it, and nothing is charged. No markup, no discount — you are buying certainty." |
| Open your own stall | "Takes about a minute. No account." Owner key stored in `localStorage` (`puesto:owner:<id>`), sent as header `x-puesto-owner`; privacy: "the stall key is saved in your browser's local storage so you stay signed in to your stall" | https://puestofijo.com/, /privacy, chunk 3c41xzseiuul2.js |
| Waitlist | role radios (I want dinner / I run a stall / I'd host a window), email, optional neighbourhood, honeypot input `name="website"` with `aria-hidden="true" tabindex="-1"` | index HTML |

Money is faked: "Prototype · no accounts · no payments taken". The pattern to note is sequencing, not the payments: value first, identity last.

## 7. Copy voice (exact quotes, from https://puestofijo.com/ and /privacy, accessed 2026-09-29)

1. "Not shipped. Not delivered. Handed to you."
2. "The window is fifteen minutes. The walk is six. Nobody waits on a courier."
3. "There is no discount field anywhere, on purpose."
4. "Nobody is paying you to show up and nobody is marking up the food."
5. "That’s the whole product: a stall you can watch, a plate that’s held, and a short walk to a person who knows your name."
6. "One email when your corner opens. No spam, no selling your address."
7. Privacy page opener: "There are no accounts and no payments yet, so we hold very little about you. This page lists all of it."
8. Loading label "Llegando…", arrival headline "Llegaste." (Spanish, unexplained, in the flow).

Voice notes: short declaratives; concrete numbers (79¢, fifteen minutes, six minutes, 0.30 mi); one running metaphor (a walk to a stall); bilingual seasoning without translation ("sin markup ✶ sin descuento ✶ de fijo" marquee, "Tú · you"); it says what it does not do; states prices and when money is charged in the same sentence; calls itself a "Prototype" and "Preview" repeatedly. Suits a no-upsell registrar ("what you're buying is certainty").

## 8. Degradation: no WebGL, no JS, reduced motion

| Case | What happens | Evidence |
|---|---|---|
| No WebGL (home) | `try/catch` around `createStreetScene`; on error sets `fallback` state, shows `.scene-fallback` (CSS radial + linear gradient sunset) and lands immediately; HUD cards and all copy still work via scroll progress. No message. | shots/ref-puestofijo-nowebgl-desktop.png, -s020.png (Reserve card over gradient), -s045.png. Console: "THREE.WebGLRenderer: A WebGL context could not be created. Reason: disabled by enterprise policy or commandline switch" then the warn above |
| No WebGL (stall page) | `onUnavailable` swaps to a "painted stall" made of CSS divs (moon, lanterns, string lights, awning, crates, fruit, steam, vendor, passersby); captions rotate every 4.2 s: "Someone just asked if the mango is extra ripe." / "Steam off the elote. Chile on the rim." / "A neighbor wants two aguas if the jug holds." / "The awning light just flickered. Still live." Fully functional purchase UI | shots/ref-puestofijo-stall-nowebgl-desktop.png; chunk 3qt2sottwnzn2.js |
| JavaScript disabled | Page stays on the veil with "Llegando…" only; hero copy is in the HTML but measured `.hero-sub` and `.hero-ctas` opacity is 0 (they animate in only under `.is-landed`, which JS sets) and the veil covers the page. No `<noscript>` remedy | shots/ref-puestofijo-nojs-desktop.png |
| Reduced motion | JS: Lenis not created (`lenis` class absent), scene `reducedMotion:true` -> intro 0 s, idle sway amplitude 0.38 -> 0.05, some figure animations skipped (`t.reducedMotion||(...)` branches). CSS block: hero line/kicker/sub/CTA animations off, grain/marquee/skeleton off, `.reveal` transitions off, route curtain 10 ms. The 1.4 s veil fade and the 700 ms canvas fade are not covered; 3D idle motion still runs (reduced amplitude). | CSS `@media (prefers-reduced-motion:reduce){...}` x2 in 0qqx1d3xdyo59.css; shots/ref-puestofijo-reduced-motion-2500ms.png |
| WebGL context lost mid-session | Only three's own default listeners (`webglcontextlost` preventDefault, `webglcontextrestored`); no site-level UI. Behaviour on restore unverified | chunk 3g3vr9-98_86h.js |

## 9. Sound

None. No `<audio>`/`<video>` elements in the DOM, no `AudioContext`/`new Audio` in any chunk (grep 0 hits), and host webcam uses `getUserMedia({... audio:false})`. Nothing to autoplay-gate.

## 10. Motion inventory

Lenis smooth wheel scroll; scroll-scrubbed camera; masked line reveal on the H1; animated film grain overlay (`.scene-grain`); marquee strip; skeleton loaders; awning route-curtain transition; ambient 3D (traffic loop, figures, string-light flicker); pointer parallax (`setPointer`); 6.2 s camera intro.

## 11. Accessibility basics (DOM measured on the home page)

| Check | Result |
|---|---|
| Canvas equivalent | Canvas is inside `.scene-layer[aria-hidden="true"]`; the same story is real text: 1 h1 and 16 h2/h3 in logical order ("Dinner is six minutes away." -> "See who’s cooking, right now." -> ... -> "Got a comal and a corner? Go live tonight.") |
| Landmarks | header 1, main 1, nav 1, footer 1 |
| Images | 1 `<img alt="">` (decorative logo); one decorative `<svg aria-hidden>`; 14 `aria-hidden="true"` nodes total (scene, anchors, HUD cards, story rail) |
| HUD cards | `aria-hidden` and contain no interactive elements (`hudInteractive: []`), so the reserve "button" in the hero is an illustration |
| Keyboard | Tab order logo, Who's live, Waitlist, Go live...; visible focus ring on "Go live" (browser two-tone ring; CSS also declares `:focus-visible{outline:2px solid var(--marigold);outline-offset:2px}`); shots/ref-puestofijo-focus-ring.png. No skip link. 28 tabbables |
| Forms | radios and inputs have labels; honeypot properly hidden; reserve dialog has `role="dialog" aria-modal="true"` |
| Language | `<html lang="en">` only; Spanish phrases ("Llegaste", "en vivo", "Tú") are not wrapped in `lang="es"` |
| Live regions | none (`aria-live` count 0); changing counters are silent |
| Contrast / touch targets | not measured; visually, mobile hero text over the 3D scene is weakly contrasted in places (see mobile shots) |

## 12. Mobile (390x844, Chromium mobile emulation, DPR 2)

- Layout: single column, header drops "Who's live", hero copy left-aligned, CTAs stacked, the bottom story rail is not visible in the mobile captures (cause not traced). Screenshots: shots/ref-puestofijo-mobile.png and -s010/-s025/-s040/-s055/-s070/-s085/-s100.png; stall page: shots/ref-puestofijo-stall-rosa-mobile.png (clean, no overflow, `scrollWidth 390`).
- Defect (home page only): `document.documentElement.scrollWidth = 459` at a 390 px viewport (overflow 69 px). Cause: `.stall-card` in "Who’s cooking" is 439 px wide (left 20, right 459) and nothing clips it (`overflow-x: visible`). In non-mobile 390 px emulation the page scrolls sideways; in mobile emulation the layout viewport grows to 459 px, so the header "Go live" button (x 371 to 439), the "PUESTO DE ROSA · EN VIVO" pill and the right side of every HUD card are cut off in the 390 px capture, and stall-card text is truncated ("...until the / runs dry."). Real-phone behaviour not verified.
- Text sits directly on the busy 3D scene ("See who’s cooking, right now." over sign lettering), legibility is marginal on phones.
- Canvas is 803 x 1739 backing pixels for 459 x 994 CSS px (DPR cap 1.75 applied).

## 13. Things that surprised me

1. The site is not what the brief implies about the domain itself: no registrar, no "these sites"; it is a single food-pickup preview.
2. The "N watching" number is fabricated: code reads `viewerOpens+3` (stall page) and `i ? i.viewerOpens+3 : 21` (home phone card). Server HTML shows the static fallback "21 watching"; after data loads it read 25 (viewerOpens was 22 in my first API fetch), then 26, 27, 28, 29 as my own stall-page loads incremented it. The "LIVE 160:57:39" timer counts from a seeded `wentLiveAt` of 2026-09-23. Contradicts the otherwise honest voice.
3. `GET /api/stalls` is public, unauthenticated, and returned draft rows named "RSI Soft Ready Probe" (tagline "diag only") and "RSI Probe Stall" plus a visitor-created "Puesto de Nico", along with order records (buyerName blank, ownerToken blank). Anonymous creation plus a public list means strangers' and test data show up on the marketing page.
4. The entire 3D city is procedural: no model or texture downloads; the whole page is under 0.7 MB, and almost half of that is fonts.
5. Near-identical stack to Mosshatch's plan (Vercel, Neon Postgres, three.js, React), except Next.js SSR instead of a Vite SPA. The SSR HTML is what makes the h1, story copy and privacy text available before/without JS. A Vite SPA would need prerendering to match this (inference, not verified against Mosshatch's repo).

## 14. Patterns Mosshatch should adopt

1. Real text in the DOM, decorative canvas `aria-hidden`; HUD cards projected from 3D anchors. Rationale: keeps SEO, screen readers and no-JS content intact while the creature scene is pure feel. (Section 11)
2. Lazy-load three.js after hydration and show a branded veil with one in-voice line. Rationale: page paints in ~1 s while the 158 KB scene chunk loads; the "Llegando…" idea gives the wait a personality. (Sections 3, 4)
3. Procedural or tiny assets; cap DPR (1.75) and pause when off-screen. Rationale: whole page ~0.69 MB; creature-per-domain lists can reuse one engine. (Sections 3, 4)
4. Wrap scene creation in try/catch with a CSS-painted fallback that already fits the layout, and land the UI immediately on failure. Rationale: content never depends on WebGL. Improve on it by adding a one-line in-brand message (they do not). (Section 8)
5. Pass a `reducedMotion` flag into the scene (no intro, damped idle), disable smooth-scroll libraries and CSS reveals, shorten page transitions; also cover the veil fade. (Section 8)
6. Value before identity: search, preview a creature and see the exact flat price with no account; ask for a passkey only at the money step. Rationale: matches "human passkey approves anything that costs money" and the reserve-with-first-name pattern. (Section 6)
7. One strongly named place carried through scene, copy, labels, loading text and footer etymology. Rationale: cohesion is most of the "feel". (Section 7)
8. Copy rules: short declaratives, real numbers, say what you do not do ("no discount field anywhere, on purpose"), state when money moves in the same sentence, a privacy page that says "This page lists all of it." Rationale: fits wholesale-plus-one-flat-fee positioning. (Section 7)
9. A single branded route transition that doubles as the loading mask for the next page (awning curtain). Skip under reduced motion. (Section 5)
10. Label previews honestly ("Prototype", "Preview"); honeypot input that is `aria-hidden` and `tabindex=-1`. (Sections 6, 7)

## 15. Patterns to avoid

1. Fake social proof (`viewerOpens + 3`, fallback 21, seeded live timer). A registrar that handles secrets and money cannot show invented numbers.
2. Home-page horizontal overflow at 390 px (unclipped 439 px cards; `min-width:0` and `overflow-x:clip` plus a 360/390 px test in CI). (Section 12)
3. Holding the hero copy until a ~4.5 s designed intro finishes on capable devices (copy fully settled ~6 s after the scene is ready); keep the headline readable from first paint and let the camera move afterwards. (Section 4)
4. Silent WebGL failure and a permanent veil for no-JS users; add `<noscript>` CSS that removes the veil and a visible in-brand fallback line. (Section 8)
5. A hero "demo" that looks clickable but is aria-hidden and inert. If the brief wants a live demo in the hero, make the hero card actually search or hold a name. (Section 1)
6. Text directly on busy 3D on phones without a scrim. (Section 12)
7. Public list endpoints that include drafts/test rows or order records. For a vault product this must be authenticated and scoped. (Section 13)
8. No skip link; Spanish (or any second-language) strings without `lang`. For Mosshatch's creature names or in-joke words, mark the language. (Section 11)
9. Polling every 5 s forever for a marketing counter; prefer fetch-on-focus or SSE-free static snapshot. (Section 3)
10. Smooth-scroll hijacking (Lenis) is optional cost; on a product with forms and a vault UI, prefer native scroll and use scroll-driven camera only on the landing page.

## 16. Unverified (and why)

- Real-GPU frame rate, thermals, battery, low-end phone behaviour (sandbox uses SwiftShader software GL).
- Real-phone rendering of the mobile overflow (only Chromium mobile emulation; Safari iOS not tested).
- Colour contrast ratios, touch-target sizes, screen-reader output (not measured).
- Real-network paint timings (sandbox proxy adds latency; FCP 0.8 to 1.4 s is indicative only).
- Whether the "N watching" number is used the same way on every surface (verified in two chunks; not exhaustively).
- Behaviour after a mid-session WebGL context loss.
- Whether other domains share this "one named place" pattern ("these sites" plural in the brief).
- Server-side code, database schema and how reservations are stored (only the public API JSON and client code were read).
- Tailwind version (utility class names present; version not read).

## 17. Screenshots (all in working-directory/research/shots/)

Required:
- ref-puestofijo-desktop.png (1280x800, settled at 12 s)
- ref-puestofijo-mobile.png (390x844 @2x, settled at 12 s)

Supporting: ref-puestofijo-desktop-t4s-midreveal.png, ref-puestofijo-desktop-full.png, ref-puestofijo-desktop-s020-reserve.png, ref-puestofijo-desktop-s045-collect.png, ref-puestofijo-loading-600ms.png, -1200ms, -2000ms, -3500ms, ref-puestofijo-nowebgl-desktop.png, -s020.png, -s045.png, ref-puestofijo-stall-nowebgl-desktop.png, ref-puestofijo-nojs-desktop.png, ref-puestofijo-reduced-motion-2500ms.png, ref-puestofijo-reduced-motion-s032.png, ref-puestofijo-focus-ring.png, ref-puestofijo-reserve-step.png, ref-puestofijo-stall-rosa-desktop.png, ref-puestofijo-stall-rosa-desktop-s050.png, ref-puestofijo-stall-rosa-mobile.png, ref-puestofijo-mobile-s010.png, -s025, -s040, -s055, -s070, -s085, -s100.

Working files (HTML, chunks, scripts): working-directory/research/puesto/
