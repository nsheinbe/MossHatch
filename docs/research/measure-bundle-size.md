# MEASURE: JavaScript bundle-size budget inputs (Mosshatch Phase 0)

Access date for every source below: **2026-09-29**. All sizes are **measured locally on 2026-09-29** from real `vite build` output (not estimated) unless marked "estimate". 1 kB = 1000 bytes. "gzip" = zlib level 9 (like `gzip-size`), "brotli" = quality 11 (static precompress). Vite's own reporter numbers are noted separately because they differ slightly.

## TL;DR

1. **Shell (React 19.3.0 + ReactDOM + zustand 5.0.15 + tiny app): 221.8 kB raw / 68.7 kB gzip / 59.1 kB brotli** (+0.57 kB gzip CSS). React-DOM alone is 93% of it; zustand is about 0.6 kB raw.
2. **three.js (your named import set + `mergeGeometries`): 543.6 kB raw / 134.9 kB gzip / 110.5 kB brotli**. Statically bundled with the shell the initial JS is 203.0 kB gzip (b-static).
3. **`three` does NOT declare `sideEffects: false`**; it declares `"sideEffects": ["./src/nodes/**/*"]` (only the TSL nodes are impure; build/*.js and addons are treated as pure). Tree shaking works, but it barely helps: **a bare `new WebGLRenderer()` is 521.6 kB raw / 128.4 kB gzip = 95.2% of the gzip size of the whole requested set**. Everything else you named (all geometries, InstancedMesh, Points, RT, textures, addon merge) adds only about 22.0 kB raw / 6.5 kB gzip.
4. **`@simplewebauthn/browser` 14.0.0 (register + authenticate + feature detection): 9.5 kB raw / 3.1 kB gzip** (+2.7 kB gzip when added to the bundle in Vite 8).
5. **Lazy split works** (dynamic `import()` after first-contentful-paint): initial 69.3 kB gzip JS, lazy scene chunk 134.4 kB gzip. Verified in headless Chromium 141: the scene chunk was requested after FCP in 45/45 runs (3 lazy variants x 3 network profiles x 5); on Slow 4G + 4x CPU FCP was 0.82 s (lazy) vs 1.96 s (static).
6. **Toolchain:** Vite 8.3.1 uses Rolldown 1.2.11 + Oxc minifier (there is no Rollup/esbuild in the default build). Cross-checks: Vite 8.3.1 + esbuild 0.28.2 minify (+3.1% gzip on the three chunk) and Vite 7.3.6 = Rollup 4.63.5 + esbuild 0.28.2 (within 2%).
7. **Recommended budgets (gzip):** initial JS **target 110 kB, hard 130 kB**; lazy scene chunk **hard 150 kB** (floor is 128.4); lazy passkey chunk **hard 5 kB**; total JS **target 270 kB, hard 300 kB**. Current measured total with everything: 206.6 kB.
8. Caveats: headless Chromium/SwiftShader with CDP throttling, not a real phone; app code, real shaders, Stripe, fonts are not in these numbers; `THREE.Clock` is deprecated since r183 (use `Timer`).

---

## 1. What was built and how it was measured

Project: `working-directory/research/scratch-bundle` (Vite 8 build) and `.../scratch-bundle/compare-vite7` (Vite 7 build of identical sources). Nothing under `/home/user/MossHatch` was touched.

### 1.1 Versions used (all "latest" per `npm view <pkg> dist-tags.latest` on 2026-09-29)

| Package | Version | npm publish time (UTC) | Note |
|---|---|---|---|
| vite | 8.3.1 | 2026-09-24T12:26:19Z | `dist-tags.latest`. Deps: `rolldown ~1.2.9`, `lightningcss ^1.33.0`, `postcss`, no rollup, no esbuild dependency |
| rolldown (bundler inside Vite 8) | 1.2.11 | n/a | `import('vite').rolldownVersion` printed `1.2.11` |
| Oxc minifier (default `build.minify`) | bundled in rolldown 1.2.11 | n/a | exact oxc-minify version not exposed (unverified) |
| esbuild | 0.28.2 | n/a | installed as devDependency; used only for the `build.minify: 'esbuild'` cross-check and (transitively) by Vite 7 |
| rollup | 4.63.5 | n/a | only in the Vite 7.3.6 cross-check (`npm ls rollup`) |
| vite (cross-check) | 7.3.6 | 2026-06-25T01:51:49Z | `dist-tags.previous`; Rollup + esbuild based |
| @vitejs/plugin-react | 6.1.1 (Vite 8) / 5.2.0 (Vite 7) | n/a | 6.1.1 is `latest`; 5.2.0 is the newest 5.x that accepts Vite 7 |
| react, react-dom | 19.3.0 | 2026-09-09T17:21:30Z | latest |
| zustand | 5.0.15 | 2026-08-13T00:39:55Z | latest; declares `"sideEffects": false` |
| three | 0.186.1 | 2026-09-24T14:42:21Z | latest; `@types/three` 0.186.0 |
| @simplewebauthn/browser | 14.0.0 | 2026-09-02T05:49:26Z | latest |
| typescript | 7.0.2 | n/a | latest; `tsc -p` typecheck passed (exit 0) for both projects |
| Node | v22.22.2 | n/a | |
| Chromium (functional/timing checks) | 141.0.7390.37 headless via Playwright 1.56.1, SwiftShader WebGL2 | n/a | |

Sources: `npm view` output and `https://registry.npmjs.org/<pkg>/<version>` JSON saved under `research/src-cache/`. (accessed 2026-09-29)

### 1.2 Source under test

- `src/scene.ts` imports **by name** (no `import * as THREE`): WebGLRenderer, Scene, PerspectiveCamera, ShaderMaterial, BufferGeometry, BufferAttribute, InstancedBufferAttribute, Mesh, InstancedMesh, Points, Group, Object3D, Vector2, Vector3, Color, Matrix4, Quaternion, Euler, Clock, MathUtils, PlaneGeometry, SphereGeometry, CylinderGeometry, ConeGeometry, TorusGeometry, CapsuleGeometry, WebGLRenderTarget, DataTexture, CanvasTexture, AdditiveBlending, plus `mergeGeometries` from `three/addons/utils/BufferGeometryUtils.js`. `renderOneFrame(canvas)` instantiates and uses all of them (custom GLSL vertex/fragment shaders for the body, instanced tendrils, additive Points, background plane, render target pass then screen pass, `readPixels`).
- **Proof nothing was dropped:** in the built scene chunk the strings `SphereGeometry`, `CylinderGeometry`, `ConeGeometry`, `TorusGeometry`, `CapsuleGeometry` are present (1 each) and absent in the renderer-only build; unused classes (`RingGeometry`, `LatheGeometry`, `ExtrudeGeometry`, `TubeGeometry`, `ShapeGeometry`, `AnimationMixer`, `Skeleton`, `PMREMGenerator`, `AudioContext`) are absent. The frame was actually rendered in headless Chromium for every variant (Vite 8 oxc, Vite 8 esbuild, Vite 7): `{drawCalls:4, triangles:2298, points:200, mergedVertices:1351, nonZeroPixel:true}`.
- Shell (`src/App.tsx`, `src/store.ts`): search input, six-TLD results list, zustand store, plain CSS (1.08 kB raw).
- Passkey helper (`src/passkey.ts`): `startRegistration`, `startAuthentication`, `browserSupportsWebAuthn`, `platformAuthenticatorIsAvailable`, `browserSupportsWebAuthnAutofill`, both ceremonies in one function so both are retained.

### 1.3 Variants

| id | contents |
|---|---|
| r-only | React + ReactDOM only (`createRoot().render(<h1/>)`) |
| **a** | (a) React + zustand shell |
| **b-static** | (b) shell + three set, one chunk |
| **b-lazy** | (b) shell initial; three set behind `import()` gated on first-contentful-paint (`PerformanceObserver` paint entry, double-rAF fallback) |
| **c-static** | (c) b-static + @simplewebauthn/browser, one chunk |
| **c-lazy3** | (c) shell + passkey initial, three lazy |
| **c-lazyboth** | (c) shell initial; passkey lazy (on click) and three lazy |
| t-ctor / t-min / t-only | three only, no React: `new WebGLRenderer()` only / + `render(new Scene(), new PerspectiveCamera())` / the full named set |
| t-ns-static / t-ns-escape | reference: `import * as THREE` with static member access / namespace object escaping (nothing shakeable) |
| w-only | @simplewebauthn/browser only |

Config: `vite build`, defaults (`build.minify` default `'oxc'`; `build.target` default `'baseline-widely-available'`; CSS minified by Lightning CSS). Sizes were computed with node `zlib` on every emitted `assets/*.js|css` file (`measure.mjs`); raw data in `dist/sizes.json`, `dist-v8-esbuild/sizes.json`, `compare-vite7/dist/sizes.json`.

---

## 2. Results (primary: Vite 8.3.1, Rolldown 1.2.11, Oxc minify, default config)

### 2.1 Per-chunk sizes (every emitted JS/CSS file)

| variant | chunk | loads | raw B | gzip-9 B | brotli-11 B | raw kB | gzip kB | brotli kB |
|---|---|---|---:|---:|---:|---:|---:|---:|
| r-only | r-only-BqmlhEJV.js | initial | 219,550 | 67,684 | 58,326 | 219.55 | 67.68 | 58.33 |
| **a** | a-Dm2NDtxS.js | initial | 221,831 | 68,680 | 59,123 | 221.83 | 68.68 | 59.12 |
| **a** | a-B5Uk1mIl.css | initial | 1,076 | 574 | 471 | 1.08 | 0.57 | 0.47 |
| **b-static** | b-static-DAmzsJsW.js | initial | 765,430 | 203,036 | 168,631 | 765.43 | 203.04 | 168.63 |
| b-static | b-static-B5Uk1mIl.css | initial | 1,076 | 574 | 471 | 1.08 | 0.57 | 0.47 |
| **b-lazy** | b-lazy-CK2wBaGs.js | initial | 223,457 | 69,313 | 59,664 | 223.46 | 69.31 | 59.66 |
| b-lazy | scene-CwTmmMt2.js | lazy | 542,596 | 134,355 | 110,234 | 542.60 | 134.35 | 110.23 |
| b-lazy | b-lazy-B5Uk1mIl.css | initial | 1,076 | 574 | 471 | 1.08 | 0.57 | 0.47 |
| **c-static** | c-static-Cm9wX9v_.js | initial | 774,314 | 205,773 | 170,795 | 774.31 | 205.77 | 170.79 |
| c-static | c-static-B5Uk1mIl.css | initial | 1,076 | 574 | 471 | 1.08 | 0.57 | 0.47 |
| **c-lazy3** | c-lazy3-C89d5VwR.js | initial | 232,324 | 71,994 | 62,028 | 232.32 | 71.99 | 62.03 |
| c-lazy3 | scene-CwTmmMt2.js | lazy | 542,596 | 134,355 | 110,234 | 542.60 | 134.35 | 110.23 |
| c-lazy3 | c-lazy3-B5Uk1mIl.css | initial | 1,076 | 574 | 471 | 1.08 | 0.57 | 0.47 |
| **c-lazyboth** | c-lazyboth-CPj9fQJC.js | initial | 223,565 | 69,358 | 59,759 | 223.56 | 69.36 | 59.76 |
| c-lazyboth | passkey-1VhgSaE7.js | lazy (click) | 8,778 | 2,856 | 2,427 | 8.78 | 2.86 | 2.43 |
| c-lazyboth | scene-CwTmmMt2.js | lazy | 542,596 | 134,355 | 110,234 | 542.60 | 134.35 | 110.23 |
| c-lazyboth | c-lazyboth-B5Uk1mIl.css | initial | 1,076 | 574 | 471 | 1.08 | 0.57 | 0.47 |
| t-ctor | t-ctor-kDvP1VFj.js | n/a | 521,632 | 128,387 | 105,385 | 521.63 | 128.39 | 105.39 |
| t-min | t-min-SDsXPpSN.js | n/a | 523,029 | 128,682 | 105,699 | 523.03 | 128.68 | 105.70 |
| t-only | t-only-C5fq-v_v.js | n/a | 543,632 | 134,915 | 110,542 | 543.63 | 134.91 | 110.54 |
| t-ns-static | t-ns-static-SDsXPpSN.js | n/a | 523,029 | 128,682 | 105,699 | 523.03 | 128.68 | 105.70 |
| t-ns-escape | t-ns-escape-CTtGuT9F.js | n/a | 737,454 | 184,949 | 150,215 | 737.45 | 184.95 | 150.22 |
| w-only | w-only-D8_dzoVe.js | n/a | 9,485 | 3,148 | 2,680 | 9.49 | 3.15 | 2.68 |

(gzip-6, Vite's default zlib level, is in `dist/sizes.json`; it is about 0.3% larger than gzip-9.)

### 2.2 Scenario summary (the requested (a) / (b) / (c) table)

JS only unless stated; CSS is 0.57 kB gzip / 0.47 kB brotli in every variant.

| Scenario | Initial JS raw | Initial JS gzip | Initial JS brotli | Lazy JS gzip | Lazy JS brotli | Total JS gzip | Total JS brotli |
|---|---:|---:|---:|---:|---:|---:|---:|
| (a) React + zustand shell | 221,831 | **68,680** | 59,123 | 0 | 0 | 68,680 | 59,123 |
| (b) + three set, single chunk (b-static) | 765,430 | **203,036** | 168,631 | 0 | 0 | 203,036 | 168,631 |
| (b) + three set, lazy (b-lazy) | 223,457 | **69,313** | 59,664 | 134,355 | 110,234 | 203,668 | 169,898 |
| (c) b-static + @simplewebauthn/browser (c-static) | 774,314 | **205,773** | 170,795 | 0 | 0 | 205,773 | 170,795 |
| (c) shell + passkey initial, three lazy (c-lazy3) | 232,324 | **71,994** | 62,028 | 134,355 | 110,234 | 206,349 | 172,262 |
| (c) shell initial, passkey + three lazy (c-lazyboth) | 223,565 | **69,358** | 59,759 | 137,211 | 112,661 | 206,569 | 172,420 |

### 2.3 Increments (Vite 8, gzip-9)

| Component | raw B | gzip B | brotli B | How derived |
|---|---:|---:|---:|---|
| React + ReactDOM 19.3.0 client | 219,550 | 67,684 | 58,326 | r-only |
| zustand + app shell code | +2,281 | +996 | +797 | a minus r-only (zustand itself is 592 B raw in the source-map attribution) |
| three named set incl. WebGLRenderer | 543,599 | 134,356 | 109,508 | b-static minus a |
| @simplewebauthn/browser (both ceremonies + detection) | 8,884 | 2,737 | 2,164 | c-static minus b-static (Vite 8); standalone w-only is 9,485 raw / 3,148 gzip; lazy chunk 8,778 / 2,856 |
| Cost of making three lazy (dynamic-import helper + glue in initial chunk) | +1,626 | +633 | +541 | b-lazy initial minus a |
| Total-bytes penalty of splitting (b-lazy total minus b-static total) | +623 | +632 | +1,267 | the split costs about 0.6 kB gzip |

Source-map attribution of chunk `a` (raw bytes, via `source-map-explorer` 2.x): react-dom 206,941; react 8,178; scheduler 3,528; app code 1,332 (App.tsx 924, store.ts 293, entry 75); zustand 592; unmapped 1,292.

---

## 3. three.js: side effects, tree-shaking and the unshakeable renderer core

### 3.1 Does three declare `sideEffects: false`? No.

- npm registry, three 0.186.1: `"sideEffects": ["./src/nodes/**/*"]` (source: https://registry.npmjs.org/three/0.186.1, accessed 2026-09-29; identical in https://raw.githubusercontent.com/mrdoob/three.js/dev/package.json, whose `version` is 0.186.0). Quote: `"sideEffects": [ "./src/nodes/**/*" ]`.
- Meaning: only files under `src/nodes/` (the WebGPU/TSL node system) are flagged impure. `build/three.module.js`, `build/three.core.js` (the files `import 'three'` resolves to via `exports["."].import`) and `examples/jsm/**` (addons) are treated as side-effect-free, so unused exports are removable. This is a package-level declaration (an allowlist of impure paths), not the boolean `false`.
- Residual top-level side effects in `build/three.core.js` that survive tree shaking whenever any three export is used (confirmed in the minified output): the `window.__THREE__ = REVISION` registration/duplicate-import warning and `__THREE_DEVTOOLS__` dispatch blocks. Size impact is small (not separately measured).
- three 0.186.1 ships two ESM files: `build/three.core.js` (1,458,113 B unminified: math, objects, geometries, materials, textures) and `build/three.module.js` (662,772 B unminified: WebGLRenderer and everything under `renderers/webgl`, shader chunks). `build/three.cjs` is a deprecated shim. Source-map attribution of the t-only build (raw minified bytes attributable to a source file): `three.module.js` 199,498; `three.core.js` 183,589; BufferGeometryUtils 3,720; `scene.ts` 2,601; **149,942 unattributed**.
- zustand declares `"sideEffects": false`; `@simplewebauthn/browser` 14.0.0 declares no `sideEffects` field (registry JSON), yet its unused exports still tree-shake in the Vite 8 build (only measured through the size deltas above).

### 3.2 How much of the three chunk is WebGLRenderer core that cannot be shaken

| Build | raw B | gzip B | brotli B | % of full named set (gzip) |
|---|---:|---:|---:|---:|
| `new WebGLRenderer()` only (t-ctor), the absolute floor | 521,632 | 128,387 | 105,385 | **95.2%** (raw 96.0%, brotli 95.3%) |
| + `render(new Scene(), new PerspectiveCamera())` (t-min) | 523,029 | 128,682 | 105,699 | 95.4% |
| **Full named set incl. mergeGeometries (t-only)** | 543,632 | 134,915 | 110,542 | 100% |
| Everything the set adds on top of t-min | +20,603 | +6,233 | +4,843 | 4.6% |
| Everything the set adds on top of t-ctor | +22,000 | +6,528 | +5,157 | 4.8% |
| Reference: `import * as THREE` with the namespace escaping (no shaking) | 737,454 | 184,949 | 150,215 | 137% |

Findings:
- Tree shaking removes about 26% raw / 27% gzip versus the whole library, but the residual after shaking is dominated by WebGLRenderer. The renderer floor cannot go lower because `WebGLRenderer` statically references the built-in shader library and subsystems.
- Evidence of what is retained in the bare-renderer build (string counts in the minified `t-min` output): PBR/transmission GLSL (`USE_TRANSMISSION` x16, `meshphysical` x6), `RectAreaLight` LTC tables, AgX/ACES tone mapping, PMREM/CubeUV, shadow-map GLSL, `WebXRManager`, `MeshPhysicalMaterial`, `BatchedMesh`. Even a scene using only `ShaderMaterial` still ships them.
- The built-in GLSL template literals alone are about **138.5 kB raw (80 template literals > 300 chars) of the 523 kB floor (26%)**, about 25.9 kB when gzipped in isolation. This is the largest single chunk of "unshakeable" content. (measured by regex over `dist/t-min/assets/*.js`.)
- Namespace imports are not the problem: `import * as THREE` with static member access produces a byte-identical chunk to the named-import build (same content hash `SDsXPpSN` for t-ns-static and t-min in Vite 8; `DviPbB1_` for both in Vite 7). It only hurts when the namespace escapes (dynamic lookup): about +41% versus the renderer-only build.
- Consequence: the "shakeable" portion of three for this feature set is about 6.5 kB gzip. Budget three as a near-fixed cost of about 130 kB gzip (about 105 kB brotli), and do not expect further tree-shaking wins from trimming the import list.
- `THREE.Clock` works but is deprecated: `src/core/Clock.js` in 0.186.1 contains `warn( 'Clock: This module has been deprecated. Please use THREE.Timer instead.' ); // @deprecated, r183` and prints that warning in the console at runtime (seen in Chromium). `Timer` is exported from `three` (`src/Three.Core.js`). Plan on `Timer`; size not separately measured.

---

## 4. Lazy chunk split (dynamic import after first paint)

**It works.** With `await import('./scene')` gated on first-contentful-paint, Vite 8 emits a separate `scene-CwTmmMt2.js` chunk; the entry HTML references only the entry script and the CSS (`<script type="module" src="/assets/b-lazy-CK2wBaGs.js">` + one stylesheet; no `modulepreload` for the lazy chunk, checked in `dist/b-lazy/pages/b-lazy.html`).

| | Initial JS (raw / gzip / brotli) | Lazy chunk (raw / gzip / brotli) |
|---|---|---|
| b-lazy | 223,457 / 69,313 / 59,664 | 542,596 / 134,355 / 110,234 |
| c-lazyboth | 223,565 / 69,358 / 59,759 | scene 542,596 / 134,355 / 110,234 + passkey 8,778 / 2,856 / 2,427 |

Vite prints "(!) Some chunks are larger than 500 kB after minification" for the scene chunk (default `build.chunkSizeWarningLimit` 500 kB, "compared against the uncompressed chunk size"); raise it to about 600 for that chunk or ignore it.

### 4.1 Runtime check (headless Chromium 141, local static server with gzip-9, cold cache per run, 5 runs per cell, medians)

Method: `runtime-throttled.mjs`. FCP is the browser's `first-contentful-paint` with the `<h1>` present; "scene req" is the Resource Timing `startTime` of the `scene-*.js` request; "frame" is `performance.now()` when `renderOneFrame` finished. Profiles: none; "Fast 4G" (9 Mbps, 75 ms RTT, 4x CPU throttle); "Slow 4G" (Lighthouse-style 1.6 Mbps, 150 ms RTT, 4x CPU throttle). WebGL is software (SwiftShader), so the frame time is not representative of a GPU.

| variant | none: FCP / frame | Fast 4G + 4x CPU: FCP / frame | Slow 4G + 4x CPU: FCP / frame | scene req after FCP? |
|---|---|---|---|---|
| a (shell only) | 80 ms / n/a | 396 ms / n/a | 804 ms / n/a | n/a |
| b-static | 352 ms / 361 ms | 1100 ms / 1075 ms | **1964 ms** / 1938 ms | n/a (single chunk) |
| **b-lazy** | 92 ms / 471 ms | 420 ms / 1248 ms | **820 ms** / 2155 ms | 15/15 yes |
| c-static | 352 ms / 392 ms | 1012 ms / 1063 ms | 2008 ms / 2015 ms | n/a |
| c-lazy3 | 100 ms / 485 ms | 404 ms / 1101 ms | 860 ms / 2380 ms | 15/15 yes |
| c-lazyboth | 92 ms / 393 ms | 428 ms / 1130 ms | 860 ms / 2172 ms | 15/15 yes |

Reading: making the three set lazy moved Slow-4G FCP from about 1.96 s to about 0.82 s (about 2.4x) while the first rendered frame arrives at about the same time (about 2.2 s vs 1.9 s). Median scene-request start was 3 to 15 ms after median FCP in every cell, and after FCP in every individual run. An earlier 5-run set of the same test on an earlier build (before I changed the passkey module) gave b-static a Slow-4G median of 1640 ms with two outliers at 2.4 s, so treat the static figure as 1.6 to 2.0 s. First-order slope between the two measured endpoints (a: 69.9 kB total, b-static: 203.6 kB total): about 8.6 ms of Slow-4G FCP per kB gzip of initial JS (estimate, two points, this machine only).

Note that without the explicit FCP gate (my first version used `requestAnimationFrame` + `setTimeout(0)` after `render()`), the scene chunk was requested at about 95 ms, before FCP at about 308 ms (single unthrottled run): React's async render does not guarantee a paint before the next task. The gate matters.

---

## 5. Cross-checks: other minifier and Vite 7

Same sources, same measurement script, gzip-9 (full tables in `dist-v8-esbuild/sizes.json` and `compare-vite7/dist/sizes.json`).

| Scenario | Vite 8.3.1 + Oxc (primary) | Vite 8.3.1 + `minify:'esbuild'` 0.28.2 | Vite 7.3.6 (Rollup 4.63.5 + esbuild 0.28.2) |
|---|---:|---:|---:|
| (a) shell JS gzip | 68,680 | 69,947 (+1.8%) | 70,026 (+2.0%) |
| three chunk alone (t-only) gzip | 134,915 | 139,122 (+3.1%) | 134,526 (-0.3%) |
| t-ctor (renderer floor) gzip | 128,387 | 132,300 | 128,075 |
| scene lazy chunk gzip | 134,355 | 138,729 | 133,600 |
| (b-static) initial gzip | 203,036 | 209,308 | 205,123 |
| (b-lazy) initial gzip | 69,313 | 70,666 | 70,747 |
| passkey lazy chunk gzip | 2,856 | 2,913 | 2,911 |
| (c-static) minus (b-static) gzip | +2,737 | +2,854 | +1,908 (see note) |
| CSS gzip | 574 (Lightning CSS) | 574 | 546 (esbuild CSS minify) |

Note: in Vite 7 (Rollup) `c-static` dropped the `startRegistration` code path (`credentials.create` count 0 vs 1 in Vite 8) because the only call site passes the constant `'authenticate'` and Rollup specialises on it. That understates (c) for Vite 7; the lazy `passkey` chunk (2,911 B gzip, contains both) and `w-only` are the precise numbers. The conclusions do not depend on the bundler: results agree within about 3%.

Vite's own reporter is not the same as zlib: Vite 8's native `builtin:vite-reporter` printed `205.42 kB` gzip for b-static (zlib-6: 203.64 kB, zlib-9: 203.04 kB, i.e. about 1% higher); Vite 7 printed `205.71 kB` which equals zlib-6 exactly. Use one method consistently in CI (recommend zlib-9 or brotli).

Vite docs (https://vite.dev/config/build-options.md, accessed 2026-09-29): `build.minify` "Default: `'oxc'` for client build"; "The default is Oxc Minifier which is 30 ~ 90x faster than terser and only 0.5 ~ 2% worse compression"; "`build.minify: 'esbuild'` is deprecated and will be removed in the future." Our measured Oxc-vs-esbuild gap is the reverse direction (Oxc is 1.8 to 3.1% smaller than esbuild here), so do not assume Oxc costs bytes. https://vite.dev/guide/migration.md: "Vite 8 uses Rolldown and Oxc based tools instead of esbuild and Rollup."

---

## 6. Recommended budgets

Unit: kB gzip-9 (1000 B), measured on build output, Vite 8.3.1 default. Brotli transfer is expected to be about 14 to 18% smaller (Vercel documents "brotli compressed JavaScript files are 14% smaller than gzip" at https://vercel.com/docs/compression, last updated March 5, 2026; measured here: 13.9% on the shell, 18.1% on the three chunk at brotli q11). Vercel's actual brotli quality is not documented (unverified), so keep budgets in gzip as the conservative figure.

| Budget | Measured today | Target | Hard fail | Basis |
|---|---:|---:|---:|---|
| **Initial JS** (entry + statically imported chunks; "first paint shows real content before the scene loads") | 69.4 (shell, passkey lazy) to 72.0 (passkey static) | **110** | **130** | React 19.3 DOM alone is 67.7 of it. 130 leaves 58 kB for router, API client, search/checkout UI and app state. Interpolated Slow-4G + 4x CPU FCP at 130 kB is about 1.3 s (estimate from the 8.6 ms/kB slope). Well inside web.dev's "under 170 KB of critical-path resources (compressed/minified)" (https://web.dev/articles/your-first-performance-budget, last updated 2018-11-05, dated) |
| Initial CSS | 0.57 | 8 | 10 | scene canvas styling only |
| **Lazy scene chunk** (three + procedural creature code + GLSL) | 134.4 | 145 | **150** | Renderer floor is 128.4 (95.2%) and is not reducible; the hard cap leaves 15.6 kB (11.6%) for real shaders, more geometry and creature code. Exceeding it means custom code is over about 15 kB gzip, review it |
| Lazy passkey chunk (if loaded on click) | 2.9 | 4 | **5** | @simplewebauthn/browser 14.0.0 |
| **Total JS, all chunks** | 206.6 | **270** | **300** | Initial hard 130 + scene 150 + passkey 5 = 285, rounded to 300. Also consistent with Alex Russell's 2026 critical-path table: for a 3 s load at 9 Mbps, 100 ms RTT on a Galaxy A24 4G / HP 14 class device (75th percentile), the JS-light case allows 0.3 MiB of JS (https://infrequently.org/2025/11/performance-inequality-gap-2026/, published 2025-11; passage: "3 sec 2.0 0.3 1.7 1.2 0.62 0.62"; whether his figures are compressed bytes is not stated in the passage I read) |
| Time gate (not a size) | FCP 0.82 s on Slow 4G + 4x CPU with lazy scene | FCP <= 1.2 s in that profile | 1.5 s | measured; keep the FCP-gated dynamic import as a CI-tested behavior |

Notes for enforcement: check each chunk (initial set vs lazy set) rather than the sum; compute with zlib-9 in CI; treat `dist` HTML as the source of truth for which chunks are initial (a `modulepreload` for the scene chunk would silently make it initial).

---

## 7. Design implications for Mosshatch

1. **Plan three as a roughly fixed 130 kB gzip lazy chunk.** Import-list trimming is worth about 6 kB. Bigger levers: do not ship the WebGPU/TSL entry; keep custom GLSL small (built-in shader chunks are already 26% of the floor and unavoidable); generate creatures procedurally rather than shipping models.
2. **Lazy-load three behind an FCP-gated `import()`**, not `requestAnimationFrame`/`setTimeout`. Use `PerformanceObserver` paint entries (MDN: `PerformancePaintTiming` "available across browsers since April 2021", https://developer.mozilla.org/en-US/docs/Web/API/PerformancePaintTiming; `import()` "since January 2020", https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import). The double-rAF fallback branch was written but not exercised in a test.
3. **The shell is the initial-JS problem, not the scene**: React DOM 19.3 is 67.7 of 68.7 kB. If you want "real content before any JS", pre-render the landing/search HTML (static HTML or SSG) so first paint does not wait for React at all; otherwise first paint costs about 0.8 s on Slow 4G + 4x CPU. This is an option, not measured here.
4. **Passkey code is cheap** (2.9 kB gzip). Loading it on the sign-in click keeps 2.7 kB out of the critical path at the cost of one extra request; loading it statically is acceptable within the 110 kB target.
5. Replace `Clock` with `Timer` from the start (deprecated since r183, logs a console warning).
6. Raise or silence `build.chunkSizeWarningLimit` for the scene chunk only, and pin measurement to zlib-9/brotli, not Vite's reporter.
7. Pin versions: Vite 8's default toolchain (Rolldown + Oxc) is new; Vite 7 gave results within about 3%, so a fallback exists if a Rolldown regression appears.
8. Not in these numbers (budget separately): application code beyond the shell, router, API/auth client, real creature GLSL and geometry code, fonts, images/textures, Stripe.js if embedded, analytics, error reporting.

---

## 8. Unverified / limits

- **Real-device performance:** all timings are headless Chromium 141 with SwiftShader and CDP throttling on one machine (5 runs per cell). No real phone, no Safari/Firefox, no GPU.
- Exact Oxc minifier version inside Rolldown 1.2.11 is not exposed (only the Rolldown version was verifiable).
- Whether Alex Russell's figures are compressed bytes is not stated in the passage read; the web.dev budget article is from 2018 (dated) and is used only as a sanity bound.
- Vercel's brotli quality/level is not documented on the page read; brotli-11 is a best case.
- The three.js manual (https://threejs.org/manual/pages/installation.html) does not discuss tree shaking; it shows `import * as THREE from 'three'` and says "Addons do not need to be installed separately, but do need to be imported separately." Tree-shakeability was therefore established by package.json + measurement, not by an official statement.
- `THREE.Timer` size and behavior differences from `Clock` were not measured.
- The PerformanceObserver-unavailable fallback path was not tested.
- WebSearch quota was exhausted mid-task, so budget sources were located by direct URL rather than by search; no second independent budget source (e.g. Lighthouse thresholds) was checked.
- Vite 7's `c-static` understates (c) because of call-site specialisation (see Section 5).

---

## 9. Sources (all accessed 2026-09-29)

| Claim | URL | Quote / evidence |
|---|---|---|
| three sideEffects | https://registry.npmjs.org/three/0.186.1 ; https://raw.githubusercontent.com/mrdoob/three.js/dev/package.json | `"sideEffects": [ "./src/nodes/**/*" ]`; `exports["."].import` = `./build/three.module.js` |
| three Clock deprecation | local `node_modules/three/src/core/Clock.js` (three 0.186.1) | `warn( 'Clock: This module has been deprecated. Please use THREE.Timer instead.' ); // @deprecated, r183` |
| three manual on addons/imports | https://threejs.org/manual/pages/installation.html | "Addons do not need to be installed separately, but do need to be imported separately." |
| Vite 8 uses Rolldown/Oxc | https://vite.dev/guide/migration.md | "Vite 8 uses Rolldown and Oxc based tools instead of esbuild and Rollup." |
| Vite minify default | https://vite.dev/config/build-options.md | "Default: `'oxc'` for client build"; "`build.minify: 'esbuild'` is deprecated and will be removed in the future." |
| Vite chunk warning | https://vite.dev/config/build-options.md | "Default: 500 ... It is compared against the uncompressed chunk size" |
| Vite target default | https://vite.dev/config/build-options.md | "Default: `'baseline-widely-available'`" |
| Vite 8.3.1 deps | https://registry.npmjs.org/vite/8.3.1 | dependencies: `rolldown ~1.2.9`, `lightningcss ^1.33.0`, `postcss`, `picomatch`, `tinyglobby` |
| Latest versions/dates | `npm view <pkg> dist-tags.latest` and `time` (registry.npmjs.org) | vite 8.3.1 (2026-09-24), three 0.186.1 (2026-09-24), react 19.3.0 (2026-09-09), zustand 5.0.15 (2026-08-13), @simplewebauthn/browser 14.0.0 (2026-09-02), vite `previous` 7.3.6 (2026-06-25) |
| zustand sideEffects false | https://registry.npmjs.org/zustand/5.0.15 | `"sideEffects": false` |
| Brotli vs gzip | https://vercel.com/docs/compression (last updated March 5, 2026) | "brotli compressed JavaScript files are 14% smaller than gzip" |
| Budget: 170 KB critical path | https://web.dev/articles/your-first-performance-budget (Last updated 2018-11-05) | "try to deliver under 170 KB of critical-path resources (compressed/minified)"; row "Slow 4G Moto G4 200 50 35 30 30 ~345 KB 3s" |
| Budget 2026 | https://infrequently.org/2025/11/performance-inequality-gap-2026/ | "Updated network test parameters for 2026 are: 9 Mbps downlink 3 mbps uplink 100 millisecond RTT"; table row "3 sec 2.0 0.3 1.7 1.2 0.62 0.62" (JS-light total/JS/other, JS-heavy total/JS/other, MiB) |
| Paint Timing support | https://developer.mozilla.org/en-US/docs/Web/API/PerformancePaintTiming | "Baseline Widely available ... available across browsers since April 2021" |
| Dynamic import support | https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import | "Baseline Widely available ... available across browsers since January 2020" |
| SimpleWebAuthn browser API | https://simplewebauthn.dev/docs/packages/browser | documents `startRegistration()` / `startAuthentication()`; API also confirmed by `tsc` typecheck of the probe against 14.0.0 |
| All sizes, chunk counts, timings | local files listed below | measured 2026-09-29 |

### Reproduction (local paths)

- Sources: `.../research/scratch-bundle/src/` (`scene.ts`, `scene-min.ts`, `passkey.ts`, `after-first-paint.ts`, `App.tsx`, `store.ts`, `entries/*.tsx`), `pages/*.html`, `vite.config.ts` (env `VARIANT`, `MINIFY`, `OUT_ROOT`, `SOURCEMAP`, `THREE_SRC`).
- Build all: `OUT_ROOT=dist ./build-all.sh` (logs `build-vite8-oxc.log`); esbuild minify: `OUT_ROOT=dist-v8-esbuild MINIFY=esbuild ./build-all.sh`; Vite 7: `cd compare-vite7 && OUT_ROOT=dist ./build-all.sh`.
- Sizes: `node measure.mjs dist` writes `dist/sizes.json`. Functional check: `node runtime-check.mjs dist b-lazy ...`. Timings: `node runtime-throttled.mjs dist 5 slow4g a b-static b-lazy c-static c-lazy3 c-lazyboth` (logs `runtime-slow4g.log`, `runtime-fast4g.log`, `runtime-none.log`).
- Attribution: `.../research/tools/sme-*.json` (`source-map-explorer`), `dist-map/` (sourcemap builds).
