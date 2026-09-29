# MEASURE: headless Chromium + WebGL2 + Playwright screenshot tests in this container

Accessed/measured: 2026-09-29. Method: everything below was run in this container (Linux 6.18, 4 vCPU Intel Xeon 2.1 GHz, 16 GB RAM, no `/dev/dri`, no `/dev/snd`), and documentation claims were fetched from the primary source on the same day. Working dir: `working-directory/research/scratch-pw` (scripts `t*.mjs`, raw output `raw-t*.txt|json`, screenshots in `shots/`, docs in `docs/`). Nothing under `/home/user/MossHatch` was touched.

## TL;DR

1. YES: the preinstalled Chromium 141.0.7390.37 (Playwright build 1194) renders WebGL2 here, entirely in software (ANGLE on SwiftShader Vulkan, `WebGL 2.0 (OpenGL ES 3.0 Chromium)`, MAX_TEXTURE_SIZE 8192, EXT_color_buffer_float and OES_texture_float_linear both present). There is no GPU device.
2. `npm i @playwright/test@latest` (1.63.0) installs in ~2 s and downloads NO browser, but 1.63 wants Chromium 153 (build 1243) so a plain `launch()` fails; either pass `executablePath` (worked with both the full binary and headless_shell) or pin `@playwright/test@1.56.1` (its `browsers.json` is build 1194, works with zero config). Never run `playwright install`.
3. WebGL2 comes up with Playwright's DEFAULT args, because Playwright 1.63 already adds `--enable-unsafe-swiftshader` on Linux. Trap: raw `chromium --headless=new --disable-gpu` (the form in the task brief) gives NO WebGL at all (webgl2 and webgl1 both null, 3/3); `--disable-gpu` only "works" when `--disable-field-trial-config` (a Playwright default) or `--enable-unsafe-swiftshader` is also present. Recipe: never pass `--disable-gpu`; pass `--enable-unsafe-swiftshader`.
4. A three.js r186 ShaderMaterial scene (gl_FragCoord/DPR, fwidth iso-lines, 3 line layers, time uniform) rendered correctly at 1280x800 and 390x844 at DPR 1 and 2 (viewed PNGs); DPR1 vs box-downsampled DPR2 differ by 1.2-1.3/255 mean, so the CSS-px maths holds.
5. Software frame time is roughly 37-39 ns per drawing-buffer pixel for this shader at best (12-38 ms/frame at 390x844@1 and 1280x800@1, 150 ms+ at 1280x800@2), measured while load average was 9-13 on 4 vCPUs. It is NOT representative of any real GPU; use it only to say "free-running animation is unusable in CI".
6. Deterministic screenshots are achievable: with a frozen time uniform (`?t=`), a seeded RNG (`?seed=`) and an on-demand render loop, PNGs were byte-identical across 5 launches x 4 viewport/DPR combos, across full-chrome vs headless_shell, and across Playwright 1.56.1 vs 1.63.0. `page.clock` was NOT deterministic enough (4 launches -> 3 distinct hashes).
7. Pixel-diff pitfalls measured: `toHaveScreenshot` defaults to `scale: "css"` (DPR2 baselines silently shrink to CSS size) and `threshold: 0.2` (a 10 ms animation-phase change passes with maxDiffPixels 0); set `scale: 'device'` and `threshold: 0`. GL flags change pixels (0.103% of pixels between default and `--use-angle=swiftshader`), so pin them.
8. `@axe-core/playwright` 4.13.0 works fully offline (also verified inside an empty network namespace); text over the WebGL canvas comes back as axe "incomplete", not pass. Console/pageerror guard, favicon-404 trap, and device-descriptor emulation (needs `browserName: 'chromium'` override) all verified; 58 Playwright tests passed.
9. NOT verifiable here: real-device GPU behaviour and precision, thermal/battery throttling, Safari/iOS WebGL (no WebKit installed, and Playwright WebKit is not Safari), touch feel, audio output, WebGPU (adapter is null), cross-machine pixel identity (section 12).

---

## 1. Environment facts

| Fact | Value | Evidence (source, accessed 2026-09-29) |
|---|---|---|
| Node / npm | v22.22.2 / 10.9.7 | `node -v; npm -v` in container |
| Browsers dir | `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` containing `chromium-1194`, `chromium_headless_shell-1194`, `ffmpeg-1011`, and a symlink `chromium -> chromium-1194/chrome-linux/chrome`. No Firefox, no WebKit. | `ls -la /opt/pw-browsers` |
| Full Chromium | `Chromium 141.0.7390.37` | `/opt/pw-browsers/chromium-1194/chrome-linux/chrome --version` |
| Headless shell | `Chromium 141.0.7390.37` | `/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell --version` |
| `chromium` on PATH | absent (`bash: chromium: command not found`); use the absolute path | `which chromium` |
| Build 1194 = Playwright 1.56.x | 1.56.0 and 1.56.1 `browsers.json`: chromium/chromium-headless-shell revision 1194, browserVersion 141.0.7390.37; 1.57.0 = 1200 / 143.0.7499.4 | `npm pack playwright-core@1.56.1` then read `package/browsers.json` (raw in `raw/pwcore/`); Playwright release notes https://playwright.dev/docs/release-notes ("Version 1.56 ... Browser Versions Chromium 141.0.7390.37") |
| Latest Playwright | `@playwright/test` / `playwright` 1.63.0 (dist-tag latest; `next` = 1.64.0-alpha-2026-09-29); its `browsers.json` = chromium 1243 = 153.0.8010.12 | `npm view playwright dist-tags`; `node_modules/playwright-core/browsers.json`; release notes ("Version 1.63 ... Chromium 153.0.8010.12") |
| Other packages | `@axe-core/playwright` 4.13.0 (peer `playwright-core >= 1.0.0`, depends on `axe-core ~4.13.0`), `axe-core` 4.13.0, `three` 0.186.1 (REVISION "186"), `@types/three` 0.186.0 | `npm view ...`; `npm ls` |
| GPU hardware | none: no `/dev/dri`, no `/dev/nvidia*`, no `/dev/kfd`; CDP `SystemInfo.getInfo` lists exactly one "device": ANGLE / SwiftShader | `ls /dev/dri` error; `raw` output of `t9-gpuinfo.mjs` |
| CPU / load during timing | 4 vCPU; load average 9-13 during the frame-time runs because other research agents share the VM | `uptime`, `lscpu` |

## 2. Installing Playwright without `playwright install`

