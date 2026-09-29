# Reference study: lightningdragon.com (feel reference for Mosshatch)

Accessed 2026-09-29 (all fetches and captures below were made that day). Analyst: research subagent, Phase 0.

## TL;DR

1. Reachable and live. It is NOT a registrar-style site: it is a free American mahjong game ("Game night, with a little lightning."), hosted on Vercel, built with Vite + vanilla TypeScript + three.js r170. No React, Babylon or Pixi found in any of the 32 chunks I downloaded.
2. The brief is mostly right about feel: play before signup (verified), plain warm copy (verified), in-brand WebGL-unavailable panel (verified, three variants). It is only half right on "a live demo in the hero": the default hero is a pre-rendered still of the 3D room plus a 2D-canvas rain layer plus a DOM tile-fan animation. A real live three.js room loads only on capable desktops and I only saw it by forcing `?live=1`.
3. Best idea to steal: a tiered hero (blurred inline placeholder, then baked still, then 2D ambience, then live 3D behind a capability gate and a frame-time watchdog). The 526 KB raw / 138 KB brotli three.js chunk never loads on phones, reduced-motion or low-end machines.
4. Best failure-state idea: an inline classic-script "sentinel" and inline CSS panel that says why (no WebGL2 on desktop / iOS-specific / script failed) and offers exits that still work.
5. Things to avoid: everything client-rendered (empty `#ui` in the HTML, no `<h1>` in server HTML), hashed assets served `max-age=0, must-revalidate`, plain-text Vercel 404, server room created BEFORE the WebGL check, no skip link, canvas with no DOM equivalent, only HSTS as a security header.
6. Cold-load cost, desktop lobby: 21 requests, about 343 KB on the wire (43 KB JS). Mobile: 21 requests, about 322 KB. Reduced motion: 20 requests, about 278 KB. No JS: 3 requests, about 17 KB.
7. Side effects I caused on their server (disclosed in section 12): two throwaway anonymous tables, both visible in their public lobby list at the time.
8. Screenshots: see section 13.

---

## 1. Verdict on the brief

