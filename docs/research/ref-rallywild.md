# Reference study: rallywild.com (feel reference for Mosshatch)

Accessed 2026-09-29. Researcher: Claude (Phase 0). Every source below was fetched on 2026-09-29; the source key at the end gives URL and access date, and each finding row also carries its source id and, for load-bearing claims, an exact quote.

## TL;DR

1. Reachable, live, and NOT a domain product: Rally Wild is a free browser sports/party-game site (tennis, pickleball, ping-pong, racing) whose codename "Air Court" leaks everywhere. It is a good reference for feel and craft, not for the brief's "shared strongly named place" claim, which is only half true (see section 1).
2. Confirmed: live 3D scene as the hero background, playable with no account (two guest matches; the only gate is a two-checkbox safety/age dialog), short punchy copy, and a purpose-built in-brand failure screen.
3. Stack is vanilla TypeScript + Vite + three.js r170 (no React, no Babylon, no Pixi). Zero binary assets: no glTF, no mp3 (mp3 paths 404; audio is synthesized with WebAudio). Boot to live 3D hero is about 400 kB over 36-37 requests.
4. Its privacy page names Vercel, Neon, Resend and Stripe: the same planned backend as Mosshatch, so it is a working proof of the stack shape.
5. Best patterns to steal: prerendered readable HTML first, an inline classic-script boot sentinel that tells "no WebGL" apart from "chunk did not arrive" and self-heals, adaptive render-quality tiers, sound that starts only on a user gesture, native details/summary and dialog semantics.
6. Weak spots to avoid: canvas has no text alternative, the WebGL-missing screen is a dead end (no non-3D way to play), naming is split between brand and codename, fixed single-screen mobile layout clips a card at 390x844, sound toggles are not persisted, page fires a designed 503 on every load.

---

## 0. Method and caveats