| Step | Result | Evidence |
|---|---|---|
| `npm install --save-dev @playwright/test@latest @axe-core/playwright@latest three@latest` | `added 6 packages ... in 2s`; no browser downloaded (`~/.cache/ms-playwright` does not exist afterwards; `playwright` and `playwright-core` 1.63.0 have no install scripts: `npm view playwright@1.63.0 scripts` is empty) | container, `t1`; npm registry |
| `chromium.launch()` with 1.63.0, no options | FAILS: `Executable doesn't exist at /opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell` + "Please run ... npx playwright install" | `t1-default-launch.mjs` |
| `chromium.launch({executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'})` | OK, `browser.version()` = `141.0.7390.37` (UA `HeadlessChrome/141.0.0.0`, reduced) | `t2-exec-launch.mjs` |
| same with the `/opt/pw-browsers/chromium` symlink | OK | `t2` |
| same with `.../chromium_headless_shell-1194/chrome-linux/headless_shell` | OK, `141.0.7390.37`, full UA `HeadlessChrome/141.0.7390.37` | `t2` |
| `@playwright/test@1.56.1` in `scratch-pw/pw156`, plain `chromium.launch()` and `launch({channel:'chromium'})` | both OK with no `executablePath`, both `webgl2 = WebGL 2.0 (OpenGL ES 3.0 Chromium)` | `pw156/t.mjs` |

Playwright's own documentation warns about the `executablePath` route: "Playwright is only guaranteed to work with the bundled Chromium ... There is no guarantee it will work with any other version. Use executablePath option with extreme caution." (https://playwright.dev/docs/api/class-browsertype, accessed 2026-09-29). Here Playwright 1.63 (built for Chromium 153) drove Chromium 141 through all 58 tests without a protocol problem, but that is an observation, not a guarantee. The pin-to-1.56.1 route removes the mismatch. The docs also state the headless split: "Playwright ships a regular Chromium build for headed operations and a separate chromium headless shell for headless mode." (https://playwright.dev/docs/browsers, accessed 2026-09-29).

Descriptor gotcha for the unpinned route: the UA strings inside 1.63's `devices` registry claim Chrome/153 (Pixel 7 descriptor: `Chrome/153.0.8010.12`) while the real engine is 141.

## 3. WebGL2 availability by launch flags

### 3.1 Through Playwright (`t3-webgl-probe.mjs`, 2 binaries x 11 flag sets = 22 launches)

Every one of the 22 launches gave `typeof window.WebGL2RenderingContext === 'function'` and `getContext('webgl2')` non-null. This includes "defaults (no args)". Reason: Playwright 1.63.0 adds `--enable-unsafe-swiftshader` itself (`node_modules/playwright-core/lib/coreBundle.js` line 43337: `chromeArguments.push("--enable-unsafe-swiftshader");`; and `DEBUG=pw:browser` shows the flag disappears when `ignoreDefaultArgs: ['--enable-unsafe-swiftshader']` is passed). So a Playwright-only matrix cannot tell the flags apart; section 3.2 does that with raw Chromium.

Flag sets tried through Playwright: A none; B `--use-gl=angle --use-angle=swiftshader`; C `--enable-unsafe-swiftshader`; D `--ignore-gpu-blocklist`; E `--enable-webgl`; F B+C+D; G `--use-angle=swiftshader-webgl`; H `--disable-gpu`; I `--disable-gpu --enable-unsafe-swiftshader`; J `--use-gl=swiftshader`; K `--use-angle=swiftshader`. Result for all: RENDERER `WebKit WebGL`, VERSION `WebGL 2.0 (OpenGL ES 3.0 Chromium)`, MAX_TEXTURE_SIZE 8192, unmasked renderer identical, no console messages. Removing Playwright's default flag (`ignoreDefaultArgs`) and even adding `--disable-gpu` still gave WebGL2 under Playwright (`t4`), because Playwright's other defaults (see 3.2) keep it alive.

### 3.2 Raw Chromium CLI, no Playwright (`--dump-dom` of `raw/probe.html`)

| Binary + flags | webgl2 | Notes |
|---|---|---|
| full chrome `--headless=new --no-sandbox --disable-gpu` | **false** (webgl1 also false) | reproduced 3/3 runs. This is the brief's suggested form. |
| full chrome `--headless=new --no-sandbox` | true | stderr contains the SwiftShader fallback deprecation warning (1x) |
| full chrome `--headless=new --no-sandbox --enable-unsafe-swiftshader` | true | no warning |
| full chrome `--headless=new --no-sandbox --disable-gpu --enable-unsafe-swiftshader` | true | no warning |
| full chrome `--headless --no-sandbox` | true | warning 1x |
| full chrome `--headless=old` | exit 1 | "Old Headless mode has been removed from the Chrome binary. Please use the new Headless mode ... or the chrome-headless-shell" |
| headless_shell `--no-sandbox` (bare) | true | warning 2x |
| headless_shell `--no-sandbox --disable-gpu` | true | warning 2x (so `--disable-gpu` does not break the shell, only the full binary) |
| headless_shell + `--use-gl=angle --use-angle=swiftshader` | true | warning 2x (the ANGLE flags alone do not opt in) |
| headless_shell + `--enable-unsafe-swiftshader` (also with `--use-angle=swiftshader`, or with `--disable-gpu`) | true | no warning |
| headless_shell + `--ignore-gpu-blocklist` / `--enable-webgl` | true | warning 2x (neither flag matters here) |
| headless_shell + `--disable-3d-apis` or `--disable-webgl` | false | as expected |
| any binary as root without `--no-sandbox` | exit 1 | "Running as root without --no-sandbox is not supported. See https://crbug.com/638180." Playwright adds `--no-sandbox` by default, raw CLI must add it |

Bisect of the `--disable-gpu` trap on the full binary (`--headless --no-sandbox --disable-gpu` plus one extra flag): `--hide-scrollbars` false, `--mute-audio` false, `--force-color-profile=srgb` false, `--disable-field-trial-config` **true**. `--disable-field-trial-config` is in Playwright's default args, which is why Playwright + `--disable-gpu` still works but a hand-rolled command line does not. The dependency on an unrelated field-trial flag is fragile, so the recipe avoids `--disable-gpu` entirely.