| Brief claim | Verdict | Evidence |
|---|---|---|
| "share one strongly named place" | Partly. One strongly named brand with an evocative default room (Storm Pavilion), but the site offers THREE named rooms the visitor picks (Storm Pavilion, Lantern House, Moon Garden). "These sites" (a family of sibling sites): unverified, the page links to no sibling site. | Footer links are only internal (`?play=solo`, `?groups=1`, `?tournaments=1`, `?diag=1`). Room copy: "Choose a room. The game is the same; the evening is yours." (https://lightningdragon.com/, accessed 2026-09-29) |
| "play before signup" | True. | Hero note: "No account and nothing to install. Bots take any seat your friends don't." "Open a table" issues a request to `/api/rooms` and returns `{code, seat, token}` (client code `Online.open`, https://lightningdragon.com/assets/online-BOMKMvcI.js, accessed 2026-09-29). Solitaire and lessons need no account either. "Sign in" is a plain nav link. |
| "plain warm copy" | True. See section 9 for exact quotes. | |
| "a live demo in the hero" | Half true. Default hero is a baked still + 2D canvas + DOM animation. Live three.js only if a gate passes (section 4). The hero is decorative (`aria-hidden="true"`) and is not interactive; the playable thing is one click away. | Gate function `Xt` in https://lightningdragon.com/assets/lobby-EWqrzJXd.js (accessed 2026-09-29). Forced `?live=1` run loaded three.js and showed the live room (`shots/ref-lightningdragon-desktop-live3d.png`). |
| "in-brand message when WebGL is unavailable" | True, and better than expected (three copy variants). But only the game routes need WebGL; the lobby works without it. | Section 8. |

Honest framing: Lightning Dragon shows how to make a heavy 3D thing feel instant, kind and forgiving. It shows nothing about domains, money, vaults, passkeys or agents. Every mapping to Mosshatch below is my inference, labelled as such.

## 2. What the page is (title, meta, headings)

Source: `curl -sSL https://lightningdragon.com/` -> HTTP/2 200, 19,976 bytes raw HTML, `server: Vercel`, `x-vercel-cache: HIT`, accessed 2026-09-29.

- `<title>`: "Lightning Dragon — Game night, with a little lightning"
- `meta description`: "American mahjong with friends or computer players, one-minute lessons and a friendly coach — in a storm pavilion, a lantern house or a moon garden. Hong Kong, Riichi and solitaire too. Free in your browser, nothing to install."
- `theme-color` #0B1311, viewport `width=device-width, initial-scale=1, viewport-fit=cover`, canonical, full Open Graph and Twitter card with `og:image:alt`, JSON-LD `VideoGame` with `offers.price "0"`, `manifest.webmanifest`, apple-touch-icon.
- Server HTML body contains only: a clipped, `aria-hidden` `<p id="product-description">` (for crawlers), an empty `<canvas id="stage">`, an EMPTY `<div id="ui">`, the hidden boot-fallback panel, a `<noscript>` message and the sentinel script. The lobby is rendered entirely by JavaScript.
- Rendered headings (Chromium, after JS): H1 "Game night, with a little lightning."; H2 "Where shall we play tonight?"; H2 "Learn as you play"; H3 "One-minute lessons"; H2 "Make it your table"; H3 "Meeting your group?"; H2 "Around the tables"; H2 "Where shall we play?". Landmarks present after render: banner, navigation "Lightning Dragon", main. (aria snapshot via Playwright 1.56.1, accessed 2026-09-29.)
- robots.txt: "Disallow: /admin /app /api /auth ... Allow: /", sitemap.xml lists only `/` (171 bytes). `/humans.txt` and `/.well-known/security.txt`: 404.

## 3. First paint and loading

Source for design intent: HTML comment in https://lightningdragon.com/ (accessed 2026-09-29): "The first frame. Every page paints in its place's night colour before any script or stylesheet arrives, and the lobby — which opens on a picture of the room — paints a blurred copy of that picture too, and starts fetching the full one now rather than after the game code."

How it works (from the inline `<head>` script):
1. `html{background:#0b1311}` inline, then a tiny inline script picks the place (`?place=` query, else `localStorage["lightning-dragon:place"]`, else pavilion) and sets `--arrival` to an inline base64 WebP blur placeholder (255-379 characters each, landscape and portrait; measured from the `places` object in the HTML).
2. It injects `<link rel="preload" as="image" imagesrcset=... fetchpriority="high">` for the responsive hero (landscape 1024/1600/2400 w; portrait 720/1080 w) BEFORE any stylesheet.
3. Fonts (Marcellus, Chivo Mono) are `rel=preload as=style` with `onload` swap, plus `<noscript>` fallback. Comment: "As a plain stylesheet it held back the first paint and every script, the game included, until Google answered; Georgia stands in for the moment it takes."

Observed timeline (Playwright + headless Chromium, cold cache, through the sandbox proxy, so treat absolute times as indicative only):

| t | Desktop 1280x800 | Mobile 390x844 |
|---|---|---|
| 0.5 s | Blurred dark colour field of the room (no text) | Same, portrait crop |
| 1.5 s | Real image resolved, headline fading in | (similar) |
| 4 s | Final: hero, nav, CTAs, place switcher | Final |
| FCP | 492 - 536 ms (2 runs) | 296 - 664 ms |
| LCP | 1.8 - 2.7 s, element = the H1 `<em>` ("with a little lightning."), not the image | 1.1 - 1.6 s, same element |
| CLS | 0.0078 | 0 |
| Long tasks | 3 (354-447 ms total) | 2-3 (105-160 ms total) |

Note: in one extra inspection run the lobby had not mounted after 5 s (empty `#ui`, no landmarks); a re-run waiting for the H1 was fine. Cause unverified (sandbox network vs. JS-render dependence). It fits the fact that nothing is visible but the placeholder until the JS lobby mounts.

Transfer per scenario (Playwright `request.sizes()` = body + headers, cold cache, dumped to `pw-*.json`):

| Scenario | Requests | Total | Biggest parts |
|---|---|---|---|
| Desktop lobby, default | 21 | 342,685 B | images 231,662; JS 43,383; fonts 42,442; CSS 15,750; HTML 8,350 |
| Mobile lobby (iPhone UA, 2x) | 21 | 322,146 B | images 211,375; JS 43,392 |
| Desktop, `prefers-reduced-motion` | 20 | 278,064 B | images 166,863 (lightning-flash image skipped) |
| Desktop, WebGL disabled (`--disable-gpu --disable-3d-apis`) | 21 | 342,703 B | identical to default |
| Desktop, JavaScript off | 3 | 16,739 B | HTML + CSS + font sheet |
| Desktop, forced `?live=1` (live 3D) | 32 (+ lobby poll every ~20 s) | 515,382 B | JS 212,084 (three.js 138,827 on the wire) |
| `?lesson=intro` | 16 | 108,781 B | no three.js |
| `?play=solo` (solitaire) | 16 | 251,312 B | three.js loaded, JS 192,127 |

About 178 KB of the 343 KB desktop total is optional imagery fetched after first paint: the three rooms' 1024 px place-card images (32 + 48 + 33 = 113 KB) plus the 65 KB lightning-flash image. The hero image itself is another 54 KB. Critical path for a useful page is roughly HTML 8 KB + CSS 7 KB + entry JS 8.6 KB + lobby chunk 15.4 KB + hero 54 KB.

Bundle facts (https://lightningdragon.com/assets/, accessed 2026-09-29, brotli / raw): entry `index-CGCnB7ev.js` 8,066 / 19,649 B; `lobby-EWqrzJXd.js` about 15 KB / 40,234 B; `three.module-CPUzpdrs.js` 138 KB / 525,775 B; `mahjongGame` 21.7 KB / 63.6 KB; `americanPublicTable` 38.6 KB / 115.9 KB. Vite is evident (`__vite__mapDeps`, `vite:preloadError` handling in the entry).

Caching: every asset I checked (HTML, hashed JS chunks, WebP images) returns `cache-control: public, max-age=0, must-revalidate`. The second navigation in one run showed `304` on `index-*.js` and `index-*.css`. So hashed files are not cached as immutable. (Avoid, see section 11.)

## 4. Hero: the demo is a four-tier stack

Read from https://lightningdragon.com/assets/lobby-EWqrzJXd.js (class `_t`, function `Xt`) and https://lightningdragon.com/assets/lobbyRoom-Dx0xeGZt.js, accessed 2026-09-29.

| Tier | What | Loads when |
|---|---|---|
| 0 | Room colour + inline blurred WebP | Always, before any request |
| 1 | Baked still of the real 3D scene (`/places/pavilion-1600.webp` etc.), portrait crop on tall screens; second still "flash" image cross-faded for lightning | Always |
| 2 | 2D `<canvas class="ld-weather">` (rain, embers or fireflies) at 32 ms steps, lightning flash, and a DOM "arrival" animation: a red, green and white dragon tile fan flying in | Unless reduced motion or saveData; pauses when off-screen or tab hidden |
| 3 | Live three.js room (`canvas.ld-live`, `aria-hidden`, pixel ratio capped at 1.5, bloom, shadows, mouse parallax) cross-faded over the still | Only if the gate passes, on `requestIdleCallback` (timeout 2500 ms) |

The tier-3 gate, verbatim from `Xt`: `if(matchMedia("(prefers-reduced-motion: reduce)").matches||!matchMedia("(pointer: fine) and (hover: hover)").matches||window.innerWidth<900||(s=i.connection)!=null&&s.saveData||i.deviceMemory!==void 0&&i.deviceMemory<4||(navigator.hardwareConcurrency||8)<4)return t;` then it requires `getContext("webgl2",{failIfMajorPerformanceCaveat:!0})` and rejects the renderer if `/swiftshader|llvmpipe|software|basic render/i` matches. Overrides: `?live=0` off, `?live=1` force.

Consequences: phones and tablets (no `hover: hover, pointer: fine`) never get tier 3; software-GL machines never get it; my default headless runs saw tiers 0-2 only.

Watchdog in `lobbyRoom`: collects 70 frame times, discards the first 10 and takes the median of the remaining 60. If that median is over 20 ms and pixel ratio has not been lowered yet, it drops pixel ratio to 1 (once). Otherwise, if the median is over 26 ms, it calls `onGiveUp` and the live canvas is removed after 1.5 s, leaving the still. In practice give-up can only happen on a later sample after the pixel-ratio drop has already been used. `webglcontextlost` also calls `onGiveUp`. With `force` the watchdog is off.

The still is a render of the same scene, so still -> live is a crossfade, not a jump (compare `ref-lightningdragon-desktop.png` with `ref-lightningdragon-desktop-live3d.png`: same camera and composition). The HTML comment says the placeholders' originals are `src/places.ts` and `src/placeArt.ts`, written by `tools/render-places.mjs`, and that `site.test.ts` holds the inline copies to them.

Hero controls: room switcher (Storm Pavilion / Lantern House / Moon Garden, `aria-pressed`), "Replay the dragon welcome" (aria-label), and a "Pause" toggle titled "Hold the room still", persisted in `localStorage`. Under reduced motion or saveData both buttons are hidden (`pauseButton.hidden=this.quiet()`). Lightning also makes the headline's last word glow (`.ld-bolt-word.is-struck`); visible in the keyboard-focus capture, so copy and scene are in sync.

The hero look is themed per room with CSS tokens (bg, accent, glow), same composition and same copy; the invitation lines differ per room (section 9).

## 5. Tech stack (inspected)

| Item | Finding | Source |
|---|---|---|
| Framework | None: vanilla TS with a tiny `n(tag, class)` DOM helper. Zero hits for `react.element`, `ReactDOM`, `preact`, `svelte`, `Babylon`, `PIXI`, `gsap`, `Howl`, `framer-motion` across 32 downloaded chunks + entry. Chunks not fetched (`partyPhone`, one that failed with TLS error): unverified. | assets under https://lightningdragon.com/assets/ |
| Bundler | Vite (dynamic-import `__vite__mapDeps`, `vite:preloadError`) | `index-CGCnB7ev.js` |
| 3D | three.js r170: `window.__THREE__="170"` plus `Copyright 2010-2024 Three.js Authors`. npm: `three@0.170.0` published 2024-10-31; latest is `0.186.1` published 2026-09-24 (`npm view three`, accessed 2026-09-29), so they are 16 minor releases behind. Ships a `RoundedBoxGeometry` chunk and a bloom-style post-processing chain (inferred from constructor arguments 0.38 / 0.6 / 0.92; class names are minified). | `three.module-CPUzpdrs.js` |
| Audio | Web Audio synthesis only (oscillators + a generated noise buffer); zero `<audio>`/`<video>` elements; no audio files requested | `audio-CAEA9xgw.js`; DOM count in Playwright |
| Fonts | Google Fonts: Marcellus (display) and Chivo Mono (codes); body is the system UI stack | HTML `<head>` |
| Hosting | Vercel (`server: Vercel`, `x-vercel-id: iad1::...`) | response headers |
| Backend | `/api/rooms` JSON API (lobby list, open, join, long-poll) | `online-BOMKMvcI.js` |
| PWA | Manifest `display: "browser"` on purpose | HTML comment, see section 10 |

## 6. Play before signup, sound, motion

Play before signup (verified):
- Hero: "Open a table" and "Learn as you play", with "No account and nothing to install." right under the buttons.
- `?lesson=intro`: "Try a move, see what happens, and take as long as you like — nothing here touches your games." (108 KB total page, no three.js).
- `?play=solo`: solitaire straight to a board; after PLAY, a coach toast appears: "These two glow because they match, and nothing is covering them. Tap one, then the other." (`shots/solo-playing2.png`).
- "Sign in" is just a link to `?groups=1`; accounts are for saved groups. Nothing gates the first play.
- A "Check this browser" page (`?diag=1`) runs a self-test (WebGL2 status, create a table, read back, deal, long-poll) and ends "ALL STEPS PASSED — if the game still will not load, the problem is above this layer. Screenshot this whole page."

Sound:
- The lobby is silent: no `AudioContext` string in the entry, lobby or lobbyRoom chunks.
- Game audio is synthesized (rain, thunder, tile clacks). `ensure()` creates the context or resumes a suspended one (whether every call site is behind a user gesture: not verified); there is a Sound on/off button with `aria-pressed`, key `m` in solitaire, and the ambient bed fades to 0 when the tab is hidden (`visibilitychange`).
- Observed: on `?play=solo`, Chrome logged "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture" four times before any click, so a context is constructed early. Harmless, but avoid.

Motion and reduced motion (verified by emulating `prefers-reduced-motion: reduce` and by reading the CSS/JS):
- Hero: no animation, no rain canvas motion, no lightning flash image fetched, Pause/Replay hidden, `.ld-live{display:none}`, reveal-on-scroll disabled, smooth scrolls become `auto`. Transfer drops from 343 KB to 278 KB.
- CSS `@media (prefers-reduced-motion: reduce)` rules in `lobby-B4oRXQ0l.css` also remove transitions on layers, cards, nav and hero copy.
- Also honoured: `navigator.connection.saveData`, tab visibility, IntersectionObserver visibility. A user-controlled Pause exists for people who do not set the OS flag.

## 7. Accessibility basics (what I could verify)

| Check | Result |
|---|---|
| `lang` | `en` |
| Headings | One H1 then H2/H3 in order (rendered) |
| Landmarks | banner, navigation, main present after render. Also 2 each of `header`/`nav`/`footer` elements in the DOM. |
| Skip link | None found (0 anchors containing "skip") |
| Focus style | `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2-3px }`; measured on "Open a table": `rgb(230, 179, 92) solid 3px`, offset 3px, clearly visible in `shots` capture |
| Touch targets | `min-height: 44px` (most controls) and 52 px (primary), 56 px CTA on mobile |
| Images | 11 `<img>`, all have an `alt` attribute (decorative ones `alt=""`) |
| Hero as decoration | `.ld-stage` `aria-hidden="true"`; the real text is DOM; nothing essential is only in the canvas |
| Toggles | `aria-pressed` on place buttons, Pause, game and sound choices |
| Live regions | `role=status` (2 in lobby), `aria-live=polite` `#live` and `#coach` in solitaire |
| Dialogs | 2 native `<dialog>` elements with no `aria-label` (name from content not verified) |
| Game canvas | `<canvas id="stage">` has no role, label or tabindex. Solitaire/board content has no DOM equivalent; controls (Undo, Hint, Shuffle, Sound...) are real buttons with letter shortcuts, and the coach speaks through a polite live region. I could not enter a multiplayer table without creating server state, so table-level accessibility is unverified. |
| Contrast | Not measured |

## 8. WebGL / failure handling (in-brand)

Tested: Chromium with `--disable-gpu --disable-3d-apis`.
- Lobby (`/`): renders normally, identical to default. The lobby never needs WebGL.
- "Open a table" (`?game=four&room=...`), and `?play=solo`: the inline panel appears. Console: `[lightning-dragon] no usable WebGL2 context`. `<html data-boot-reason="webgl">`, `window.__lightningDragonBooted="failed"`.

Mechanics, from the HTML comments and inline script (https://lightningdragon.com/, accessed 2026-09-29):
- The panel and its CSS are inline in the HTML, "The sentinel's own styles, inline on purpose. This panel exists for the case where the bundle never runs — and if the bundle never runs then the stylesheet it imports never loads either".
- The sentinel is a classic script, "deliberately — not a module. A module that fails to PARSE never runs, and a parse failure is the exact thing this exists to report". It listens for the entry script's `error` event and a custom `lightningdragon:failed` event, and has a 15 s backstop keyed on the marker being absent ("a slow load sets it to 'pending' on its first line and must not be called a failure").
- Three stories, one panel, chosen by `data-boot-reason` and UA (iOS detected via UA or `MacIntel` + touch points).
- Actions: Reload (primary), "Try a one-minute lesson", "Back to the lobby" (the last two hidden when the script itself failed, because they run the same script).
- `<noscript>`: "Lightning Dragon is American mahjong in your browser — with friends, computer players or a coach — and it needs JavaScript to deal the tiles. Turn JavaScript on for this site and reload. Nothing is installed and there is nothing to sign up for."

Panel text (exact):
- Desktop WebGL: H1 "This browser can't light the lanterns." Body: "Lightning Dragon draws its table in 3D, so it needs two things this browser has not given it: WebGL 2, and an engine new enough to run the game code. A browser with hardware acceleration switched off is the usual reason, and so are older smart TVs." then "Open it on a laptop, a desktop or a phone instead — nothing is installed and nothing needs signing up for."
- iOS (verified by faking an iPhone UA with 3D off, so it shows the copy branch, not real Safari behaviour): "iPhone and iPad Safari have had that since iOS 15, and a current phone can run this table. This page asked for a context and Safari did not keep one." then "On an iPhone the usual causes are Low Power Mode, too many open Safari tabs — iOS only keeps a few WebGL contexts at once — or an iOS older than 15. There is no hardware-acceleration switch to flip, unlike on a desktop."
- Script failed: H1 "The page loaded. The game didn't."

Look: dark room colour, Marcellus headline, amber primary button. It is text-only (no place picture, no illustration) and fairly long and technical.

Caveat found: the room is created before the check. Order in the network log: a request to `/api/rooms` (JSON body per client code) at about 3.8 s, then navigation to `?game=four&room=SZL7SV`, then the panel. So a browser that cannot render the table still leaves an orphan table on the server (it appeared in the public lobby list).

## 9. Copy voice (exact lines)

Source: https://lightningdragon.com/ rendered text and bundle strings, accessed 2026-09-29.

1. "Game night, with a little lightning." (H1)
2. "No account and nothing to install. Bots take any seat your friends don't."
3. "Rain on the eaves, lanterns on the rail and thunder somewhere far off." (Storm Pavilion)
4. "Choose a room. The game is the same; the evening is yours."
5. "The storm can wait. The tiles are warm." and "Pull up a chair. Somebody just put the kettle on." (room invitations, in `index-CGCnB7ev.js`)
6. "New to mahjong? Press PLAY — the game will point out your first few moves, and then it lets go." (solitaire)
7. "This browser can't light the lanterns." (failure)

Voice traits: second person, short sentences, concrete sensory nouns (rain, lanterns, kettle, oolong), a light pun on the brand word, honest limits stated plainly ("Its winning hands differ from annual publisher cards." and the footer "Our hand card is original to Lightning Dragon. It is not an NMJL annual card."), and even the error pages keep the fiction. Eyebrow labels in small caps, e.g. "AMERICAN MAHJONG · FRIENDS, BOTS AND A FRIENDLY COACH".

## 10. Mobile layout

(`shots/ref-lightningdragon-mobile.png`, 390x844 CSS px at 2x = 780x1688 px, iPhone UA.)
- Portrait-cropped still (`pavilion-portrait-1080.webp`, 47 KB), `@media (max-aspect-ratio: 4/5)`.
- Nav collapses to logo, "Sign in" and "Choose a place"; the other links live under "More ways to play".
- H1 wraps to three lines; primary "Open a table" and secondary "Learn as you play" are full-width stacked buttons with the "No account..." line under them, all above the fold.
- Room switcher shortens labels ("Pavilion", "Lanterns", "Garden") and keeps Replay and Pause.
- No horizontal overflow (`scrollWidth` 390 = `innerWidth`). Live 3D never loads here.
- `viewport-fit=cover`, `theme-color`, apple-touch-icon; manifest is `display: "browser"`. HTML comment rationale: "iOS gives a standalone home-screen app its own storage, so a player seated at a table in Safari — where every invitation from Messages opens — would arrive through the icon without their seat." (a claim by the site; I did not test iOS.)

## 11. Recommendations

### Adopt (with rationale; mapping to Mosshatch is my inference)

1. Paint identity before any script: inline `html{background}` plus a base64 blurred placeholder plus a `preload` of the responsive hero image ahead of stylesheets; non-blocking fonts with a system fallback. Mosshatch: each creature's habitat colour and blur in the first HTML byte.
2. Tiered hero with a gate: baked still from the real scene, then ambient 2D layer, then lazy live three.js only if reduced-motion is off, `(pointer: fine) and (hover: hover)`, width at least 900, no saveData, deviceMemory and cores at least 4, WebGL2 without performance caveat, and not a software renderer. Rationale: LCP and first impression never depend on WebGL, and the three.js payload is paid only by machines that can use it.
3. Frame-time watchdog plus context-loss handler that silently falls back to the still. Rationale: the worst experience is a juddering hero.
4. Bake stills from the same scene code with a script, and test that inline copies stay in sync. Rationale: crossfade instead of a jump; the OG image is rendered from the real thing too (HTML comment: "`og.png` is not a mockup: it is rendered from the real game by `tools/og.mjs`, and `site.test.ts` asserts the file exists and is the size these tags claim").
5. Sentinel pattern for failures: inline classic script and inline CSS, cause-specific copy (no WebGL2 / iOS / script failed), exits that still work, 15 s backstop, `noscript` message, `data-boot-reason` hook. Mosshatch should add its own equivalents for WebAuthn unavailable and passkey prompt cancelled in the same voice (not evidenced by this site).
6. Motion control: a visible, persisted Pause plus a Replay, hidden when the OS asks for reduced motion; hero decorative and `aria-hidden` with all real text in the DOM.
7. Sound: silent by default (lobby has no audio code at all), synthesized on the fly (zero audio bytes), audio running only after a user gesture (Chrome's autoplay rule), but create the context lazily on that first gesture rather than early as this site does, visible Sound on/off with `aria-pressed`, fades on tab hide.
8. "No account" line directly under the primary CTA, and an anonymous session token for the first play; sign-in as a quiet nav link. Mosshatch: meet and name a creature and search domains with no account; passkey only at the money and secrets boundary.
9. A `/diag` "Check this browser" page that prints WebGL2 status, API reachability and ends with "Screenshot this whole page." Mosshatch: add WebAuthn availability and platform-authenticator checks.
10. Pre-paint preference read (`?place=` then localStorage) so themed pages do not flash the default.
11. Warm plain copy with honest limits and a fictional-world voice that persists into errors; 44 px min touch targets; a 3 px amber `:focus-visible` ring.

### Avoid

1. Fully client-rendered marketing page (empty `#ui`, no H1 in server HTML; crawlers get a clipped `aria-hidden` paragraph). A registrar needs SEO and no-JS resilience: pre-render the hero copy and CTAs.
2. `cache-control: public, max-age=0, must-revalidate` on hashed assets. Serve `/assets/*` with `max-age=31536000, immutable`.
3. Raw plain-text Vercel 404 ("The page could not be found NOT_FOUND"). Ship an in-brand 404 (and creature) plus `security.txt`.
4. Creating server state before the capability check (room POST happens before the WebGL2 check). Mosshatch must check WebGL and WebAuthn before creating a session, cart or Stripe Checkout.
5. Canvas with no DOM equivalent. In Mosshatch the creature carries information (renewals, secrets, agent tokens), so every fact needs a real DOM twin (list or table) and a keyboard path.
6. No skip link, duplicate landmarks, `<dialog>` without an accessible name.
7. Only HSTS as a security header on the homepage (no CSP, no Referrer-Policy, no Permissions-Policy observed). For a vault product ship a strict CSP.
8. Shipping internal HTML comments naming tools and tests (`tools/render-places.mjs`, `site.test.ts`) to production; strip in the build.
9. Third-party font hosts (fonts.googleapis.com, fonts.gstatic.com). Self-host for privacy and one less origin.
10. A text-only, technical fallback panel ("This page asked for a context and Safari did not keep one."). Keep the structure, add the creature still, shorten.
11. Constructing an `AudioContext` before a gesture (four Chrome warnings on solitaire).
12. Staying on an old three.js (r170, October 2024) - not a problem for a reference but check Mosshatch pins a current version and reads release notes.

### Surprising

- The "live demo" is mostly a picture. Most visitors never load three.js in the hero.
- The lobby is genuinely light (about 43 KB JS on the wire) and needs no framework.
- Copy and scene are choreographed: a lightning strike lights the word "lightning" in the headline.
- The whole failure path is designed and commented like a feature ("Three stories, one panel").
- Anonymous tables are listed publicly by code via an unauthenticated lobby JSON (`/api/rooms?op=lobby`), including my two test tables.
- The fallback and diag pages are unusually candid about causes (Low Power Mode, WebGL contexts per tab).

## 12. Method, side effects and limits

Method: `curl -sSL -m 30 -A "Mozilla/5.0 (X11; Linux x86_64) ..."` for HTML, headers and assets; Playwright 1.56.1 with headless Chromium (software GL, so the machine reports SwiftShader) for screenshots, network logs, DOM, aria snapshots, emulated reduced motion, JS off and `--disable-gpu --disable-3d-apis`; `npm view three`. Scripts and raw JSON are in this folder (`pw*.js`, `pw-*.json`, `ld-assets/`).

Network notes: the first `curl` timed out at 30 s and a few later fetches ended with `SSL_ERROR_SYSCALL`; every retry succeeded. The proxy status showed no `connect_rejected` for lightningdragon.com, fonts.googleapis.com or fonts.gstatic.com. Cause of the first timeout: unverified.

Side effects I caused on their production server (disclosure): (1) clicking "Open a table" once created table SZL7SV; (2) visiting `?diag=1` ran the page's own self-test which created table HRFWX6. Both appeared in the public lobby list ("1 player - 3 seats open"). No other writes. I did not repeat either.

Unverified or not done: real GPU rendering performance (software renderer only); real Safari/iOS behaviour; contrast ratios; screen-reader behaviour on the live multiplayer table (I did not enter one); whether `<dialog>`s get a name from content; the `saveData`/`deviceMemory` branches were read, not exercised; the "these sites" family claim in the brief; chunks `partyPhone` and one TLS-failed fetch were not scanned for frameworks; the exact HTTP method of the `/api/rooms` open call (client posts a JSON body, method inferred).

## 13. Files

- `working-directory/research/shots/ref-lightningdragon-desktop.png` (1280x800, default tier, at 9 s)
- `.../shots/ref-lightningdragon-mobile.png` (390x844 viewport at 2x = 780x1688, iPhone UA, at 9 s)
- `.../shots/ref-lightningdragon-desktop-live3d.png` (forced `?live=1`, software GL, at 20 s)
- `.../shots/ref-lightningdragon-desktop-nowebgl.png` (in-brand fallback, desktop)
- `.../shots/ref-lightningdragon-mobile-nowebgl.png` (in-brand fallback, iPhone-UA copy branch)
- Supporting: `shots/place-lantern-7000.png`, `shots/place-garden-7000.png`, `shots/lesson-4000.png`, `shots/solo-10000.png`, `shots/solo-playing2.png`, `shots/live1-20000.png`, `shots/mobile-500.png` (first paint)
- Raw: `ld.html`, `ld-assets/` (all JS/CSS chunks, manifest, robots), `pw-*.json` (request logs), `ld-lobby-text.txt`, `ld-aria.txt`
