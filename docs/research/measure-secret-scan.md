# MEASURE: build-time "no secret in the client bundle" scan (Phase 4 test)

Research date: 2026-09-29. Every URL below was opened on 2026-09-29 unless marked otherwise. Numbers labelled "measured" come from runs in `research/scratch-secretscan/` (paths at the end); everything else is quoted from the cited source.

## TL;DR

1. Vite 8.3.1 (npm `latest`, modified 2026-09-24) exposes only `VITE_*` to client code (`envPrefix`, default `VITE_`) and throws if `envPrefix` is `''`; it has no other leak check, so the gate is ours (docs: "`VITE_*` variables should _not_ contain sensitive information such as API keys").
2. Deliverables in section 4: `scan-client-bundle.mjs` (356 lines, Node built-ins only), `vite-secret-guard.mjs` (77-line fail-the-build Vite plugin), `scan-client-bundle.test.mjs` (75 lines, 17/17 pass on Node 22.22.2 and 24.21.0).
3. Planted fakes (43, generated at run time): 41/43 found in minified (oxc, esbuild) and unminified `dist/`, also when bundled beside real three.js + React + R3F/drei output; 43/43 when source names are visible (sourcemap `sourcesContent` or the plugin's pre-transform hook). The 2 misses are `const apiKey = "..."` locals whose names Rolldown inlines away even with `minify: false`.
4. Negative controls: 27/27 clean in every variant. Real output: 0 errors in 59 dist dirs / 191 files / 82.4 MiB (three.js, React, R3F, drei, Stripe.js, zod, WebAuthn, Firebase, Supabase, crypto libs, and the server SDKs built into a client bundle on purpose; Vite 8.3.1 oxc, esbuild, unminified, sourcemaps; Vite 7.3.6). 11 warnings, all in the stress bundles.
5. Tuning was necessary and is logged (7.3): a naive "high-entropy string anywhere" check gives 41 hits on a 0.8 MiB app and 1,473 on the three.js/drei kitchen sink (wasm/PNG base64, emscripten glue, WebGL constants); gating on a secret-ish property name gives 0; the shape filters removed 19 to 42 false positives per Firebase/Supabase bundle and 1 to 3 per AWS-SDK bundle.
6. Time: about 10 to 85 ms in-process for a 0.8 to 3.8 MiB `dist/` (CLI 0.07 to 0.2 s with Node start-up), 0.15 to 0.5 s for 11.7 MiB with sourcemaps, 1.8 to 3.9 s and 225 MiB RSS for 105 MiB. The Vite plugin adds 27 to 43 ms (0.8 MiB app) and 72 to 151 ms (kitchen sink) of hook time.
7. Limits (section 8): no static scan finds an unknown-format secret in a local variable of a built bundle, a run-time-assembled secret, or a low-entropy password. Hence defence in depth: server-only env values (5 encodings) and names are searched in `dist/`, server SDK modules are banned from the client graph, `public/` is checked for `.env`/key files.
8. Not verified (section 13): Stripe/Resend/Mosshatch token body lengths, Vercel failing a deployment on a non-zero build command, Secret-type env vars being visible to the build, Windows, terser.

---

## 1. Scope and method

- Question: what does the project need in Phase 4 so that a secret can never ship in the browser bundle, and what does that cost in false positives and time.
- Environment: Linux sandbox, 4 vCPU Xeon 2.1 GHz shared (timings vary about 2x run to run), Node 22.22.2 (system) and Node 24.21.0 (fetched from the npm `node` package to test the project's target runtime, `engines.node` 24.x in the Phase 1 pins).
- Toolchain measured: `vite@8.3.1` (bundler `rolldown@1.2.11`), `@vitejs/plugin-react@6.1.1`, `react@19.3.0`, `three@0.186.1`, `@react-three/fiber@9.8.1`, `@react-three/drei@10.7.9`, `@stripe/stripe-js@9.17.0`, `zod@4.6.5`, `@simplewebauthn/browser@14.0.0`, `zustand@5.0.15`. Stress-only: `nanoid@6.0.1 uuid@14.0.2 crypto-js@4.2.0 jose@6.2.12 tweetnacl@1.0.3 @noble/hashes@2.4.0 @noble/curves@2.4.0 bcryptjs@3.0.3 jwt-decode@4.0.0 firebase@12.19.0 @supabase/supabase-js@2.117.2 lodash-es@4.18.1 date-fns@4.4.0 i18next@26.4.2 @tanstack/react-query@5.104.0 react-router@8.4.0 framer-motion@13.4.6`, and the server SDKs `stripe@22.6.2 @aws-sdk/client-kms@3.1143.0 @neondatabase/serverless@1.1.0 drizzle-orm@0.45.3 @simplewebauthn/server@14.0.3 resend@6.31.0`.
- Re-used `../scratch-bundle` (13 variant builds, esbuild-minified rebuilds, sourcemap builds, a Vite 7.3.6 comparison set) plus `../scratch-final/dist` and `../scratch-smoke/dist` as extra real-output corpora, and built new corpora in `scratch-secretscan/`.
- Repository state: `/home/user/MossHatch` has no commits and no token-format spec, so `mh_live_` / `mh_test_` body format is an assumption (section 13).
- Web search budget was exhausted mid-task (200 of 200), so sources are direct fetches of provider docs, RFCs and raw GitHub files; no snippet-only evidence is used.

---

## 2. Vite: which env-variable rule applies today (Vite 8.3.1) and how to fail the build

### 2.1 What the docs say

| # | Claim | Source (accessed 2026-09-29) | Quote |
|---|---|---|---|
| V1 | Default client prefix is `VITE_` | https://vite.dev/guide/env-and-mode (page header shows v8.3.1); raw: https://raw.githubusercontent.com/vitejs/vite/main/docs/guide/env-and-mode.md | "Variables prefixed with `VITE_` will be exposed in client-side source code after Vite bundling." |
| V2 | Secrets must not use it | same | "`VITE_*` variables should _not_ contain sensitive information such as API keys. The values of these variables are bundled into your source code at build time." |
| V3 | `envPrefix` option, `string \| string[]`, default `VITE_` | https://vite.dev/config/shared-options (section envPrefix); raw: https://raw.githubusercontent.com/vitejs/vite/main/docs/config/shared-options.md | "Env variables starting with `envPrefix` will be exposed to your client source code via `import.meta.env`." |
| V4 | `''` is forbidden | same | "`envPrefix` should not be set as `''`, which will expose all your env variables and cause unexpected leaking of sensitive information. Vite will throw an error when detecting `''`." |
| V5 | `define` is static replacement, and is the documented way to expose an unprefixed variable (so it is also a leak path) | same (define, envPrefix warning box) | "Entries will be defined as globals during dev and statically replaced during build." and "`define: { 'import.meta.env.ENV_VARIABLE': JSON.stringify(process.env.ENV_VARIABLE) }`" |
| V6 | Unprefixed variables are not exposed | env-and-mode | "The parsed value of `VITE_SOME_KEY` – `"123"` – will be exposed on the client, but the value of `DB_PASSWORD` will not." |
| V7 | Process env beats `.env` files | env-and-mode | "environment variables that already exist when Vite is executed have the highest priority and will not be overwritten by `.env` files." |
| V8 | `.env.*.local` may hold secrets | env-and-mode | "`.env.*.local` files are local-only and can contain sensitive variables. You should add `*.local` to your `.gitignore`" |
| V9 | `loadEnv` default prefix and process.env merge | https://vite.dev/guide/api-javascript | "Load .env files within the envDir and merge them with the matching variables already present in process.env. By default, only env variables prefixed with VITE_ are loaded, unless prefixes is changed." (signature `prefixes: string \| string[] = 'VITE_'`) |
| V10 | `public/` is copied verbatim (so a `public/.env` ships) | shared-options (publicDir) | "copied to the root of `outDir` during build, and are always served or copied as-is without transform." |
| V11 | Sourcemaps off by default; `hidden` only removes the comment | https://raw.githubusercontent.com/vitejs/vite/main/docs/config/build-options.md | "`'hidden'` works like `true` except that the corresponding sourcemap comments in the bundled files are suppressed." (default `false`) |
| V12 | TypeScript can reject unknown `import.meta.env` keys | env-and-mode (IntelliSense section) | "By adding this line, you can make the type of ImportMetaEnv strict to disallow unknown keys." (`// strictImportMetaEnv: unknown` inside `interface ViteTypeOptions`) |
| V13 | Version currency | `npm view vite dist-tags` (2026-09-29) | `latest: 8.3.1`, `previous: 7.3.6`, modified 2026-09-24T12:26Z |
| V14 | Rollup/Rolldown hook used by the plugin | https://rollupjs.org/plugin-development/ (generateBundle) | `OutputChunk` has `code`, `moduleIds`, `modules`; "You can prevent files from being emitted by deleting them from the bundle object in this hook." |

Conclusion for Phase 4: the rule that applies today is unchanged: default `envPrefix` `VITE_`; only prefixed variables reach `import.meta.env`; Vite itself rejects the empty prefix; there is no built-in check for secrets, for `define`, for `public/`, or for server code imported into the client.

### 2.2 What Vite 8.3.1 actually does (measured, `vite.leak.config.ts`, scenarios A to F)

| Scenario | Client code | Result in `dist/` (measured) | Scanner (with `--env-dir scenarios/X`) |
|---|---|---|---|
| clean | `import.meta.env.VITE_RP_ID` | value inlined (`mosshatch.example`) | 0 findings, exit 0 |
| A | mis-prefixed `VITE_STRIPE_SECRET_KEY` in `.env.production` | value inlined verbatim | 3 errors: `stripe-secret-key`, `server-env-value-in-client`, `client-prefixed-var-looks-secret`; exit 1 |
| B | `import.meta.env.SESSION_SECRET` (unprefixed) and `process.env.SESSION_SECRET` | first becomes `void 0` (docs say `undefined`, same meaning); second becomes `{}.SESSION_SECRET` (**the name survives**) | 1 error: `server-env-name-in-client` |
| C | `define: {'process.env.DATABASE_URL': JSON.stringify(process.env.DATABASE_URL)}` | full Neon-shaped URL inlined | 3 errors: `db-url-with-credentials`, `server-env-value-in-client`, `server-env-name-in-client` |
| C2 | `define: {'process.env': process.env}` (classic mistake) | 0.8 kB bundle grew to 21 kB: the **whole environment** was inlined (dist deleted after the run because it held this sandbox's real environment) | exit 1, at least 14 error lines (output was truncated to 14); never printed a value |
| D / D2 | `envPrefix: ''` / `['VITE_','']` | build aborts: `Error: envPrefix option contains value '', which could lead unexpected exposure of sensitive information.` | n/a (build fails first) |
| E | `console.log(import.meta.env)` with `VITE_INTERNAL_SIGNING_TOKEN` set but never referenced | **all** `VITE_*` values are inlined, including the unreferenced one | 6 errors (entropy-near-name, name, value, client-prefixed) |
| F | `public/.env` | copied to `dist/.env` | 4 errors: `dangerous-file-in-dist` plus name/value matches in `.env` and JS |

### 2.3 How to fail the build (all four layers were tested)

1. **Config time** (plugin `config` / `configResolved`): reject `envPrefix` other than exactly `VITE_`; reject `define` keys `process.env`, `import.meta.env`, `process`; reject `define` values that are secret-shaped or keys that end in a secret-ish name; reject any `VITE_*` variable whose name looks secret (allow-list: `VITE_VERCEL_*`, `*_PUBLISHABLE_KEY`, `*_PUBLIC_KEY`, `*_SITE_KEY`, plus explicit names).
2. **Source time** (plugin `transform`, `enforce: 'pre'`): scan first-party modules before Rolldown inlines constants and drops local names.
3. **Bundle time** (plugin `generateBundle`): ban server-only modules from every client chunk via `chunk.moduleIds` (packages: stripe, @aws-sdk, @smithy, @neondatabase, drizzle-orm, drizzle-kit, @simplewebauthn/server, resend, pg, postgres; first-party paths: `/api/`, `/server/`, `*.server.ts`), and search emitted code for server env names and values. `this.error(...)` aborts the build (exit 1).
4. **After the build** (CLI, authoritative): `vite build && node scripts/scan-client-bundle.mjs dist`. This is the only layer that sees `public/` files, HTML, CSS, JSON, binary assets and sourcemaps.

Server-only variables are defined as: every name in `.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local` that does not start with `envPrefix`, plus every `process.env` entry whose name matches a secret-ish pattern (`secret|password|token|credential|private|api_key|*_KEY|database_url|postgres|dsn|webhook|salt|hmac|signing|kms`), plus explicit `--server-names`. Their values (8+ characters, not `true`/`production`/...) are searched in the raw, JSON-escaped, URL-encoded, base64 and base64url forms.

Vercel context (all accessed 2026-09-29):

| Claim | Source | Quote |
|---|---|---|
| Build can read env vars | https://vercel.com/docs/environment-variables | "Your source code can read these values to change behavior during the Build Step or during Function execution." |
| Secret values are write-only, and are redacted in build logs only when 32+ characters and verbatim | https://vercel.com/docs/environment-variables/sensitive-environment-variables | "Secret values are write-only after saving." / "During builds, if a Secret environment variable value is 32 characters or longer and appears in build logs, Vercel replaces the value with [REDACTED]." |
| Vercel injects `VITE_`-prefixed system variables into Vite builds (must be allow-listed, e.g. `VITE_VERCEL_HASH_SALT`) | https://vercel.com/docs/environment-variables/framework-environment-variables | "Vercel adds these prefixes automatically for your production and preview deployments"; list includes `VITE_VERCEL_ENV`, `VITE_VERCEL_URL`, `VITE_VERCEL_HASH_SALT`, `VITE_VERCEL_GIT_PROVIDER` |
| Build Command can be overridden or be the `package.json` build script | https://vercel.com/docs/builds/configure-a-build | "Depending on the framework, the Build Command can refer to the project's package.json file." / "If you'd like to override the Build Command for all deployments in your Project, you can turn on the Override toggle and specify the custom command." |

Implication: the scanner must never print a value (Vercel redacts only whole verbatim Secret values of 32+ characters, not prefixes or fragments). Measured: 0 of the 43 planted secrets appear in the scanner's text or JSON output.

---

## 3. Secret shapes and prior art (what each rule is based on)

| Rule id | Shape used | Source (accessed 2026-09-29) | Quote / evidence | Confidence |
|---|---|---|---|---|
| stripe-secret-key | `sk_` or `rk_` + `live` / `test` / `prod` / `org`, then 16+ alphanumerics. `pk_*` is deliberately NOT flagged | https://docs.stripe.com/keys.md | "Sandbox keys start with `pk_test_` for publishable keys, `rk_test_` for restricted keys, and `sk_test_` for secret keys." / live keys "start with `pk_live_`, `rk_live_`, and `sk_live_`." / "Organization API key `sk_org_...`" / "Only publishable keys are safe to expose outside your application's backend." Prior art: gitleaks `stripe-access-token` `\b((?:sk\|rk)_(?:test\|live\|prod)_[a-zA-Z0-9]{10,99})` (https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml) | prefixes high; body length medium (docs give no length) |
| stripe-webhook-secret | `whsec_` + 16+ chars | https://docs.stripe.com/webhooks.md | "a signing secret beginning with `whsec_` appears." | prefix high |
| aws-access-key-id | `AKIA` / `ASIA` + 16 uppercase alphanumerics; skip values ending `EXAMPLE` | https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html | table: "AKIA \| Access key", "ASIA \| Temporary (AWS STS) access key IDs use this prefix, but are unique only in combination with the secret access key and the session token." API ref https://docs.aws.amazon.com/IAM/latest/APIReference/API_AccessKey.html: AccessKeyId "Minimum length of 16. Maximum length of 128. Pattern: [\w]+". gitleaks `aws-access-token`: `(?:A3T[A-Z0-9]\|AKIA\|ASIA\|ABIA\|ACCA)[A-Z2-7]{16}` with allowlist `.+EXAMPLE$` | prefix high; 20-char length medium (from the official example `AKIAIOSFODNN7EXAMPLE`, https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html) |
| aws-secret-access-key | 40 base64 chars right after `aws_secret_access_key` / `secretAccessKey` | same access-keys page | example `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` (40 chars); API ref lists SecretAccessKey as "Type: String" with no length | length medium-low (example only) |
| pem-private-key | `-----BEGIN [RSA\|EC\|DSA\|OPENSSH\|ENCRYPTED\|PGP ]PRIVATE KEY[ BLOCK]-----` followed by 40+ base64 chars = error; header alone = warning | https://www.rfc-editor.org/rfc/rfc7468.txt | "Unencrypted PKCS #8 Private Key Information Syntax structures ... are encoded using the "PRIVATE KEY" label." plus the "ENCRYPTED PRIVATE KEY" label. Prior art gitleaks `private-key`: `-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----` | RFC labels high; RSA/EC/OPENSSH/PGP labels are convention, not RFC 7468 (medium) |
| gcp-service-account-json | `"type": "service_account"` or `"private_key_id": "<hex>"`, with up to 3 backslashes before quotes (JSON inside a JS string) | https://docs.cloud.google.com/iam/docs/keys-create-delete | key file is `{ "type": "service_account", "project_id": ..., "private_key_id": ..., "private_key": "-----BEGIN PRIVATE KEY-----\n PRIVATE_KEY \n-----END PRIVATE KEY-----\n", "client_email": ... }` | high |
| db-url-with-credentials | `postgres(ql)://user:password@host` (also mysql, mariadb, mongodb, redis, amqp); documentation placeholders (`password`, `${...}`, `<...>`) = warning | https://www.postgresql.org/docs/current/libpq-connect.html ; https://neon.com/docs/connect/connect-from-any-app | "The URI scheme designator can be either postgresql:// or postgres://." example `postgresql://user:secret@localhost`; Neon: "A Neon connection string includes the role, password, hostname, and database name." with `postgresql://alex:<password>@ep-cool-darkness-a1b2c3d4-pooler.us-east-2.aws.neon.tech/dbname?sslmode=require&channel_binding=require` (the docs show a fake password there; replaced here so this file does not itself look like a leaked URL) | high |
| jwt | `eyJ...` `.` `eyJ...` `.` sig, header must base64url-decode to JSON with a string `alg` | https://www.rfc-editor.org/rfc/rfc7519.txt | "A JWT is represented as a sequence of URL-safe parts separated by period ('.') characters. Each part contains a base64url-encoded value." RFC example header `eyJ0eXAiOiJKV1QiLA0K...`. Derived and checked in Node: base64url of `{"alg"`, `{"typ"`, `{"kid"` all start `eyJ` (a header starting `{"1` gives `eyI`, which is why the JSON decode check is used) | high |
| github-token | `ghp_ gho_ ghu_ ghs_ ghr_` + 36+ alphanumerics; `github_pat_` + 22+; and the new `ghs_<appid>_<JWT>` form | https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github | token-type table: `ghp_` classic PAT, `github_pat_` fine-grained PAT, `gho_` OAuth, `ghu_` user-to-server, `ghs_` installation, `ghr_` refresh. Note: "Starting April 27, 2026, GitHub began a staged rollout of a stateless format ( ghs_APPID_JWT ) to all newly minted GitHub App installation tokens". Blog https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/ : "We are including specific 3 letter prefixes". gitleaks: `ghp_[0-9a-zA-Z]{36}`, `github_pat_\w{82}` | prefixes high; lengths from gitleaks (medium) |
| resend-api-key | `re_` + 6-16 alnum + `_` + 16-48 alnum | https://resend.com/docs/api-reference/api-keys/create-api-key.md | response example `"token": "re_c1tpEyD8_<24 chars>"` (`re_` + 8 + `_` + 24; the 24-char tail is elided here). Docs also say "You cannot view or edit an API key value after it has been created." (https://resend.com/docs/dashboard/api-keys/introduction.md). gitleaks has no Resend rule | prefix medium; length LOW (single example) |
| mosshatch-agent-token | `mh_live_` / `mh_test_` + 16+ `[A-Za-z0-9_-]`; bare prefix in UI copy is allowed | project-defined | Repo has no commits; format is an assumption | unverified |
| uuid-under-secret-name | (warning) UUID v4 literal after a STRONG secret-ish name | measured, not from a provider doc | 5000/5000 flagged as warn under `apiKey`, 0/5000 under `sessionId` | n/a |
| high-entropy-near-name | quoted literal right after `:` or `=` whose property name is secret-ish, 20-256 chars, passes shape filters and a Shannon threshold | prior art: detect-secrets https://raw.githubusercontent.com/Yelp/detect-secrets/master/detect_secrets/plugins/high_entropy_strings.py : `class Base64HighEntropyString ... def __init__(self, limit: float = 4.5)`, `class HexHighEntropyString ... limit: float = 3.0`; gitleaks `generic-api-key` `entropy = 3.5` | thresholds measured in section 7.5 | n/a |

---

## 4. The script (final text, adopt as `scripts/scan-client-bundle.mjs`)

Dependency-free, read-only, Node >= 20 (tested 22.22.2 and 24.21.0). Exit 0 clean, 1 findings, 2 usage or empty scan (an empty `dist/` must fail, not pass).

```js
#!/usr/bin/env node
// scan-client-bundle.mjs
// Mosshatch Phase 4 gate: "no secret in the client bundle".
// Dependency-free ES module. Node >= 20 (built-ins only). Read-only: no network, no writes.
//
//   node scripts/scan-client-bundle.mjs [dist] [options]
//     --env-dir <dir>        where .env* files live (default: .)   -> server-only values/names are hunted in dist
//     --mode <mode>          Vite mode for .env.<mode> (default: production)
//     --env-prefix <p,p>     Vite envPrefix (default: VITE_)      -> vars WITHOUT it are "server-only"
//     --server-names <a,b>   extra server-only variable names (values read from process.env if set)
//     --no-process-env       do not treat sensitive-looking process.env entries as server-only
//     --allow <file.json>    {"fingerprints":[{"fp":"ab12..","reason":".."}],"publicVars":["VITE_X"],"serverValueIgnore":["NAME"]}
//     --entropy-b64 <n>      Shannon threshold, base64/base64url value after a WEAK name (key/auth/salt)   (default 4.0)
//     --entropy-b64-strong <n> same, after a STRONG name (secret/password/token/apiKey/...)              (default 3.5)
//     --entropy-hex <n>      Shannon threshold for hex values (>= 32 chars)                              (default 3.0)
//     --no-entropy           disable the entropy heuristic
//     --report-unnamed       also list (info only, never fails) high-entropy tokens that are NOT near a secret-ish name
//     --strict               warnings fail the build too
//     --json                 machine-readable output
// Exit codes: 0 clean, 1 findings (errors, or warnings with --strict), 2 usage / nothing scanned.
//
// Findings never print the secret: only rule id, location, a fixed known prefix, length and a
// sha256 fingerprint (first 12 hex) that can be pasted into the allowlist.

import { readdir, readFile } from 'node:fs/promises';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, basename, extname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------- helpers
export function shannon(s) {
  if (!s.length) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}
const fp = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const isJson = (s) => { try { const v = JSON.parse(s); return v !== null && typeof v === 'object' ? v : null; } catch { return null; } };

// Where the secret-ish name appears immediately before a quoted literal, e.g. `apiKey:"..."`, `password = '...'`.
export const STRONG_NAME = /(secret|passw(or)?d|passwd|(?<![A-Za-z])pwd(?![A-Za-z])|token|credential|api[_-]?key|apikey|private[_-]?key|privatekey|access[_-]?key|signing[_-]?key|encryption[_-]?key|master[_-]?key|hmac|bearer|authorization)/i;
export const WEAK_NAME = /(?:^|[^a-z])(?:key|auth|salt|dsn|signature)$|[a-z](?:Key|Auth|Salt|Dsn)$/;
// names that hold public / non-secret values by design
export const BENIGN_NAME = /(public|publishable|pubkey|pub_|sitekey|site_key|recaptcha|turnstile|integrity|checksum|hash|etag|nonce|csrf|xsrf|uuid|guid|challenge|credentialid|credential_id|rpid|kid$|keyid|key_id|storagekey|storage_key|cachekey|cache_key|localstoragekey|i18n|translation|tokenizer|tokentype|token_type|tokenlist|keycode|keyname|keypath|keyframe)/i;

// ---------------------------------------------------------------- specific-pattern rules
// severity: error fails the build; warn fails only with --strict.
// Prefix facts: see dossier section "Secret shapes" for the primary source of each.
export const RULES = [
  { id: 'stripe-secret-key', sev: 'error', needles: ['sk_', 'rk_'], prefix: /^(?:sk|rk)_(?:live|test|prod|org)_(?:(?:live|test)_)?/,
    lb: /[A-Za-z0-9]/, re: /(?:sk|rk)_(?:live|test|prod|org)_(?:(?:live|test)_)?[A-Za-z0-9]{16,}/g },
  { id: 'stripe-webhook-secret', sev: 'error', needles: ['whsec_'], prefix: /^whsec_/,
    lb: /[A-Za-z0-9]/, re: /whsec_[A-Za-z0-9+/=_-]{16,}/g },
  { id: 'aws-access-key-id', sev: 'error', needles: ['AKIA', 'ASIA'], prefix: /^A[KS]IA/,
    lb: /[A-Za-z0-9]/, re: /A[KS]IA[A-Z0-9]{16}(?![A-Za-z0-9])/g,
    accept: (m) => !/EXAMPLE$/.test(m[0]) },
  { id: 'aws-secret-access-key', sev: 'error', needles: ['ecret'], prefix: null,
    re: /(?:aws[_\-. ]?secret[_\-. ]?(?:access[_\-. ]?)?key|secretAccessKey)["'`\s:=]{1,8}([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi,
    accept: (m) => !/EXAMPLEKEY$/.test(m[1]) && shannon(m[1]) >= 3.5 },
  { id: 'pem-private-key', sev: 'error', needles: ['-----BEGIN'], prefix: /^-----BEGIN [A-Z ]+-----/,
    re: /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----(?:(?:\\+[rn]|\s)*)([A-Za-z0-9+/=]{40,})?/g,
    // header-only string (a PEM parser's label constant) is a warning; header + base64 body is a leaked key
    sevOf: (m) => (m[1] ? 'error' : 'warn') },
  { id: 'gcp-service-account-json', sev: 'error', needles: ['service_account', 'private_key_id'], prefix: null,
    re: /(?:type\\{0,3}["']?\s*:\s*\\{0,3}["']service_account\\{0,3}["']|private_key_id\\{0,3}["']?\s*:\s*\\{0,3}["'][0-9a-f]{20,}\\{0,3}["'])/g },
  { id: 'gcp-service-account-email', sev: 'warn', needles: ['.iam.gserviceaccount.com'], prefix: null,
    re: /[a-z0-9-]{3,}@[a-z0-9-]{3,}\.iam\.gserviceaccount\.com/g },
  { id: 'db-url-with-credentials', sev: 'error', needles: ['://'], prefix: /^[a-z+]+:\/\//,
    lb: /[A-Za-z0-9+.-]/, re: /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/([^\s:@/"'`\\<>]{0,128}):([^\s@/"'`\\<>]{1,256})@[^\s"'`\\<>]{3,}/g,
    // `user:password@host`-style documentation placeholders are warnings, real-looking passwords are errors
    sevOf: (m) => (/^(?:password|pass|passwd|pwd|secret|changeme|x{3,}|\*+|\$\{[^}]*\}|%s|\{[^}]*\}|<[^>]*>|\[[^\]]*\])$/i.test(m[2]) ? 'warn' : 'error') },
  { id: 'jwt', sev: 'error', needles: ['eyJ'], prefix: /^eyJ/,
    lb: /[A-Za-z0-9_-]/, re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*(?![A-Za-z0-9_-])/g,
    // header must decode to JSON with a string "alg"; kills random base64 that merely starts with eyJ
    accept: (m) => { const [h, p] = m[0].split('.'); const hj = isJson(b64urlDecode(h)); return !!hj && typeof hj.alg === 'string' && !!isJson(b64urlDecode(p)); } },
  { id: 'github-token', sev: 'error', needles: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'], prefix: /^(?:gh[pousr]_|github_pat_)/,
    lb: /[A-Za-z0-9]/, re: /(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255}|ghs_[0-9]{1,20}_eyJ[A-Za-z0-9_.-]{30,})(?![A-Za-z0-9])/g },
  { id: 'resend-api-key', sev: 'error', needles: ['re_'], prefix: /^re_/,
    lb: /[A-Za-z0-9]/, re: /re_[A-Za-z0-9]{6,16}_[A-Za-z0-9]{16,48}(?![A-Za-z0-9_])/g },
  { id: 'mosshatch-agent-token', sev: 'error', needles: ['mh_live_', 'mh_test_'], prefix: /^mh_(?:live|test)_/,
    lb: /[A-Za-z0-9]/, re: /mh_(?:live|test)_[A-Za-z0-9_-]{16,}/g },
];

// ---------------------------------------------------------------- entropy heuristic
// `<name>["']?\s*[:=]\s*["'`]<value>["'`]` with a secret-ish name and a long token-shaped, high-entropy value.
export const VALUE_LITERAL = /[:=]\s{0,3}\\{0,2}(["'`])((?:Bearer |Basic )?[A-Za-z0-9+/_\-=]{20,4096})\\{0,2}\1/g;
const PLACEHOLDER = /^(?:.*EXAMPLE(?:KEY)?|x{6,}|\*{6,}|0{8,}|1234567890+|(?:abc|xyz)[a-z]*|your[_-]?.*|change[_-]?me|example.*|placeholder.*|replace[_-]?me.*|dummy.*|redacted|test[_-]?(?:key|token|secret).*)$/i;

function hasAscendingRun(s, n) { let run = 1; for (let i = 1; i < s.length; i++) { run = s.charCodeAt(i) === s.charCodeAt(i - 1) + 1 ? run + 1 : 1; if (run >= n) return true; } return false; }

export function entropyCandidate(name, rawValue, opt) {
  const no = (why) => ({ ok: false, why });
  if (BENIGN_NAME.test(name)) return no('benign-name');
  const strong = STRONG_NAME.test(name);
  if (!strong && !WEAK_NAME.test(name)) return no('name-not-secret-ish');
  const value = rawValue.replace(/^(?:Bearer|Basic) /, '');
  if (value.length < 20 || value.length > 256) return no('length');
  if (PLACEHOLDER.test(value) || /^sha(?:1|256|384|512)-/.test(value)) return no('placeholder-or-sri');
  const isHex = /^[0-9a-fA-F]+$/.test(value);
  if (isHex && value.length < 32) return no('hex-too-short');
  // identifier-shaped values. Random base64/alnum secrets essentially never look like this (P < 1e-5 at 24 chars).
  if (!/[A-Z]/.test(value) && !isHex) return no('lowercase-identifier');                       // header names, error codes, kebab/snake words
  if (/^[a-z]{2,}[0-9]*(?:[A-Z][a-z]{2,}[0-9]*)+$/.test(value)) return no('camelCase-identifier');   // words of >= 3 letters, so random base62 rarely matches
  if (/^(?:[A-Z][a-z]{2,}[0-9]*){3,}$/.test(value)) return no('PascalCase-identifier');
  if (/^[A-Za-z][a-z0-9]*(?:[-_.][A-Za-z][a-z0-9]*){2,}$/.test(value)) return no('kebab-snake-words');   // X-Amz-Security-Token
  if (/^\/[a-z0-9_-]{1,20}\/[A-Za-z0-9_/-]+$/.test(value) || /^(?:\.\.?\/|~)/.test(value)) return no('path');   // /assets/x, ./x, ~/x (base64 that merely starts with '/' still passes)
  if ((value.match(/\//g) ?? []).length >= 2 && /^[a-z0-9./_-]+$/.test(value)) return no('path');
  if (hasAscendingRun(value, 8)) return no('alphabet-like');
  const h = shannon(value);
  // strong names (secret/password/token/...) tolerate a lower threshold than weak ones (key/auth/salt)
  const limit = isHex ? opt.entropyHex : strong ? opt.entropyB64Strong : opt.entropyB64;
  if (h < limit) return no('entropy-below-threshold');
  return { ok: true, entropy: h, strong };
}

// ---------------------------------------------------------------- core text scan
export function scanText(text, file, opt = {}) {
  const o = { entropy: true, entropyB64: 4.0, entropyB64Strong: 3.5, entropyHex: 3.0, reportUnnamed: false, decodeB64: true, ...opt };
  const out = [];
  const nl = []; // lazily-built newline index
  let nlBuilt = false;
  const loc = (off) => {
    if (!nlBuilt) { for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) nl.push(i); nlBuilt = true; }
    let lo = 0, hi = nl.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < off) lo = mid + 1; else hi = mid; }
    return { line: lo + 1, col: off - (lo ? nl[lo - 1] + 1 : -1) };
  };
  const push = (rule, sev, off, len, matchStr, extra = {}) =>
    out.push({ rule, severity: sev, file, offset: off, length: len, ...loc(off), fingerprint: fp(matchStr), ...extra });

  for (const r of RULES) {
    if (!r.needles.some((n) => text.includes(n))) continue;
    r.re.lastIndex = 0;
    for (const m of text.matchAll(r.re)) {
      if (r.lb && !o.binary && m.index > 0 && r.lb.test(text[m.index - 1])) continue;   // binary files: no word-boundary requirement
      if (r.accept && !r.accept(m)) continue;
      const shown = r.prefix ? (m[0].match(r.prefix)?.[0] ?? '') : '';
      push(r.id, r.sevOf ? r.sevOf(m) : r.sev, m.index, m[0].length, m[0], { prefix: shown });
    }
  }

  if (o.entropy && (text.includes('=') || text.includes(':'))) {
    VALUE_LITERAL.lastIndex = 0;
    for (const m of text.matchAll(VALUE_LITERAL)) {
      const before = text.slice(Math.max(0, m.index - 80), m.index);
      const nm = before.match(/([A-Za-z_$][\w$.\-]*)\\{0,2}["'`]?\s{0,3}$/);
      const name = nm ? nm[1] : '';
      const c = name ? entropyCandidate(name, m[2], o) : null;
      if (c?.ok) {
        push('high-entropy-near-name', 'error', m.index, m[0].length, m[2], { name, entropy: +c.entropy.toFixed(2), valueLength: m[2].length });
      } else if (name && !c?.ok && UUID.test(m[2]) && STRONG_NAME.test(name) && !BENIGN_NAME.test(name)) {
        // UUID-format credentials have only ~122 random bits in a lowercase/dash shape the identifier filters reject: warn, do not fail
        push('uuid-under-secret-name', 'warn', m.index, m[0].length, m[2], { name, valueLength: m[2].length });
      } else if (o.reportUnnamed && m[2].length >= 32) {
        const v = m[2]; const isHex = /^[0-9a-fA-F]+$/.test(v);
        if (shannon(v) >= (isHex ? o.entropyHex + 0.5 : 4.5) && /[0-9]/.test(v) && /[A-Za-z]/.test(v))
          push('unnamed-high-entropy', 'info', m.index, m[0].length, v, { name, entropy: +shannon(v).toFixed(2), valueLength: v.length });
      }
    }
  }
  if (o.decodeB64) {
    // base64-wrapped secrets (e.g. GOOGLE_CREDENTIALS_B64): decode any long quoted base64 literal and re-run the prefix-anchored rules on the plaintext
    B64_LITERAL.lastIndex = 0;
    for (const m of text.matchAll(B64_LITERAL)) {
      const dec = Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
      if (dec.length < 20 || !PRINTABLE.test(dec)) continue;
      for (const f of scanText(dec, file, { ...o, entropy: false, decodeB64: false })) push(f.rule + '-in-base64', f.severity, m.index, m[0].length, m[2], { prefix: f.prefix });
    }
  }
  return dedupe(out);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64_LITERAL = /(["'`])([A-Za-z0-9+/_-]{40,65536}={0,2})\1/g;
const PRINTABLE = /^[\x09\x0a\x0d\x20-\x7e]+$/;

// overlapping findings: keep the most specific one (prefix-anchored rules beat the entropy heuristic), then the earliest
const rank = (f) => (f.rule === 'high-entropy-near-name' ? 2 : f.severity === 'info' ? 3 : 1);
function dedupe(list) {
  list.sort((a, b) => rank(a) - rank(b) || a.offset - b.offset);
  const res = [];
  for (const f of list) { if (f.severity !== 'info' && res.some((g) => g.severity !== 'info' && f.offset < g.offset + g.length && g.offset < f.offset + f.length)) continue; res.push(f); }
  return res.sort((a, b) => a.offset - b.offset);
}

// ---------------------------------------------------------------- env-based checks
const SENSITIVE_ENV_NAME = /(secret|passw(or)?d|passwd|pwd|token|credential|private|api[_-]?key|(?:^|_)key$|_key_|database_url|postgres|dsn|webhook|salt|hmac|signing|kms)/i;
const TRIVIAL_VALUES = new Set(['true', 'false', 'null', 'undefined', 'production', 'development', 'preview', 'test', 'localhost', 'http://localhost']);

export function parseDotenv(src) {
  // dotenv-compatible subset: export prefix, '..' and ".." quoting (double quotes expand \n), multi-line quoted values (PEM / JSON keys), trailing # comments
  const vars = {};
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if (q === '"' || q === "'" || q === '`') {
      let body = v.slice(1);
      while (!body.includes(q) && i + 1 < lines.length) body += '\n' + lines[++i];
      v = body.slice(0, body.indexOf(q));
      if (q === '"') v = v.replace(/\\n/g, '\n');
    } else v = v.replace(/\s+#.*$/, '');
    vars[m[1]] = v;
  }
  return vars;
}

export function collectServerVars({ envDir, mode, prefixes, extraNames, useProcessEnv, publicVars, ignoreNames = [] }) {
  const isClient = (n) => prefixes.some((p) => p && n.startsWith(p));
  const files = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
  const fromFiles = {};
  for (const f of files) { const p = join(envDir, f); if (existsSync(p)) Object.assign(fromFiles, parseDotenv(readFileSync(p, 'utf8'))); }
  const server = new Map();   // name -> value ('' if unknown)
  const suspiciousPublic = []; // client-prefixed names that look secret
  const consider = (name, value, source) => {
    if (ignoreNames.includes(name)) return;
    if (isClient(name)) {
      if (SENSITIVE_ENV_NAME.test(name) && !BENIGN_NAME.test(name) && !publicVars.some((re) => re.test(name))) {
        suspiciousPublic.push({ name, source });
        server.set(name, value);            // its value must not be in dist either
      }
      return;
    }
    server.set(name, value);
  };
  for (const [n, v] of Object.entries(fromFiles)) consider(n, v, '.env file');
  if (useProcessEnv) for (const [n, v] of Object.entries(process.env)) if (v && SENSITIVE_ENV_NAME.test(n) && !n.startsWith('npm_')) consider(n, v, 'process.env');
  for (const n of extraNames) if (!isClient(n)) server.set(n, process.env[n] ?? server.get(n) ?? '');
  return { server, suspiciousPublic };
}

export function scanServerVars(text, file, server) {
  const out = [];
  const lineCol = (off) => { const pre = text.slice(0, off); const line = pre.split('\n').length; return { line, col: off - (pre.lastIndexOf('\n') + 1) + 1 }; };
  for (const [name, value] of server) {
    if (name.length >= 8 && /[A-Z]/.test(name) && (name.includes('_') || name.length >= 10)) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')}(?![A-Za-z0-9_])`);
      const m = re.exec(text);
      if (m) out.push({ rule: 'server-env-name-in-client', severity: 'error', file, offset: m.index, length: name.length, ...lineCol(m.index), name, fingerprint: fp(name) });
    }
    if (value && value.length >= 8 && !TRIVIAL_VALUES.has(value.toLowerCase())) {
      const forms = new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value),
        Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')]);
      for (const f of forms) {
        if (f.length < 8) continue;
        const i = text.indexOf(f);
        if (i !== -1) { out.push({ rule: 'server-env-value-in-client', severity: 'error', file, offset: i, length: f.length, ...lineCol(i), name, fingerprint: fp(value) }); break; }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- filesystem walk
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.wasm', '.glb', '.ktx2', '.basis', '.hdr', '.exr', '.mp3', '.ogg', '.wav', '.mp4', '.webm', '.bin', '.dds', '.drc']);
const COMPRESSED_EXT = new Set(['.gz', '.br', '.zip', '.zst', '.tgz', '.7z']);
const DANGEROUS_FILE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore|sqlite3?|db)|id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc|\.git-credentials|(?:service[-_]?account|credentials?|secrets?)[^/]*\.json|terraform\.tfstate.*)$/i;

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else if (e.isFile()) yield p;
  }
}

export async function scanDir(dist, options = {}) {
  const t0 = process.hrtime.bigint();
  const findings = []; const skipped = []; let files = 0, bytes = 0;
  const server = options.server;
  for await (const p of walk(dist)) {
    const rel = relative(dist, p) || basename(p);
    const ext = extname(p).toLowerCase();
    if (DANGEROUS_FILE.test(basename(p))) findings.push({ rule: 'dangerous-file-in-dist', severity: 'error', file: rel, offset: 0, length: 0, line: 0, col: 0, fingerprint: fp(rel) });
    if (COMPRESSED_EXT.has(ext)) { skipped.push({ file: rel, why: 'compressed (scan the uncompressed build output)' }); continue; }
    const buf = await readFile(p);
    files++; bytes += buf.length;
    if (buf.length > 200 * 1024 * 1024) { skipped.push({ file: rel, why: 'larger than 200 MB' }); continue; }
    const binary = BINARY_EXT.has(ext) || buf.subarray(0, 8192).includes(0);
    const text = buf.toString(binary ? 'latin1' : 'utf8');
    if (ext === '.map') {
      const map = isJson(text);
      if (map && Array.isArray(map.sourcesContent)) {
        map.sourcesContent.forEach((src, i) => {
          if (typeof src !== 'string') return;
          const name = `${rel}#${map.sources?.[i] ?? i}`;
          for (const f of scanText(src, name, options)) findings.push(f);
          if (server) for (const f of scanServerVars(src, name, server)) findings.push(f);
        });
        continue;
      }
    }
    // binary: only prefix-anchored rules (entropy heuristic is text-only)
    for (const f of scanText(text, rel, binary ? { ...options, entropy: false, binary: true } : options)) findings.push(f);
    if (server) for (const f of scanServerVars(text, rel, server)) findings.push(f);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { findings, skipped, files, bytes, ms };
}

// ---------------------------------------------------------------- CLI
function applyAllow(findings, allowPath) {
  if (!allowPath) return { kept: findings, allowed: [] };
  const allow = JSON.parse(readFileSync(allowPath, 'utf8'));
  const ok = new Set((allow.fingerprints ?? []).map((x) => x.fp));
  for (const x of allow.fingerprints ?? []) if (!x.reason) throw new Error(`allowlist entry ${x.fp} needs a "reason"`);
  return { kept: findings.filter((f) => !ok.has(f.fingerprint)), allowed: findings.filter((f) => ok.has(f.fingerprint)) };
}

export async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'env-dir': { type: 'string', default: '.' }, mode: { type: 'string', default: 'production' },
    'env-prefix': { type: 'string', default: 'VITE_' }, 'server-names': { type: 'string', default: '' },
    'no-process-env': { type: 'boolean', default: false }, allow: { type: 'string' },
    'entropy-b64': { type: 'string', default: '4.0' }, 'entropy-b64-strong': { type: 'string', default: '3.5' }, 'entropy-hex': { type: 'string', default: '3.0' },
    'no-entropy': { type: 'boolean', default: false }, 'report-unnamed': { type: 'boolean', default: false },
    strict: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
  } });
  const dist = resolve(positionals[0] ?? 'dist');
  if (!existsSync(dist) || !statSync(dist).isDirectory()) { console.error(`scan: ${dist} is not a directory (did the build run?)`); return 2; }

  let publicVars = [/^VITE_VERCEL_/, /(?:PUBLISHABLE|PUBLIC|SITE)_KEY$/];
  if (values.allow) publicVars = publicVars.concat((JSON.parse(readFileSync(values.allow, 'utf8')).publicVars ?? []).map((s) => new RegExp(`^${s}$`)));
  const prefixes = values['env-prefix'].split(',').filter(Boolean);
  const { server, suspiciousPublic } = collectServerVars({
    envDir: resolve(values['env-dir']), mode: values.mode, prefixes,
    extraNames: values['server-names'].split(',').filter(Boolean), useProcessEnv: !values['no-process-env'], publicVars,
    ignoreNames: values.allow ? (JSON.parse(readFileSync(values.allow, 'utf8')).serverValueIgnore ?? []) : [] });

  const res = await scanDir(dist, { server, entropy: !values['no-entropy'], entropyB64: +values['entropy-b64'], entropyB64Strong: +values['entropy-b64-strong'], entropyHex: +values['entropy-hex'], reportUnnamed: values['report-unnamed'] });
  for (const s of suspiciousPublic) res.findings.push({ rule: 'client-prefixed-var-looks-secret', severity: 'error', file: `env:${s.name}`, offset: 0, length: 0, line: 0, col: 0, name: s.name, fingerprint: fp(s.name) });
  const { kept, allowed } = applyAllow(res.findings, values.allow);

  const errors = kept.filter((f) => f.severity === 'error'), warns = kept.filter((f) => f.severity === 'warn'), infos = kept.filter((f) => f.severity === 'info');
  const summary = { dist, files: res.files, bytes: res.bytes, ms: +res.ms.toFixed(1), maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), errors: errors.length, warnings: warns.length, info: infos.length, allowlisted: allowed.length, skipped: res.skipped };
  if (values.json) console.log(JSON.stringify({ summary, findings: kept }, null, 2));
  else {
    for (const f of kept) {
      const extra = [f.name && `name=${f.name}`, f.prefix && `prefix=${f.prefix}`, f.entropy && `H=${f.entropy}`, f.valueLength && `len=${f.valueLength}`].filter(Boolean).join(' ');
      console.error(`${f.severity.toUpperCase().padEnd(5)} ${f.rule.padEnd(28)} ${f.file}:${f.line}:${f.col} ${extra} fp=${f.fingerprint}`);
    }
    for (const s of res.skipped) console.error(`SKIP  ${s.file} (${s.why})`);
    console.error(`scanned ${res.files} files, ${(res.bytes / 1024).toFixed(0)} KiB in ${res.ms.toFixed(0)} ms (rss ${summary.maxRssMiB} MiB): ${errors.length} error(s), ${warns.length} warning(s)${allowed.length ? `, ${allowed.length} allowlisted` : ''}`);
  }
  if (res.files === 0) { console.error('scan: no files found in dist - refusing to pass an empty scan'); return 2; }
  return errors.length || (values.strict && warns.length) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
}
```

### 4.1 Companion Vite plugin (adopt as `scripts/vite-secret-guard.mjs`)

```js
// vite-secret-guard.mjs - fail-the-build Vite plugin (Vite >= 6; tested on 8.3.1). Companion to scan-client-bundle.mjs.
// Catches leaks at four points; the post-build CLI scan of dist/ stays the authoritative last gate (it also sees public/ files).
//   config           : envPrefix widening, `define` that dumps process.env / import.meta.env or carries secret-shaped values
//   configResolved   : what Vite will expose (cfg.env: VITE_* etc.) - secret-looking names or secret-shaped values
//   transform (pre)  : first-party source, BEFORE the bundler inlines/mangles constant names (this is where `const apiKey = "..."` is visible)
//   generateBundle   : module graph of every client chunk (forbidden server-only modules) + server env names/values in emitted code
import { scanText, collectServerVars, scanServerVars, STRONG_NAME } from './scan-client-bundle.mjs';

// third-party packages that must never reach the browser bundle (server SDKs of the planned stack)
const FORBIDDEN_PACKAGES = /[\\/]node_modules[\\/](?:stripe|@aws-sdk|@smithy|@neondatabase|drizzle-orm|drizzle-kit|@simplewebauthn[\\/]server|resend|pg|postgres)[\\/]/;
// first-party paths that are server-only (Vercel functions dir, server/ dir, *.server.ts)
const FORBIDDEN_PATHS = [/[\\/](?:api|server)[\\/]/, /\.server\.[cm]?[jt]sx?$/];

export function secretGuard(opts = {}) {
  const forbiddenPkgs = opts.forbiddenPackages ?? FORBIDDEN_PACKAGES;
  const forbiddenPaths = opts.forbiddenPaths ?? FORBIDDEN_PATHS;
  const isForbidden = (id) => (/[\\/]node_modules[\\/]/.test(id) ? forbiddenPkgs.test(id) : forbiddenPaths.some((re) => re.test(id)));
  const publicVars = opts.publicVars ?? [/^VITE_VERCEL_/, /(?:PUBLISHABLE|PUBLIC|SITE)_KEY$/, /^VITE_(?:APP|API|RP|WEBAUTHN)_[A-Z_]*(?:ID|ORIGIN|URL|NAME)$/];
  let server = new Map();
  const cwd = process.cwd();
  const fmt = (fs) => fs.map((f) => `  ${f.severity} ${f.rule} ${f.file}:${f.line}:${f.col}${f.name ? ` name=${f.name}` : ''}${f.prefix ? ` prefix=${f.prefix}` : ''} fp=${f.fingerprint}`).join('\n');

  return {
    name: 'mosshatch-secret-guard',
    apply: 'build',
    enforce: 'pre',

    config(user) {
      const prefixes = [user.envPrefix ?? 'VITE_'].flat();
      if (prefixes.some((p) => p !== 'VITE_')) throw new Error(`[secret-guard] envPrefix must be exactly "VITE_" (got ${JSON.stringify(prefixes)})`);
      for (const [k, v] of Object.entries(user.define ?? {})) {
        if (k === 'process.env' || k === 'import.meta.env' || k === 'process') throw new Error(`[secret-guard] define["${k}"] would inline a whole environment object into the client bundle`);
        const text = typeof v === 'string' ? v : JSON.stringify(v);
        const bad = scanText(`${k}:${text}`, `define:${k}`).filter((f) => f.severity === 'error');
        if (bad.length) throw new Error(`[secret-guard] define["${k}"] carries a secret-shaped value:\n${fmt(bad)}`);
        if (/^(?:process\.env|import\.meta\.env)\./.test(k) && STRONG_NAME.test(k.split('.').pop())) throw new Error(`[secret-guard] define["${k}"] exposes a secret-named variable to the client`);
      }
    },

    configResolved(cfg) {
      const collected = collectServerVars({ envDir: cfg.envDir || cfg.root, mode: cfg.mode, prefixes: ['VITE_'], extraNames: opts.serverNames ?? [], useProcessEnv: true, publicVars });
      server = collected.server;
      if (collected.suspiciousPublic.length) throw new Error(`[secret-guard] client-exposed (VITE_) variable(s) with secret-looking names: ${collected.suspiciousPublic.map((s) => s.name).join(', ')} (rename without VITE_, or allow-list it)`);
      for (const [k, v] of Object.entries(cfg.env ?? {})) {
        const bad = scanText(`${k}:${JSON.stringify(v)}`, `env:${k}`).filter((f) => f.severity === 'error');
        if (bad.length) throw new Error(`[secret-guard] exposed env var ${k} has a secret-shaped value:\n${fmt(bad)}`);
      }
    },

    transform(code, id) {
      if (id.startsWith('\0') || id.includes('/node_modules/') || !/\.(?:[cm]?[jt]sx?|json)(?:\?|$)/.test(id)) return null;
      const bad = scanText(code, id.split('?')[0]).filter((f) => f.severity === 'error');
      if (bad.length) this.error(`[secret-guard] secret-shaped literal in first-party source:\n${fmt(bad)}`);
      return null;
    },

    generateBundle(_o, bundle) {
      const problems = [];
      for (const [file, item] of Object.entries(bundle)) {
        if (item.type === 'chunk') {
          const groups = new Map();   // collapse to one line per package / first-party file so the log stays readable
          for (const id of item.moduleIds) if (isForbidden(id)) {
            const m = id.match(/[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/);
            const key = m ? `node_modules/${m[1]}` : id.replace(cwd + '/', '');
            groups.set(key, (groups.get(key) ?? 0) + 1);
          }
          for (const [key, n] of groups) problems.push(`server-only code in client chunk ${file}: ${key}${n > 1 ? ` (${n} modules)` : ''}`);
          for (const f of scanServerVars(item.code, file, server)) problems.push(`${f.rule} ${file}:${f.line}:${f.col} name=${f.name} fp=${f.fingerprint}`);
          for (const f of scanText(item.code, file).filter((x) => x.severity === 'error')) problems.push(`${f.rule} ${file}:${f.line}:${f.col} fp=${f.fingerprint}`);
        } else if (typeof item.source === 'string') {
          for (const f of scanText(item.source, file).filter((x) => x.severity === 'error')) problems.push(`${f.rule} ${file}:${f.line}:${f.col} fp=${f.fingerprint}`);
        }
      }
      if (problems.length) this.error(`[secret-guard] ${problems.length} problem(s):\n  ${problems.slice(0, 20).join('\n  ')}`);
    },
  };
}
```

### 4.2 Wiring

```jsonc
// package.json
{
  "scripts": {
    "build": "vite build && node scripts/scan-client-bundle.mjs dist --env-dir . --allow scripts/secret-scan.allow.json",
    "test:secrets": "node --test scripts/"
  }
}
```

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { secretGuard } from './scripts/vite-secret-guard.mjs'
export default defineConfig({
  plugins: [react(), secretGuard()],
  envPrefix: 'VITE_',              // the default; the guard rejects anything else
  build: { sourcemap: false },     // if maps are ever needed, build them to a separate outDir and scan that too
})
```

```ts
// src/vite-env.d.ts  (Vite docs: "make the type of ImportMetaEnv strict to disallow unknown keys")
interface ViteTypeOptions { strictImportMetaEnv: unknown }
interface ImportMetaEnv { readonly VITE_API_ORIGIN: string; readonly VITE_RP_ID: string; readonly VITE_STRIPE_PUBLISHABLE_KEY: string }
interface ImportMeta { readonly env: ImportMetaEnv }
```

```jsonc
// scripts/secret-scan.allow.json  (every entry needs a reason; the script refuses entries without one)
{
  "fingerprints": [ { "fp": "0123456789ab", "reason": "public demo JWT, reviewed 2026-xx-xx" } ],
  "publicVars": [ "VITE_SOME_PUBLIC_TOKEN_URL" ],
  "serverValueIgnore": [ "SOME_SENSITIVE_NAMED_VAR_WHOSE_VALUE_IS_PUBLIC" ]
}
```

### 4.3 Test file (adopt as `scripts/scan-client-bundle.test.mjs`)

Fakes are assembled at run time, so no full-shape secret literal sits in the repository (avoids GitHub push protection tripping on the test itself).

```js
// scan-client-bundle.test.mjs - node:test (built-in, no dependencies). Run: node --test scripts/
// Every fake secret is assembled at run time, so no full-shape secret literal exists in the repository (keeps GitHub push protection quiet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { scanText, scanDir, main } from './scan-client-bundle.mjs';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rnd = (alpha, n) => Array.from(randomBytes(n), (b) => alpha[b % alpha.length]).join('');
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

const POSITIVE = {
  'stripe-secret-key': ['sk', 'live'].join('_') + '_' + rnd(ALNUM, 99),
  'stripe-webhook-secret': 'whsec' + '_' + rnd(ALNUM, 32),
  'aws-access-key-id': 'AKI' + 'A' + rnd('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16),
  'aws-secret-access-key': 'aws_secret_access_key = "' + rnd(ALNUM + '+/', 40) + '"',
  'pem-private-key': JSON.stringify(pem),
  'gcp-service-account-json': JSON.stringify(JSON.stringify({ type: 'service_account', private_key_id: rnd('0123456789abcdef', 40) })),
  'db-url-with-credentials': 'postgresql://owner:' + rnd(ALNUM, 24) + '@ep-x-pooler.us-east-2.aws.neon.tech/db?sslmode=require',
  jwt: [b64u({ alg: 'HS256', typ: 'JWT' }), b64u({ sub: 'a', exp: 4102444800 }), rnd(ALNUM, 43)].join('.'),
  'github-token': 'gh' + 'p_' + rnd(ALNUM, 36),
  'resend-api-key': 're_' + rnd(ALNUM, 8) + '_' + rnd(ALNUM, 24),
  'mosshatch-agent-token': 'mh_' + 'live_' + rnd(ALNUM, 32),
  'high-entropy-near-name': '{apiKey:"' + rnd(ALNUM + '+/', 40) + '"}',
};
const NEGATIVE = [
  ['pk', 'live'].join('_') + '_' + rnd(ALNUM, 99), 'keys start with sk_live_ or mh_live_', 'AKIAIOSFODNN7EXAMPLE',
  'postgres://localhost:5432/dev', '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----',
  '{integrity:"sha384-' + rnd(ALNUM, 64) + '"}', '{publicKey:"' + rnd(ALNUM, 88) + '"}', '{token:"aaaaaaaaaaaaaaaaaaaaaaaa"}',
  '{key:"someVeryLongTranslationKeyName"}', '{"x-aws-ec2-metadata-token":"x-aws-ec2-metadata-token-ttl-seconds"}', '{buildId:"' + rnd('0123456789abcdef', 40) + '"}',
];

for (const [rule, sample] of Object.entries(POSITIVE)) {
  test(`detects ${rule}`, () => {
    const hits = scanText(`var x=${/^[{"]/.test(sample) || sample.includes(' = ') ? sample : JSON.stringify(sample)};`, 'a.js').filter((f) => f.severity === 'error');
    assert.ok(hits.some((f) => f.rule === rule), `expected ${rule}, got ${hits.map((f) => f.rule)}`);
  });
}
test('does not flag negative controls', () => {
  for (const s of NEGATIVE) assert.deepEqual(scanText(s.startsWith('{') ? s : JSON.stringify(s), 'a.js').filter((f) => f.severity === 'error'), [], s.slice(0, 40));
});
test('finds a base64-wrapped secret', () => {
  const wrapped = Buffer.from(POSITIVE['stripe-secret-key']).toString('base64');
  assert.ok(scanText(`x={k:"${wrapped}"}`, 'a.js').some((f) => f.rule === 'stripe-secret-key-in-base64'));
});
test('never echoes the secret in a finding', () => {
  const s = POSITIVE['stripe-secret-key'];
  assert.ok(!JSON.stringify(scanText(JSON.stringify(s), 'a.js')).includes(s.slice(12)));
});
test('CLI: exit 1 on a planted secret, 0 on a clean dir, 2 on an empty dir', async () => {
  const d = mkdtempSync(join(tmpdir(), 'scan-')); mkdirSync(join(d, 'assets'));
  const quiet = (fn) => { const e = console.error; console.error = () => {}; return fn().finally(() => { console.error = e; }); };
  try {
    assert.equal(await quiet(() => main([d, '--no-process-env', '--env-dir', d])), 2);
    writeFileSync(join(d, 'assets', 'a.js'), 'console.log("hello")');
    assert.equal(await quiet(() => main([d, '--no-process-env', '--env-dir', d])), 0);
    writeFileSync(join(d, 'assets', 'b.js'), `x=${JSON.stringify(POSITIVE['github-token'])}`);
    assert.equal(await quiet(() => main([d, '--no-process-env', '--env-dir', d])), 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('server-only env value inlined by define is caught', async () => {
  const d = mkdtempSync(join(tmpdir(), 'scan-')); writeFileSync(join(d, '.env.production'), `SESSION_SECRET=${rnd('0123456789abcdef', 64)}\n`);
  const dist = join(d, 'dist'); mkdirSync(dist);
  try {
    const v = (await import('node:fs')).readFileSync(join(d, '.env.production'), 'utf8').split('=')[1].trim();
    writeFileSync(join(dist, 'a.js'), `var s="${v}";`);
    const { collectServerVars, scanServerVars } = await import('./scan-client-bundle.mjs');
    const { server } = collectServerVars({ envDir: d, mode: 'production', prefixes: ['VITE_'], extraNames: [], useProcessEnv: false, publicVars: [] });
    assert.ok(scanServerVars(`var s="${v}";`, 'a.js', server).some((f) => f.rule === 'server-env-value-in-client'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
```

---

## 5. Validation 1: planted fakes (43 positives, 27 negative controls)

Method: `make-fixtures.mjs` generates seeded fake secrets into `src/planted-pos.gen.ts` (43) and `src/planted-neg.gen.ts` (27), each bundled by Vite 8.3.1 into its own `dist/` (positives and negatives in separate bundles so any finding in the negative bundle is a false positive). `check-planted.mjs` finds each secret's byte position in the built output (or in the sourcemap's `sourcesContent`) and requires a finding overlapping it. Also built as one `dist/` together with the real kitchen sink (dynamic-import chunks `planted-pos.gen-*.js` and `planted-neg.gen-*.js` beside the three.js/R3F/drei chunks and three wasm files).

Result summary (measured):

| Variant | Positives detected | By the expected rule | Missed | Negative-control findings (27/27 present in bundle) |
|---|---|---|---|---|
| Vite 8.3.1, oxc minifier (default) | 41/43 | 40 | 2 local-variable fixtures | 0 |
| Vite 8.3.1, esbuild minifier | 41/43 | 40 | same 2 | 0 |
| Vite 8.3.1, `minify: false` | 41/43 | 40 | same 2 | 0 |
| Vite 8.3.1, sourcemap (`sourcesContent` scanned) | **43/43** | 42 | none | 0 |
| Combined dist (kitchen sink + planted chunks), oxc / esbuild / unminified | 41/43 each | 40 | same 2 | 0 findings outside the planted-pos chunk |

The one detection not by the expected rule: `ghs_<appid>_<JWT>` is reported as `github-token`, not `jwt` (fine). One detection is a warning, not an error: `db-template-literal` (`postgres://${user}:${pass}@${host}/db`, credentials built at run time, treated like a placeholder). In the combined oxc dist the planted chunk produced 41 errors and 3 warnings and **every other file (kitchen chunk, wasm, negative chunk) produced nothing**.

Why the 2 local-variable fixtures are missed in `dist/` even unminified: `const apiKey = "<40 b64>"` is constant-inlined by Rolldown, leaving `{ "x-k": "<value>" }` with no name (verified by reading the `minify: false` output: `return fetch("/x", { headers: { "x-k": "IToJi8S..." } })`). With source names visible (sourcemap or the plugin's `transform` hook, which failed the build in `G=localvar`) the same two fixtures are caught.

Per-fixture matrix (yes = finding overlaps the secret; kind: `prop` = appears as a property/value/JSON string, `local-var` = local constant):

| # | fixture | shape | expected rule | oxc-min | esbuild-min | unminified | sourcemap |
|---|---|---|---|---|---|---|---|
| 1 | stripe-sk-live-modern | prop | stripe-secret-key | yes | yes | yes | yes |
| 2 | stripe-sk-test-legacy | prop | stripe-secret-key | yes | yes | yes | yes |
| 3 | stripe-rk-live | prop | stripe-secret-key | yes | yes | yes | yes |
| 4 | stripe-sk-org-prefix-only-documented | prop | stripe-secret-key | yes | yes | yes | yes |
| 5 | stripe-whsec-b64 | prop | stripe-webhook-secret | yes | yes | yes | yes |
| 6 | stripe-whsec-hex64 | prop | stripe-webhook-secret | yes | yes | yes | yes |
| 7 | aws-akia | prop | aws-access-key-id | yes | yes | yes | yes |
| 8 | aws-asia | prop | aws-access-key-id | yes | yes | yes | yes |
| 9 | aws-secret-snake | prop | aws-secret-access-key | yes | yes | yes | yes |
| 10 | aws-secret-camel | prop | aws-secret-access-key | yes | yes | yes | yes |
| 11 | pem-pkcs8-rsa | prop | pem-private-key | yes | yes | yes | yes |
| 12 | pem-sec1-ec | prop | pem-private-key | yes | yes | yes | yes |
| 13 | pem-openssh-header+body | prop | pem-private-key | yes | yes | yes | yes |
| 14 | gcp-sa-json-string | prop | gcp-service-account-json | yes | yes | yes | yes |
| 15 | gcp-sa-object-literal | prop | gcp-service-account-json | yes | yes | yes | yes |
| 16 | db-neon-postgresql | prop | db-url-with-credentials | yes | yes | yes | yes |
| 17 | db-postgres-scheme | prop | db-url-with-credentials | yes | yes | yes | yes |
| 18 | db-template-literal | prop | db-url-with-credentials | yes | yes | yes | yes |
| 19 | jwt-hs256 | prop | jwt | yes | yes | yes | yes |
| 20 | jwt-rs256 | prop | jwt | yes | yes | yes | yes |
| 21 | github-ghp | prop | github-token | yes | yes | yes | yes |
| 22 | github-pat-fine | prop | github-token | yes | yes | yes | yes |
| 23 | github-gho | prop | github-token | yes | yes | yes | yes |
| 24 | github-ghs-jwt-format | prop | jwt | yes (github-token) | yes (github-token) | yes (github-token) | yes (github-token) |
| 25 | resend-key | prop | resend-api-key | yes | yes | yes | yes |
| 26 | mh-live-base62 | prop | mosshatch-agent-token | yes | yes | yes | yes |
| 27 | mh-test-base62 | prop | mosshatch-agent-token | yes | yes | yes | yes |
| 28 | mh-live-b64url-256bit | prop | mosshatch-agent-token | yes | yes | yes | yes |
| 29 | ent-apiKey-b64-40 | prop | high-entropy-near-name | yes | yes | yes | yes |
| 30 | ent-json-client_secret-32 | prop | high-entropy-near-name | yes | yes | yes | yes |
| 31 | ent-password-b64u-24 | prop | high-entropy-near-name | yes | yes | yes | yes |
| 32 | ent-secret-20-shortest | prop | high-entropy-near-name | yes | yes | yes | yes |
| 33 | ent-token-hex-40 | prop | high-entropy-near-name | yes | yes | yes | yes |
| 34 | ent-SESSION_SECRET-hex64 | prop | high-entropy-near-name | yes | yes | yes | yes |
| 35 | ent-HMAC_KEY-b64-44 | prop | high-entropy-near-name | yes | yes | yes | yes |
| 36 | ent-authorization-bearer | prop | high-entropy-near-name | yes | yes | yes | yes |
| 37 | ent-signingKey-template | prop | high-entropy-near-name | yes | yes | yes | yes |
| 38 | ent-kmsToken-in-header-name | prop | high-entropy-near-name | yes | yes | yes | yes |
| 39 | ent-privateKey-raw-b64 | prop | high-entropy-near-name | yes | yes | yes | yes |
| 40 | b64-wrapped-gcp-json | prop | gcp-service-account-json-in-base64 | yes | yes | yes | yes |
| 41 | b64-wrapped-stripe | prop | stripe-secret-key-in-base64 | yes | yes | yes | yes |
| 42 | ent-local-const-apiKey | local-var | high-entropy-near-name | **MISSED** | **MISSED** | **MISSED** | yes |
| 43 | ent-local-const-dbPassword | local-var | high-entropy-near-name | **MISSED** | **MISSED** | **MISSED** | yes |

Negative controls (all produced zero findings, error or warning, in all four variants): Stripe `pk_live_` and `pk_test_` keys; the bare text "sk_live_ or sk_test_" and "mh_live_ or mh_test_" in UI copy; AWS documentation example key id and secret (`...EXAMPLE`, `...EXAMPLEKEY`); Resend docs placeholder `re_xxxxxxxxx`; `postgres://localhost:5432/dev`; `postgresql://user@localhost/otherdb`; an `eyJ...eyJ...` string that is not a JWT; PEM `PUBLIC KEY` and `CERTIFICATE` blocks; a WebAuthn `publicKey` (88 b64url chars); an SRI `integrity: "sha384-..."`; `csrfToken` and WebAuthn `challenge` values; `key: "someVeryLongTranslationKeyName"`; `password: "your-password-here-please"`; `token: "aaaaaaaaaaaaaaaaaaaaaaaa"`; `apiKey: "YOUR_API_KEY_GOES_HERE"`; `secret: "kebab-case-long-identifier-name"`; a 64-hex `contentHash`; a 40-hex `buildId` (unnamed, by design not flagged); a UUID `sessionId`; `VITE_VERCEL_HASH_SALT=1783933175`; `tokenEndpoint: "https://.../auth/token/refresh"`; `token: "abc123"`.

Extra file-type checks (`dist-synth`, measured): a `ghp_` token in inline HTML script, an `AKIA` id in a CSS comment, `rk_live_` in SVG text, an entropy-flagged `apiSecret` in `manifest.webmanifest`, `whsec_` inside a `.wasm` binary (after fixing the word-boundary rule for binary files), `.env.local` and `id_rsa` in `dist/` (`dangerous-file-in-dist`), and `blob.br` reported as SKIPPED (compressed files are listed, never silently passed).

Source-level check (what the plugin's `transform` hook sees): running the same `scanText` over `src/planted-pos.gen.ts` detects **43/43** and `src/planted-neg.gen.ts` yields 0 findings; the plugin (`vite.guard.planted.config.ts`) aborts that build with 45 error lines and exit 1.

Other CLI behaviours verified: exit 1 on findings, 2 on an empty or missing `dist/`; `--strict` turns the 11 library warnings into failures (exit 1) and default mode passes them; allow-list by fingerprint works and an entry without `reason` is refused; the 43 planted secrets never appear in text or `--json` output.

---

## 6. Validation 2: false positives on real production output

Corpora (all built from real libraries; none contains a planted secret):

| Group | Builds | Dirs | Files | MiB scanned | Errors | Warnings |
|---|---|---|---|---|---|---|
| Vite 8.3.1, default oxc minifier | app (React 19.3 + named three imports + zustand + WebAuthn + Stripe.js + zod), kitchen sink (below), 13 `scratch-bundle` variants, `scratch-final`, `scratch-smoke`, leak-clean, plus 2 stress builds | 20 | 58 | 14.3 | 0 | 3 (stress only) |
| Vite 8.3.1, esbuild minifier | app, kitchen sink, 13 `scratch-bundle/dist-v8-esbuild` variants | 15 | 48 | 11.5 | 0 | 0 |
| Vite 8.3.1, `minify: false` | app, kitchen sink, 2 stress builds | 4 | 16 | 13.8 | 0 | 3 (stress only) |
| Vite 8.3.1, sourcemaps (every `sourcesContent` entry scanned) | app, kitchen sink, 3 `scratch-bundle/dist-map`, 2 stress builds | 7 | 33 | 35.9 | 0 | 5 (stress only) |
| Vite 7.3.6 (Rollup + esbuild) | 13 `scratch-bundle/compare-vite7` variants | 13 | 36 | 6.8 | 0 | 0 |
| **Total** | | **59** | **191** | **82.4** | **0** | **11** |

(Overlapping code is built in several configurations, so 82.4 MiB is scanned volume, not unique code.) The 53 dirs without stress libraries (three.js, React, R3F, drei, Stripe.js, zod, WebAuthn, zustand) produced no finding of any severity.

"Kitchen sink" = `import * as THREE from 'three'` plus GLTFLoader, DRACOLoader, KTX2Loader, MeshoptDecoder, EffectComposer, RenderPass, SMAAPass, UnrealBloomPass, OutputPass, RoomEnvironment, OrbitControls, FontLoader, TextGeometry, `@react-three/fiber`, `@react-three/drei` (Environment, Text (troika), Html, Stats), `@stripe/stripe-js`, zod, `@simplewebauthn/browser`. Output 2.8 to 3.8 MiB plus three wasm assets (basis_transcoder 527 KB, draco decoders 286 KB and 192 KB). Embedded blobs it exercises: 253 quoted base64-looking literals of 40+ chars, 6 of them 1,000+ chars (73 KiB in total: zstd/mikktspace/wasm loaders), and 3 `data:image/png;base64` URIs (44 KiB, the SMAA lookup textures).

Stress bundles (built specifically to be hostile to name-based heuristics):
- `client-libs` = nanoid, uuid, crypto-js, jose, tweetnacl, @noble/hashes and curves, bcryptjs, jwt-decode, firebase (app + auth), @supabase/supabase-js, lodash-es, date-fns, i18next, @tanstack/react-query, react-router, framer-motion, Stripe.js; full-namespace imports, 1.3 MB minified, 4.1 MB unminified.
- `server-sdks` = stripe, @aws-sdk/client-kms, @neondatabase/serverless, drizzle-orm (+pg-core), @simplewebauthn/server, resend built into a browser bundle on purpose; 1.0 MB minified. These are full of `accessKeyId`, `secretAccessKey`, `apiKey`, `password`, PEM handling and connection-string code.

The 11 warnings, all expected and all in stress bundles: `pem-private-key` header-only (in `jose`: `pkcs8.indexOf("-----BEGIN PRIVATE KEY-----") !== 0`, a label constant) and `db-url-with-credentials` placeholders in `@neondatabase/serverless` (`postgresql://user:password@host.tld/dbname?option=value` inside an error message, and a run-time template `postgresql://${u(o.user)}:${u(o.password)}@...`).

### 6.1 Cross-check with the server-only-value search

`--env-dir scenarios/C` (a `.env.production` holding `SESSION_SECRET` and `DATABASE_URL`) scanned against `dist-app`, `dist-kitchen`, `dist-kitchen-map`, `stress/dist-client-libs`: 0 errors. Secrets that exist but are not used by client code cause no finding.

---

## 7. Validation 3: the entropy heuristic (tuning log, funnel, thresholds)

### 7.1 Design as shipped

Only a quoted literal that directly follows `:` or `=` is examined (`{apiKey:"..."}`, `password = '...'`, JSON `"client_secret":"..."`, backslash-escaped JSON inside JS strings, `Authorization: "Bearer ..."`). The property or variable name before it must match a STRONG pattern (secret, password, passwd, pwd, token, credential, api_key, private_key, access_key, signing_key, encryption_key, master_key, hmac, bearer, authorization) or a WEAK pattern (name ends in key, auth, salt, dsn, signature). Benign names are excluded (public, publishable, pubkey, sitekey, recaptcha, integrity, checksum, hash, etag, nonce, csrf, uuid, challenge, credentialId, rpId, kid, keyId, storageKey, cacheKey, ...). Value: 20 to 256 chars of `[A-Za-z0-9+/_=-]`, hex needs 32+; rejected when it looks like a placeholder or SRI hash, an all-lowercase identifier (non-hex), camelCase (words of 3+ letters), PascalCase, kebab/snake words, a path, or has an 8-character ascending run (alphabets). Shannon entropy thresholds: base64/base64url 3.5 after a STRONG name and 4.0 after a WEAK name; hex 3.0. Long quoted base64 literals (40+ chars, any name) are also decoded and re-scanned with the prefix rules (catches `GOOGLE_CREDENTIALS_B64`-style values).

### 7.2 Funnel on real bundles (measured, `fp-funnel.mjs`)

N0 = every run of 20+ base64/hex-ish characters anywhere with entropy >= 4.0 (base64) / 3.0 (hex); N0b = same at detect-secrets' 4.5; N1 = quoted literal after `:`/`=`, any name, entropy >= 3.5 / 3.0; N2 = N1 with a STRONG/WEAK name; N3 = N2 after the shape filters (what the scanner reports).

| Corpus | KiB | N0 anywhere | N0b >= 4.5 | N1 | N2 | N3 (final) | N2 rejected by |
|---|---|---|---|---|---|---|---|
| app (oxc) | 837 | 41 | 0 | 16 | 0 | 0 | |
| app unminified | 1,949 | 70 | 1 | 16 | 0 | 0 | |
| kitchen sink (oxc) | 2,829 | 1,062 | 60 | 75 | 0 | 0 | |
| kitchen sink unminified | 5,075 | 1,186 | 63 | 75 | 0 | 0 | |
| kitchen sink + maps | 8,310 | 1,473 | 113 | 167 | 0 | 0 | |
| client-libs (oxc) | 1,277 | 31 | 9 | 193 | 19 | 0 | lowercase-identifier 15, benign-name 4 |
| client-libs unminified | 4,084 | 246 | 12 | 216 | 22 | 0 | lowercase-identifier 11, placeholder-or-sri 8, benign-name 2, entropy 1 |
| client-libs + maps | 6,290 | 273 | 27 | 407 | 42 | 0 | lowercase-identifier 26, placeholder-or-sri 8, benign-name 7, entropy 1 |
| server-sdks (oxc) | 1,004 | 241 | 188 | 359 | 0 | 0 | |
| server-sdks unminified | 2,010 | 579 | 204 | 364 | 1 | 0 | kebab-snake-words 1 |
| server-sdks + maps | 3,842 | 700 | 383 | 725 | 3 | 0 | lowercase-identifier 2, kebab-snake-words 1 |

What the naive N0 hits are (kitchen sink, 1,062): 893 emscripten/WebGL/glue fragments and alphabets such as `ABCDEFGHIJKLMNOPQRSTUVWXYZ...` (the `=` is inside the naive token), 106 camelCase/PascalCase identifiers, 30 constants like `RGBA_ASTC_10x5_Format`, 26 long base64 blobs (wasm, textures), 6 asset paths, 1 PNG data URI. In the small app: WebGL constants (`COMPRESSED_SRGB8_ALPHA8_AS...`), `unstable_IdlePriority=5`, `TimeBufferType=Float32Array`.

### 7.3 Every false positive met while tuning, and the fix

| # | Where it appeared | What | Fix |
|---|---|---|---|
| 1 | code review before first run | `BENIGN_NAME` contained `tokens?$`, which would have exempted every name ending in `token` | removed before any measurement |
| 2 | first planted run, negative bundle | the AWS documentation example `aws_secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"` flagged by the entropy rule (the prefix rule already skipped it) | placeholder filter `.*EXAMPLE(KEY)?` in the entropy path too (gitleaks allow-lists `.+EXAMPLE$` for the same reason) |
| 3 | scenario C2 (`define: {'process.env': process.env}`), not a normal bundle | `PWD` (the working-directory variable) flagged as `pwd` = password, value is a 110-char path | `pwd` must be a whole word, and values starting with `/`, `./`, `../`, `~` are treated as paths |
| 4 | after lowering the STRONG-name threshold from 4.0 to 3.5 (needed for 20 to 24-char secrets), AWS SDK sourcemap | 2 real false positives: `X_AWS_EC2_METADATA_TOKEN = "x-aws-ec2-metadata-token"` (H 3.52) and `X_AWS_EC2_METADATA_TOKEN_TTL_SECONDS = "x-aws-ec2-metadata-token-ttl-seconds"` (H 3.62); the old "all-lowercase words" filter required no digit and `ec2` has one | replaced by shape filters: `lowercase-identifier` (no uppercase and not hex), `kebab-snake-words`, `camelCase` and `PascalCase` (all with word length >= 3) |
| 5 | recall re-measurement | first camelCase/PascalCase filters (`[a-z0-9]+` words) rejected 3.2% of random 20-char base62 secrets (391 + 246 of 20,000) (for example `w64YxpEiC6BqG9vfjkGv`) | words must be 3+ letters; recall back to 99.9% to 100% |
| 6 | recall re-measurement | "starts with `/`" path filter rejected about 1.6% of random standard-base64 secrets (recall was 98.3 to 98.5% at 32 to 64 chars, 100% after the change) | path filter now requires a lowercase first segment and further segments (`/assets/x`) |
| 7 | dedupe | when a prefix rule and the entropy rule overlapped, the earlier-starting entropy finding hid the specific rule | prefix rules win the overlap |

Recall bugs found by the planted fixtures (misses, not false positives) and fixed:

| # | Miss | Cause | Fix |
|---|---|---|---|
| R1 | `ghs_<appid>_<JWT>` (GitHub's April 2026 installation-token format) | JWT rule refused a preceding `_` | dedicated alternative in `github-token` |
| R2 | base64-wrapped Stripe key under `stripeKeyB64` | decode-and-rescan only ran after STRONG names | decode every quoted base64 literal of 40+ chars (any name) and re-run the prefix rules |
| R3 | JSON embedded in a JS string (`\"type\":\"service_account\"`, double-escaped PEM `\\n`) | regexes expected bare quotes and single `\n` | up to 3 backslashes before quotes; `\\+[rn]` between PEM header and body; same for the entropy literal pass |
| R4 | `whsec_` inside a `.wasm` | word-boundary check applied to binary files, where the preceding byte is arbitrary | boundary check skipped for binary files |

Filters that never fired on real bundles (only on the negative fixtures): camelCase, PascalCase, path, alphabet-run (the alphabet-run filter was added defensively after seeing `keyStr`/`chars` alphabets of entropy 4.7 to 6.0 in the N1 list; those had non-secret names so they never reached it). Filters that did the work on real output: name gating, `lowercase-identifier`, `placeholder-or-sri` (Supabase `apikey: "your-publishable-key"`-style placeholders and SRI hashes), `benign-name` (Firebase `MISSING_RECAPTCHA_TOKEN` error codes), `kebab-snake-words`.

### 7.4 Firebase and Supabase were the noisiest real code

Firebase Auth error-code tables (`CREDENTIAL_ALREADY_IN_USE = "auth/credential-already-in-use"`, `INVALID_API_KEY`, `MISSING_PASSWORD`, `TOKEN_EXPIRED`, ...) and Supabase placeholder API keys are exactly the pattern "secret-named property with a 20+ char high-entropy-looking string". Without the shape filters this would have been 19 (minified), 22 (unminified) and 42 (with sourcemaps) false positives in one bundle.

### 7.5 Threshold evidence (measured, `entropy-recall.mjs`, 20,000 random strings per cell)

Raw Shannon entropy of random secrets, share passing each threshold:

| Alphabet | Length | mean H | 1st pct H | >= 3.5 | >= 4.0 | >= 4.25 | >= 4.5 (detect-secrets base64 default) |
|---|---|---|---|---|---|---|---|
| base64 | 20 | 4.04 | 3.65 | 99.9% | 66.9% | 3.5% | 0% |
| base64 | 24 | 4.25 | 3.89 | 100% | 95.6% | 58.6% | 5.4% |
| base64 | 32 | 4.56 | 4.23 | 100% | 100% | 98.4% | 69.5% |
| base64 | 43 | 4.85 | 4.55 | 100% | 100% | 100% | 99.6% |
| base64 | 64 | 5.18 | 4.92 | 100% | 100% | 100% | 100% |

| Alphabet | Length | mean H | 1st pct H | >= 3.0 (detect-secrets hex default) | >= 3.25 | >= 3.5 |
|---|---|---|---|---|---|---|
| hex | 32 | 3.61 | 3.26 | 100% | 99.1% | 81.4% |
| hex | 40 | 3.70 | 3.41 | 100% | 100% | 95.3% |
| hex | 64 | 3.82 | 3.63 | 100% | 100% | 100% |

(base62 and base64url rows are within 0.5 points of base64.) camelCase identifier strings of 28+ chars: min H 2.85, median 3.76, 99th percentile 4.17, max 4.29. Conclusion: detect-secrets' 4.5 would miss 30% of random 32-char base64 secrets and all 20-char ones; 3.5 keeps about 100% recall but sits inside the identifier range (hence the shape filters and the name gate); 4.0 for weak names is the compromise.

End-to-end recall of the shipped heuristic (all filters; `heuristic-recall.mjs`, 5,000 random secrets per cell, in `{clientSecret:"..."}` (strong) and `{sessionKey:"..."}` (weak)):

| Alphabet | Length | strong name | weak name |
|---|---|---|---|
| hex | 32 / 40 / 64 | 100% / 100% / 100% | 100% / 100% / 100% |
| base62 | 20 / 24 / 32 / 43 / 64 | 99.9% / 100% / 100% / 100% / 100% | 64.9% / 95.0% / 100% / 100% / 100% |
| base64 | 20 / 24 / 32 / 43 / 64 | 99.8% / 100% / 100% / 100% / 100% | 67.0% / 95.4% / 99.9% / 100% / 100% |
| base64url | 20 / 24 / 32 / 43 / 64 | 99.9% / 100% / 100% / 100% / 100% | 67.4% / 95.2% / 100% / 100% / 100% |

Rule of thumb for Phase 3/4 token design: generate secrets of 32+ chars (or 128+ bits); every mechanism above then gets essentially full recall.

---

## 8. What this scan cannot catch (limits, measured or by construction)

1. Unknown-format secret in a **local variable of a built bundle**: names are inlined or mangled (2 of 43 fixtures, both in `dist/`; caught only via source/sourcemap/plugin `transform`). Mitigation: plugin `transform` hook (in the recommended wiring) and the server-value search.
2. Secrets assembled at run time or split across literals (`"sk_live_" + tail` in an unminified build).
3. Low-entropy values (human passwords such as `hunter2hunter2`). UUID v4 credentials (36 chars, entropy 3.15 to 4.02, median 3.72, lowercase with dashes) are not reported as errors because the identifier filters reject that shape; a targeted rule reports them as **warnings** (`uuid-under-secret-name`): 5000/5000 under `apiKey`, 0/5000 under `sessionId`. Otherwise only the server-value search finds them, and only if declared in `.env*` / `process.env`.
4. Names outside the pattern lists (for example `{ s: "<random>" }`).
5. Binary assets: only prefix-anchored rules run (no name context); compressed files (`.gz .br .zip .zst`) are reported as SKIPPED, not scanned.
6. Values that are secret by policy but public by format (Stripe `pk_`, WebAuthn public keys, Google Maps keys): intentionally not flagged.
7. Tokens of vendors not in the rule list (Slack, SendGrid, Twilio, Google API keys `AIza...`, ...). Use GitHub secret scanning / gitleaks on the repository for breadth; this gate is the "did it reach the browser" test.
8. A fingerprint is the first 12 hex chars (48 bits) of SHA-256 of the match; for a low-entropy secret that is guessable from CI logs. Acceptable for random 128-bit+ secrets; consider an HMAC with a repo salt if low-entropy findings become likely.

---

## 9. Timing (measured)

Shared 4-vCPU sandbox, high variance; cold = first pass in a fresh process, warm = median of the next 10.

| Bundle | Size scanned | Node 22.22.2 in-process (cold / warm) | Node 24.21.0 in-process (cold / warm) |
|---|---|---|---|
| app (React + three named imports + Stripe.js + zod + WebAuthn) | 0.82 MiB, 3 files | 19 to 29 ms / 13 to 15 ms | 16 to 26 ms / 9 to 13 ms |
| kitchen sink | 3.75 MiB, 9 files | 52 to 61 ms / 47 to 84 ms | 42 to 45 ms / 39 to 81 ms |
| kitchen sink + sourcemaps | 11.71 MiB, 10 files | 246 to 519 ms / 192 to 228 ms | 158 to 189 ms / 153 to 195 ms |
| client-libs + sourcemaps | 8.19 MiB, 2 files | 104 to 138 ms / 104 to 174 ms | 217 ms / 150 ms |

CLI wall time including process start (10 runs, min / median / max): Node 22: app 67 / 97 / 178 ms, kitchen sink 123 / 142 / 184 ms, kitchen sink + maps 238 / 277 / 351 ms. Node 24: app 63 / 73 / 98 ms, kitchen sink 105 / 131 / 139 ms, kitchen sink + maps 203 / 311 / 397 ms. Bare `node -e 0` start-up is about 70 ms here.

Scale test: 90 files / 105 MiB (9 copies of the sourcemap-heavy dist): 1.8 s (three runs at 1.78 to 1.86 s in the final pass; earlier runs 2.5 to 3.9 s on a busier machine), max RSS 225 MiB. Throughput is 45 to 90 MiB/s. A typical Mosshatch `dist/` (1 to 4 MiB without maps) costs under 0.2 s in CI.

Where the time goes (5 MiB of unminified kitchen sink, per-rule regex time): prefix rules 0 to 9 ms each (worst: `db-url-with-credentials` about 9 ms), the entropy literal pass 6 to 10 ms, `includes()` prefilters 0.1 to 11 ms; the remainder (file reads, UTF-8 decoding, line/column indexing) was not broken down further. The entropy pass is not the bottleneck on normal bundles: disabling entropy and base64 decoding changed warm medians by under 10 ms for the app, kitchen sink, and unminified builds; it matters only on the 11.7 MiB sourcemap dist (225 ms full, 163 ms without entropy, 143 ms without entropy and decode), where thousands of unminified sources are scanned.

Vite plugin cost (hook time only, wrapped with `performance.now()`): app 26.5 / 26.8 / 42.7 ms, kitchen sink 150.6 / 71.6 / 141.1 ms per build. Build wall-clock varied 1.4 to 4.3 s run to run on this machine, so the plugin's overhead is below the noise floor.

---

## 10. Guard plugin scenarios (measured, Vite 8.3.1)

| Scenario (`vite.guard.config.ts`, `G=`) | Outcome |
|---|---|
| `ok` (zod + `import.meta.env.VITE_RP_ID`) | build passes |
| `localvar` (`const apiKey = "<b64>"` in `src/guard-localvar.ts`) | fails in `transform`: `high-entropy-near-name ... name=apiKey` (this is the case `dist/` scanning misses) |
| `server-import` (client imports `src/server/db.ts`) | fails in `generateBundle`: `server-only code in client chunk assets/...js: src/server/db.ts` |
| stripe SDK imported by client (`stress/`, real `stripe@22.6.2`) | fails: `server-only code in client chunk ...: node_modules/stripe (190 modules)` (grouped to one line) |
| `define-env` (`define: {'process.env': process.env}`) | fails in `config`: `define["process.env"] would inline a whole environment object into the client bundle` |
| `define-secret` (`define` value is a `sk_live_` string) | fails in `config`: `define["process.env.STRIPE"] carries a secret-shaped value: error stripe-secret-key ... prefix=sk_live_` |
| `vite-secret-name` (`VITE_STRIPE_SECRET_KEY` in `.env.production`) | fails in `configResolved`: `client-exposed (VITE_) variable(s) with secret-looking names: VITE_STRIPE_SECRET_KEY` |
| `prefix` (`envPrefix: ['VITE_','PUBLIC_']`) | fails in `config`: `envPrefix must be exactly "VITE_"` |

Rolldown (Vite 8's bundler) honours `generateBundle`, `chunk.moduleIds` and `this.error` exactly as the Rollup docs describe; the exit code was 1 in every failing case.

---

## 11. Design implications for Phase 4 (short list)

1. Ship all three files (script, plugin, test) and make `build` = `vite build && node scripts/scan-client-bundle.mjs dist`; keep `node --test scripts/` in CI. Every failing case above exits 1, which is what a Vercel build command needs (that a non-zero Build Command fails the deployment is standard but not quoted from Vercel docs; see unverified).
2. Never widen `envPrefix`; keep client config to a short allow-list of `VITE_*` names (API origin, RP ID, Stripe **publishable** key). Stripe Checkout redirect needs no client key at all.
3. Keep server code out of the client graph structurally: `api/` and `server/` directories, `*.server.ts`, and the plugin's package ban list; use `@simplewebauthn/browser` in client code and `@simplewebauthn/server` only under `api/`.
4. Generate agent tokens with 128+ bits (32+ random chars) after the `mh_live_` / `mh_test_` prefix; put the prefix constants in one shared module and generate the scanner rule from it so the two cannot drift.
5. Treat `.map` files as deployable secrets containers: `build.sourcemap: false` in production (`hidden` only removes the comment), or scan a separate map build; the scanner already reads `sourcesContent`.
6. Keep `public/` free of anything but static assets; the scanner fails on `.env*`, `*.pem`, `*.key`, `id_rsa`, `credentials*.json`, `service-account*.json`, `.npmrc` and similar names.
7. Add the repository-level scanners too (GitHub secret scanning push protection, gitleaks); they cover many more vendors than this gate.
8. Expect the first real findings to be in Phase 4 integration work (Stripe.js key, Resend, KMS) and allow-list by fingerprint with a written reason; do not lower thresholds.

---

## 12. Reproduction and file locations

All under `working-directory/research/scratch-secretscan/`:

- `scan-client-bundle.mjs`, `vite-secret-guard.mjs`, `scan-client-bundle.test.mjs` (the three deliverable files, identical to sections 4 to 4.3)
- `make-fixtures.mjs`, `check-planted.mjs`, `planted-manifest.json` (fixtures and recall checker); `fp-funnel.mjs`, `fp-n1.mjs`, `entropy-recall.mjs`, `heuristic-recall.mjs`, `bench.mjs`, `rule-profile.mjs` (measurements)
- `vite.config.ts`, `vite.leak.config.ts`, `vite.guard.config.ts`, `vite.guardapp.config.ts`, `vite.guardtiming.config.ts`, `pages/`, `src/`, `scenarios/`, `stress/` (builds); `dist-*` (outputs); `src-docs/` (fetched source pages, `*.raw` and `*.txt`)
- Typical commands: `PAGE=kitchen npx vite build`; `PAGE=planted-pos OUT=dist-planted-pos npx vite build`; `node check-planted.mjs dist-planted-pos dist-planted-neg --table`; `LEAK=A npx vite build -c vite.leak.config.ts`; `G=localvar npx vite build -c vite.guard.config.ts`; `node scan-client-bundle.mjs dist-kitchen --no-process-env --env-dir /nonexistent`.

---

## 13. Unverified or partly verified

1. Stripe key body length and charset: docs give prefixes only; rule uses 16+ alphanumerics (gitleaks uses 10 to 99). `sk_org_` body format unknown (only the prefix is documented).
2. Resend key structure: one documentation example (`re_` + 8 + `_` + 24 chars); no second source was found because the web-search budget was exhausted before the search was run. Rule is tolerant (6 to 16, 16 to 48).
3. Mosshatch agent-token format (`mh_live_` / `mh_test_`): defined by the project, not yet specified anywhere in the repository; rule assumes 16+ chars of `[A-Za-z0-9_-]`.
4. AWS secret access key length (40) and access key id length (20) are from the official examples only; the IAM API reference gives 16 to 128 for the id and no length for the secret.
5. GitHub token body lengths (36, and 82 for `github_pat_`) come from gitleaks, not from GitHub documentation; GitHub documents prefixes and the `ghs_APPID_JWT` change.
6. `RSA` / `EC` / `OPENSSH` / `PGP` PEM labels are convention (OpenSSL, OpenSSH, OpenPGP), not RFC 7468.
7. Vercel: (a) that a non-zero Build Command exit fails the deployment, (b) that `Secret`-type variables are present in `process.env` during the build (inferred from "Your source code can read these values ... during the Build Step" and from build-log redaction of Secret values), (c) the Node version of Vercel's build image. No deployment was made, so none of this was exercised on Vercel.
8. Windows path handling in the plugin (it tests `/node_modules/` with forward slashes; Vite normalises ids, but this was not run on Windows).
9. Terser and any minifier other than Vite 8's default oxc and `esbuild` were not tested (terser is not installed in the Vite 8 setup used).
10. Timings come from a shared, noisy 4-vCPU sandbox; treat them as order of magnitude (ranges given).
11. gitleaks and detect-secrets were read from their `master` branches on 2026-09-29; the commit date of the gitleaks config was not retrieved (GitHub API returned no list).
12. GitHub's "supported secret scanning patterns" page did not expose its provider table in static HTML (fetched 821 KB, table absent), so it is not used as evidence for Stripe/Resend coverage.

---

## 14. Source list (all accessed 2026-09-29)

- https://vite.dev/guide/env-and-mode ; https://raw.githubusercontent.com/vitejs/vite/main/docs/guide/env-and-mode.md
- https://vite.dev/config/shared-options ; https://raw.githubusercontent.com/vitejs/vite/main/docs/config/shared-options.md
- https://raw.githubusercontent.com/vitejs/vite/main/docs/config/build-options.md ; https://vite.dev/guide/api-javascript
- https://rollupjs.org/plugin-development/
- https://vercel.com/docs/environment-variables ; https://vercel.com/docs/environment-variables/sensitive-environment-variables ; https://vercel.com/docs/environment-variables/framework-environment-variables ; https://vercel.com/docs/builds/configure-a-build
- https://docs.stripe.com/keys.md ; https://docs.stripe.com/webhooks.md ; https://docs.stripe.com/webhooks/signature.md
- https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html ; https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html ; https://docs.aws.amazon.com/IAM/latest/APIReference/API_AccessKey.html
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github ; https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/
- https://resend.com/docs/api-reference/api-keys/create-api-key.md ; https://resend.com/docs/dashboard/api-keys/introduction.md
- https://www.rfc-editor.org/rfc/rfc7519.txt ; https://www.rfc-editor.org/rfc/rfc7468.txt
- https://docs.cloud.google.com/iam/docs/keys-create-delete
- https://www.postgresql.org/docs/current/libpq-connect.html ; https://neon.com/docs/connect/connect-from-any-app
- https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml
- https://raw.githubusercontent.com/Yelp/detect-secrets/master/detect_secrets/plugins/high_entropy_strings.py ; https://raw.githubusercontent.com/Yelp/detect-secrets/master/detect_secrets/settings.py
- npm registry (`npm view vite dist-tags`, package versions listed in section 1)