The warning text is in Chromium source at the exact version (https://raw.githubusercontent.com/chromium/chromium/141.0.7390.37/gpu/command_buffer/service/gles2_cmd_decoder_passthrough.cc, accessed 2026-09-29, lines ~1091-1100): "// Deprecation warning for SwiftShader WebGL fallback ... `Automatic fallback to software WebGL has been deprecated. Please use the --enable-unsafe-swiftshader (about:flags#enable-unsafe-swiftshader) flag to opt in to lower security guarantees for trusted content.`" The condition is `feature_info_->IsWebGLContext() && ANGLE implementation == kSwiftShader && !HasSwitch(kEnableUnsafeSwiftShader)`. Consequence: the automatic fallback still works in 141 but is announced as deprecated, so an explicit `--enable-unsafe-swiftshader` is the future-proof choice. Only use it for trusted content (our own pages), as the message says. The date on which the automatic fallback is removed was not found (unverified).

### 3.3 What the software WebGL2 context reports (`raw-t3-webgl-probe.json`, identical for every flag set except where noted)

| Query | Value |
|---|---|
| `getParameter(RENDERER)` / `VENDOR` | `WebKit WebGL` / `WebKit` (masked strings) |
| `getParameter(VERSION)` | `WebGL 2.0 (OpenGL ES 3.0 Chromium)` |
| `getParameter(SHADING_LANGUAGE_VERSION)` | `WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)` |
| `WEBGL_debug_renderer_info` UNMASKED_RENDERER | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` |
| UNMASKED_VENDOR | `Google Inc. (Google)` |
| MAX_TEXTURE_SIZE / MAX_RENDERBUFFER_SIZE | 8192 / 8192 |
| MAX_SAMPLES / MAX_DRAW_BUFFERS | 4 / 6 |
| MAX_TEXTURE_IMAGE_UNITS / MAX_VERTEX_TEXTURE_IMAGE_UNITS | 32 / 32 |
| default context attributes | alpha true, antialias true, depth true, stencil false, preserveDrawingBuffer false, powerPreference default, failIfMajorPerformanceCaveat false |
| `EXT_color_buffer_float` | present |
| `OES_texture_float_linear` | present |
| `EXT_color_buffer_half_float`, `EXT_float_blend`, `EXT_texture_filter_anisotropic`, `WEBGL_compressed_texture_s3tc`, `WEBGL_lose_context` | present |
| `OES_texture_half_float_linear`, `KHR_parallel_shader_compile` | not listed by `getSupportedExtensions()` |
| `OES_standard_derivatives` | not listed, expected: MDN says it "is only available to WebGL1 contexts. In WebGL2, the functionality of this extension is available on the WebGL2 context by default." (https://developer.mozilla.org/en-US/docs/Web/API/OES_standard_derivatives, accessed 2026-09-29). `fwidth` worked in the shader. |
| `EXT_disjoint_timer_query_webgl2` | not listed by default; listed (30 extensions instead of 29) when `--use-angle=swiftshader` is passed explicitly. Timer queries on SwiftShader would not measure a GPU anyway. |
| `EXT_color_buffer_float` (MDN) | "This extension is available to WebGL 2 contexts only." (https://developer.mozilla.org/en-US/docs/Web/API/EXT_color_buffer_float, accessed 2026-09-29) |
| total extensions | 29 (30 with explicit `--use-angle=swiftshader`) |
| `OffscreenCanvas` `getContext('webgl2')` | works |
| `WEBGL_lose_context.loseContext()` then `isContextLost()` | true, so context-loss handling can be tested here |
| `navigator.gpu` | exists, but `requestAdapter()` resolves `null`; CDP feature status `webgpu: disabled_off`. No WebGPU testing possible. |
| CDP `SystemInfo.getInfo().gpu.featureStatus` | `webgl: unavailable_software`, `webgl2: unavailable_software`, `gpu_compositing: disabled_software`, `rasterization: disabled_software`, `2d_canvas: unavailable_software`, `vulkan: disabled_off`, `webgpu: disabled_off` |

### 3.4 GL flags change pixels

Same frozen page, same viewport: Playwright defaults hash `4879aa30c1761f02`; `--use-gl=angle --use-angle=swiftshader` (or `--use-angle=swiftshader` alone, or the B+C+D combination) hash `414a3d811f4b9639`. Difference: 1058 of 1,024,000 pixels (0.103%), max channel delta 45/255, only 3 pixels over 32 levels (`t13`). `--ignore-gpu-blocklist` and `--enable-unsafe-swiftshader` leave the hash unchanged. Consequence: with `threshold: 0`, baselines are only valid for the exact flag set that created them.

## 4. Shader scene and screenshots

Files: `app/index.html`, `app/main.js`, served by `serve.mjs` (dependency-free static server) with three from `node_modules/three/build/three.module.js` through an import map. Scene: `OrthographicCamera`, one `PlaneGeometry(2,2)`, `THREE.ShaderMaterial` with `uTime`, `uDpr`, `uCss`, `uSeed`, `uState`. Fragment shader: `vec2 css = gl_FragCoord.xy / uDpr;`, an `isoLine()` helper built on `fwidth()` for constant-width anti-aliased lines, and three layers: (1) 45-degree hatch at 7 CSS px pitch inside a wobbling body, (2) 4-octave value-noise contour lines across the canvas, (3) concentric outline rings (16 CSS px pitch, 1.5 CSS px wide) around the body; state `alert` switches ring colour to amber and raises wobble amplitude.

Screenshots (all viewed with the Read tool; every one shows the full line pattern, HUD text and button):

| File in `shots/` | Pixel size | Viewport / DPR | Rendered OK |
|---|---|---|---|
| `desktop-1280x800-dpr1.png` | 1280x800 | 1280x800 @1 | yes |
| `desktop-1280x800-dpr2.png` | 2560x1600 | 1280x800 @2 | yes |
| `mobile-390x844-dpr1.png` | 390x844 | 390x844 @1 | yes |
| `mobile-390x844-dpr2.png` | 780x1688 | 390x844 @2 | yes |
| `desktop-1280x800-dpr1-alert.png`, `...-asleep.png` | 1280x800 | state hooks | yes (amber rings in alert) |
| `pixel7-emulated-412x839-dpr2.625-idle.png` | 1082x2202 | Pixel 7 descriptor | yes (fractional DPR 2.625: 412*2.625 = 1081.5 rounds to 1082) |
| `iphone13-emulated-390x664-dpr3-idle.png` | 1170x1992 | iPhone 13 descriptor on Chromium | yes |

DPR independence of `gl_FragCoord / uDpr` (`t11`): after 2x2 box-downsampling the DPR2 screenshot, mean absolute difference against the DPR1 screenshot is 1.31/255 (desktop) and 1.17/255 (mobile); pixels differing by more than 32 levels are 0.11% and 0.23%; more than 96 levels: 0.00%. Line widths and pitches expressed in CSS px therefore hold across DPR, and `fwidth`-based AA works. GLSL source facts: `gl_FragCoord` and `fwidth` are standard ES 3.00 built-ins; the Khronos reference pages (registry.khronos.org/OpenGL-Refpages/es3.0) answered HTTP 403 / a Cloudflare bot challenge to both curl and headless Chromium and were not worked around, so the semantics were verified empirically above rather than from Khronos text.

## 5. Frame time under software rendering (NOT representative of real GPUs)

Method (`t6`, `t6b`): 120 `requestAnimationFrame` deltas with the app's own free-running loop; plus 55 (`t6`) or 35 (`t6b`) iterations of on-demand `renderNow()` followed by a 1-pixel `gl.readPixels` (forces the software rasteriser to finish). Three rounds, full chrome, load average recorded. Machine was shared and busy (load average 8.9-13.6 on 4 vCPUs), so these are pessimistic and noisy.

| Viewport@DPR | Drawing-buffer pixels | rAF delta median, ms (range over 3 rounds) | rAF p95, ms | render+readPixels median, ms | Best single synced frame, ms | ns per pixel at best frame | load avg (1 min) |
|---|---|---|---|---|---|---|---|
| 390x844@1 | 329,160 | 16.7 | 16.7-33.4 | 15.7-31.1 | 12.5 | 38 | 9.4-10.5 |
| 1280x800@1 | 1,024,000 | 50-83.4 | 116.6-183.3 | 43.7-151.9 | 37.9 | 37 | 9.2-13.6 |
| 390x844@2 | 1,316,640 | 50-66.7 | 66.7-150 | 62.7-113.5 | 51.5 | 39 | 8.9-9.9 |
| 1280x800@2 | 4,096,000 | 150.1-216.7 | 233.3-400 | 211.8-321.3 | 152 | 37 | 9.2-12.4 |

First run (`t6`, both binaries, load average ~9.7): full-chrome rAF medians 33.4 / 416.7 / 16.7 / 50 ms and headless_shell 83.3 / 250.1 / 16.7 / 66.6 ms for the four rows in the order 1280x800@1, 1280x800@2, 390x844@1, 390x844@2; one round of 1280x800@2 hit a 1350 ms rAF gap.

Reading: cost is linear in drawing-buffer pixels (about 37-39 ns/pixel for this 4-octave-noise + atan + 3-layer shader at the best observed frame). rAF deltas quantise to multiples of 16.7 ms (60 Hz compositor tick). Honest statement for the plan: this measures a CPU rasteriser (SwiftShader) sharing four cores with other jobs. It says nothing about frame rate, power, or thermal behaviour on a phone GPU or a laptop iGPU. Its only valid uses are (a) "free-running full-screen shader at DPR2 is unusable in CI, so tests must render on demand", and (b) a very rough relative cost model (pixels x shader ALU). `EXT_disjoint_timer_query_webgl2` is not available by default, so GPU-side timing cannot be collected either.

## 6. Determinism for pixel-diff regression

### 6.1 Measured

| Test | Result |
|---|---|
| 5 independent browser launches x 4 viewport/DPR combos, frozen page (`?debug=states&t=1.25&seed=7`), sha256 of PNG | identical within each combo: 1280x800@1 `4879aa30c1761f02`, @2 `c40c3810fd965e2a`, 390x844@1 `99bd8ed791bcc5e8`, @2 `fb2adefb122ae8c7` (`t7`) |
| full chrome vs headless_shell, same page | identical (`4879aa30c1761f02` both). The whole 58-test suite also passes with `PW_CHROMIUM_PATH` pointing at headless_shell against baselines made with full chrome. |
| Playwright 1.56.1 (default headless shell) vs 1.63.0 + executablePath | identical (`4879aa30c1761f02`) |
| Negative control: free-running page, two screenshots 700 ms apart | differ (`973e6a32...` vs `d75f45b5...`) |
| seed 7 vs seed 8; t=1.25 vs t=1.26 | all three differ (`4879...`, `2d2d5d59...`, `65b6acd3...`), so the hooks really drive the pixels |
| Playwright Test, 58 tests (4 desktop/mobile projects x 14 tests + 2 emulated-device projects x 1), `maxDiffPixels: 0`, `threshold: 0`, `scale: 'device'`: one `--update-snapshots` run, then a compare run with 3 workers, then a compare run against the headless_shell binary (36-59 s each) | 58/58 passed each time (36-59 s) |
| `page.clock.install({time:0})`, `pauseAt(1000)` before `goto`, `runFor(2000)`, free-running page, 4 launches | NOT deterministic: 125 frames each but fake `time` 1.996/1.998/1.996/1.997 s and 3 distinct hashes (`3f4ff4a5...`, `8151d1e9...`, `21093c2b...`) (`t8b`) |
| same, but `pauseAt` after `goto` | NOT deterministic: fake time 2.819-2.903 s, 4 distinct hashes (`t8`) |
| `toHaveScreenshot` on a free-running animation | fails: "Failed to take two consecutive stable screenshots." after the 5 s timeout |

`page.clock` docs (https://playwright.dev/docs/api/class-clock, accessed 2026-09-29): `clock.install` fakes `Date, setTimeout, ..., requestAnimationFrame, cancelAnimationFrame, requestIdleCallback ... performance`; and "For best results, install the clock before navigating the page and set it to a time slightly before the intended test time." Even following that, the rAF timestamp handed to the page jittered by 1-2 ms, which moves iso-lines. So the clock is fine for logic/timers but must not be the source of truth for pixel baselines; drive the time uniform from the URL/hook instead.

### 6.2 Sensitivity of the comparator (baseline t=1.25, page rendered at another time, 1280x800@1)

| Config | Page t | Pixels flagged |
|---|---|---|
| `maxDiffPixels: 0`, default `threshold` 0.2 | 1.26 (10 ms later) | 0, TEST PASSES |
| same | 1.30 | 150 (0.01% ratio) |
| same | 1.50 | 54,732 |
| `maxDiffPixels: 0`, `threshold: 0` | 1.251 (1 ms later) | 36,425 |
| same | 1.26 | 88,256 |
| same | 1.30 | 120,845 |

Docs (https://playwright.dev/docs/api/class-pageassertions, accessed 2026-09-29): `threshold` "An acceptable perceived color difference in the YIQ color space between the same pixel in compared images, between zero (strict) and one (lax) ... Defaults to 0.2."; `scale` "When set to "css", screenshot will have a single pixel per each css pixel on the page ... Defaults to "css"."; "This function will wait until two consecutive page screenshots yield the same result, and then compare the last screenshot with the expectation."; `animations` "When set to "disabled", stops CSS animations, CSS transitions and Web Animations" (so it does nothing for a WebGL rAF loop). Measured consequences: with defaults, the DPR2 project stored 1280x800 baselines (not 2560x1600) and a 10 ms shift went unnoticed; with `scale: 'device'` the baselines are 2560x1600 / 780x1688 / 1170x1992 / 1082x2202. Recipe uses `threshold: 0` because output is byte-stable here; if baselines ever come from a different machine, loosen to a small `threshold` plus `maxDiffPixelRatio`, after measuring.

Playwright's own snapshot guidance (https://playwright.dev/docs/test-snapshots, accessed 2026-09-29): "Browser rendering can vary based on the host OS, version, settings, hardware, power source (battery vs. power adapter), headless mode, and other factors. For consistent screenshots, run tests in the same environment where the baseline screenshots were generated." DOM text in the scene is rendered with DejaVu Sans (`fc-match system-ui` -> `DejaVuSans.ttf`; `fc-list` shows 59 entries); baselines are container-specific for DOM text.

### 6.3 Deterministic hooks that worked (`?debug=states` style)

Design rules: (1) the page reads its own switches from the URL, (2) `?t=` freezes the time uniform AND stops the rAF loop (render on demand, N=3 frames, then `data-mh-ready="true"` on `<html>`), (3) all randomness comes from one seeded PRNG (mulberry32, seed from `?seed=`), (4) `?debug=states` exposes `window.__mh` with `states`, `state`, `time`, `frames`, `setState()`, `setTime()`, `renderNow()`, (5) tests wait on the `data-mh-ready` attribute plus two rAFs (`settle()`), never on timeouts, (6) production builds tree-shake or gate the hook (not tested here). Excerpts of the code that ran:

```js
// Probe scene: full-screen quad, custom ShaderMaterial, three procedural line layers.
// Deterministic hooks (only active when the URL asks for them):
//   ?t=1.25          freeze the time uniform at 1.25 s and render on demand (no rAF loop)
//   ?seed=7          seeded RNG (mulberry32) feeds the shader's uSeed
//   ?state=alert     initial creature state (idle | alert | asleep)
//   ?debug=states    expose window.__mh (setState, setTime, renderNow, frames, ready)
//   ?fail=console    deliberately console.error (negative control for the error-capture fixture)
//   ?fail=throw      deliberately throw inside rAF (negative control for pageerror)
```
```js
if (debug) {
  window.__mh = {
    info, states: STATES, get frames() { return frames; }, get time() { return time; }, get state() { return STATES[state]; },
    setState(s) { state = STATES.indexOf(s); if (frozen) renderNow(); },
    setTime(t) { time = t; if (frozen) renderNow(); },
    renderNow,
  };
}
```
```js
if (frozen) {
  // Render on demand: N identical frames so the compositor has definitely presented the pixels.
  const N = 3;
  let n = 0;
  const tick = () => { renderNow(); if (++n < N) requestAnimationFrame(tick); else document.documentElement.dataset.mhReady = 'true'; };
  requestAnimationFrame(tick);
}
```

## 7. `@axe-core/playwright`

| Check | Result |
|---|---|
| install | `@axe-core/playwright@4.13.0` + `axe-core@4.13.0` installed from npm in the same 2 s install; peer `playwright-core >= 1.0.0` |
| app page (`role="img"` canvas with `aria-label`, h1, 44 px button), tags `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa, best-practice` | 0 violations in all 4 viewport/DPR projects |
| same page, results summary | 0 violations, 29 passes (incl. `button-name`, `color-contrast` for the opaque button, `role-img-alt`, `target-size`, `page-has-heading-one`, `region`, `landmark-one-main`), 1 incomplete: `color-contrast` on `<h1>moss.dev</h1>` - "Element's background color could not be determined because element contains an image node" (the h1 sits on the WebGL canvas; `t15-axe-incomplete.mjs`). axe cannot pass or fail text over a canvas; contrast over the animated creature needs another check (solid scrim behind text, or sampled screenshot pixels). |
| control page with `<img>` without alt, empty `<button>`, light-grey-on-white text | violations `button-name, color-contrast, image-alt, page-has-heading-one` (so detection works) |
| works with no external network | yes: `unshare -n` (loopback only, DNS and `curl https://example.com` fail) - the axe tests passed. axe-core ships inside the npm package. |

Limits, from the sources: axe-core README (node_modules copy, accessed 2026-09-29): "With axe-core, you can find **on average 57% of WCAG issues automatically**. Additionally, axe-core will return elements as "incomplete" where axe-core could not be certain, and manual review is needed." Playwright docs (https://playwright.dev/docs/accessibility-testing, accessed 2026-09-29): "Automated accessibility tests can detect some common accessibility problems such as missing or invalid properties. But many accessibility problems can only be discovered through manual testing." Keyboard order, screen-reader output, reduced-motion behaviour and passkey prompts still need manual passes. (`reducedMotion: 'reduce'` and `colorScheme: 'dark'` context options do flip the media queries here: `[true, true]`.)

## 8. Console-error capture pattern

Verified behaviour (all in `tests/errors.spec.ts`, 6 negative-control tests x 4 projects pass):

| Failure class | Seen as | Notes |
|---|---|---|
| `console.error(...)` in page | `page.on('console')` type `error` | |
| uncaught exception inside rAF | `page.on('pageerror')` | message `deliberate error thrown inside rAF` |
| unhandled promise rejection | `pageerror` | |
| 404 sub-resource | `page.on('response')` status 404 AND a `console.error` "Failed to load resource: the server responded with a status of 404 (Not Found)" | |
| `/favicon.ico` 404 | ONLY a `console.error` (no `response` event); in `t5` it appeared only on the first page load of the browser process, not on later contexts, which makes it look flaky | fix: `<link rel="icon" href="data:,">` in every page |
| WebGL context creation failure (`getContext` -> null) | three.js `console.error: THREE.WebGLRenderer: Error creating WebGL context.` plus a `pageerror` | |
| SwiftShader/ANGLE perf noise | `console` type **warning**: `GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels` (3x, then "this message will no longer repeat"), emitted around `page.screenshot()` | do not fail on warnings blindly; allow-list this one |

Newer Playwright also has retrospective getters: release notes 1.56 "New methods page.consoleMessages() and page.pageErrors() for retrieving the most recent console messages from the page" (https://playwright.dev/docs/release-notes, accessed 2026-09-29); the listener-based fixture below works on any version.

## 9. Mobile emulation

| Check | Result |
|---|---|
| `devices` registry offline | 207 descriptors bundled inside `playwright-core` (`coreBundle.js`); no network needed. Tests with `iPhone 13` and `Pixel 7` descriptors passed inside an empty network namespace. |
| `devices['iPhone 13']` | viewport 390x664 (not 844), DPR 3, isMobile, hasTouch, `defaultBrowserType: 'webkit'`, UA `iPhone; CPU iPhone OS 15_0 ... Version/26.6 Mobile/15E148 Safari/604.1` |
| `devices['Pixel 7']` | viewport 412x839, DPR 2.625, `defaultBrowserType: 'chromium'`, UA `Chrome/153.0.8010.12` (descriptor, not the real 141 engine) |
| `devices['iPad Pro 11']`, `['Galaxy S9+']` | webkit / chromium defaults; 834x1194@2, 320x658@4.5 |
| descriptor project WITHOUT `browserName: 'chromium'` | tries WebKit: `Executable doesn't exist at /opt/pw-browsers/webkit-2359/pw_run.sh`. With `executablePath` also set, Playwright starts the Chromium binary with WebKit's arguments and dies: "Running as root without --no-sandbox is not supported". So descriptor projects must set `browserName: 'chromium'` (emulation of iPhone on Chromium only). |
| in-page effects | `isMobile`, `hasTouch`, `navigator.maxTouchPoints` 1, `'ontouchstart' in window` true, `matchMedia('(pointer: coarse)')` and `(hover: none)` true, `visualViewport.scale` 1, `locator.tap()` works, `devicePixelRatio` equals descriptor |
| what it is | Playwright docs: descriptors "simulate browser behavior for a specific device such as user agent, screen size, viewport and if it has touch enabled" (https://playwright.dev/docs/emulation, accessed 2026-09-29). It is Chromium with a different UA/viewport, not the device's engine. |

WebKit facts from the docs (https://playwright.dev/docs/browsers, accessed 2026-09-29): "Playwright doesn't work with the branded version of Safari since it relies on patches." and "for the closest-to-Safari experience you should run WebKit on mac". Neither is possible in this container (no WebKit installed, Linux).

## 10. Recipe (code that ran)

Install and run in this container:

```bash
npm i -D @playwright/test@latest @axe-core/playwright three   # no browser download
export PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome   # or .../chromium_headless_shell-1194/chrome-linux/headless_shell
npx playwright test                       # compare
npx playwright test --update-snapshots    # (re)create baselines, then review the PNGs by eye
# alternative with zero executablePath: npm i -D @playwright/test@1.56.1   (its browsers.json is build 1194)
```

`playwright.config.ts`:
```ts
import { defineConfig, devices } from '@playwright/test';

// PW_CHROMIUM_PATH lets this container use its preinstalled Chromium 141 (build 1194) with any Playwright version.
// In CI where `npx playwright install chromium` has run, leave it unset.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: true,
  workers: Number(process.env.PW_WORKERS ?? 2),
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'raw-pw-report.json' }]],
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',
  expect: {
    toHaveScreenshot: { maxDiffPixels: 0, threshold: 0, scale: 'device', animations: 'disabled', caret: 'hide' },
  },
  webServer: {
    command: 'node serve.mjs . 4173',
    url: 'http://127.0.0.1:4173/app/index.html',
    reuseExistingServer: true,
    timeout: 15_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    launchOptions: {
      executablePath,
      // Playwright already adds --enable-unsafe-swiftshader on Linux; repeating it is harmless and survives changes to the defaults.
      // Do NOT add --disable-gpu (see dossier: without --disable-field-trial-config it removes WebGL entirely).
      args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [
    { name: 'desktop-dpr1', testIgnore: /devices\.spec\.ts/, use: { browserName: 'chromium', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
    { name: 'desktop-dpr2', testIgnore: /devices\.spec\.ts/, use: { browserName: 'chromium', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 } },
    { name: 'mobile-dpr1',  testIgnore: /devices\.spec\.ts/, use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } },
    { name: 'mobile-dpr2',  testIgnore: /devices\.spec\.ts/, use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 } },
    // Descriptor-based emulation: the descriptor says defaultBrowserType 'webkit', so browserName MUST be overridden.
    { name: 'iphone13-emulated-on-chromium', testMatch: /devices\.spec\.ts/, use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'pixel7-emulated-on-chromium',   testMatch: /devices\.spec\.ts/, use: { ...devices['Pixel 7'],   browserName: 'chromium' } },
  ],
});
```

`tests/fixtures.ts` (error guard + settle helpers):
```ts
import { test as base, expect, type Page } from '@playwright/test';

// Warnings that SwiftShader / ANGLE print on every readback; they are not app bugs.
const IGNORED_WARNINGS = [/GPU stall due to ReadPixels/];

type Opts = { allowErrors: boolean };
type Fx = { problems: string[]; errorGuard: void };

export const test = base.extend<Fx & Opts>({
  allowErrors: [false, { option: true }],           // only the negative controls set this to true
  problems: async ({ page }, use) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      const loc = m.location();
      if (m.type() === 'error') problems.push(`console.error: ${m.text()} (${loc.url}:${loc.lineNumber})`);
      if (m.type() === 'warning' && !IGNORED_WARNINGS.some((r) => r.test(m.text()))) problems.push(`console.warning: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));           // uncaught exceptions + unhandled rejections
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
    await use(problems);
  },
  // auto: true => applies to every test without being requested. Fails the test at teardown if anything was collected.
  errorGuard: [async ({ problems, allowErrors }, use) => {
    await use();
    if (!allowErrors) expect(problems, 'browser console/page errors').toEqual([]);
  }, { auto: true }],
});
export { expect };

