# tech-npm-versions: JS/TS toolchain versions and compatibility for Mosshatch Phase 1

Research date: 2026-09-29 (all "accessed" dates below are 2026-09-29). Analyst: subagent, live-verified. Registry data via `npm view` (npm 10.9.7, Node v22.22.2, registry https://registry.npmjs.org/). Scratch projects are under `working-directory/research/` (`scratch-npm`, `scratch-smoke`, `scratch-override`). Nothing under /home/user/MossHatch was touched.

## TL;DR

1. Every requested package resolves; no `latest` manifest is flagged deprecated. Installing all 35 requested packages plus @types/react-dom and @types/node together (494 packages resolved) gave zero ERESOLVE errors and zero peer-conflict warnings on npm 10.9.7.
2. Versions moved a lot: TypeScript 7.0.2 (native compiler, no stable JS API), Vite 8.3.1 (Rolldown/Oxc), @vitejs/plugin-react 6.1.1 (peer `vite ^8` only), Vitest 5.0.2, ESLint 10.11.0, Stripe 22.6.2, @simplewebauthn 14.x, zod 4.6.5, React 19.3.0, three 0.186.1. MCP SDK v2 is GA as split packages (`@modelcontextprotocol/server` 2.2.0); `@modelcontextprotocol/sdk` 1.31.0 is now the legacy line.
3. Node: use 24.x (Vercel default; Active LTS until 2026-10-20, Maintenance to 2028-04-30). Node 20 is EOL (2026-04-30) and Vercel disables it for new deployments on 2026-10-01. Vercel Functions list 24.x/22.x/20.x only; Node 26 (Current, LTS 2026-10-28) is Sandbox-only. Combined engine floor of the toolset is Node >=22.19 (size-limit 14); Node 20 fails for vitest 5, commander 15, @google-cloud/kms 6, size-limit 14.
4. `typescript-eslint` 8.71.0 peers `typescript >=4.8.4 <6.1.0`, so TS 7 must be installed via Microsoft's documented alias (`typescript` -> `@typescript/typescript6`, `@typescript/native` -> `typescript@^7`). Tested: `tsc` 7.0.2, `tsc6`, typescript-eslint, Vite build, Vitest, drizzle-kit generate all pass.
5. `npm audit` on the all-latest set: 9 vulnerable packages (6 moderate, 3 high; 17 distinct advisories), all dev-only (`--omit=dev` = 0). Sources: `@vercel/node` 16.0.2 (hard-pins undici 5.28.4, path-to-regexp 6.1.0, ajv 8.6.3) and `drizzle-kit` 0.31.11 (`@esbuild-kit/*` -> esbuild 0.18.20). Recommended: do not install `@vercel/node` (fetch handlers need no types package); add an npm `overrides` for esbuild-kit's esbuild (tested: 0 vulnerabilities, `drizzle-kit generate` still works).
6. Security floors: drizzle-orm >=0.45.2 (CVE-2026-39356, high SQL injection), @simplewebauthn/server >=14.0.2, Vite >=8.0.16, MCP SDK v1 >=1.26.0, esbuild >=0.28.1.
7. Stripe minor releases change the pinned API version (22.6.0 pins `2026-08-26.dahlia`): pin `~22.6.2` and pass `apiVersion` explicitly.
8. Drizzle: npm `latest` is 0.45.3; the docs site now shows `drizzle-orm@rc` (1.0.0-rc.4, 2026-06-27, no stable 1.0.0). Neon driver 1.1.0 is compatible (peer `>=0.10.0`).
9. Unverified: live DB/Stripe/Resend/KMS/WebAuthn calls, Node 24/26 runtime execution (only Node 20.20.2 and 22.22.2 available locally), whether Vercel has since enabled Node 26 for Functions. See section 9.

## 1. Method and sources

- Registry facts: `npm view <pkg> --json` for 42 packages (35 requested + 7 helpers), raw JSON saved in `research/npmview/`. "Latest stable" = the `latest` dist-tag; "published" = `time[<version>]`; "previous major line" = highest stable release of the previous major (for 0.x packages: previous minor).
- Node schedule: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json, https://nodejs.org/en/about/previous-releases, https://endoflife.date/api/nodejs.json.
- Vercel: https://vercel.com/docs/functions/runtimes/node-js/node-js-versions (+ `.md` twin), Vercel changelog posts (URLs inline).
- Installs: `scratch-npm` (all 35 at latest, clean `npm install`, no flags), `scratch-smoke` (recommended pins + smoke code), `scratch-override` (override experiment). Logs: `research/install-runtime.log`, `install-dev.log`, `install-clean.log`, `install-smoke.log`, `npm-audit.json`, `npm-audit-smoke.json`, `npm-bulk-advisories.json`.
- Egress: no host I used was rejected by the proxy. `api.github.com` answered 403 ("GitHub access to this repository is not enabled for this session") and `github.com/advisories/...` answered 403, so GitHub release notes were read from `raw.githubusercontent.com` CHANGELOG files instead.
- Side note: I printed the shell environment once by accident while grepping for `CLAUDE*`; nothing from it is recorded here.

## 2. Version table (registry, accessed 2026-09-29)

Source for every row: `https://registry.npmjs.org/<package>` via `npm view <package> --json` (fields `dist-tags.latest`, `time`, `engines`, `peerDependencies`, `peerDependenciesMeta`, `license`, `deprecated`). Seven helper packages that the plan implies are appended at the bottom (`@types/react-dom`, `@types/node`, `typescript-eslint`, `@typescript/typescript6`, `@size-limit/file`, `@modelcontextprotocol/server`, `@modelcontextprotocol/client`).

| Package | Latest stable (`latest` tag) | Published (UTC) | Registry `time.modified` | Previous major line: latest release (date) | engines.node | Required peers | Optional peers | License | Deprecated |
|---|---|---|---|---|---|---|---|---|---|
| `three` | 0.186.1 | 2026-09-24 14:42 | 2026-09-24 14:42 | 0.185.1 (2026-07-01) [prev minor; 0.x] | `none declared` | - | - | MIT | none |
| `@types/three` | 0.186.0 | 2026-09-11 18:07 | 2026-09-11 18:07 | 0.185.4 (2026-08-04) [prev minor; 0.x] | `none declared` | - | - | MIT | none |
| `vite` | 8.3.1 | 2026-09-24 12:26 | 2026-09-24 12:26 | 7.3.6 (2026-06-25) | `^20.19.0 \|\| >=22.12.0` | - | 12 optional (esbuild `^0.27.0 \|\| ^0.28.0`, tsx, jiti, sass, less, terser, ...) | MIT | none |
| `@vitejs/plugin-react` | 6.1.1 | 2026-08-28 03:30 | 2026-08-28 03:30 | 5.2.0 (2026-03-12) | `^20.19.0 \|\| >=22.12.0` | vite `^8.0.0` | oxc-transform-react, @rolldown/plugin-babel, babel-plugin-react-compiler | MIT | none |
| `react` | 19.3.0 | 2026-09-09 17:21 | 2026-09-29 16:44 | 18.3.1 (2024-04-26) | `>=0.10.0` | - | - | MIT | none |
| `react-dom` | 19.3.0 | 2026-09-09 17:17 | 2026-09-29 16:42 | 18.3.1 (2024-04-26) | `none declared` | react `^19.3.0` | - | MIT | none |
| `@types/react` | 19.3.0 | 2026-09-09 18:08 | 2026-09-09 18:08 | 18.3.31 (2026-06-05) | `none declared` | - | - | MIT | none |
| `typescript` | 7.0.2 | 2026-07-08 15:55 | 2026-09-29 08:36 | 6.0.3 (2026-04-16) | `>=16.20.0` | - | - | Apache-2.0 | none |
| `zustand` | 5.0.15 | 2026-08-13 00:39 | 2026-08-13 00:39 | 4.5.7 (2025-05-15) | `>=12.20.0` | - | immer, react, @types/react, use-sync-external-store | MIT | none |
| `drizzle-orm` | 0.45.3 | 2026-09-21 10:06 | 2026-09-21 10:06 | 0.44.7 (2025-10-23) [prev minor; 0.x] | `none declared` | - | 29 optional (incl. `@neondatabase/serverless` >=0.10.0, `pg` >=8, `postgres` >=3) | Apache-2.0 | none |
| `drizzle-kit` | 0.31.11 | 2026-09-21 10:06 | 2026-09-21 10:06 | 0.30.6 (2025-03-27) [prev minor; 0.x] | `none declared` | - | - | MIT | none |
| `@neondatabase/serverless` | 1.1.0 | 2026-04-17 14:01 | 2026-04-17 14:01 | 0.10.4 (2024-11-25) | `>=19.0.0` | - | - | MIT | none |
| `@simplewebauthn/server` | 14.0.3 | 2026-09-25 17:10 | 2026-09-25 17:10 | 13.3.3 (2026-08-26) | `>=20.0.0` | - | - | MIT | none |
| `@simplewebauthn/browser` | 14.0.0 | 2026-09-02 05:49 | 2026-09-02 05:49 | 13.3.0 (2026-03-10) | `none declared` | - | - | MIT | none |
| `stripe` | 22.6.2 | 2026-09-09 21:17 | 2026-09-23 23:20 | 21.0.1 (2026-03-26) | `>=18` | - | @types/node | MIT | none |
| `resend` | 6.31.0 | 2026-09-29 18:33 | 2026-09-29 18:33 | 5.0.0 (2025-08-06) | `>=20` | - | @react-email/render | MIT | none |
| `@modelcontextprotocol/sdk` | 1.31.0 | 2026-09-28 18:59 | 2026-09-28 18:59 | 0.7.0 (2024-11-20); v2 is a different package (see below) | `>=18` | zod `^3.25 \|\| ^4.0` | @cfworker/json-schema | MIT | none |
| `zod` | 4.6.5 | 2026-09-13 23:25 | 2026-09-25 10:23 | 3.25.76 (2025-07-08) | `none declared` | - | - | MIT | none |
| `vitest` | 5.0.2 | 2026-09-25 09:00 | 2026-09-25 09:00 | 4.1.11 (2026-08-18) | `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` | vite `^6.4.0 \|\| ^7.0.0 \|\| ^8.0.0` | 11 optional (jsdom, happy-dom, @vitest/ui, @vitest/coverage-v8, ...) | MIT | none |
| `@playwright/test` | 1.63.0 | 2026-09-04 22:44 | 2026-09-29 05:26 | none (1.x only stable line; prev minor 1.62.1, 2026-07-30) | `>=20` | - | - | Apache-2.0 | none |
| `@axe-core/playwright` | 4.13.0 | 2026-08-11 17:07 | 2026-09-02 12:08 | none (4.x only line; prev minor 4.12.1, 2026-06-23) | `none declared` | playwright-core `>= 1.0.0` | - | MPL-2.0 | none |
| `axe-core` | 4.13.0 | 2026-08-05 16:53 | 2026-09-29 15:19 | 3.5.6 (2021-06-16) | `>=4` | - | - | MPL-2.0 | none |
| `@aws-sdk/client-kms` | 3.1142.0 | 2026-09-28 19:04 | 2026-09-28 19:04 | none (3.x only line; daily releases) | `>=20.0.0` | - | - | Apache-2.0 | none |
| `@google-cloud/kms` | 6.2.1 | 2026-09-28 19:02 | 2026-09-28 19:02 | 5.7.0 (2026-07-21) | `>=22` | - | - | Apache-2.0 | none |
| `jose` | 6.2.12 | 2026-09-05 09:17 | 2026-09-05 09:17 | 5.10.0 (2025-02-17) | `none declared` | - | - | MIT | none |
| `commander` | 15.0.0 | 2026-05-29 09:16 | 2026-09-02 19:31 | 14.0.3 (2026-01-31) | `>=22.12.0` | - | - | MIT | none |
| `@clack/prompts` | 1.8.1 | 2026-09-13 17:01 | 2026-09-13 17:01 | 0.11.0 (2025-05-22) | `>= 20.12.0` | - | - | MIT | none |
| `esbuild` | 0.28.2 | 2026-08-08 20:00 | 2026-08-08 20:00 | 0.27.7 (2026-04-02) [prev minor; 0.x] | `>=18` | - | - | MIT | none |
| `size-limit` | 14.1.0 | 2026-09-27 13:10 | 2026-09-27 13:10 | 13.1.1 (2026-09-12) | `^22.19.0 \|\| ^24.5.0 \|\| >=26.0.0` | - | - | MIT | none |
| `@vercel/functions` | 3.9.9 | 2026-09-22 00:08 | 2026-09-22 00:08 | 2.2.13 (2025-08-26) | `>= 20` | - | ws, @aws-sdk/credential-provider-web-identity | Apache-2.0 | none |
| `@vercel/node` | 16.0.2 | 2026-09-29 03:41 | 2026-09-29 03:41 | 15.0.0 (2026-09-24) | `none declared` | @vercel/build-utils `14.13.2` | - | Apache-2.0 | none |
| `@vercel/oidc` | 3.8.9 | 2026-09-22 00:07 | 2026-09-22 00:07 | 2.0.2 (2025-08-26) | `>= 20` | - | - | Apache-2.0 | none |
| `eslint` | 10.11.0 | 2026-09-18 20:15 | 2026-09-18 20:15 | 9.39.5 (2026-07-10) | `^20.19.0 \|\| ^22.13.0 \|\| >=24` | - | jiti | MIT | none |
| `prettier` | 3.9.9 | 2026-09-23 06:31 | 2026-09-23 06:31 | 2.8.8 (2023-04-23) | `>=14` | - | - | MIT | none |
| `tsx` | 4.23.15 | 2026-09-20 07:22 | 2026-09-20 07:22 | 3.14.0 (2023-10-17) | `>=18.0.0` | - | - | MIT | none |
| `@types/react-dom` | 19.3.0 | 2026-09-09 18:07 | 2026-09-09 18:07 | 18.3.7 (2025-04-30) | `none declared` | @types/react `^19.3.0` | - | MIT | none |
| `@types/node` | 26.6.3 | 2026-09-25 22:06 | 2026-09-25 22:09 | 25.9.8 (2026-09-19) | `none declared` | - | - | MIT | none |
| `typescript-eslint` | 8.71.0 | 2026-09-28 17:12 | 2026-09-28 17:12 | 7.18.0 (2024-07-29) | `^18.18.0 \|\| ^20.9.0 \|\| >=21.1.0` | eslint `^8.57.0 \|\| ^9.0.0 \|\| ^10.0.0`; typescript `>=4.8.4 <6.1.0` | - | MIT | none |
| `@typescript/typescript6` | 6.0.2 | 2026-07-06 18:06 | 2026-07-06 18:06 | none | `none declared` | - | - | Apache-2.0 | none |
| `@size-limit/file` | 14.1.0 | 2026-09-27 13:11 | 2026-09-27 13:11 | 13.1.1 (2026-09-12) | `^22.19.0 \|\| ^24.5.0 \|\| >=26.0.0` | size-limit `14.1.0` | - | MIT | none |
| `@modelcontextprotocol/server` | 2.2.0 | 2026-09-28 19:09 | 2026-09-28 19:09 | none (2.0.0 GA 2026-07-27) | `>=20` | - | - | MIT | none |
| `@modelcontextprotocol/client` | 2.2.0 | 2026-09-28 19:09 | 2026-09-28 19:09 | none (2.0.0 GA 2026-07-27) | `>=20` | - | - | MIT | none |

Table notes:
- "Deprecated" is the `deprecated` field of the `latest` manifest: none of the 42 is deprecated. Transitive deprecations seen at install time are in section 6.
- `react` 19.3.0 and `typescript` `time.modified` values are 2026-09-29 only because dist-tags (canary/next) were re-pointed; the stable release dates are 2026-09-09 and 2026-07-08.
- `@vercel/node` shipped majors 14.0.0 (2026-09-23), 15.0.0 (2026-09-24) and 16.0.2 (2026-09-29) within one week; its only peer is an exact pin `@vercel/build-utils 14.13.2`.
- `drizzle-orm` / `drizzle-kit` have many `1.0.0-*` dist-tags. `dist-tags.rc` = `1.0.0-rc.4` (published 2026-06-27) and `dist-tags.beta` = `1.0.0-beta.22` (2026-04-16); no stable `1.0.0` exists in `versions`.
- `stripe` dist-tags: `latest` 22.6.2, `public-preview` 22.7.0-beta.1, `private-preview` 22.7.0-alpha.5.
- `vite` dist-tags: `latest` 8.3.1, `previous` 7.3.6, `beta` 8.3.0-beta.1.
- `three` and `@types/three` are versioned by three.js release (r186); types lag the library by days (three 0.186.1 on 2026-09-24 vs @types/three 0.186.0 on 2026-09-11). Every minor of three is potentially breaking.
- `@axe-core/playwright` and `axe-core` are MPL-2.0 (dev/test-only here). In the resolved tree MPL-2.0 also covers `lightningcss` (Vite 8 dependency), `edge-runtime` and `@edge-runtime/*` (from `@vercel/node`), all dev-only. Production dependency licenses in the all-latest tree: MIT, Apache-2.0, ISC, BSD-2/3-Clause, 0BSD, Unlicense (`fast-sha256`), MIT-0 (`postal-mime`, via resend).

## 3. Node.js lines and Vercel Functions runtimes

### 3.1 Node.js release lines (accessed 2026-09-29)

Sources: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json, https://nodejs.org/en/about/previous-releases, https://endoflife.date/api/nodejs.json.

| Line | Codename | Status on 2026-09-29 | Active LTS start | Maintenance start | End of life | Latest patch (endoflife.date / nodejs.org) |
|---|---|---|---|---|---|---|
| v20 | Iron | EOL | 2023-10-24 | 2024-10-22 | 2026-04-30 | 20.20.2 (2026-03-24) |
| v22 | Jod | Maintenance LTS | 2024-10-29 | 2025-10-21 | 2027-04-30 | 22.23.3 (2026-09-23) |
| v24 | Krypton | Active LTS | 2025-10-28 | 2026-10-20 | 2028-04-30 | 24.21.0 (2026-09-08) |
| v25 | - | EOL (odd line) | - | 2026-04-01 | 2026-06-01 | 25.9.0 |
| v26 | - | Current | 2026-10-28 (scheduled) | 2027-10-20 (schedule.json) | 2029-04-30 | 26.10.0 (2026-09-22) |
| v27 | - | not released (alpha 2026-10-28) | - | 2027-10-20 | 2030-04-30 | - |

- nodejs.org table rows (previous-releases page): `v 26 | - | May 05, 2026 | Sep 21, 2026 | Current`, `v 24 | Krypton | ... | LTS`, `v 22 | Jod | ... | LTS`, `v 20 | Iron | ... | EOL`, `v 25 ... EOL`.
- Quote (nodejs.org): "Production applications should only use Active LTS or Maintenance LTS releases." and "Starting with Node.js 27, the release cycle will be annual and every major version will move to LTS status after its six-month Current phase".
- Conflict to note: endoflife.date gives Node 26 `support` (maintenance) end as `2027-10-27` while nodejs/Release `schedule.json` says `maintenance: 2027-10-20`. All other dates agree.
- Quote (Node.js schedule.json, v20): `"end": "2026-04-30"`; (v22) `"end": "2027-04-30"`; (v24) `"maintenance": "2026-10-20", "end": "2028-04-30"`; (v26) `"lts": "2026-10-28"`.

### 3.2 Vercel Functions Node runtimes

- Docs page https://vercel.com/docs/functions/runtimes/node-js/node-js-versions (page footer and `.md` front matter: `last_updated: 2026-02-27`): "By default, a new project uses the latest Node.js LTS version available on Vercel." "Current available versions are: 24.x (default) 22.x 20.x". "Only major versions are available. Vercel automatically rolls out minor and patch updates when needed, such as to fix a security issue." Override via `"engines": { "node": "24.x" }` in package.json.
- Vercel changelog "Node.js 20 is being deprecated on October 1, 2026" (14 Jul 2026), https://vercel.com/changelog/node-js-20-is-being-deprecated : "Following the Node.js 20 end of life on April 30, 2026, we are deprecating Node.js 20 for Builds and Functions on October 1, 2026." and "On October 1, 2026, Node.js 20 will be disabled in Project Settings. Existing projects using 20 as the version for Functions will display an error when a new deployment is created." Existing deployments keep working.
- Vercel changelog "Node.js 24 LTS is now generally available for builds and functions" (25 Nov 2025), https://vercel.com/changelog/node-js-24-lts-is-now-generally-available-for-builds-and-functions : "This is also the default version for new projects."
- Node 26: Vercel changelog "Node.js 26.x now available on Vercel Sandboxes" (12 May 2026), https://vercel.com/changelog/node-js-26-x-now-available-on-vercel-sandboxes : "Vercel Sandbox now supports Node.js version 26." That is Sandbox only. The docs page for Functions does not list 26.x, and I found no changelog entry making 26 available for Builds/Functions (search-based, see section 9).
- Function handler formats (https://vercel.com/docs/functions/runtimes/node-js): "create a file inside the /api directory with a function using the fetch Web Standard export" (`export default { fetch(request: Request) {...} }`) or `export function GET(request: Request)`. The `@vercel/node` types (`VercelRequest`, `VercelResponse`) only appear in the `(request, response)` handler examples, so they are not needed for fetch handlers.
- Practical reading (2026-09-29): Vercel Functions today = Node 24.x (default) and 22.x; 20.x works only for existing projects until 2026-10-01 (two days from the research date).

## 4. Compatibility checks

### 4.1 Node engine floors of the whole tree

Method: read `engines.node` of every package in the resolved `scratch-npm/package-lock.json` (658 nodes, `research/engines-check.cjs`) and test with npm's own `semver` against Node 20.19.0, 20.20.2, 22.11.0, 22.12.0, 22.22.2, 22.23.3, 24.5.0, 24.21.0, 26.10.0. I also ran `npm install --dry-run` under Node 20.20.2 (`/opt/node20`) to see the real EBADENGINE output.

| Package (resolved) | engines.node | Fails on |
|---|---|---|
| `size-limit` 14.1.0 (+ `@size-limit/file` 14.1.0) | `^22.19.0 \|\| ^24.5.0 \|\| >=26.0.0` | Node 20, 22.11-22.12 (needs >=22.19) |
| `vitest` 5.0.2 | `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` | Node 20 |
| `commander` 15.0.0 | `>=22.12.0` | Node 20 |
| `@google-cloud/kms` 6.2.1 (+ google-gax 6.9.0, google-auth-library 11.1.0, gcp-metadata 9.0.4, google-logging-utils 2.0.1, proto3-json-serializer 4.0.2, retry-request 9.0.1, teeny-request 11.0.1) | `>=22` | Node 20 |
| `eslint` 10.11.0 (+ @eslint/* helper packages, espree 11, eslint-scope 9) | `^20.19.0 \|\| ^22.13.0 \|\| >=24` | Node 22.11, 22.12 |
| `vite` 8.3.1, `@vitejs/plugin-react` 6.1.1, rolldown 1.2.11, oxc-parser 0.121.0 | `^20.19.0 \|\| >=22.12.0` | Node 22.11 and below, 20.18 and below |
| `@simplewebauthn/server` 14.0.3 | `>=20.0.0` (but changelog says "minimum supported ... Node LTS 22.x", see 4.5) | - |
| everything else | `>=18` / `>=20` / none | - |

Result: the single Node line that satisfies the entire tree without caveats is **Node >=22.19 (22.x) or 24.x (>=24.5) or 26.x**. Under Node 20.20.2 the dry run printed EBADENGINE for `@google-cloud/kms@6.2.1`, `commander@15.0.0`, `size-limit@14.1.0`, `vitest@5.0.2` and the seven google-* helper packages. Vercel Functions only offer 24.x and 22.x for new deployments, so **24.x** is the alignment target; it also keeps you on the Active LTS line until 2026-10-20 and Maintenance LTS until 2028-04-30.
Source: https://registry.npmjs.org/<package> (`engines`), accessed 2026-09-29; docs quotes in section 3.

### 4.2 Vite major vs Node, plugin-react vs Vite, Vitest vs Vite

- Vite 8.3.1: `engines.node = ^20.19.0 || >=22.12.0`. Docs (https://vite.dev/guide/, accessed 2026-09-29): "Vite requires Node.js version 20.19+, 22.12+. However, some templates require a higher Node.js version to work, please upgrade if your package manager warns about it." Vite 7.3.6 (`previous` tag) has the same requirement family; Vite 8 "uses Rolldown and Oxc based tools instead of esbuild and Rollup" (https://vite.dev/guide/migration).
- Vite support policy (https://vite.dev/releases): "Regular patches are released for vite@8.3. Important fixes and security patches are backported to vite@7.3 and vite@8.2. Security patches are also backported to vite@6.4 and vite@8.1." Also "Non-LTS Node.js versions (odd-numbered) are not tested as part of Vite's CI".
- `@vitejs/plugin-react` 6.1.1: peer `vite ^8.0.0` (required); optional peers `oxc-transform-react ^0.145.0`, `@rolldown/plugin-babel ^0.1.7 || ^0.2.0`, `babel-plugin-react-compiler ^1.0.0`; dependency `@rolldown/pluginutils ^1.0.1`; same Node engines as Vite. The previous major, 5.2.0 (2026-03-12), peers `vite ^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0`, so 5.2.0 is the bridge if Vite 7 is ever needed. plugin-react 6 README: React Compiler is opt-in ("Native React Compiler support is experimental." for the Rust path; Babel path needs `@rolldown/plugin-babel`, `babel-plugin-react-compiler`, `@babel/core`).
- `vitest` 5.0.2: required peer `vite ^6.4.0 || ^7.0.0 || ^8.0.0` (Vite 8.3.1 satisfies), engines `^22.12.0 || ^24.0.0 || >=26.0.0` (drops Node 20). Optional peers pin sibling packages exactly (`@vitest/ui 5.0.2`, `@vitest/coverage-v8 5.0.2`, `@vitest/browser-playwright 5.0.2`).
- Collision found in the smoke test: with Vitest's default include glob, `src/a11y.spec.ts` (a Playwright spec using `@axe-core/playwright`) is picked up and fails with "Playwright Test did not expect test() to be called here." Fix: keep Playwright specs in `e2e/` and set Vitest `test.include: ['src/**/*.test.ts']` (verified: 1 file, 1 test pass).
- Smoke result (scratch-smoke, Node 22.22.2): `vite build` OK (`vite v8.3.1`, 20 modules, `dist/assets/index-*.js 365.17 kB`, gzip 108.43 kB for React 19.3 + three 0.186 + zustand), `vitest run` 1/1, `eslint src api` exit 0.

### 4.3 TypeScript 7 (native) and its ecosystem gap

- `typescript` `latest` = 7.0.2 (2026-07-08); previous major 6.0.3 (2026-04-16). The package now ships a native `tsc` binary (`bin: {tsc: ./bin/tsc}`, `main: null`, `exports["."] = ./lib/version.cjs`, per-platform `@typescript/typescript-<os>-<cpu>` optional dependencies).
- Announcement (https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/, dated July 8th, 2026): "While TypeScript 7.0 is here, it does not ship with an API. We expect TypeScript 7.1 to ship with a new (and different) API, but until then we have made it a priority to ensure TypeScript can be run side-by-side with TypeScript 6.0 for utilities that still need some programmatic access to the compiler (such as typescript-eslint)." and "Because some tools like typescript-eslint expect to import from typescript directly via peer dependencies, we recommend achieving this via npm aliases." with `"@typescript/native": "npm:typescript@^7.0.2", "typescript": "npm:@typescript/typescript6@^6.0.2"`.
- `typescript-eslint` 8.71.0 (2026-09-28) peers `eslint ^8.57.0 || ^9.0.0 || ^10.0.0` and `typescript >=4.8.4 <6.1.0` (registry): a bare `typescript@^7` install would violate this peer. `@typescript/typescript6` is at 6.0.2 (2026-07-06).
- New defaults in 7.0 that bite scaffolds (same post): "strict is true by default", "rootDir now defaults to ./ , and inner source directories must be explicitly set", "types now defaults to [] , and the old behavior can be restored by setting it to [\"*\"]", `baseUrl` and `moduleResolution: node/node10/classic` removed, `target: es5` removed.
- Tested in `scratch-smoke` with the alias layout: `npm ls` shows every `@typescript-eslint/*` package dedupes to `typescript@npm:@typescript/typescript6@6.0.2`; `npx tsc -v` = `Version 7.0.2`; `tsc --noEmit` (TS 7.0.2) and `tsc6 --noEmit` both exit 0 over React/three/zustand/drizzle/neon/simplewebauthn/stripe/resend/MCP v2/zod/AWS KMS/jose/@vercel/functions/Playwright/axe code with `skipLibCheck: true`. With `skipLibCheck: false` TS 7 and TS 6 report the identical 72 declaration errors, all in third-party `.d.ts` (drizzle-orm sqlite/mysql/singlestore/gel/pg-core dialect files, missing optional `mysql2`; `@vercel/functions` missing optional `ws` types), so `skipLibCheck: true` is required regardless of TS version.
- No package in the resolved tree declares a `typescript` peer (checked in the lockfile), so the alias affects only typescript-eslint and any future TS-API tooling.

### 4.4 drizzle-orm, drizzle-kit and @neondatabase/serverless

- `drizzle-orm` 0.45.3 peer `@neondatabase/serverless >=0.10.0` (optional). `@neondatabase/serverless` 1.1.0 (2026-04-17) satisfies it; engines `>=19.0.0`; dual `exports: {require: ./index.js, import: ./index.mjs}`. drizzle-orm has no `engines` field.
- Neon 1.x behavior change (CHANGELOG 1.0.0, https://raw.githubusercontent.com/neondatabase/serverless/main/CHANGELOG.md): "the HTTP query template function can now **only** be called as a template function, not as a conventional function"; use `sql.query(...)` for manual placeholders and `sql.unsafe(...)` for trusted identifiers. 1.1.0: "Type declarations are now fully inlined (some were previously re-exported from `@types/pg` and `@types/node`)".
- Runtime check (Node 22.22.2): `drizzle(neon(url))` from `drizzle-orm/neon-http` builds `select "id", "name", "created_at" from "domains"`, and `drizzle-orm/neon-serverless` with `new Pool(...)` constructs and exposes `.transaction`. No query was sent to a live database.
- Driver guidance (https://orm.drizzle.team/docs/connect-neon): "Querying over HTTP is faster for single, non-interactive transactions. If you need session or interactive transaction support, or a fully compatible drop-in replacement for the pg driver, you can use the WebSocket-based neon-serverless driver." (In Node the WebSocket driver needs `ws` and `bufferutil`.)
- **Security floor:** drizzle-orm <0.45.2 has GHSA-gpj5-g38j-94v9 / CVE-2026-39356, severity high (CVSS 7.5, CWE-89): npm bulk advisory API returns `"vulnerable_versions":"<0.45.2"` (https://registry.npmjs.org/-/npm/v1/security/advisories/bulk). Drizzle changelog 0.45.2 (https://raw.githubusercontent.com/drizzle-team/drizzle-orm/main/changelogs/drizzle-orm/0.45.2.md): "Fixed `sql.identifier()`, `sql.as()` escaping issues ... causing a possible SQL Injection (CWE-89) vulnerability".
- **1.0 status:** no stable `1.0.0`; `dist-tags.rc` = `1.0.0-rc.4` (2026-06-27), `dist-tags.beta` = `1.0.0-beta.22`. The Drizzle docs (accessed 2026-09-29) already print `npm i drizzle-orm@rc @neondatabase/serverless` and `npm i -D drizzle-kit@rc`, with a site banner "We've merged alternation-engine into Beta release", while npm `latest` remains 0.45.3 / 0.31.11. Copy-pasting docs commands installs the RC. Docs-vs-`latest` mismatch is a scaffold risk.
- `drizzle-kit` 0.31.11 dependencies: `tsx ^4.21.0`, `esbuild ^0.25.4`, `@drizzle-team/brocli ^0.10.2`, `@esbuild-kit/esm-loader ^2.5.5` (deprecated: "Merged into tsx"). The RC (`1.0.0-rc.4`) instead depends on `jiti ^2.6.1`, `esbuild ^0.25.10`, `get-tsconfig`, `@drizzle-team/brocli ^0.12.0`, `@js-temporal/polyfill` and has no `@esbuild-kit` (so it would remove the dev-only audit findings, but it is a release candidate).
- Smoke: `npx drizzle-kit generate --dialect postgresql --schema src/schema.ts --out drizzle` produced `0000_*.sql` (1 table, 3 columns) under both the plain and the `overrides` install.

### 4.5 @simplewebauthn/server and /browser

- Both 14.x. Package layout (installed `package.json`): `exports: {".": {"import": "./esm/index.js", "require": "./script/index.js"}}` (server also `./helpers`), an `esm/package.json` for the ESM tree. Verified at runtime on Node 22.22.2 and Node 20.20.2: `import { generateRegistrationOptions } from '@simplewebauthn/server'` and `require('@simplewebauthn/server')` both work; `pubKeyCredParams` alg ids `-8,-7,-257`. The browser package has no `engines`; server `engines.node >=20.0.0`.
- Discrepancy: v14.0.0 changelog (https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/CHANGELOG.md): "the minimum supported version of Node has been raised to **Node LTS 22.x and higher**, and **Deno v2.4.x and higher**", while the published `engines` field still says `>=20.0.0`. Treat 22+ as the supported floor.
- v14.0.0 adds ML-DSA PQC algorithms "in supported runtimes" (registration options prefer ML-DSA-44 where the runtime supports it), `sendSignal()`, `browserSupportsPasskeys()`, `getBrowserCapabilities()`, `expectedTopOrigin`. v14.0.3: "PQC support is now lazily evaluated. This delays Node from emitting its PQC warnings from when the Node process starts to when a method is called that checks for PQC support".
- Security: v14.0.2 (2026-09-13) "fixes a CVSS v3 Moderate (5.4 / 10) and a CVSS v3 Moderate (6.3 / 10) security vulnerabilities" (GHSA-2g3p-m8c9-hhwh, GHSA-j3h4-m3m2-7p7j; certificate revocation/CRL handling). The npm advisory database response for `@simplewebauthn/server` lists only GHSA-6hxq-p678-4hr2 (low, `<=13.3.1`), so those two are not yet visible to `npm audit`. Pin server `>=14.0.3`; keep browser and server on the same major.

### 4.6 MCP SDK, zod

- `@modelcontextprotocol/sdk` 1.31.0 (2026-09-28): peer `zod ^3.25 || ^4.0` (required, `optional: false`), optional peer `@cfworker/json-schema ^4.1.1`; engines `>=18`; direct deps include `express ^5.2.1`, `hono ^4.11.4`, `jose ^6.1.3`, `ajv ^8.17.1`. v1 README: "This SDK has a **required peer dependency** on `zod` ... The SDK internally imports from `zod/v4`, but maintains backwards compatibility with projects using Zod v3.25 or later." Verified: `McpServer.registerTool` with a zod 4.6.5 shape imports and runs on Node 22.22.2. `npm ls` shows one unmet optional dependency `@cfworker/json-schema` (expected, optional).
- **v2 is GA and is the stable line** (https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md): "**v2 is the stable release line**, released alongside the 2026-07-28 spec. v1.x continues to receive bug fixes and security updates for at least 6 months after v2's release." Packages `@modelcontextprotocol/server` / `client` / `core` 2.2.0 (2.0.0 GA 2026-07-27; 2.1.0 2026-09-23; 2.2.0 2026-09-28), engines `>=20`, ESM+CJS `exports`, **zod is a direct dependency `^4.2.0`** (no peer), README: "Tool and prompt schemas use Standard Schema — bring Zod v4, Valibot, ArkType, or any compatible library." Example uses `import { McpServer } from '@modelcontextprotocol/server'` and `server.registerTool(name, { description, inputSchema: z.object({...}) }, handler)`. Optional middleware packages: `@modelcontextprotocol/node`, `express`, `fastify`, `hono`. Verified: `@modelcontextprotocol/server` 2.2.0 + zod 4.6.5 typechecks under TS 7.0.2 and TS 6.0.2.
- Because "at least 6 months" after 2026-07-27 is a minimum and not a date, v1 has no published end-of-support date (unverified beyond that quote).
- Registry advisories for `@modelcontextprotocol/sdk` v1: GHSA-345p-7cg4-v4c7 (high, `>=1.10.0 <=1.25.3`, cross-client data leak via shared server/transport reuse), GHSA-w48q-cv73-mx4w (high, `<1.24.0`, DNS rebinding protection off by default), GHSA-8r9q-7v3j-jr4g (high, `>=1.3.0 <1.25.2`, ReDoS). 1.31.0 is outside all ranges.
- zod 4.6.5: no engines, no peers, ESM+CJS; `zod` 3.25.76 (2025-07-08) is the v3 line and also ships `zod/v4`. Registry advisory only for `<=3.22.2`.

### 4.7 Stripe SDK and pinned API version

- `stripe` 22.6.2 (2026-09-09): `engines.node >=18`, optional peer `@types/node >=18`. Installed `esm/apiVersion.js`: `export const ApiVersion = '2026-08-26.dahlia'; export const ApiMajorVersion = 'dahlia';`. Runtime check: `Stripe.API_VERSION` prints `2026-08-26.dahlia`. CHANGELOG 22.6.0 (2026-08-26): "This release changes the pinned API version to 2026-08-26.dahlia." 22.6.1/22.6.2 (2026-09-01, 2026-09-09) are patches (22.6.2: "Validate that webhook secrets are non-empty").
- Pinned API version moves with SDK **minors** in the 22.x line: 22.1.0 -> 2026-04-22.dahlia, 22.2.0 -> 2026-05-27, 22.3.0 -> 2026-06-24, 22.4.0 -> 2026-07-29, 22.6.0 -> 2026-08-26 (each CHANGELOG entry: "This release changes the pinned API version to ..."). 22.0.0 "uses the same pinned API version to `2026-03-25.dahlia` as the last major release" (21.0.0 introduced it).
- README (config table): `apiVersion` "Stripe API version to be used. If not set, stripe-node will use the latest version at the time of release." and "our types only reflect the latest API version". So `^22.6.2` would silently change the API version on `npm update`. Set `apiVersion` explicitly (typechecked: `new Stripe(key, { apiVersion: '2026-08-26.dahlia' })`) and pin `~22.6.2` (or exact).
- Aside: stripe-node >=22.5.0 writes `<claude-code-hint ... />` to **stderr** at module load when `CLAUDECODE` or `CLAUDE_CODE_CHILD_SESSION` is set, and includes an AI-agent detector list (`AI_AGENTS`) in `utils.js`; irrelevant in production but visible in agent sessions and stdio MCP servers (stderr only).
- README requirement: "we currently support all LTS versions of **Node.js 18+**."

### 4.8 Vercel packages, KMS SDKs, other runtime libs

- `@vercel/functions` 3.9.9: engines `>= 20`; depends on `@vercel/oidc 3.8.9` (exact), optional peers `ws >=8`, `@aws-sdk/credential-provider-web-identity *`. `@vercel/oidc` 3.8.9: engines `>= 20`, depends on `jose ^5.9.6`, `@vercel/cli-exec 1.0.1`, `@vercel/cli-config 0.3.0` (so a second, older `jose` 5.x exists in the tree beside `jose` 6.2.12). Installing `@vercel/oidc` separately is optional.
- `@vercel/node` 16.0.2: dependencies pin exact versions `undici 5.28.4`, `path-to-regexp 6.1.0`, `@vercel/static-config 3.4.4` (-> `ajv 8.6.3`), `esbuild 0.27.0`, `tsx 4.21.0`, `typescript npm:typescript@5.9.3`, `node-fetch 2.6.9`, `@types/node 20.11.0`, `edge-runtime 2.5.9` (MPL-2.0). These cause the audit findings in section 7. Not needed for fetch handlers.
- KMS: `@aws-sdk/client-kms` 3.1142.0 (Node >=20; released almost daily, single 3.x line); `@google-cloud/kms` 6.2.1 (Node >=22; pulls `google-gax` 6.9.0 -> `node-fetch` 3.3.2 -> `fetch-blob` -> `node-domexception@1.0.0`, which npm flags "Use your platform's native DOMException instead"). Installing both is only needed for evaluation; pick one after the KMS decision. Typecheck OK for `KMSClient`/`EncryptCommand` and `jose` `SignJWT`.
- `jose` 6.2.12: ESM (`type: module`), no engines, no peers. Advisories only for old lines (v1-v4).
- `commander` 15.0.0 (2026-05-29): ESM, engines `>=22.12.0` (14.0.3 is the previous major). `@clack/prompts` 1.8.1: engines `>= 20.12.0`.
- Playwright: `@playwright/test` 1.63.0 depends on exact `playwright 1.63.0`; `@axe-core/playwright` 4.13.0 depends on `axe-core ~4.13.0` and peers `playwright-core >= 1.0.0` (satisfied by playwright's dependency), so a direct `axe-core` dependency is redundant. Browsers are not downloaded by `npm install` (I did not run `playwright install`); `npx playwright --version` = 1.63.0.
- `eslint` 10.11.0: migration guide (https://eslint.org/docs/latest/use/migrate-to-10.0.0): "Node.js < v20.19, v21, v23 are no longer supported ... ESLint now supports the following versions of Node.js: Node.js v20.19.0 and above; Node.js v22.13.0 and above; Node.js v24 and above" and the `.eslintrc` format is gone (flat `eslint.config.js` only).
- `prettier` 3.9.9: install docs (https://prettier.io/docs/install): "Install an exact version of Prettier locally in your project ... Even a patch release of Prettier can result in slightly different formatting".
- `size-limit` 14.1.0 and `@size-limit/file` 14.1.0: the plugin's peer is the exact string `size-limit 14.1.0`, so both must move together.
- `esbuild` 0.28.2: Vite 8 lists it as an optional peer (`^0.27.0 || ^0.28.0`); registry advisory GHSA-g7r4-m6w7-qqqr (low, `>=0.27.3 <0.28.1`, Windows dev server file read) is fixed at 0.28.1. Not required as a direct dependency (tsx and Vite bring their own).
- `three` advisory GHSA-fq6p-x6j3-cmmq (high, `<0.125.0`) is long fixed. `vitest` advisories (GHSA-9crc-q9x8-hgqq, GHSA-5xrq-8626-4rwp critical; GHSA-82fw-gwwq-j7x9 moderate `>=2.1.0 <4.1.11`) all fixed before 5.0.2. `vite` 8.x advisories GHSA-fx2h-pf6j-xcff (high, `>=8.0.0 <=8.0.15`), GHSA-v2wj-q39q-566r and GHSA-p9ff-h696-f583 (high, `<=8.0.4`), GHSA-4w7w-66w2-5vf9 (moderate, `<=8.0.4`), GHSA-v6wh-96g9-6wx3 (moderate, `<=8.0.15`) are fixed at 8.0.16 (8.3.1 is clear). All from https://registry.npmjs.org/-/npm/v1/security/advisories/bulk queried with every stable version of each planned package (`research/npm-bulk-advisories.json`).

## 5. Scratch install: peer conflicts, warnings, tree health

### 5.1 All requested packages at latest (`scratch-npm`, Node 22.22.2, npm 10.9.7)

Commands: `npm install <19 runtime packages>` then `npm install -D <18 dev packages>`, and finally a clean re-install (`rm -rf node_modules package-lock.json && npm install`) from the resulting `package.json`, all with default settings (no `--legacy-peer-deps`, no `--force`). Direct set = the 35 requested + `@types/react-dom` + `@types/node`.

- Result: exit 0, `added 494 packages, and audited 495 packages in 22s`, `npm ls` exit 0. **No ERESOLVE, no "Could not resolve dependency", no peer-conflict warnings, no "invalid"/"missing" entries** in `npm ls --all`. The only unmet item is the optional peer `@cfworker/json-schema@^4.1.1` of the MCP SDK v1.
- Warnings printed by npm (full log `research/install-clean.log`):
  - `npm warn deprecated @esbuild-kit/esm-loader@2.6.5: Merged into tsx: https://tsx.hirok.io` (via drizzle-kit 0.31.11)
  - `npm warn deprecated @esbuild-kit/core-utils@3.3.2: Merged into tsx: https://tsx.hirok.io` (via drizzle-kit 0.31.11)
  - `npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead` (via @google-cloud/kms -> google-gax 6.9.0 -> node-fetch 3.3.2 -> fetch-blob 3.2.0)
- Resolved oddities: `@types/node` latest = 26.6.3 (installed by default, but Vercel runs 24.x, so use `@types/node@^24`); four esbuild copies (`esbuild@0.28.2` top level and under vite/tsx, `esbuild@0.27.0` under `@vercel/node`, `esbuild@0.25.12` under drizzle-kit, `esbuild@0.18.20` under `@esbuild-kit/core-utils`); two `jose` (6.2.12 direct, 5.10.0 under `@vercel/oidc`); `@vercel/node` brings its own `typescript@5.9.3`.
- Node-engine warnings: none on Node 22.22.2. On Node 20.20.2 dry run: EBADENGINE for `@google-cloud/kms`, `commander`, `size-limit`, `vitest` and 7 google-* helper packages (section 4.1).
- The `deprecated` field on the direct packages' `latest` manifests is empty for all 42 packages (section 2).

### 5.2 Recommended pin set (`scratch-final`, file `research/recommended-package.json`)

Fresh `npm install`: exit 0, `added 260 packages`, `found 0 vulnerabilities` (with the override), only warnings: EBADENGINE for the project's own `"engines": {"node": "24.x"}` versus the local Node 22.22.2 (expected) and the two `@esbuild-kit` deprecations. Then, with Node 22.22.2: `tsc -v` = `Version 7.0.2`; `tsc --noEmit` OK; `tsc6 --noEmit` OK; `vite build` OK (`vite/8.3.1`); `vitest run` 1 file / 1 test pass; `eslint src api` exit 0 with `typescript-eslint` 8.71.0; `size-limit` 14.1.0 reports "Size: 90.89 kB brotlied" against a 150 kB budget; `npm audit` and `npm audit --omit=dev`: 0 vulnerabilities.

## 6. Deprecations (transitive) and licenses

| Item | Notice (exact npm text) | Pulled in by | Action |
|---|---|---|---|
| `@esbuild-kit/esm-loader@2.6.5` | "Merged into tsx: https://tsx.hirok.io" | `drizzle-kit@0.31.11` (dependency `@esbuild-kit/esm-loader ^2.5.5`) | Accept (dev tool) until drizzle-kit 1.0 (RC.4 no longer depends on it) |
| `@esbuild-kit/core-utils@3.3.2` | "Merged into tsx: https://tsx.hirok.io" | `@esbuild-kit/esm-loader` | same; nested `esbuild 0.18.20` handled by override (section 8) |
| `node-domexception@1.0.0` | "Use your platform's native DOMException instead" | only when `@google-cloud/kms` is installed (google-gax -> node-fetch 3 -> fetch-blob) | Only present if `@google-cloud/kms` is chosen; a small npm-hygiene point in favor of the AWS SDK |

Licenses in the all-latest tree (from `package-lock.json`): MIT 486, Apache-2.0 88, ISC 26, MPL-2.0 20, BSD-3-Clause 18, BlueOak-1.0.0 8, BSD-2-Clause 8, 0BSD 2, Unlicense 1 (`fast-sha256`, prod), MIT-0 1 (`postal-mime`, prod via resend). MPL-2.0 packages are all dev-only: axe-core, @axe-core/playwright, lightningcss (+ 10 platform binaries), edge-runtime and @edge-runtime/* (from `@vercel/node`).

## 7. npm audit (all-latest set, `scratch-npm`, `npm audit --json`, 2026-09-29)

Metadata: `vulnerabilities: {info 0, low 0, moderate 6, high 3, critical 0, total 9}`; dependencies `prod 263, dev 396, optional 172, peer 5, total 658`. **`npm audit --omit=dev`: 0 vulnerabilities** (both vulnerable roots are devDependencies here). Raw JSON: `research/npm-audit.json`.

### 7.1 Vulnerable packages (9) as npm reports them

| Package (installed) | Severity | Direct? | Vulnerable range | `fixAvailable` reported by npm | Real fix |
|---|---|---|---|---|---|
| `@vercel/node` 16.0.2 | high | yes (dev) | `>=2.1.1-canary.0` | `@vercel/node@4.0.0` (isSemVerMajor true) | **Not a fix**: 4.0.0 is a downgrade artefact. 16.0.2 exact-pins the vulnerable deps below. Do not install `@vercel/node`. |
| `undici` 5.28.4 | high | no | `<=6.27.0` | via `@vercel/node@4.0.0` | needs undici >=6.28.1 (6.x) / >=7.29.1 / >=8.10.2 (registry ranges); 5.x has no patch for the high items |
| `path-to-regexp` 6.1.0 | high | no | `4.0.0 - 6.2.2` | via `@vercel/node@4.0.0` | path-to-regexp >=6.3.0 |
| `@vercel/static-config` 3.4.4 | moderate | no | `*` | via `@vercel/node@4.0.0` | follows ajv |
| `ajv` 8.6.3 (under @vercel/static-config) | moderate | no | `7.0.0-alpha.0 - 8.17.1` | via `@vercel/node@4.0.0` | ajv >=8.18.0 |
| `drizzle-kit` 0.31.11 | moderate | yes (dev) | `0.19.0 - 1.0.0-beta.1-fd8bfcc` | `drizzle-kit@0.18.1` (isSemVerMajor true) | **Not a fix** (downgrade artefact). Override nested esbuild (tested) or move to drizzle-kit 1.0 RC |
| `@esbuild-kit/esm-loader` 2.6.5 | moderate | no | `*` | via drizzle-kit@0.18.1 | follows core-utils |
| `@esbuild-kit/core-utils` 3.3.2 | moderate | no | `*` | via drizzle-kit@0.18.1 | follows esbuild |
| `esbuild` 0.18.20 (nested under core-utils) | moderate | no | `<=0.24.2` | via drizzle-kit@0.18.1 | esbuild >=0.25.0 (override to 0.25.12 verified) |

### 7.2 Distinct advisories (17)

| Package | GHSA | Severity | Range | Title | CWE | CVSS |
|---|---|---|---|---|---|---|
| ajv | GHSA-2g4f-4pwh-qvx6 | moderate | >=7.0.0-alpha.0 <8.18.0 | ajv has ReDoS when using `$data` option | CWE-400, CWE-1333 | unscored (0) |
| esbuild | GHSA-67mh-4wv8-2f99 | moderate | <=0.24.2 | esbuild enables any website to send any requests to the development server and read the response | CWE-346 | 5.3 |
| path-to-regexp | GHSA-9wv6-86v2-598j | high | >=4.0.0 <6.3.0 | path-to-regexp outputs backtracking regular expressions | CWE-1333 | 7.5 |
| undici | GHSA-vrm6-8vpv-qv8q | high | <6.24.0 | Unbounded Memory Consumption in WebSocket permessage-deflate Decompression | CWE-409 | 7.5 |
| undici | GHSA-v9p9-hfj2-hcw8 | high | <6.24.0 | Unhandled Exception in WebSocket Client Due to Invalid server_max_window_bits Validation | CWE-248 | 7.5 |
| undici | GHSA-vxpw-j846-p89q | high | <6.27.0 | WebSocket client vulnerable to denial of service via fragment count bypass | CWE-400, CWE-770 | 7.5 |
| undici | GHSA-c76h-2ccp-4975 | moderate | >=4.5.0 <5.28.5 | Use of Insufficiently Random Values in undici | CWE-330 | 6.8 |
| undici | GHSA-g9mf-h72j-4rw9 | moderate | <6.23.0 | Unbounded decompression chain in HTTP responses (Fetch, Content-Encoding) | CWE-770 | 5.9 |
| undici | GHSA-p88m-4jfj-68fv | moderate | <6.27.0 | HTTP header injection via Set-Cookie percent-decoding | CWE-93 | 5.9 |
| undici | GHSA-2mjp-6q6p-2qxm | moderate | <6.24.0 | HTTP Request/Response Smuggling issue | CWE-444 | 6.5 |
| undici | GHSA-4992-7rv2-5pvq | moderate | <6.24.0 | CRLF Injection via `upgrade` option | CWE-93 | 4.6 |
| undici | GHSA-8xcm-r25x-g524 | moderate | <6.28.0 | downstream response desynchronization via retry interceptor | CWE-444 | 4.8 |
| undici | GHSA-m8rv-5g2x-5cg5 | moderate | <6.28.0 | CRLF Injection via blob-like body `type` property | CWE-93 | 4.2 |
| undici | GHSA-v3r7-h72x-cjcm | moderate | <6.28.0 | cookie attribute injection via unsanitized domain / unparsed setCookie fields | CWE-74 | 4.8 |
| undici | GHSA-cxrh-j4jr-qwg3 | low | <5.29.0 | Denial of Service via bad certificate data | CWE-401 | 3.1 |
| undici | GHSA-g8m3-5g58-fq7m | low | <6.27.0 | Set-Cookie SameSite attribute downgrade via permissive substring matching | CWE-183 | 3.7 |
| undici | GHSA-35p6-xmwp-9g52 | low | <6.27.0 | HTTP response queue poisoning via keep-alive socket reuse | CWE-367 | 3.7 |

Advisory URLs follow `https://github.com/advisories/<GHSA>`; `github.com` returned 403 to my fetches, so severities/ranges come from the npm audit response and the npm bulk advisory API (`https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`).

### 7.3 Audit of the recommended set

`scratch-smoke` (recommended pins without the override): 4 moderate (drizzle-kit, @esbuild-kit/esm-loader, @esbuild-kit/core-utils, esbuild `<=0.24.2` GHSA-67mh-4wv8-2f99, dev-only). `scratch-final` / `scratch-override` (with `overrides: {"@esbuild-kit/core-utils": {"esbuild": "0.25.12"}}`): **0 vulnerabilities**, `npm ls esbuild` shows `@esbuild-kit/core-utils@3.3.2 overridden -> esbuild@0.25.12 overridden`, `drizzle-kit generate` works. GHSA-67mh-4wv8-2f99 is titled "esbuild enables any website to send any requests to the development server and read the response", i.e. it concerns esbuild's dev server; I did not inspect drizzle-kit's source to prove it never starts one, so treat the residual risk as low but unproven. The override keeps `npm audit` at zero in CI. Only `drizzle-kit generate` was exercised (not `migrate`, `push`, `pull`, `studio`).

## 8. Recommended pins for the Phase 1 scaffold

Validated as a whole in `scratch-final` (section 5.2); the exact file is `research/recommended-package.json` (lockfile: `research/recommended-package-lock.json`). Rules used: `~` for 0.x libraries and anything whose minors change behavior (React pair, three, Stripe, drizzle, Playwright, axe), `^` for stable-semver libraries, **exact** where the tool itself demands it (Prettier formatting stability; `size-limit` <-> `@size-limit/file` peer equality).

```json
{
  "engines": { "node": "24.x" },
  "dependencies": {
    "@aws-sdk/client-kms": "^3.1142.0",
    "@clack/prompts": "^1.8.1",
    "@modelcontextprotocol/server": "^2.2.0",
    "@neondatabase/serverless": "^1.1.0",
    "@simplewebauthn/browser": "^14.0.0",
    "@simplewebauthn/server": "^14.0.3",
    "@vercel/functions": "^3.9.9",
    "commander": "^15.0.0",
    "drizzle-orm": "~0.45.3",
    "jose": "^6.2.12",
    "react": "~19.3.0",
    "react-dom": "~19.3.0",
    "resend": "^6.31.0",
    "stripe": "~22.6.2",
    "three": "~0.186.1",
    "zod": "^4.6.5",
    "zustand": "^5.0.15"
  },
  "devDependencies": {
    "@axe-core/playwright": "~4.13.0",
    "@playwright/test": "~1.63.0",
    "@size-limit/file": "14.1.0",
    "@types/node": "^24.19.0",
    "@types/react": "~19.3.0",
    "@types/react-dom": "~19.3.0",
    "@types/three": "~0.186.0",
    "@typescript/native": "npm:typescript@~7.0.2",
    "@vitejs/plugin-react": "^6.1.1",
    "drizzle-kit": "~0.31.11",
    "eslint": "^10.11.0",
    "prettier": "3.9.9",
    "size-limit": "14.1.0",
    "tsx": "^4.23.15",
    "typescript": "npm:@typescript/typescript6@~6.0.2",
    "typescript-eslint": "^8.71.0",
    "vite": "^8.3.1",
    "vitest": "^5.0.2"
  },
  "overrides": {
    "@esbuild-kit/core-utils": { "esbuild": "0.25.12" }
  }
}
```

Rationale per decision (numbers refer to the sections above):

| Decision | Choice | Why |
|---|---|---|
| Runtime Node | `engines.node = "24.x"`; CI and local on Node 24 (>=24.5); local Node >=22.19 works | Vercel default and only non-EOL LTS besides 22; satisfies every engine range (4.1); Node 22 leaves support 2027-04-30 |
| Frontend build | Vite `^8.3.1` + plugin-react `^6.1.1` (do not mix: plugin-react 6 peers `vite ^8` only) | 4.2; Vite 8.x below 8.0.16 has high advisories |
| TypeScript | alias layout: `typescript` -> `@typescript/typescript6@~6.0.2` (API for typescript-eslint), `@typescript/native` -> `typescript@~7.0.2` (the `tsc` binary) | 4.3; fallback if the alias is unwanted: single `typescript@~6.0.3` (no code changes; loses TS 7 speed). Set `skipLibCheck: true`, explicit `types` and `rootDir` in tsconfig |
| Tests | `vitest ^5.0.2`, include only `src/**/*.test.ts`; Playwright specs in `e2e/` | 4.2 collision |
| Server runtime | fetch-style handlers (`export default { fetch }` / `export function GET`), `@vercel/functions ^3.9.9`; **no `@vercel/node`** | 3.2, 4.8, 7 |
| DB | `drizzle-orm ~0.45.3` (floor 0.45.2), `@neondatabase/serverless ^1.1.0`, `drizzle-kit ~0.31.11` + override; neon-http for single statements, neon-serverless (WebSocket, needs `ws`) for interactive transactions | 4.4; revisit 1.0 GA (RC docs vs `latest`) |
| Passkeys | `@simplewebauthn/server ^14.0.3` + `/browser ^14.0.0` | 4.5 (14.0.2 security fix; Node 22+ supported floor) |
| Payments | `stripe ~22.6.2` and explicit `apiVersion: '2026-08-26.dahlia'` | 4.7 |
| Email | `resend ^6.31.0` (Node >=20; optional peer `@react-email/render`) | 2 |
| MCP | `@modelcontextprotocol/server ^2.2.0` (zod 4 via Standard Schema) | 4.6; alternative if v1 is required: `@modelcontextprotocol/sdk ^1.31.0` + `zod ^4.6.5` (v1 gets fixes for "at least 6 months" after 2026-07-27) |
| KMS | placeholder `@aws-sdk/client-kms ^3.1142.0`; alternative `@google-cloud/kms ^6.2.1` (forces Node >=22, adds deprecated `node-domexception`) | 4.8; final choice belongs to the KMS topic |
| Tokens | `jose ^6.2.12` | 4.8 |
| CLI (later phase) | `commander ^15.0.0` (Node >=22.12), `@clack/prompts ^1.8.1` | 4.1 |
| Lint/format/size | `eslint ^10.11.0` (flat config only) + `typescript-eslint ^8.71.0`; `prettier` exact `3.9.9`; `size-limit` and `@size-limit/file` both exact `14.1.0` | 4.8 |
| Not installed on purpose | `esbuild` (optional peer of Vite 8; tsx/drizzle-kit bring their own), `axe-core` (dependency of `@axe-core/playwright`), `@vercel/oidc` (dependency of `@vercel/functions`), `@vercel/node` | 4.8, 7 |

Operational guidance derived from the data (recommendations, not sourced facts): commit `package-lock.json` and use `npm ci` in CI; several picks were published within two days of the research date (`resend` 6.31.0 and `@vercel/node` 16.0.2 on 2026-09-29; `@modelcontextprotocol/sdk` 1.31.0, `@modelcontextprotocol/server` 2.2.0 and `@aws-sdk/client-kms` 3.1142.0 on 2026-09-28), so review lockfile diffs before merging updates; re-run `npm audit` and re-check the Vercel Node docs after 2026-10-01 (Node 20 cut-off) and after 2026-10-28 (Node 26 LTS).

## 9. Not verified / open items

1. Live behavior: no query was sent to Neon, no Stripe/Resend/KMS/WebAuthn call was made (no credentials); drizzle+Neon was only constructed and `toSQL()`-checked; SimpleWebAuthn only generated registration options.
2. Node 24 and Node 26 execution: only Node 20.20.2 and 22.22.2 exist locally; Node 24/26 support is inferred from `engines` ranges via semver, not from running the code.
3. Vercel Functions on Node 26: the docs page is dated `last_updated: 2026-02-27` and still lists 20.x (EOL since 2026-04-30), so it may lag; I found no changelog entry enabling 26 for Builds/Functions (Sandbox-only entry dated 12 May 2026), but the search was not exhaustive.
4. MCP SDK v2: not exercised on a Vercel Function (Streamable HTTP over fetch handlers); v1 end-of-support date is unpublished beyond "at least 6 months after v2's release"; whether target agent clients already speak the 2026-07-28 MCP spec is unverified.
5. Two SimpleWebAuthn advisories fixed in 14.0.2 (GHSA-2g3p-m8c9-hhwh, GHSA-j3h4-m3m2-7p7j) were not in the npm advisory data and their affected ranges could not be fetched (github.com 403); only the changelog statement is available.
6. `drizzle-kit` override: only `generate` exercised; `migrate`/`push`/`pull`/`studio` untested. Drizzle 1.0 RC not installed or tested.
7. `@vercel/node`: only the `latest` (16.0.2) manifest was evaluated; older majors were not checked for a clean dependency set, since the recommendation is to not use it.
8. GitHub REST API (releases) and github.com advisory pages were unreachable in this session (403); release notes were read from `raw.githubusercontent.com` files (SimpleWebAuthn CHANGELOG, Neon CHANGELOG, Drizzle changelogs, MCP README).
9. Only npm 10.9.7 on Linux x64 was tested (no pnpm/yarn/bun, no macOS/Windows; Vercel builds with the package manager implied by the lockfile).
10. `endoflife.date` and `schedule.json` disagree by one week on Node 26's maintenance start (2027-10-27 vs 2027-10-20); both recorded, nodejs.org's page does not show that date.
11. Registry `time.modified` for `react`, `react-dom`, `typescript`, `axe-core`, `@playwright/test` moves daily because dist-tags are re-pointed; it is not a release date.

## 10. Reproduction

- Registry JSON: `research/npmview/*.json`; table generator output: `research/table-versions.md`.
- Node facts: `research/web/node-schedule.json`, `research/web/eol-nodejs.json`, `research/web/node-prev.txt`, Vercel docs/changelog text in `research/web/vercel-*.txt` and `research/web/vc-*.txt`.
- Installs: `research/scratch-npm` (all-latest), `research/scratch-smoke` (pins + smoke code), `research/scratch-override` (override experiment), `research/scratch-final` (recommended set). Engine scan: `research/engines-check.cjs`. Bulk advisories: `research/npm-bulk-advisories.json`.
- Primary URLs used: https://registry.npmjs.org/ (packuments and `/-/npm/v1/security/advisories/bulk`), https://raw.githubusercontent.com/nodejs/Release/main/schedule.json, https://nodejs.org/en/about/previous-releases, https://endoflife.date/api/nodejs.json, https://vercel.com/docs/functions/runtimes/node-js/node-js-versions, https://vercel.com/docs/functions/runtimes/node-js, https://vercel.com/changelog/node-js-20-is-being-deprecated, https://vercel.com/changelog/node-js-24-lts-is-now-generally-available-for-builds-and-functions, https://vercel.com/changelog/node-js-26-x-now-available-on-vercel-sandboxes, https://vite.dev/guide/, https://vite.dev/releases, https://vite.dev/guide/migration, https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/, https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md (v2) and `/v1.x/README.md`, https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/CHANGELOG.md, https://raw.githubusercontent.com/neondatabase/serverless/main/CHANGELOG.md, https://raw.githubusercontent.com/drizzle-team/drizzle-orm/main/changelogs/drizzle-orm/0.45.2.md, https://orm.drizzle.team/docs/connect-neon, https://eslint.org/docs/latest/use/migrate-to-10.0.0, https://prettier.io/docs/install, the installed `stripe` package files (`esm/apiVersion.js`, `CHANGELOG.md`, `README.md`).
