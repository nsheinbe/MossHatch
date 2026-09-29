# Reference study: airmahjong.com (feel reference for Mosshatch)

Accessed 2026-09-29 (all fetches and screenshots that day). Analyst: Phase 0 research. Nothing under /home/user/MossHatch was touched.

## TL;DR
1. Reachable, real, and mostly what the brief implies: one product, one strongly named place ("Your table is waiting." / "Your seat at the table" / "This browser can't set the table."). It is a single site; "these sites share one place" is unverified (only one site studied).
2. Play before signup: verified. Guests play with an optional name; accounts are only for saving groups. A no-WebGL lesson route exists.
3. Hero "live demo" is ambient, not the product: a full-bleed room photograph, an optional hand-written WebGL2 camera drift, and three CSS/DOM tiles that flip in for about 3 s. It has Pause and Replay controls and honours reduced motion and Save-Data.
4. The landing page never loads three.js. three.js r170 (141 KB brotli, 536 KB raw) arrives only on game routes. No React, Babylon or Pixi found.
5. WebGL-missing message is excellent and in-brand: three variants (desktop, iOS, script failure), inline-styled, with exits to routes that need no 3D. The lobby itself still works without WebGL (hero drops to a CSS renderer).
6. Weight: lobby route 24 requests, about 631 KB on the wire (hero photo 302 KB is the bulk); game route 24 requests, about 427 KB. Every asset, including hashed /assets/*, is served `max-age=0, must-revalidate` (a miss).
7. Accessibility is good on the lobby (31 of 31 controls named, 44 px+ targets, 3 px focus rings, aria-hidden decorative stage) with gaps: no `<main>` or skip link in the rendered lobby, canvas has no text alternative, older Riichi/HK table has little a11y.
8. Sound: fully synthesised WebAudio, only in the game, with a comfort dialog and separate levels. Hero is silent.
9. Sandbox caveat: the egress relay returned intermittent 502s on random requests; retried until clean. No GPU, so real-GPU WebGL hero path is unverified.

---

## 0. Method and honesty notes
- Fetched with `curl -sSL -m 30 -A "Mozilla/5.0 (X11; Linux x86_64) ... Chrome/126.0 Safari/537.36"`, then rendered with Playwright 1.56.1 driving the pre-installed Chromium (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers). No TLS bypass, no proxy unset.
- Network stats are from Chrome DevTools Protocol `encodedDataLength` (bytes on the wire, compressed). Sizes for curl-fetched files are decoded sizes unless marked "br".
- Egress relay flakiness (sandbox, not attributable to the site): several page loads had one or two assets answered `502 Bad Gateway` / body "upstream request failed". The same URLs returned 200 by curl minutes later. Proxy status log (curl http://127.0.0.1:37695/__agentproxy/status) recorded, accessed 2026-09-29T19:49:51Z: `"kind": "ws_closed_mid_exchange", "detail": "tunnel closed (code 1006, Connection ended) after 11s; 517 B sent, 39 B received ... "host": "airmahjong.com:443"`. I retried every measurement until clean and kept the first bad run (`ref-airmahjong/amj-desktop-run1-502.json`), which incidentally exercised the "script failure" fallback (described in section 5).
- No host needed for this study was reported as connect_rejected for airmahjong.com; `brunhild.challenges.cloudflare.com` and `developers.hexonet.net` appear as connect_rejected in the same log (other analysts' traffic; not used here).
- I did not click "Start a table" or otherwise create rooms on the production service (it POSTs a new room). The American table (the main product path) was therefore not opened; it is assessed from its bundle only.

## 1. What the site is (source: https://airmahjong.com/, accessed 2026-09-29)
- `<title>`: "Air Mahjong — Your seat at the table"
- meta description: "Your seat at the table. Play American mahjong with friends, learn with a coach, and find a setting that feels like home."
- theme-color `#F4F1E8`; canonical https://airmahjong.com/; full OG and Twitter tags with `og:image` https://airmahjong.com/og.png (1200x630, alt "Air Mahjong — a welcoming place to play"); JSON-LD `VideoGame`, `"offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" }`.
- Headings in the rendered lobby: H1 "Your table is waiting."; H2 "Where shall we play?"; H2 "Learn as you play"; H2 "Make it your table"; H3 "Meeting your regular group?". Clean single-H1 outline.
- Server HTML (before JS) already contains the product pitch for crawlers: `<main id="air-product">` with H1 "Your table is waiting." Comment in source: "The lobby's own invitation, plus the product description, in the HTML the server sends. A crawler that does not run the game still reads them."
- Hosting: response header `server: Vercel`, `x-vercel-cache: HIT` (accessed 2026-09-29). HTML `content-encoding: br`.
- robots.txt (https://airmahjong.com/robots.txt): "# Public marketing pages are open. The game, accounts, and the API are not." with Disallow for /admin /app /api /auth. sitemap.xml lists only the root URL.
- manifest.webmanifest: `"display": "browser"`; source comment says why: "The manifest's display is "browser" on purpose: an iPhone gives a standalone home-screen app its own cookies and storage".

### Brief check
| Brief claim | Verdict | Evidence |
|---|---|---|
| "share one strongly named place" | Partly. One strongly named place exists in this site ("the table", "seat", "settings/rooms"), repeated in title, H1, meta, fallback copy. Multiple sites sharing it: unverified. | Title "Your seat at the table"; fallback "This browser can't set the table."; code carries an earlier/sibling name: console `[lightning-dragon] no usable WebGL2 context`, localStorage key `lightning-dragon:name`, HTML comment "Marcellus was Lightning Dragon's serif; Air sets its words in Georgia". |
| play before signup | Yes | See section 6. |
| plain warm copy | Yes | See section 4. |
| live demo in the hero | Only ambient, not the product | See section 3. |
| in-brand message when WebGL unavailable | Yes, unusually thorough | See section 5. |

## 2. Stack, scripts and weight (sources: https://airmahjong.com/ and its /assets/*, accessed 2026-09-29)
- Build: Vite (evidence in entry bundle: `__vite__mapDeps`, `vite:preloadError`, hashed `/assets/index-koysCWMm.js`). Vanilla TypeScript DOM code; grep of entry and all 32 lazy chunks found no react-dom, preact, vue, svelte, gsap, framer-motion, howler, pixi, babylon.
- three.js: chunk `/assets/tiles3d-Ciwt8OFJ.js`, 141,069 B brotli (535,767 B raw), contains `const co="170"` (REVISION) and `THREE.WebGLRenderer` warnings. Loaded only for game routes (`?game=...`), not the lobby.
- Hero renderer: hand-written raw WebGL2 (no library) in `/assets/lobby-CQoewhSb.js` (18,570 B br; 47,259 B raw). Context options in source: `alpha:!1,antialias:!1,depth:!1,stencil:!1,...,powerPreference:"low-power",failIfMajorPerformanceCaveat:!0`.
- Game renderer (game chunk): `shadowMap.autoUpdate=!1` (static shadows), `setPixelRatio(Math.min(window.devicePixelRatio||1, ...pixelRatioCap...))`.
- Fonts: headings Georgia ("Air sets its words in Georgia"), body system sans, one Google Fonts face (Chivo Mono 400/600) loaded non-blocking via `rel="preload" as="style" onload=...` (source comment: "loaded without blocking anything"). Chivo Mono woff2 27 KB.
- Cache headers (curl -I, accessed 2026-09-29) for `/`, `/assets/index-koysCWMm.js`, `/rooms/coast.webp`, `/rooms/coast-768.webp`: every one `cache-control: public, max-age=0, must-revalidate`, with etag. Hashed assets are not `immutable`.

### Lobby route, one clean desktop load (CDP, 1280x800, run 2; run on mobile emulation gave the same count)
| Resource | Wire bytes | Note |
|---|---:|---|
| HTML | 7,999 | 18,874 raw |
| index JS (entry) | 13,362 | 33,774 raw |
| index CSS | 15,316 | 71,802 raw |
| lobby JS + CSS | 19,145 + 1,985 | |
| small chunks (dom, tableGuide, online, americanCard, tileFaces, face, tiles) | 631 + 3,702 + 2,629 + 3,430 + 1,134 + 3,951 + 1,282 | |
| hero photo `rooms/coast.webp` | 302,020 | 1536x1024 WebP, preloaded high priority |
| room cards `coast/living/mountain-768.webp` | 76,187 + 69,034 + 79,146 | below the fold, fetched on load |
| Chivo Mono CSS + woff2 | 1,243 + 27,102 | Google Fonts |
| `/api/rooms?op=lobby` (x2) | 841 each | live "Around the tables" list |
| TOTAL | 24 requests, 630,980 B (mobile run 630,011 B) | |
- Paint Timing in this sandbox (through a relay, so not representative): first-paint = first-contentful-paint at 1,108 ms and 1,232 ms (desktop runs), 1,568 ms (mobile), DCL 1.07 to 1.31 s, load 1.35 to 1.78 s, TTFB 0.46 to 0.57 s.

### Solo game route `?game=mahjong&rule=riichi` (CDP, software GL)
24 requests, 427,215 B. tiles3d (three.js) 141,695 B is a third of it. No model, texture or audio file requests: tile faces are drawn procedurally (`tileFaces` chunk 585 B, `face` 3.9 KB) and sound is synthesised. Only image fetched is the 768 px room backdrop (76,188 B).

## 3. Hero and demo (sources: https://airmahjong.com/, /assets/lobby-CQoewhSb.js, accessed 2026-09-29)
- Screenshots: `shots/ref-airmahjong-desktop.png` (1280x800) and `shots/ref-airmahjong-mobile.png` (390x844); I opened both with Read.
- Desktop composition: left-aligned copy block (kicker, 2-line serif H1, lede, two CTAs "Start a table" (filled cream) and "Learn as you play" (ghost), one-line reassurance), top-right nav (Join friends, TV Party, Your groups, Club tournaments, Choose setting), bottom-right room switcher (Beach club / Fireside home / Mountain café) plus Pause and Replay welcome, and a chevron "More ways to play". A dark left-to-right scrim keeps text legible over the photograph.
- What moves: (a) "welcome tiles", three tiles (1 Bam, plum "梅", 1 Dot) that fan and flip above the table for roughly 3.4 s (source: `J=e.style==="again"?2.4:3.4`), built as DOM elements with CSS 3D transforms (`translate3d(...) rotateX(...) rotateY(...)`), hence they exist with no WebGL; (b) a slow camera push/pan of the photograph, in WebGL when available, otherwise CSS transforms (`data-scene-renderer="css"`).
- Not a playable demo: the hero does not let you move a tile. The playable things are behind "Learn as you play", `?lesson=intro` and `?play=solo`.
- Motion controls (source): Pause button toggles `aria-pressed`, `aria-label` becomes "Pause the moving room" or "Play the moving room", persisted in localStorage key `air-mahjong:arrival-paused`. Replay button: `aria-label="Replay the welcome tiles"`, visible text "Replay welcome". The Pause button is hidden in CSS-renderer mode unless the welcome is running (`$.hidden=!r||h==="css"&&!o&&!ne()`).
- Performance governor (source, lobby chunk, verified by behaviour): frame loop capped at 30 fps ambient and 60 fps during transitions (`(f?1e3/60:1e3/30)`), IntersectionObserver stops it off screen, stops on `visibilitychange` and `pagehide`; if animation frames keep taking longer than 45 ms (`if(a<=45){_=0;return}`) for 1.5 s the render scale steps down (`Q=Math.max(.5,Q*.7)`, i.e. 1.0 to 0.7 to 0.5) and once at 0.5 it abandons WebGL for the CSS renderer unless `window.__airArrivalKeepGl` is set; it also skips the sharper "detail" texture on `saveData`, 2g/3g, or `MAX_TEXTURE_SIZE<4096`, and falls back to CSS on texture/draw errors and `webglcontextlost`.
  - Observed (sandbox, software GL forced on via `window.__airArrivalAllowSoftware=true`, an escape hatch in the source; trace in `ref-airmahjong/gov_trace.log`): `data-scene-quality` stepped 1.00 (0.5 s) to 0.70 (about 4.75 to 6.25 s) to 0.50 (about 9.5 s) while `data-scene-renderer` stayed `webgl2`, i.e. the staged governor works. In an earlier run the same flag showed `webgl2` at 0.5 s and `css` by 1.5 s; the cause of that quicker demotion (slow-frame governor vs. a swallowed GL error path) is not determined. Without the flag, `failIfMajorPerformanceCaveat` made software GL choose CSS from the start.
- Room switcher: three named "settings" swap photograph, palette and table (`aria-pressed` chips; choice stored under `air-mahjong:brand-lab`). Cards below: "Beach club: Ocean air, pale oak and nowhere else to be.", "Fireside home: Soft linen, warm oak and a seat by the fire.", "Mountain café: Forest views, warm timber and one more hand."
- Images: the hero photograph and all room thumbnails have `alt=""` and sit inside an `aria-hidden="true"` stage (decorative by design).

## 4. Copy voice (exact strings, https://airmahjong.com/ and chunks, accessed 2026-09-29)
1. "Your table is waiting." (H1)
2. "A hand with friends. A quiet moment for yourself. Settle in, find your rhythm, and stay for another game." (lede)
3. "Play with friends or computer players. Go at your own pace." (reassurance under CTAs)
4. "Choose a setting. Make yourself at home." (rooms section)
5. "Open it on a laptop, a desktop or a phone instead — nothing is installed and nothing needs signing up for." (WebGL fallback)
- Also: "The page loaded. The game didn't." (script-failure heading); "Make yourself comfortable" (sound dialog title); "Three short, hands-on examples. Try a move, see what happens, and take as much time as you like." (lessons).
- Voice traits: second person, short declaratives, hospitality words (seat, table, settle in, make yourself at home), no jargon, buttons are verbs of invitation ("Start a table", "Learn as you play", "Join friends"), errors are calm and specific about cause and fix, and repeat the reassurance "nothing is installed and nothing needs signing up for".
- Design language from inline fallback CSS: background `#f4f1e8`, text `#273e48`, accent `#365f75`, Georgia headings, system sans body, 48 px minimum button height; source comment claims "Every pair here is above 6:1" (not independently measured).

## 5. WebGL-unavailable behaviour (sources: https://airmahjong.com/ inline sentinel, /assets/index-koysCWMm.js, accessed 2026-09-29)
- Test: Chromium with `--disable-gpu --disable-3d-apis` (page-level `getContext('webgl2')` and `('webgl')` both false).
- Lobby `/`: does not show an error. The hero degrades to `sceneRenderer=css` and the whole lobby works (screenshot `shots/amj-nowebgl-home.png`). Replay welcome is still offered (tiles are DOM), Pause is not.
- Lesson `/?lesson=intro`: works with no WebGL (verified with the flags above; H1 "A little practice. A more familiar game.").
- Game `/?game=mahjong&rule=riichi`: the entry module logs `error: [lightning-dragon] no usable WebGL2 context`, sets `data-boot-reason="webgl"` and reveals the in-brand panel. Screenshot `shots/ref-airmahjong-nowebgl-fallback.png` (copy of `amj-nowebgl-game.png`). Panel text:
  - H1 "This browser can't set the table."
  - "Air Mahjong draws its table in 3D, so it needs two things this browser has not given it: WebGL 2, and an engine new enough to run the game code. A browser with hardware acceleration switched off is the usual reason, and so are older smart TVs."
  - "If you are on a desktop browser, check that hardware acceleration is enabled in its settings; that is the fix in almost every case."
  - Actions: Reload (button), "Try a one-minute lesson" (`/?lesson=intro`), "Back to the lobby" (`/?lobby=1`).
- Three stories in one panel, chosen by a classic (non-module) inline script: desktop WebGL, iOS WebGL (mentions Low Power Mode, too many Safari tabs, iOS 15 or newer), and script failure ("The page loaded. The game didn't." with "turn off content blockers for this site and open it in Safari rather than inside another app"). Source comment: "Classic script, deliberately — not a module. A module that fails to PARSE never runs, and a parse failure is the exact thing this exists to report".
- Robustness details: styles are inline "because the panel cannot depend on style.css"; avoids `:is()` for old browsers; a 15 s backstop timer (`window.setTimeout(...,15000)`) reveals it if the bundle never set `__lightningDragonBooted`; `<noscript>` message; the panel only offers exits that do not need 3D ("The lessons and the lobby draw no 3D, so they still work when WebGL is what failed; the sentinel hides them when the script is what failed, because they run the same script.").
- Incidental observation: in my first desktop run two lazy chunks got 502 from the sandbox relay, the dynamic import rejected (`TypeError: Failed to fetch dynamically imported module: https://airmahjong.com/assets/lobby-CQoewhSb.js`) and the script-failure variant showed: kicker "Air Mahjong", H1 "The page loaded. The game didn't.", the two paragraphs quoted above and only a Reload button (the lesson and lobby exits are deliberately hidden in this variant because they run the same script). I viewed that screenshot; the clean rerun overwrote the file, the network JSON of the bad run is kept as `ref-airmahjong/amj-desktop-run1-502.json`.

## 6. Play before signup (sources: /assets/lobby-CQoewhSb.js, /assets/clubUI-C2Unbycl.js, accessed 2026-09-29)
- Lobby form: label "Your name at the table", input `name="player-name"`, `autocomplete="nickname"`, `maxLength=24`, `placeholder="Optional"`. No email, password or passkey field in the lobby chunk (regex for sign in / password / passkey / account found nothing there).
- Accounts exist only in the groups UI: "Create a free account to host a saved group. Your friends can join as guests." and after sign-out "You can still play as a guest."
- Entry points that need no account: "Start a table" (creates a room via `/api/rooms`, name optional), "Learn as you play" (three bots plus coach), `?lesson=intro` "Try a one-minute lesson", "Play solitaire" (`?play=solo`), joining with a 6-character code. Lesson footer: "Nothing here changes your table or statistics."
- Solo game verified playable at load: `?game=mahjong&rule=riichi` boots straight into a 3D table with three bots and prompt "Discard by clicking a tile." (screenshot `shots/amj-game-riichi-15s.png`).

## 7. Sound (sources: /assets/audio-Wp5j8ce-.js, /assets/mahjongGame-DLh0CjgR.js, accessed 2026-09-29)
- No audio files (grep for .mp3/.ogg/.wav/.m4a/.aac/.opus in every chunk: zero). All sound is synthesised with WebAudio (noise buffer, oscillators, gain nodes); the context is created lazily in `ensure()` and resumed if suspended.
- The lobby chunk contains no `AudioContext`; the hero is silent.
- Controls: toggle button labelled "Sound on"/"Sound off" with `aria-pressed`; dialog titled "Make yourself comfortable": "Set tile sounds and room ambience separately. Sound off at the table mutes both." Sliders "Tiles and celebrations" (default 0.8) and "Room ambience" (default 0.35) stored under `air-mahjong:sound-levels`. Coach speech uses `speechSynthesis`.
- Unverified: actual audibility, autoplay-policy behaviour, mix quality (headless, no audio device).

## 8. Motion and reduced-motion (accessed 2026-09-29)
- Source: lobby `motionAllowed(){return!this.motionPreference.matches&&!((e=this.connection)!=null&&e.saveData)}` with `matchMedia("(prefers-reduced-motion: reduce)")`, re-evaluated on `change`; smooth scrolling switches to `auto` under reduced motion.
- Verified: with Playwright `reducedMotion: 'reduce'` the stage reported `sceneState=reduced`, `sceneFrames=2`, no welcome tiles, no Pause or Replay buttons (screenshot `shots/amj-reduced-home.png`).
- CSS: `prefers-reduced-motion` blocks present in index CSS (4), lobby CSS (1), american-table CSS (9), party display CSS (1), and in the inline head style (`html[data-table-room] #stage { transition: none; }`). The 71 KB index CSS has 4 minified `@media (prefers-reduced-motion:reduce)` blocks (`grep -o` count; my first regex missed them because of the missing space).

## 9. Accessibility basics (rendered lobby, 1280x800, accessed 2026-09-29; artefact `ref-airmahjong/amj-a11y.json`)
| Check | Result |
|---|---|
| `<html lang>` | `en` |
| Headings | one H1, then H2, H2, H2, H3 (no skipped levels) |
| Landmarks | `header`, `nav[aria-label=Main navigation]`, three `section[aria-labelledby=...]`. No `<main>` or `[role=main]` found in the rendered DOM (the static `<main id="air-product">` is replaced when the lobby mounts). No skip link. |
| Interactive elements | 31 visible, 0 without an accessible name; text input has a real `<label>` |
| Target size | all at or above 44 x 44 px on desktop and mobile emulation (smallest 44x44: Pause/Replay icons on mobile) |
| Focus | Tab shows `outline: 3px solid rgb(255, 250, 241)` with `outline-offset: 3px` on the hero (visible double ring in `shots/amj-focus-1.png`); CSS also has `:focus-visible{outline:2px solid var(--accent);outline-offset:2px}` |
| Toggle state | room chips and Pause use `aria-pressed`; status line is `role="status"` |
| Images | hero and thumbnails `alt=""` inside aria-hidden stage (decorative) |
| Canvas | `<canvas id="stage">` has no aria-label, role or text alternative; on the lobby it is inert (the WebGL hero canvas is inside the aria-hidden stage) |
| DOM equivalents | Lessons render tiles as DOM with names ("1 Bam", "1 Crak", "Joker"), buttons and text; American table chunk has 47 aria-label, 23 role, 6 aria-live, 7 keydown and a "Large print" tool. The older Riichi/Hong Kong 3D game chunk has 2 aria-label, 0 aria-live, 0 keydown ("Discard by clicking a tile.") |
| Mobile document | `scrollWidth 390 = clientWidth 390`; the lobby scrolls inside `div.mj-lobby` (scrollHeight 3,151 vs 844), the window itself does not scroll |
- Not tested: real screen readers, forced-colors, zoom to 400 percent, hero text contrast over the photograph.
- Visual note (opinion from the screenshot, not measured): the "Sound on" control at the bottom right of the Riichi table looks low contrast against the pale table edge (`shots/amj-game-riichi-15s.png`).

## 10. Mobile (390x844, DPR 1, iPhone UA string, Chromium emulation; accessed 2026-09-29)
- Viewport meta: `width=device-width, initial-scale=1, viewport-fit=cover`.
- Hero fills exactly one screen (`document.scrollHeight 844`); photo is re-cropped to the table; H1 about 45 px serif; header collapses to the wordmark plus "Choose setting"; the other nav links move into the scrolled content; Pause and Replay become 44 px icon buttons at top right (with aria-labels); both CTAs sit at y=770 of 844, in the thumb zone, side by side ("Start a table" 150x52, "Learn as you play" 194x52).
- Below the fold: "Where shall we play?" shows the three room cards as a horizontal scroller with the next card peeking (`shots/amj-mobile-scrolled.png`).
- Caveat: Chromium emulation, not real iOS Safari.

## 11. First paint (sources: inline head script and style in https://airmahjong.com/, accessed 2026-09-29)
- Source comment: "Every page paints in Air's colours before any script runs; without this the page painted Lightning Dragon's near-black until the game code set the brand, a dark flash on every load."
- Mechanism: inline script sets `data-brand-lab="air"`; picks the remembered room (localStorage `air-mahjong:brand-lab`, default `coast`); injects `<link rel="preload" as="image" href="/rooms/coast.webp" fetchpriority="high">` before the stylesheet; sets a roughly 600 byte base64 WebP of the room as a CSS variable, painted as a fixed, 32 px-blurred `body::before` on `#4a4238` (inset -64 px so blur edges are hidden). The lobby then cross-fades to the sharp photograph. Returning from a table skips the veil (`sessionStorage air-mahjong:seated`).
- Observed: my earliest captures (about 0.15 s and 0.6 s after response commit) are the blurred placeholder in the room's colours (`shots/amj-desktop-t150.png`, `amj-desktop-t600.png`), never a white or black flash; the sharp hero with tiles appears by about 1.5 s in the sandbox.
- Tests pin the inline HTML to the JS routes ("The routes, placeholders and table positions here mirror main.ts and src/arrivalScene.ts, and site.test.ts holds them to it." (source comment; the tests themselves are not public, so unverified beyond the comment).

## 12. Patterns Mosshatch should adopt
1. One place noun, used everywhere. Air says "table/seat/setting" in title, H1, meta, buttons and errors. Pick Mosshatch's single place word once and use it in title, H1, error panels and email subject lines.
2. Zero-signup first success. Guest play with an optional name; accounts only for saving. Mosshatch analogue: search a name and meet the creature before any account; ask for the passkey only when something is saved, holds a secret, or costs money.
3. Instant branded first frame that is independent of the 3D library: inline LQIP + brand colours + high-priority preload, then progressive enhancement (photo, optional WebGL, CSS fallback). Keep three.js out of the landing chunk; load it on the route that needs it (Air's landing page ships none of its 141 KB).
4. A renderer governor for the hero creature: cap ambient FPS, stop off-screen and in hidden tabs, cap DPR, step resolution down on sustained slow frames, then fall back to a static or CSS creature; `failIfMajorPerformanceCaveat` and `powerPreference: "low-power"` for ambient scenes; handle `webglcontextlost`; respect Save-Data and slow `effectiveType`.
5. Visible motion controls. Pause/Play with `aria-pressed` and a state-aware `aria-label`, persisted; Replay; both hidden or moot when reduced motion is on.
6. A WebGL/script-failure panel that is on-brand and does real work: inline CSS, classic script sentinel, separate stories for "no WebGL" vs "script never ran" vs iOS-specific causes, a timeout backstop, and exits to routes that need no 3D. Mosshatch's version should keep domain search, checkout status and vault access usable with no WebGL at all.
7. DOM equivalents for anything important that is drawn on canvas. Air's lesson tiles are real text ("1 Bam"); its 3D table is not. Mosshatch's creature must not be the only carrier of domain state, price, approval prompts or secret names.
8. Plain, specific error copy with cause and fix ("check that hardware acceleration is enabled").
9. Mobile: one-screen hero, thumb-zone CTAs, 44 px minimum targets, icon-only controls with `aria-label`, card carousel with a peeking next card.
10. Crawler-readable server HTML (real H1 and product text in the initial HTML) and a generated OG image rendered from the real app with a test asserting its size.
11. Prose comments in shipped HTML explaining why each first-paint decision exists (it made this study fast). Keep those for future maintainers.

## 13. Patterns to avoid
1. Uncached hashed assets. Air serves `/assets/*` with `cache-control: public, max-age=0, must-revalidate`; on Vercel set `Cache-Control: public, max-age=31536000, immutable` for hashed files via `vercel.json` headers.
2. Eagerly loading below-the-fold images: 224 KB of 768 px room cards (about 36 percent of the 631 KB lobby) load at first paint. Lazy-load them.
3. Losing the `<main>` landmark and giving no skip link when the JS replaces server HTML. Keep landmarks in the mounted app.
4. A canvas with no text alternative for meaningful content; the Riichi/HK table has minimal semantics. Given Mosshatch's vault and money approvals, all of that must be DOM.
5. Decorative "demo" that is not the product. If the promise is a live creature in the hero, render the real creature; Air's hero is a photograph plus three flipping tiles.
6. Third-party font request for a minor face (Google Fonts). Self-host or use system fonts (Air already chose Georgia for headings for this reason).
7. Leaking previous brand names into console messages, storage keys and globals (`[lightning-dragon]`, `lightning-dragon:name`, `__lightningDragonBooted`). Namespace cleanly per product.
8. Low-contrast overlay buttons on light surfaces (Riichi "Sound on"; visual impression only).

## 14. Anything surprising
- The landing page's WebGL is optional garnish on a photograph via a hand-written renderer, not three.js; real 3D lives behind game URLs.
- The lobby and lessons work without WebGL; the "can't set the table" panel appears only when the 3D table is requested.
- The hero WebGL governor is real and staged: on software GL its render scale was observed stepping 1.00 to 0.70 to 0.50 (section 3).
- The whole app is vanilla TS with Vite chunks; 32 lazy chunks, 1.2 MB raw and 376 KB brotli in total for the entire product (excluding photos), from `chunks/` measurements: `tiles3d` is 141 KB of that.
- Production HTML is heavily commented and carries a legacy internal brand.
- Live lobby data: the page fetched `/api/rooms?op=lobby` and listed one open table ("7PF4BP ... waiting for somebody to sit down") at the time of test; I did not create it.

## 15. Unverified
- Real-GPU rendering of the WebGL hero (sandbox has no GPU; only software GL, which the site itself rejects or demotes).
- Real iOS Safari behaviour (Chromium emulation with an iPhone UA only).
- Sound quality, audibility and autoplay behaviour.
- Screen-reader output, keyboard-only play of the American table, hero text contrast over photographs.
- The American table UI (main product path); not opened to avoid creating rooms in production.
- Whether the photographs are photographic or generated imagery.
- Multiple sites "sharing one place": only airmahjong.com was studied; the legacy "Lightning Dragon" name suggests a sibling brand on the same code, unconfirmed.
- Real-world load timings and whether the intermittent 502s ever happen outside this sandbox relay.
- Site tests (`site.test.ts`) exist only per a source comment.

## 16. Artefacts
Screenshots (absolute paths):
- working-directory/research/shots/ref-airmahjong-desktop.png (1280x800)
- working-directory/research/shots/ref-airmahjong-mobile.png (390x844)
- working-directory/research/shots/ref-airmahjong-nowebgl-fallback.png (1280x800, WebGL-missing panel)
- Supporting: shots/amj-hero-gl-0_5s.png (WebGL path), amj-reduced-home.png, amj-nowebgl-home.png, amj-game-riichi-15s.png, amj-lesson.png, amj-mobile-scrolled.png, amj-focus-1.png, amj-desktop-t150.png (blurred first frame)
Working files: working-directory/research/ref-airmahjong/ (HTML, bundles, decompressed chunks in `chunks_raw/`, network JSON, playwright scripts `amj_*.js`).