// Wait until the app says it has rendered its frames, then let the compositor present two more frames.
export async function gotoReady(page: Page, query: string) {
  await page.goto(`/app/index.html?${query}`);
  await page.waitForSelector('html[data-mh-ready="true"]');
  await settle(page);
}
export async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}
```

`tests/webgl.spec.ts`:
```ts
import { test, expect, gotoReady, settle } from './fixtures.ts';

const Q = 'debug=states&t=1.25&seed=7';

test('WebGL2 is available and reports the software renderer', async ({ page }) => {
  await gotoReady(page, Q);
  const info = await page.evaluate(() => (window as any).__mhInfo);
  expect(info.isWebGL2).toBe(true);
  expect(info.version).toContain('WebGL 2.0');
  expect(info.extColorBufferFloat).toBe(true);
  expect(info.oesTextureFloatLinear).toBe(true);
  expect(info.unmasked).toMatch(/SwiftShader/);   // tells the test log which renderer produced the baselines
  test.info().annotations.push({ type: 'renderer', description: info.unmasked });
});

for (const state of ['idle', 'alert', 'asleep']) {
  test(`creature state: ${state}`, async ({ page }) => {
    await gotoReady(page, `${Q}&state=${state}`);
    await expect(page).toHaveScreenshot(`creature-${state}.png`);
  });
}

