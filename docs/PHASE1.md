# Phase 1 report: the place (no backend)

Status: built, waiting for your "go" before Phase 2. Preview: https://mosshatch.vercel.app (Vercel login required).

## What shipped
- Workspace: `apps/web` (Vite 8, React 19, three 0.186, Zustand), `packages/core` (`deriveTraits`, `deriveCreatureState`, money and the D-003 fee bands), `packages/registrar` (`MockRegistrar`, sample prices labelled).
- The scene: hatch shader (three ink layers in screen space, moss, rim, speckle, desaturation, sleep dimming, attention pulse, shedding band, fog, sway), sky dome with moon and stars, ripple pool, merged trees, stones, grass, lanterns with flicker and halos, fireflies, pollen, burst particles, goal-and-damp camera with fit-to-aspect.
- Four creature families plus the `.app` and `.studio` palettes, one merged mesh per creature animated in the vertex shader. All eight states (egg is the rising egg). Armored shells, crates and pulse rings are instanced.
- Find view: pool input, eggs, sleepers with struck-through chips, three alternatives, "The deal", Arrival demo (cancelled by any input), Hatch sheet (practice, no charge), the Hatch sequence, card snapshot from a second render target.
- Sound (WebAudio synthesis, off by default), Calm mode, mobile layout (bottom bar, chip list), WebGL2 fallback page, no-JS static page, sample My grove, `debug.html?debug=states&family=...`.
- Gates: CSP and headers in `vercel.json`, bundle secret scan and size budgets inside `npm run build`, ST-id coverage check, supply-chain check, GitHub Actions CI (actions pinned to commit SHAs), Playwright + axe (WCAG 2.2 AA tags).

## Measured (software WebGL, Chromium 1194 headless; not real devices)
| Item | Result | Budget |
|---|---|---|
| Initial JS (gzip -9) | 78.1 kB | target 110, hard 130 |
| Scene chunk (gzip -9) | 149.1 kB | hard 150 (margin is 0.9 kB) |
| Fonts | 35.7 kB (subset) | target 40 |
| Draw calls, debug page, 21 creatures | 33 | at most 60 |
| Unit tests | 29 pass | |
| Playwright | 10 prod + 9 dev pass | |

## Exit criteria
- Met by test: draw calls; initial JS; golden traits identical in browser and Node; first paint shows real content before the scene; fallback with WebGL disabled and with JavaScript disabled; zero console errors and CSP violations (ST-36); DPR step-down; axe clean on Find, deal, sheet, card, grove, fallback and static pages; keyboard path to the sheet; ST-14 (only for the static/asset routes that exist), ST-37, ST-139, ST-140. C-53 (search notice and no-request canary) and C-55 (WCAG 2.2 AA axe gate) built.
- Not met or not proven: see below.

## Still rough or unproven
1. **Deliberately leaking preview refused by Vercel (ST-21)**: not done. It needs a throwaway branch pushed to GitHub; I did not push one without your say-so. The scanner itself has 17 unit tests and fails the local build.
2. **Real devices**: no frame-time, thermal, touch or Safari/Firefox check was possible. Software GL gives no frame times. The manual device pass is owed.
3. **Scene chunk is 0.9 kB under the hard limit.** Almost all of it is three.js's renderer. Further headroom needs a lighter renderer path or dropping features.
4. **Keyboard pass and screen-reader matrix (C-55)**: automated axe and one keyboard path only; the manual pass with JAWS/NVDA/VoiceOver is owed.
5. Without JavaScript the search box is disabled (a static page cannot search). The plan's "working plain search" holds with JavaScript on and WebGL off.
6. Moth wings have no shader-drawn pattern yet; the creature-part animation method (vertex-shader parts, one mesh each) is chosen and works but was not compared with instanced parts.
7. Ledger view is not built (Phase 3). "Open its nest" is omitted from the card (Phase 4). Card address `hatchkind.com/<domain>` is shown as not live.
8. Sound is untested by ear here; only that it is silent by default and throws nothing.
9. Point-sprite sizes, camera framing, and the crowded chip layout on desktop need your eye.

## Decisions needed
- Push a throwaway branch to prove the leak refusal (ST-21)? 
- Accept `?debug=states` on preview deployments only (env `MOSSHATCH_DEBUG_ENTRY=1` on the Vercel preview target)? Production builds exclude it and fail if it appears.
- Node 22 locally, Node 24 on Vercel: fine for now.