- HTML, JS and CSS fetched with curl (Chrome UA, brotli decoded with `--compressed`). Rendered behaviour captured with the pre-installed headless Chromium via playwright (global install), UA reports `HeadlessChrome/141.0.7390.37`.
- WebGL in this sandbox is software (SwiftShader/ANGLE), and every request goes through the egress proxy, so all timings below are indicative only; they will be faster on real GPUs and slower on real phones. The proxy intermittently returned 502 for random static assets (harness noise, not a site fault; it is why a few early runs booted into the site's failure panel). For the play-flow and screenshot scripts I retried 5xx asset fetches inside a Playwright route handler, which does not change content. The performance runs (section 4) used no interception; I report runs 3 and 4 as clean and mention the others.
- `curl -sS http://127.0.0.1:37695/__agentproxy/status` did not list rallywild.com, fonts.googleapis.com or fonts.gstatic.com as connect_rejected. No host needed to be marked "blocked by egress policy".
- I did not create a member account (would send real email) and did not test on a real phone or in Safari.

## 1. Does the site match the brief?

| Brief claim | Verdict | Evidence |
|---|---|---|
| "these sites share one strongly named place" | Partly. Four games share one brand (Rally Wild) and one house style. The "place" name is split: the brand is Rally Wild but the product codename Air Court shows in the hero card, legal text, error screens and robots.txt. Racing is "Air Circuit". | [S1] title `Rally Wild — Free Browser Sports & Party Games`; hero card label `AIR COURT`; `<div class="kicker">AIR COURT</div>` in the failure panel; [S9] `# Air Court — web sofa demo`; [S1] `<li><a href="/racing">AIR CIRCUIT</a>` |
| "play before signup" | Yes. Two guest matches, then free email verification (magic link). Only a safety/age gate stands between Play and the court. | [S1] `Two completed guest matches let you try Rally Wild before signing up.`; live gate dialog [S13] |
| "plain warm copy" | Yes, with a sporty, punchy voice. Occasionally jokey. See section 8. | [S1], [S13] |
| "a live demo in the hero" | Yes, with a caveat: the hero is an ambient, real-time 3D court behind the copy (camera keeps moving; frames 2 s apart differ). I saw no bot-vs-bot rally in my frames; the tennis ball in the headline is a CSS element. The playable match uses the same canvas after Play. | [S1] `<i class="hero-ball" aria-hidden="true"></i>` inside the h1; screenshots `ref-rallywild-desktop.png`; `rw-ingame.png` |
| "an in-brand message when WebGL is unavailable" | Yes, and better than expected: two separate in-brand panels with different, honest wording. | section 6 |

Rally Wild is not a registrar, has no secrets or vault concept, and has no pricing beyond an unavailable optional "Plus" plan. Only the feel is transferable.

## 2. What it is (facts)

| Fact | Source | Quote or value |
|---|---|---|
| Title | [S1] | `Rally Wild — Free Browser Sports & Party Games` |
| Meta description | [S1] | `Play tennis, pickleball, ping-pong and racing in your browser. Two guest matches, then free email membership. No download. Phone controllers optional.` |
| OG title | [S1] | `Rally Wild — let the good games roll` |
| Hosting | [S1] headers | `server: Vercel`, `x-vercel-cache: HIT` |
| Routes | [S10] | `/`, `/pickleball`, `/pingpong`, `/racing`, `/terms`, `/safety`, `/privacy` |
| Game switching | [S13] | Bottom bar buttons TENNIS / PICKLEBALL / PING-PONG / RACING change URL to `/?game=pickleball` etc. without reload. Pickleball view swaps the hero for a large dark panel that covers most of the 3D scene (`rw-pickleball-hero.png`). |
| Backend stack (stated) | [S11] | `sends that link through Resend`; `stored in Neon`; `Stripe processes checkout`; `Vercel also provides site analytics and performance measurements` |
| Phone-as-controller | [S1], [S5] | QR pairing; `RTCPeerConnection`, `WebSocket`, `BroadcastChannel` present in `phoneLink` chunk; page polls `/api/rally-link?room=...` about every 1.2 s (measured intervals 1186-1337 ms over 12 s, mobile viewport) |
| Paid tier state | [S12] | `/api/subscription` returns HTTP 503 `{"available":false,"active":false,"error":"Plus is not available right now. Core games are free."}`; `/api/checkout` returns `{"mode":"test","open":false,"price":{"amount":499,"currency":"usd"}}` |

## 3. Technology stack (verified from bundles)

| Question | Answer | Evidence |
|---|---|---|
| Bundler | Vite | [S2] contains `__vite__mapDeps` and `vite:preloadError` |
| three.js | Yes, r170 | [S4] `window.__THREE__="170"`; renderer tags canvas `data-engine="three.js r170"` |
| Post-processing | three EffectComposer with bloom (tier 0 only) | [S5] `EffectComposer`; [S7] `0:{maxPixels:2073600,bloom:!0,shadows:!0}` |
| React / Preact | No. No `react-dom`, `jsx-runtime`, `useState` or `__reactFiber` found in the entry bundle or any chunk. UI is hand-built DOM with `data-act` attributes and innerHTML templates. | grep of all 39 chunks + [S2]; the only "react" hits are words like `reactToPoint` |
| Babylon / Pixi | No | no matches in any chunk |
| Audio library | None. Raw WebAudio (`createOscillator` x8, `createBufferSource` x8, `createBiquadFilter` x8, `createDynamicsCompressor`, `createStereoPanner`). | [S6] |
| Audio files | Optional and currently absent. Code lists `/audio/ui_tick.mp3`, `/audio/crowd_loop.mp3` etc., loads them only if `ready.json` names them, and `ready.json` is empty; the mp3 URLs return 404. So all sound is synthesized. | [S6] `const i=await fetch("/assets/ready.json")`; [S8] `{"models": [], "audio": []}`; [S14] `audio/ui_tick.mp3 404` |
| 3D model files | None (`"models": []`); characters and courts are procedural voxel-style geometry | [S8], screenshots |
| Code splitting | Entry chunk is tiny; the game is dynamically imported. 39 lazy dependencies are listed (38 js, 1 css). | [S2] `__vite__mapDeps` |
| Analytics | Vercel Web Analytics + Speed Insights scripts, plus first-party `/api/event` pings | request log [S13]; [S11] |
| Fonts | Google Fonts: Archivo Black, Barlow Condensed (500/600/700), Chivo Mono (400/600); `display=swap` | [S1] |

Sizes (curl, brotli via `Accept-Encoding: br`, plus raw after decode):

| File | Raw bytes | Brotli bytes |
|---|---|---|
| `/` HTML (prerendered shell + inline sentinel) | 21,224 | 8,777 (CDP encoded length) |
| `assets/index-BgykSxzm.js` (entry) | 53,539 | 20,236 |
| `assets/index-B1f3jJVK.css` | 64,107 | 15,580 |
| `assets/three-d4uwJM2u.js` | 545,543 | 141,797 |
| `assets/game-Br1c7XJv.js` | 213,919 | 73,135 |
| `assets/audio-ASt_Gmcx.js` | 16,024 | 5,221 |
| Four Google Fonts woff2 | n/a | about 92 kB total |

Cache headers: HTML and hashed assets both send `cache-control: public, max-age=0, must-revalidate` with an ETag ([S1] headers, [S2] headers). Hashed filenames are not marked immutable, so every visit revalidates. The inline sentinel's own comments say stale cached shells asking for old chunk hashes are a real failure mode.

## 4. Weight and first paint (headless Chromium, SwiftShader, through proxy; indicative)

Cache disabled, networkidle + 3 s. Runs 3 and 4 booted cleanly; run 1 was slow/cold (desktop first paint at 5.3 s, CLS 0.40); in run 2 the desktop page fell into the failure panel and the log shows a proxy 502 on a chunk (harness noise).

| Run / viewport | Requests | Transfer (kB, encoded) | First contentful paint | Live 3D hero (`body.hub-rail`) | CLS |
|---|---|---|---|---|---|
| run 3 desktop 1280x800 | 36 | 402.4 | 712 ms | about 2.6 s | 0.043 |
| run 3 mobile 390x844 | 36 | 402.4 | 680 ms | about 2.5 s | 0 |
| run 4 desktop | 37 | 403.1 | 620 ms | about 3.2 s | 0.043 |
| run 4 mobile | 36 | 402.5 | 436 ms | about 2.1 s | 0 |

Breakdown for run 4 desktop: Document 8.8 kB, stylesheets 17.8 kB, scripts 287.4 kB (17 requests), fonts 91.9 kB, fetch/ping about 6.8 kB. The 3D hero is therefore about 400 kB / 36-37 requests including fonts and analytics. Every load also makes 2 requests to `/api/subscription` that answer 503 by design (console shows two red "Failed to load resource" errors).

First-paint behaviour (important): the first frame is not the hero. It is the prerendered plain-text home document (`FOUR GAMES. ONE GOOD TIME.` in big type plus five paragraphs; `rw-gl-desktop-t0.6s.png`), then the bundle boots and swaps to the 3D hero (`body` class goes `home-mode` -> empty -> `hub-rail`). So users on slow links see a text page first, then a visible swap. The text is real HTML, which is what search engines and no-JS users get.

## 5. Hero, demo and play-before-signup flow

Observed sequence (desktop; `rw-gl-desktop-t6s.png`, `rw-after-play.png`, `rw-gate-checked.png`, `rw-ingame.png`, `rw-ingame-swing.png`):

1. Hero: full-bleed 3D court, headline `MAKE SOME RACKET.` (second line in yellow), sub line, three pills `No downloads` / `Play free` / `Phone optional`, a cream card `YOU'RE UP.` with one big yellow PLAY button and the line `Two guest matches. Then verify your email to keep playing free.` Below: a collapsible `YOUR PHONE. A REAL RACKET.` card and a sport switcher bar. Top right: `Join free`.
2. Click PLAY: a modal dialog, not an account form. Quote [S13]: `BEFORE YOU SWING` / `CLEAR THE ROOM.` with two checkboxes, `I read the safety rules and play at my own risk.` and `I am 13 or older. If I am under 18, a parent or guardian agrees for me.` The ENTER COURT button is `disabled` until both are ticked.
3. ENTER COURT: straight into a match with an in-context coach card (`YOUR FIRST RALLY` / `Aim the crosshair, then swing. Your feet find the ball for you.`), scoreboard, minimap, and a bottom hint bar of controls. No email, no signup wall. The acknowledgement is stored locally: localStorage `air-court.legal.ack` = `{"version":"3","play":true,"purchase":false}` and `air-court.court`; no cookies were set for a guest.
4. After two completed guest matches the site asks for email verification. The Join dialog (`rw-join.png`, in a plain system sans, unlike the display fonts) reads `More good games. Zero cost.` / `Verify your email for unlimited free play. Your first two completed matches are on us.` / `No password or payment. We use this email for sign-in; this doesn't subscribe you to marketing.` (magic link, no password). I did not submit it. The two-match limit itself I did not exhaust: unverified beyond the stated copy.

Dialog semantics: `<div class="pause-card gate-card" role="dialog" aria-modal="true" aria-labelledby="gate-heading" tabindex="-1">`.

## 6. Graceful degradation

| Scenario | Result | Evidence |
|---|---|---|
| No WebGL (`--disable-gpu --disable-3d-apis`) | App still boots and shows its own screen: `AIR COURT` kicker, `NEEDS WEBGL 2.`, `This sofa demo is a real-time 3D court and it needs WebGL 2. In Safari that means version 15 or newer, so updating macOS is what fixes it; in any browser, check that hardware acceleration is switched on, then reload.` plus Safety/Terms/Privacy links. There is no non-3D way to play or see what the game is. Same on mobile. Screens: `rw-nogl-desktop.png`, `rw-nogl-mobile.png`. `Join free` stays visible on top. | [S13] |
| Bundle boot failure with WebGL missing (game chunk aborted) | Inline sentinel panel: `THIS BROWSER CAN'T RUN THE COURT.` naming WebGL 2, Safari 15 and hardware acceleration, a `TRY AGAIN` button, and a mono "Technical details — send these to Nick" block. | [S13], `rw-chunkblock-desktop.png` |
| Bundle boot failure with WebGL present (game chunk aborted) | Same panel but honest: `THE COURT DIDN'T LOAD.` / `This browser is fine — it has WebGL 2, which is the part that usually goes wrong. The game file itself did not arrive, which is almost always a dropped connection or a page cached from an older version of the site.` Diagnostics list `reason`, `webgl2`, `webgl1`, `gpu`, `error`, `ua`. | [S13], `rw-chunkblock-glon-desktop.png` |
| JavaScript disabled | Prerendered home text stays readable; a `<noscript>` bar says `AIR COURT is a real-time 3D demo and needs JavaScript to play.` It overlaps the top of the page text (visual bug, `rw-nojs-desktop.png`). | [S13], [S1] |
| Panel self-healing | A slow boot that finishes later hides the panel: poll every 400 ms on `window.__aircourtBooted`; 15 s backstop `nothing started within 15s`; stops watching after 5 min. | [S1] inline script |
| WebGL context loss | three.js registers `webglcontextlost` / `webglcontextrestored` listeners (library default). Site-specific handling not verified. | [S4] |

The sentinel is a classic (non-module) inline script on purpose. Quote [S1]: `A module that fails to PARSE never runs, and a parse failure is the exact thing this exists to report, so the guard cannot itself be inside the module system.` Its styles are inline for the same reason. It also records the incident that motivated it: `top-level await was a syntax error to it and so the bundle never ran at all` (an LG TV browser).

## 7. Sound, motion, performance adaptation

| Topic | Finding | Evidence |
|---|---|---|
| Autoplay | No `AudioContext` exists on the hero before interaction (instrumented constructor: empty list). After PLAY and ENTER COURT the context is `running`. Hero is silent until first gesture. | [S13] |
| Toggles | Two buttons `SOUND ON` and `MUSIC ON` with `aria-pressed="true"`; clicking flips text to `SOUND OFF` and `aria-pressed="false"`. The state is not written to localStorage (keys after toggle: only `air-court.court`), so it resets on reload. Note the label reads ON while nothing is audible pre-gesture. | [S13] |
| Sound design | Fully synthesized (oscillators, filtered noise, compressor, stereo panner); mp3 layer is dormant | [S6], [S8], [S14] |
| Reduced motion CSS | Five `@media(prefers-reduced-motion:reduce)` blocks, including a global `*,*:before,*:after{animation-duration:.001ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.001ms!important}` and `.hero-ball{animation:none}` | [S3] |
| Reduced motion JS | Camera shake off, camera-drop intro shortened (0.8 s vs 2.8 s) and simplified, host-burst confetti skipped | [S5], [S2] |
| Reduced motion does NOT stop the 3D scene | With `reducedMotion: reduce` the hero canvas still changes between frames 2 s apart (bytes differ). Continuous camera drift remains. Mosshatch should not copy this if it wants a strict reading of the preference. | [S13] |
| Adaptive quality | Three tiers: 0 = up to 2,073,600 px, bloom + shadows; 1 = 921,600 px, shadows; 2 = 518,400 px, none. Pixel ratio capped at 1.5. Drops a tier when the smoothed frame time exceeds 1/45 s for 3 s, with a 2 s settle. | [S7] `const l={0:{maxPixels:2073600,bloom:!0,shadows:!0},1:{maxPixels:921600,bloom:!1,shadows:!0},2:{maxPixels:518400,bloom:!1,shadows:!1}},u=1.5;` `const i=1/45,c=3,n=2;` |
| Background handling | Input released on `blur` and `visibilitychange` when hidden. Whether rendering pauses in a hidden tab: unverified. | [S5] |
| Bottom-of-page polish | A 180x180 inline SVG feTurbulence grain overlay (`<div id="grain">`), zero bytes over the network. | [S1], [S3] |

## 8. Copy voice (exact lines)

Quotes are verbatim from the live page (typographic apostrophes as served).

1. `Big rallies. Tiny setup.` / `Turn a little downtime into game time.` [S1 live DOM, hero]
2. `YOU'RE UP.` / `Press space to swing. We’ll chase the ball.` [S1 live DOM, play card]
3. `Two guest matches. Then verify your email to keep playing free.` [S1 live DOM]
4. `Aim the crosshair, then swing. Your feet find the ball for you.` [S13 coach card]
5. `This browser is fine — it has WebGL 2, which is the part that usually goes wrong.` [S1 inline sentinel]
6. Also useful: `More good games. Zero cost.`; the Rookie difficulty tooltip `Late to the ball and loose on the swing. Learn the toss here.`; `Free, and there is a whole game here`; `No install, no account to try it`.

Voice notes: second person, short declaratives, sport metaphors, deadpan humour, no marketing abstractions, honest about limits ("almost always a dropped connection"). Headlines are ALL CAPS display type; body is condensed sans; labels are wide-tracked mono.

## 9. Accessibility basics (rendered DOM + accessibility tree, desktop 1280x800)

| Check | Result |
|---|---|
| `<html lang>` | `en` |
| Headings | One `h1` (`MAKE SOME RACKET.`) and one `h2` (`YOU'RE UP.`) in the live hero; the prerendered doc has a proper h1/h2 outline (`Play right now`, `Or make your phone the racket`, ...). Gate dialog uses its own `h1`. |
| Landmarks | Two `nav` elements (one labelled `Rally Wild games`). No `main`. |
| Canvas | `<canvas id="stage">` has no `aria-label`, `role`, or text alternative. Nothing in the accessibility tree describes the 3D scene or the match state. Only the surrounding DOM HUD (score, coach text) is readable. |
| DOM equivalents of canvas content | The hero copy, controls and HUD are DOM (good). The scene itself is decorative; the match is not accessible to screen readers or keyboard-only users beyond the documented key bindings. |
| Controls | Native `button`, `a`, `details/summary` (`Make it your match`, `YOUR PHONE. A REAL RACKET.`), `aria-pressed` on sound toggles. The Play button's touch/keyboard label variants are two spans toggled by CSS; the accessibility tree exposes one name (`PLAY ↗`). The sport switcher marks the active game with `aria-current="true"` (checked in the DOM; the accessibility snapshot did not surface it) but has no `role=tab` semantics. |
| Focus styles | Visible: `:focus-visible{outline:2px solid var(--sun);outline-offset:3px}` (computed `rgb(255, 196, 46) solid 2px`, `rw-focus-desktop.png`, `rw-focus-mobile.png`). No `outline:none` in the CSS. |
| Live region | A polite `aria-live` region exists (empty at rest). |
| Images | Only the QR image, with alt `Scan to connect player one’s phone`. Decorative bits use `aria-hidden="true"`. |
| Modal | Gate is `role="dialog" aria-modal="true" aria-labelledby`. |
| Prefers-reduced-motion | Handled in CSS and partly in JS (section 7). Scene drift not stopped. |
| Gaps | Duplicate `Safety · Terms` strips in the home DOM; the `noscript` bar overlaps the page text; the small dim mono hint line at the bottom of the in-game screen sits on a busy 3D scene (`rw-ingame.png`); the `Join free` modal uses a different font from the rest of the site; sound toggles (36 px) and `Join free` (34 px) are small touch targets. |

## 10. Mobile layout (390x844, DPR 2, touch, iPhone UA)

- The copy adapts: `Swipe to swing. We’ll chase the ball.` and the button becomes `PLAY ON THIS PHONE ↗` (two lines).
- One screen only. `document.documentElement.scrollHeight` equals viewport height and body is `overflow:hidden`, so nothing scrolls. The `YOUR PHONE. A REAL RACKET.` disclosure is clipped by the bottom sport switcher (only its title row peeks out; `ref-rallywild-mobile.png`, `rw-focus-mobile.png`). In a real phone browser with an address bar the visible height is smaller still, so clipping risk is higher; I could not test that here.
- `SOUND ON` / `MUSIC ON` wrap under the logo. Measured touch targets (CSS px): PLAY 294x54, sport switcher buttons 43 tall, sound toggles 36 tall, `Join free` 34 tall. The small ones are under the common 44 px guideline (they do meet WCAG 2.2 AA's 24 px minimum).
- With JavaScript disabled on mobile, the `<noscript>` bar sits on top of the static headline and text and they overprint each other (`rw-nojs-mobile.png`). In one slow-boot frame I also saw the kicker line run under the `Join free` button; that frame was overwritten and is not retained, so treat it as an unrepeated observation.
- No horizontal scroll (`scrollWidth` 390).
- Phone is also a first-class controller (QR pairing, gyroscope), which is out of scope for Mosshatch.

## 11. Patterns Mosshatch should adopt

| Pattern | Why it fits Mosshatch |
|---|---|
| Prerendered, readable HTML shell first; JS enhances into the 3D hero | Search engines, no-JS users and slow phones get real words; works for a domain marketing page where SEO and trust matter. |
| Inline classic-script boot sentinel that distinguishes "no WebGL 2" from "code chunk did not arrive", prints diagnostics, retries by reload, and self-heals if the app finishes late | Mosshatch is a payments/security product; an honest, specific failure message builds more trust than a blank canvas. |
| Failure copy that refuses to blame the user's browser when it is not the browser's fault | Matches Mosshatch's "plain warm copy" principle. |
| Adaptive quality tiers with a pixel budget and frame-time downgrade | Keeps a creature-per-domain scene usable on low-end phones without a settings screen. |
| Synthesized/no-asset sound with gesture-first audio start and an ON/OFF `aria-pressed` toggle (plus persistence, which the reference lacks) | Zero audio bytes; respects autoplay policy. |
| Lazy game/three.js chunk (entry about 20 kB brotli, three about 142 kB brotli, game about 73 kB brotli) | Shows a live 3D hero can hold to about 400 kB total including fonts. |
| Play before signup with a single lightweight acknowledgement dialog (`role=dialog`, `aria-modal`, `aria-labelledby`, disabled primary until ticked) | Mosshatch equivalent: let visitors meet and interact with a creature before sign-in; gate only money and secrets behind passkey. |
| In-context coach card in plain language | Good model for explaining "your creature guards your secrets" without a tutorial. |
| Native `details/summary` for secondary options | Accessible, no JS. |
| `:focus-visible` in a high-contrast brand colour; `aria-hidden` on decoration; `alt` on the one real image | Cheap accessibility wins already proven here. |
| Prefers-reduced-motion at both CSS and JS level (camera shake off, shorter intro) | Adopt, and go further (see below). |
| Same backend shape (Vercel functions, Neon, Resend magic link, Stripe) | Proof the planned stack supports this experience. Rally Wild's privacy page describes hashed single-use 15-minute links and a 30-day cookie: `Verification links expire after 15 minutes and work once. We store a hash of the link token`. |
| Honouring Do Not Track / Global Privacy Control on first-party analytics | Reasonable baseline for a privacy-forward registrar. |

## 12. Patterns to avoid

| Anti-pattern | Why |
|---|---|
| Unlabeled `<canvas>` with no DOM equivalent of what the creature is doing | Screen reader users get nothing. Mosshatch should add `role="img"` with `aria-label`, and expose creature state and vault status in DOM text. |
| A WebGL-missing screen that is a dead end | Rally Wild says only "needs WebGL 2". Mosshatch's registrar must still let people search, buy and manage domains without 3D. Ship a full 2D/text path. |
| Splitting the identity (Rally Wild vs Air Court vs "web sofa demo" vs "send these to Nick") | Weakens the "one strongly named place" idea. Pick one name and use it in errors, robots.txt, legal text. |
| Designed 503 on every page load (`/api/subscription`), producing red console errors | Return 200 with `available:false` instead. |
| Non-persisted mute toggles and a label that says ON when nothing plays | Persist choice in localStorage (try/catch) and reflect real audio state. |
| Reduced motion that leaves continuous camera drift | Freeze or slow to a still frame for `prefers-reduced-motion` in Mosshatch's hero. |
| Fixed 100vh, `overflow:hidden` single-screen layout on mobile | Clips content on short viewports and real mobile browser chrome; Mosshatch has more content (pricing, TLDs, vault) and needs normal scrolling. |
| Hashed assets with `max-age=0, must-revalidate` | Use `public, max-age=31536000, immutable` for hashed files; keep HTML short-lived. |
| Text-first flash followed by a hard swap to the 3D hero (CLS 0.04 desktop) | Prerender a lightly styled version of the final hero (static image or CSS scene) so the swap is invisible. |
| Modal with a different typeface from the rest of the site (`Join free`) | Feels bolted-on; in a money/security context consistency reads as trust. |
| Storing the "hidden lab" URLs in robots.txt | Reveals unlinked experiments (`Disallow: /lab`); use noindex/auth, not robots, for secrets. |

## 13. Surprising

- The homepage headline in the static shell (`FOUR GAMES. ONE GOOD TIME.`) differs from the live hero headline (`MAKE SOME RACKET.`); the static one becomes a small line in the live view. Two hero messages exist.
- The privacy page and deployment match Mosshatch's planned stack almost one-for-one (Vercel, Neon, Resend, Stripe).
- No React at all; the whole UI is templated DOM. Small bundles follow from that.
- Zero audio and 3D asset files: everything is procedural or synthesized.
- The failure panel says "send these to Nick" and the source contains long design-history comments (including a story about an LG TV browser). Real craft, but it exposes internals.
- The paid feature is priced (`499` cents) in the checkout API but not open; the JSON-LD deliberately omits `offers` for that reason.
- The homepage weighs only about 400 kB for a live 3D scene, on par with many marketing pages.

## 14. Unverified

- Behaviour on a real GPU, real phones and real Safari (all measurements are SwiftShader in headless Chromium through a proxy).
- Whether the hero scene ever shows a bot-vs-bot rally (frames captured show camera drift over an empty court).
- Whether rendering pauses when the tab is hidden (only input release is confirmed).
- What happens after exactly two guest matches (I did not complete two matches or submit the email form).
- Any sound content at all with a real audio device (headless has no output; I only confirmed the `AudioContext` state).
- WebGL context-loss recovery specific to the site.
- Whether `Join free` sends mail (not submitted, to avoid sending real email).
- Lighthouse/INP figures (not measured).

## 15. Screenshots (all in `working-directory/research/shots/`)

| File | What it shows |
|---|---|
| `ref-rallywild-desktop.png` | 1280x800, WebGL on, hero 6 s after DOMContentLoaded |
| `ref-rallywild-mobile.png` | 390x844 viewport at DPR 2 (780x1688 px), hero |
| `rw-gl-desktop-t0.6s.png` | first paint: prerendered text page before boot |
| `rw-gl-mobile-t0.6s.png`, `rw-gl-mobile-full.png`, `rw-gl-desktop-full.png` | supporting frames |
| `rw-focus-desktop.png`, `rw-focus-mobile.png` | visible focus ring on MUSIC ON |
| `rw-reduced-motion-desktop.png` | hero with reduced motion |
| `rw-after-play.png`, `rw-gate-checked.png` | safety/age gate |
| `rw-ingame.png`, `rw-ingame-swing.png` | first rally with coach card |
| `rw-join.png` | free-membership dialog |
| `rw-pickleball-hero.png`, `rw-racing-hero.png` | other game heroes |
| `rw-nogl-desktop.png`, `rw-nogl-mobile.png` | "NEEDS WEBGL 2." screen |
| `rw-chunkblock-desktop.png`, `rw-chunkblock-mobile.png` | sentinel panel, no WebGL |
| `rw-chunkblock-glon-desktop.png`, `rw-chunkblock-glon-mobile.png` | sentinel panel, WebGL present |
| `rw-nojs-desktop.png`, `rw-nojs-mobile.png` | JS disabled |

## Source key (all accessed 2026-09-29)

- S1 https://rallywild.com/ (HTML, headers, inline sentinel script, JSON-LD)
- S2 https://rallywild.com/assets/index-BgykSxzm.js
- S3 https://rallywild.com/assets/index-B1f3jJVK.css
- S4 https://rallywild.com/assets/three-d4uwJM2u.js
- S5 https://rallywild.com/assets/game-Br1c7XJv.js
- S6 https://rallywild.com/assets/audio-ASt_Gmcx.js
- S7 https://rallywild.com/assets/quality-DV3ILSW4.js
- S8 https://rallywild.com/assets/ready.json
- S9 https://rallywild.com/robots.txt
- S10 https://rallywild.com/sitemap.xml
- S11 https://rallywild.com/privacy
- S12 https://rallywild.com/api/subscription, /api/checkout, /api/member
- S13 Live rendered page in headless Chromium 141 (DOM, accessibility tree, network log, localStorage, screenshots), https://rallywild.com/, scripts in `.../scratchpad/research/rw/`
- S14 https://rallywild.com/audio/ui_tick.mp3 and /audio/crowd_loop.mp3 (both HTTP 404)