test('state switch through the debug hook is deterministic', async ({ page }) => {
  await gotoReady(page, Q);
  const before = (await page.evaluate(() => (window as any).__mh.frames)) as number;
  await page.evaluate(() => (window as any).__mh.setState('alert'));
  await settle(page);
  expect(await page.evaluate(() => (window as any).__mh.frames)).toBeGreaterThan(before);
  await expect(page).toHaveScreenshot('creature-alert-via-hook.png');
});

test('button click cycles state (touch/click path)', async ({ page }) => {
  await gotoReady(page, Q);
  await page.getByRole('button', { name: 'Cycle state' }).click();
  await settle(page);
  expect(await page.evaluate(() => (window as any).__mh.state)).toBe('alert');
});
```

`tests/a11y.spec.ts`:
```ts
import AxeBuilder from '@axe-core/playwright';
import { test, expect, gotoReady } from './fixtures.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

test('app page has no axe violations', async ({ page }) => {
  await gotoReady(page, 'debug=states&t=1.25&seed=7');
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  test.info().annotations.push({ type: 'axe', description: `axe-core ${r.testEngine.version}; passes=${r.passes.length} violations=${r.violations.length} incomplete=${r.incomplete.length}` });
  console.log('AXE incomplete:', JSON.stringify(r.incomplete.map((i) => ({ id: i.id, nodes: i.nodes.length, msg: i.nodes[0]?.any[0]?.message }))));
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test('axe detects deliberate violations (control)', async ({ page }) => {
  await page.goto('/app/bad-a11y.html');
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const ids = r.violations.map((v) => v.id);
  console.log('AXE control violations:', ids.join(','));
  expect(ids).toEqual(expect.arrayContaining(['image-alt', 'button-name', 'color-contrast']));
});
```

`tests/devices.spec.ts` (run only by the two descriptor projects): asserts `isMobile`, `hasTouch`, `devicePixelRatio === deviceScaleFactor`, `matchMedia('(pointer: coarse)')`, `(hover: none)`, takes a `toHaveScreenshot`, then `tap()`s the button and checks state through `window.__mh`.

Fragment-shader helper that made DPR-independent constant-width lines (used unchanged in the tests above):
```glsl

```

Rules distilled from the measurements:

1. Do not pass `--disable-gpu`. Pass `--enable-unsafe-swiftshader` (already a Playwright 1.63 default on Linux; repeating it is harmless).
2. Pin the GL flag set and the Chromium build together with the baselines; changing `--use-angle` changes 0.1% of pixels, a new Chromium major is untested here.
3. `toHaveScreenshot`: `threshold: 0`, `maxDiffPixels: 0`, `scale: 'device'` (defaults are `0.2` and `"css"`).
4. Never screenshot a free-running loop: freeze time with `?t=`, seed with `?seed=`, render on demand, wait for `data-mh-ready` plus two rAFs.
5. Add a data-URI favicon so `console.error` guards do not trip on `/favicon.ico`.
6. Descriptor projects need `browserName: 'chromium'`; set the viewport explicitly if you want 390x844 (the iPhone 13 descriptor is 390x664).
7. Keep a CI-only note: baselines generated in this container are SwiftShader/DejaVu baselines; regenerate them in the CI image where they will be compared.

## 11. Things measured that the plan can rely on, in one place

| Statement | Basis |
|---|---|
| WebGL2 works in CI-style headless Chromium with software rendering | 22-launch matrix, raw CLI matrix, 58 passing tests |
| `EXT_color_buffer_float` and `OES_texture_float_linear` exist in this environment | probe; three.js reported them in `__mhInfo` |
| `fwidth`/derivatives, `gl_FragCoord / dpr`, 3-layer line shader compile and render | screenshots viewed |
| Byte-stable screenshots are possible with the hooks in 6.3 | hashes in 6.1 |
| `@axe-core/playwright` runs and detects real violations; canvas-backed text is "incomplete" | section 7 |
| Console/pageerror guard catches 6 classes of failure | section 8 |
| Device descriptors work offline but emulate only viewport/UA/touch | section 9 |

## 12. What CANNOT be verified in this container (state this plainly in the plan)

| # | Not verifiable | Why | What to do instead |
|---|---|---|---|
| 1 | Real-device GPU behaviour: frame rate, fill-rate, overdraw cost, shader precision (mediump vs highp on phone GPUs), derivative (`fwidth`) accuracy differences between GPUs, driver bugs, MSAA quality, real `MAX_TEXTURE_SIZE`/`MAX_SAMPLES` limits | the only "GPU" is SwiftShader on 4 shared CPU cores (`SystemInfo`: `webgl2: unavailable_software`, no `/dev/dri`); it computes in fp32 | named test phones/laptops, manual pass, or a real-device cloud (unverified here) |
| 2 | Thermal throttling, battery drain, sustained-load behaviour, low-power modes | no thermal or power model; frame times here are dominated by other jobs (load average 9-13) | soak test on a real phone; log frame times over minutes |
| 3 | Safari / iOS WebGL: WebKit's WebGL implementation, iOS memory limits and context loss, Safari-specific canvas/DPR/viewport behaviour | no WebKit installed (`/opt/pw-browsers/webkit-2359/pw_run.sh` does not exist); and per Playwright "Playwright doesn't work with the branded version of Safari" and Linux WebKit is not the closest-to-Safari option | real iPhone + Safari checklist; `WEBGL_lose_context` simulation here covers only the app's handler logic, not iOS's real triggers |
| 4 | Firefox WebGL | no Firefox installed | CI with `playwright install firefox` |
| 5 | Touch feel: scroll physics, gesture latency, multi-touch, haptics, on-screen keyboard resizing, 300 ms/long-press behaviour, hover-less affordances | `tap()` is a synthetic event; `isMobile`/`hasTouch` flip flags and media queries only | hand-test on devices |
| 6 | Audio output | no `/dev/snd`; Playwright passes `--mute-audio` in headless; `new AudioContext()` reports `state: running`, `baseLatency 0.01`, `outputLatency 0` with no device. Graph logic and autoplay-policy state can be tested, not sound, latency or loudness | manual listening on devices |
| 7 | WebGPU | `navigator.gpu.requestAdapter()` is `null`; `webgpu: disabled_off` | if a WebGPU path is ever added, it needs real hardware |
| 8 | Platform passkey UI and biometric prompts | not exercised in this measure (a virtual authenticator was not tried) | separate WebAuthn research/testing |
| 9 | Pixel identity across machines or across Chromium versions | verified only inside this VM, one CPU model, Chromium 141; GL flags alone move 0.1% of pixels (3.4) | generate and compare baselines in the same CI image; pin the Chromium build |
| 10 | Production browser versions: Playwright 1.63 targets Chromium 153, this container has 141 | only build 1194 is present; `playwright install` is not allowed | run the same suite in CI with Playwright's bundled builds |
| 11 | Fonts / text rasterisation / colour management on real displays (wide gamut, ClearType/CoreText) | container `fc-list` has 59 entries, `system-ui` resolves to DejaVu Sans; Playwright passes `--force-color-profile=srgb` | visual review on devices |
| 12 | Timing/perf budgets (LCP/INP/TBT) | CPU-rasterised and contended | Lighthouse/RUM on real hardware (not measured) |

## 13. Gaps in this research itself

- The WebSearch tool's session budget was exhausted (200/200) before this task's searches could run, so no source was found by search; every URL above was fetched directly from a known primary-source host (playwright.dev, developer.mozilla.org, raw.githubusercontent.com/chromium, registry.npmjs.org via `npm`). No snippet was used as evidence.
- Khronos GLSL ES reference pages: HTTP 403 (curl) and a Cloudflare "Just a moment" challenge (headless Chromium). This is site bot protection, not an egress-policy rejection (`__agentproxy/status` shows no `connect_rejected` for the host). Not bypassed; semantics were verified empirically.
- `chromium.googlesource.com` answered 503, so the Chromium source was read from the `chromium/chromium` GitHub mirror at the same tag `141.0.7390.37`.
- Removal date of Chrome's automatic SwiftShader fallback: not found (unverified).
- Frame-time numbers were taken under load average 9-13 on 4 vCPUs; ranges rather than single values are given.
- Only one Chromium build (141.0.7390.37) exists here, so nothing was learned about behaviour differences in newer Chromium.
- The raw-CLI matrix used `--dump-dom` (full navigation to a `file://` page); the Playwright matrix used `about:blank`. Both agree on availability.
- The virtual-authenticator/WebAuthn path, `page.consoleMessages()`, and Lighthouse were not run.

## 14. Source list (all accessed 2026-09-29)

| Source | Used for | Quote |
|---|---|---|
| https://playwright.dev/docs/api/class-pageassertions | toHaveScreenshot options | "Defaults to "css"." (scale); "Defaults to 0.2." (threshold); "This function will wait until two consecutive page screenshots yield the same result" |
| https://playwright.dev/docs/test-snapshots | environment sensitivity | "For consistent screenshots, run tests in the same environment where the baseline screenshots were generated." |
| https://playwright.dev/docs/browsers | headless shell vs new headless, WebKit vs Safari, browsers path | "Playwright ships a regular Chromium build for headed operations and a separate chromium headless shell for headless mode."; "Playwright doesn't work with the branded version of Safari since it relies on patches." |
| https://playwright.dev/docs/api/class-browsertype | executablePath warning | "There is no guarantee it will work with any other version. Use executablePath option with extreme caution." |
| https://playwright.dev/docs/emulation | device registry | "Playwright comes with a registry of device parameters using playwright.devices" |
| https://playwright.dev/docs/api/class-clock | page.clock | "For best results, install the clock before navigating the page ..." |
| https://playwright.dev/docs/accessibility-testing | axe limits | "many accessibility problems can only be discovered through manual testing" |
| https://playwright.dev/docs/release-notes | Chromium per Playwright version, new console getters | "Version 1.56 ... Chromium 141.0.7390.37"; "Version 1.63 ... Chromium 153.0.8010.12" |
| https://raw.githubusercontent.com/chromium/chromium/141.0.7390.37/gpu/command_buffer/service/gles2_cmd_decoder_passthrough.cc | SwiftShader fallback deprecation | "Automatic fallback to software WebGL has been deprecated. Please use the --enable-unsafe-swiftshader ..." |
| https://developer.mozilla.org/en-US/docs/Web/API/OES_standard_derivatives | derivatives in WebGL2 | "In WebGL2, the functionality of this extension is available on the WebGL2 context by default." |
| https://developer.mozilla.org/en-US/docs/Web/API/EXT_color_buffer_float | float render targets | "This extension is available to WebGL 2 contexts only." |
| https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio | DPR meaning | "the ratio of the resolution in physical pixels to the resolution in CSS pixels" |
| npm registry (`npm view`, `npm pack`) | package versions, browsers.json per version | see section 1 |
| local: `node_modules/playwright-core/lib/coreBundle.js` line 43337 | Playwright default swiftshader flag | `chromeArguments.push("--enable-unsafe-swiftshader");` |
| local: `node_modules/axe-core/README.md` line 19 | axe coverage | "on average 57% of WCAG issues automatically" |

## 15. Artifact index

- Scenario app: `scratch-pw/app/index.html`, `app/main.js`, `app/bad-a11y.html`; server `scratch-pw/serve.mjs`.
- Test suite: `scratch-pw/playwright.config.ts`, `scratch-pw/tests/*.spec.ts`, `tests/fixtures.ts`, baselines in `tests/__screenshots__/`.
- Measurement scripts and raw output: `scratch-pw/t1..t14*.mjs`, `raw-t3-webgl-probe.json`, `raw-t6-frametime.json`, `raw-t6b-frametime.json`, `raw-t7-determinism.txt`, `raw-t8-clock.txt`, `raw-t8b-clock.txt`, `raw-pw-report.json`.
- Docs fetched: `scratch-pw/docs/*.txt`, Chromium source `docs/gles2_cmd_decoder_passthrough.cc`.
- Screenshots: `scratch-pw/shots/*.png`.
