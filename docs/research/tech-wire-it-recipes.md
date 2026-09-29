# Mosshatch Phase 4 "wire it" recipes: hosting, Postgres, email, and honest DNS propagation

Research date: 2026-09-29 (all "accessed" dates below are 2026-09-29). Research only; no application code was written and nothing under /home/user/MossHatch was touched.

## TL;DR

1. Do NOT hard-code provider DNS values. Vercel (76.76.21.21 vs newer per-project pool e.g. 216.198.79.1, plus a per-project CNAME) and Resend (TXT+MX today, CNAME variants for domains created after Aug 2026, per-domain DKIM key) both say the dashboard/API value is the source of truth. A recipe must read them from `GET /v6/domains/{domain}/config` (works before the domain is attached to a project) and Resend `POST /domains` `records[]`.
2. Preview fidelity differs: Vercel and Netlify records are knowable before applying; Resend records only exist after `POST /domains` (a reversible, free, provider-side object), so the UI needs a "provider-generated (pending)" preview state.
3. Connect-flow auth: Vercel = classic "connectable account" integration (code valid 30 min, `POST /v2/oauth/access_token`; needs Vercel approval) or a user-pasted team/project-scoped `vcp_` token; "Sign in with Vercel" API permissions are still private beta. Neon OAuth is partners-only, so use a pasted Neon API key (project-scoped keys exist) or the Vercel marketplace path. Resend has a real OAuth 2.1+PKCE flow (scopes `emails:send`, `full_access`; access token 900 s).
4. Neon vars: `DATABASE_URL` = pooled (`-pooler` host), `DATABASE_URL_UNPOOLED` = direct (Drizzle Kit/migrations). Resend var: `RESEND_API_KEY` (mint a `sending_access` key restricted to the domain). Vercel `sensitive` env vars cannot target `development`.
5. A registrar DNS API "success" is NOT propagation: Porkbun's API explicitly accepts writes for zones nobody queries and only adds a `warnings` string; Cloudflare batch "propagation of changes is not atomic"; Route 53 only claims PENDING/INSYNC across its own servers.
6. Derive "shedding" from measurements in this order: (a) API accepted, (b) every authoritative NS answers the desired RRset (RD=0, AA=1), (c) sampled Cloudflare + Google DoH answers, needing N consecutive matching samples. My live probe shows the TTL returned by the same public DoH endpoint jumps around (Cloudflare 206 -> 2823 -> 2909 -> 2700 -> 3230 s for one name), so remaining-TTL is not a countdown; use `max(old TTL, SOA-minimum negative TTL)` only as an upper-bound window.
7. Never probe a name at public resolvers before it is written (RFC 2308 negative caching); check pre-write state at the authoritative servers only.
8. .dev and .app are on the HSTS preload list (verified via hstspreload.org), so "spread" for those must include a valid certificate, not only DNS.
9. Blocked/unverified: Namecheap API docs (Cloudflare bot challenge, challenge host blocked by egress policy), raw UDP/53 (sandbox answers SERVFAIL for every server, so direct authoritative probing could not be live-tested), whether Vercel Functions allow outbound UDP/53.
10. Proposed recipe data model (declarative JSON with sourced records, variables, checks, rollback, derived status) is in section 8.

---

## 1. Method, environment notes, conflicts of evidence

- Every provider page below was fetched live today with curl (many providers publish `.md` twins of docs pages: vercel.com/docs/*.md, docs.netlify.com/*.md, neon.com/docs/*.md, resend.com/docs/*.md, developers.cloudflare.com/**/index.md). Vercel and Neon OpenAPI JSON specs and the Netlify swagger were downloaded and parsed. WebSearch budget for the session was already exhausted (200/200), so no search-engine discovery was used; all URLs were reached directly or via each vendor's own `llms.txt` index.
- No provider API was called with credentials (no account tokens were used). Response bodies quoted are from vendor docs/OpenAPI examples, not from live authenticated calls. Two live unauthenticated probes were run: Cloudflare and Google DoH endpoints (section 6).
- Blocked or unreachable, recorded as such and not worked around:
  - namecheap.com/support/api/* : Cloudflare "Just a moment..." bot challenge; headless Chromium also failed because `brunhild.challenges.cloudflare.com:443` is rejected by the egress proxy ("connect_rejected ... 502 to CONNECT (policy denial or upstream failure)"). Status: **blocked by egress policy**. Namecheap DNS API semantics are therefore unverified.
  - api.github.com unauthenticated tree listing returned 403 (rate limit/proxy); Domain Connect template repo not enumerated.
  - Raw UDP/53 from this sandbox: every server (192.5.6.30, 1.1.1.1, 8.8.8.8) returned an identical 29-byte SERVFAIL (flags 0x8082) so a local stub intercepts port 53. Direct authoritative probing could not be tested here.
- Conflicting/varying sources are called out inline as "CONFLICT".

---

## 2. HOSTING A: Vercel

### 2.1 DNS values (what the recipe writes at the registrar's DNS)

| Item | Value / rule | Source (accessed 2026-09-29) and exact quote |
|---|---|---|
| Apex A record | `76.76.21.21` for most projects; newer projects may show e.g. `216.198.79.1`; the project's domain card / API is authoritative | https://vercel.com/kb/guide/a-record-and-caa-with-vercel (published 2026-07-27, last_updated 2026-07-28): "For most projects that value is `76.76.21.21`, a general-purpose anycast address. Newer projects draw a value from a pool of anycast IPs matched to the plan and project, so your card may show a different address such as `216.198.79.1`. The card is the source of truth" |
| Apex must not be CNAME | A record or Vercel nameservers | same KB: "An apex domain can't use a CNAME, so an A record (or delegating to Vercel's nameservers) is the standards-compliant way"; https://vercel.com/docs/domains/troubleshooting: "Because an apex domain requires `NS` records and usually some other records, such as `MX` (for a mail service), adding a `CNAME` at the zone apex would violate this rule" |
| www CNAME | Per-project unique target, e.g. `d1d4fc829fe7bc7c.vercel-dns-017.com` (example from docs, not a real project's value) | https://vercel.com/docs/domains/working-with-domains/add-a-domain (last_updated 2026-09-16): "Each project has a unique CNAME record e.g. `d1d4fc829fe7bc7c.vercel-dns-017.com`." Older generic target shown in https://vercel.com/docs/domains/working-with-dns: "`cname.vercel-dns-0.com`" |
| Wildcard | Requires nameserver delegation, or delegate `_acme-challenge` with 2 NS records (`ns1.vercel-dns.com.`, `ns2.vercel-dns.com.`) plus `CNAME * -> cname.vercel-dns-0.com.` | add-a-domain page tables (same URL) |
| Apex + www | Adding an apex prompts to add www | add-a-domain: "If you add an apex domain (e.g. `example.com`) to the project, Vercel will prompt you to add the `www` subdomain prefix." |
| AAAA | Do not add AAAA for third-party DNS | https://vercel.com/docs/domains/troubleshooting: "we do not support IPv6 yet. This means if you are adding a custom domain from a third-party, you won't be able to point an `AAAA` record to Vercel." |
| CAA | No CAA needed unless you restrict issuers; then allow Let's Encrypt | troubleshooting: "Having no applicable CAA records doesn't itself block issuance. If your policy restricts issuers, authorize Let's Encrypt with `0 issue \"letsencrypt.org\"`." |
| Proxy | Cloudflare orange cloud blocks verification/SSL | KB: "A proxied Cloudflare record (the orange cloud) ... blocks verification and the SSL challenge." |
| Suggested TTL | 300 s in KB; Vercel DNS default 60 s | KB: "A short TTL such as 300 seconds keeps propagation fast" |
| TTL floor (CONFLICT) | API schema: min 60; guide text: "minimum 30s" | https://vercel.com/docs/rest-api/reference/endpoints/dns/create-a-dns-record: "The TTL value. Must be a number between 60 and 2147483647. Default value is 60." vs https://vercel.com/docs/domains/working-with-dns: "A short TTL (minimum 30s) is beneficial if you are constantly updating the content" |
| Propagation claim | Nameserver changes up to 24-48 h; A/CNAME/TXT typically quicker | troubleshooting: "changing a domain's nameservers can take up to **24–48 hours** to fully propagate" |
| Verification TXT (domain in use by another Vercel account) | API returns `verification[]` = {type:"TXT", domain, value, reason}; team-level claim uses `_vercel.{domain}` | OpenAPI https://openapi.vercel.sh/ (`GET /v9/domains/{domain}/verification`): "The caller must add this TXT record to `_vercel.{domain}` in their DNS configuration, then call POST /domains/:domain/claim". Project-level: add-domain response text "If `verification.type = TXT` the `verification.domain` will be checked for a TXT record matching `verification.value`." The literal TXT value format (`vc-domain-verify=...`) is NOT documented in the pages fetched: unverified. |

### 2.2 Domains API (project-level)

| Purpose | Endpoint | Notes (quote) |
|---|---|---|
| Add apex/www to project | `POST https://api.vercel.com/v10/projects/{idOrName}/domains` body `{name, gitBranch?, customEnvironmentId?, redirect?, redirectStatusCode?}` | "If the domain is not yet verified to be used on this project, the request will return `verified = false`, and the domain will need to be verified according to the `verification` challenge via `POST /projects/:idOrName/domains/:domain/verify`. If the domain already exists on the project, the request will fail with a `400` status code." Errors: 403 "You don't have access to the domain you are adding"; 409 "The domain is already assigned to another Vercel project" (https://vercel.com/docs/rest-api/reference/endpoints/projects/add-a-domain-to-a-project) |
| Verify | `POST /v9/projects/{idOrName}/domains/{domain}/verify` | "Attempts to verify a project domain with `verified = false` by checking the correctness of the project domain's `verification` challenge." (verify-project-domain page) |
| Get project-domain state | `GET /v9/projects/{idOrName}/domains/{domain}` | returns `verified`, `verification[]`, `redirect` (get-a-project-domain page) |
| Get DNS config (preview + status) | `GET /v6/domains/{domain}/config?projectIdOrName=...&strict=` | Response `configuredBy` (`A`,`CNAME`,`dns-01`,`http`,`null`), `misconfigured` ("Whether or not the domain is configured AND we can automatically generate a TLS certificate."), `recommendedIPv4[{rank,value[]}]` ("rank=1 is the preferred value(s) to use. Only using 1 ip value is acceptable."), `recommendedCNAME[{rank,value}]`, `acceptedChallenges` (`dns-01`,`http-01`). Query param `projectIdOrName`: "Use this when the domain is not yet associated with a project." (get-a-domain-s-configuration page). So the exact records can be previewed BEFORE attaching the domain. |
| Remove (rollback) | `DELETE /v9/projects/{idOrName}/domains/{domain}` | listed in integration scope table (https://vercel.com/docs/integrations/create-integration/vercel-api-integrations) |
| Write DNS in Vercel DNS (only if Vercel is the nameserver) | `POST /v2/domains/{domain}/records`, types `A,AAAA,ALIAS,CAA,CNAME,HTTPS,MX,SRV,TXT,NS` | not needed when Mosshatch DNS is authoritative |
| Env vars | `POST /v10/projects/{idOrName}/env?upsert=true` body `{key,value,type: system/encrypted/plain/sensitive, target:[production/preview/development], gitBranch?, comment?, customEnvironmentIds?}` | "If you include `upsert=true` as a query parameter, a new environment variable will not be created if it already exists but, the existing variable's value will be updated." |
| Sensitive vars | cannot target Development | https://vercel.com/docs/environment-variables/sensitive-environment-variables: "If the **Development** environment is selected, you will be unable to enable the switch." Values are unreadable after creation. |

### 2.3 Rate limits and plan limits (https://vercel.com/docs/limits, last_updated 2026-09-16)

| Limit | Value |
|---|---|
| Project domain creation, update, or remove | 100 per 60 s, scope owner |
| Project domains verification | 100 per 60 s, scope user |
| Project domains get | 500 per 60 s, scope user |
| Domains dns config retrieval | 500 per 60 s, scope user |
| Domains record creation / update (Vercel DNS) | 50 per 60 s each, scope owner |
| Project env var creation | 120 per 60 s; updates 120; deletions 60 |
| Env vars per environment | 1000; total size 64 KB (Node.js etc.) |
| Domains per project | Hobby 50; Pro/Enterprise "Unlimited*" (soft 100,000 / 1,000,000) |

### 2.4 Connect-flow auth for Vercel

| Option | Facts | Source and quote |
|---|---|---|
| A. User pastes access token | Full-account, team, or project scoped; `vcp_` prefix; shown once; scoped tokens do not need `teamId` | https://vercel.com/docs/accounts/access-tokens (last_updated 2026-09-08): "Every token carries a scope that determines which resources it can reach"; "Personal access tokens begin with the prefix `vcp_`"; "A token's value appears only once, at creation". Project-scoped token "can only read and write resources belonging to that one project" (inference, not tested: it should cover that project's domains and env vars but may be refused on team-level Domains endpoints such as `GET /v6/domains/{domain}/config`, because the page says a project-scoped token "denies any request to another project, to a user-level resource, or to a team-level resource"; see section 10). |
| B. Connectable-account Integration (classic OAuth-like) | Needs Vercel approval; user is redirected to your Redirect URL with a `code`; exchange at `POST https://api.vercel.com/v2/oauth/access_token`; code valid 30 min, single use; scopes chosen per API area (Projects, Project Env Vars, Domain: Read or Read/Write); when installed on a team append `teamId` | https://vercel.com/docs/integrations/create-integration/vercel-api-integrations (last_updated 2026-09-16): "This short-lived parameter is valid for **30 minutes** and can be exchanged **once**"; https://vercel.com/docs/integrations/create-integration (last_updated 2026-09-16): "Once your integration is approved, you can share it for users to install if it's a connectable account integration". Scope table lists Projects Read/Write incl. `POST /v9/projects/{idOrName}/domains` and `.../verify`, Project Environmental Variables Read/Write, Domain Read/Write incl. `POST /v2/domains/{domain}/records`. |
| C. Sign in with Vercel (OAuth2/OIDC) | Access token 1 h, refresh 30 days rotating, but API permissions still private beta (page last_updated 2026-02-26) | https://vercel.com/docs/sign-in-with-vercel/scopes-and-permissions: "Permissions for issuing API requests and interacting with team resources are currently in private beta." Scopes available: `openid`, `email`, `profile`, `offline_access`. Not usable today for managing domains without beta access. |
| D. Vercel Connect | Vercel product for YOUR deployed app to call third-party APIs (Slack, GitHub, ...); not a way for Mosshatch to manage a user's Vercel project | https://vercel.com/docs/connect: "Give your agents and services secure, short-lived access to third-party APIs like Slack, GitHub, Microsoft, and Snowflake" |

Vercel Domains via Marketplace-managed installs (e.g. Resend/Neon marketplace installs) are managed by Vercel: see 5.5 and 4.3.

---

## 3. HOSTING B: Netlify

| Item | Value / rule | Source and quote |
|---|---|---|
| Apex, preferred | ALIAS / ANAME / flattened CNAME at `@` -> `apex-loadbalancer.netlify.com` | https://docs.netlify.com/manage/domains/configure-domains/configure-external-dns (fetched as .md): "Unlike subdomains, apex domains don't support CNAME records. You must configure your apex domain with an ALIAS, ANAME, flattened CNAME, or A record." ... "Point the record to Netlify's load balancer at: `apex-loadbalancer.netlify.com`." |
| Apex, fallback | A record `75.2.60.5` | same: "Point the record to Netlify's load balancer IP address: `75.2.60.5`." "High-Performance Edge" sites use different values shown in the "Pending DNS verification" modal. |
| Subdomain / www | CNAME `www` -> `<site-name>.netlify.app` (per-site value) | same: "add the CNAME record with your subdomain ... Point the record to your Netlify subdomain, `brave-curie-12345.netlify.app`." |
| Apex and www come as a pair | assigning either adds both | "If you assign an apex domain or a `www` subdomain to your site, Netlify will automatically add _both_ the apex domain and the `www` subdomain." https://docs.netlify.com/manage/domains/manage-domains/manage-multiple-domains: "If you're using external DNS, we strongly recommend setting the `www` subdomain (or another subdomain) as your primary domain." |
| TXT ownership verification for external DNS | Not documented on the pages fetched; per-domain records are shown in the dashboard "Pending DNS verification" modal | "To access customized details about the DNS records you need to configure, go to Domain management > Production domains and select **Pending DNS verification**". No public API for this modal was found: unverified. |
| Propagation claim | "It may take a full day"; cert issuance needs old TTLs expired | "It may take a full day for the settings to propagate across the global Domain Name System." https://docs.netlify.com/manage/domains/troubleshooting-tips: "**All previous DNS settings must have their cache timeouts expired.**" |
| Netlify DNS caveats | supports A, AAAA, CAA, CNAME, MX, NS, SPF, SRV, TXT (no ALIAS listed; uses "NETLIFY" records); no DNSSEC | https://docs.netlify.com/manage/domains/configure-domains/dns-records; troubleshooting-tips: "Netlify DNS doesn't support DNSSEC." Edits: "you need to first add a new record with the new value and then delete the old record." |
| Netlify-side name servers | vary per domain, format like `dns1.p01.nsone.net` | https://docs.netlify.com/manage/domains/configure-domains/netlify-name-servers |
| Cloudflare proxy in front | must be disabled before cert provisioning | troubleshooting-tips: "you need to disable that routing before we can provision the certificate" |

### 3.1 Netlify API (swagger v2.60.0, https://open-api.netlify.com/swagger.json)

| Purpose | Endpoint |
|---|---|
| Base | `https://api.netlify.com/api/v1/` ("SSL only"); rate limit "up to 500 requests per minute for most requests" (https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api) |
| Assign custom domain / aliases | `PATCH /sites/{site_id}` (site object has `custom_domain`, `domain_aliases`, `force_ssl`, `managed_dns`) |
| Provision TLS (Let's Encrypt) | `POST /sites/{site_id}/ssl` ("Omit certificate params to initiate Let's Encrypt provisioning"); read `GET /sites/{site_id}/ssl` |
| Netlify DNS zone | `POST /dns_zones` (body `account_slug, site_id, name`), `GET /dns_zones/{zone_id}`, records: `POST /dns_zones/{zone_id}/dns_records` body `{type, hostname, value, ttl, priority, weight, port, flag, tag}` |
| Env vars | `POST /accounts/{account_id}/env?site_id=...` body array `{key, scopes[builds,functions,runtime,post-processing], values[{value, context: all/dev/dev-server/branch-deploy/deploy-preview/production/branch, context_parameter}], is_secret}`; "Granular scopes are available on Pro plans and above." Secret: "Secret values are only readable by code running on Netlify's systems." |
| Auth | OAuth2. Personal access tokens for own use; "If you're making a public integration with Netlify for others to enjoy, you must use OAuth2"; end-user authorization endpoint `https://app.netlify.com/authorize`; swagger declares `securityDefinitions.netlifyAuth.flow = "implicit"`. Apps registered at https://app.netlify.com/applications. Whether an authorization-code exchange exists is unverified. |

---

## 4. POSTGRES: Neon

Note: Neon's own docs now call the product "Lakebase Postgres" in several pages (e.g. "provisions a Lakebase Postgres database from the Vercel Marketplace"), while the API host stays `console.neon.tech`. Treat naming as in flux.

### 4.1 Connection strings and variables

| Item | Value | Source and quote |
|---|---|---|
| Pooled vs direct hostnames | pooled = add `-pooler` to endpoint id | https://neon.com/docs/connect/connection-pooling: direct `postgresql://user1:AbC123dEf@ep-cool-darkness-123456.us-east-2.aws.neon.tech/dbname?sslmode=require`; pooled `...ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/dbname?sslmode=require` |
| Pooler type | PgBouncer transaction mode, up to 10,000 client connections | same: "Neon uses PgBouncer ... enabling up to 10,000 concurrent connections"; unsupported on pooled: `SET`/`RESET`, `LISTEN`/`NOTIFY`, SQL-level `PREPARE`, session advisory locks |
| Use pooled for | serverless functions, web apps; direct for schema migrations, pg_dump, logical replication | same page, pooled-vs-direct table row: Schema migrations use a Direct connection because "Tools may not support transaction pooling" |
| Vercel integration env vars | `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` (direct), `PGHOST`, `PGHOST_UNPOOLED`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`, legacy `POSTGRES_*` (e.g. `POSTGRES_URL`), plus `NEON_AUTH_BASE_URL`, `VITE_NEON_AUTH_URL` when Neon Auth is enabled | https://neon.com/docs/guides/vercel-managed-integration (section "Environment variables set by the integration": `DATABASE_URL` = "Pooled connection string (PgBouncer)"; `DATABASE_URL_UNPOOLED` = "Direct connection string"); https://neon.com/docs/guides/neon-managed-vercel-integration: "The integration sets both modern (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`) and legacy PostgreSQL variables (`POSTGRES_URL`, `PGHOST`, etc.) for Production and Development environments. Preview variables are injected dynamically per deployment." |
| Drizzle convention | app uses `DATABASE_URL` (pooled); Drizzle Kit uses `DATABASE_URL_UNPOOLED` | https://neon.com/docs/guides/drizzle: "# Pooled connection for your application DATABASE_URL=... -pooler ... # Unpooled connection for Drizzle Kit DATABASE_URL_UNPOOLED=..." |
| Optional prefix | Vercel-managed install lets you prefix names (e.g. `PRIMARY_`) | vercel-managed-integration: "You can add a prefix if you have multiple databases in the same project" |

### 4.2 Neon API (base `https://console.neon.tech/api/v2`, bearer auth; OpenAPI https://neon.com/api_spec/release/v2.json)

| Purpose | Endpoint | Notes |
|---|---|---|
| Create project | `POST /projects` body `{project:{name, region_id (e.g. "aws-us-east-1"), pg_version, org_id, store_passwords, autoscaling_limit_min_cu/max_cu, history_retention_seconds, ...}}` | 201: "The project includes a connection URI with a database, password, and role. At least one non-protected role is created with a password. Wait until the operations are finished before attempting to connect to a project database." Response = project + `connection_uris[]` + roles + databases + operations + branch + endpoints. "Plan limits define how many projects you can create." Personal key needs `org_id`; org key infers it. |
| Connection URI | `GET /projects/{project_id}/connection_uri?database_name=&role_name=&pooled=true&branch_id=&endpoint_id=` | "Set `pooled=true` to include the `-pooler` suffix for a connection pooler URI." `connection_uris[].connection_parameters` = {database, role, password, host, pooler_host}; marked `x-sensitive`. |
| Create branch | `POST /projects/{project_id}/branches` | "By default, the branch is created from the project's default branch with no compute endpoint ... To access the branch, add a `read_write` endpoint." |
| Create role | `POST /projects/{project_id}/branches/{branch_id}/roles` | "Connections established to the active compute endpoint will be dropped." Password: `GET .../roles/{role_name}/reveal_password`, reset: `POST .../reset_password` |
| Create database | `POST /projects/{project_id}/branches/{branch_id}/databases` | |
| Poll async op | `GET /projects/{project_id}/operations/{operation_id}` | statuses `scheduling, running, finished, failed, error, cancelling, cancelled, skipped`; https://neon.com/docs/reference/api/key-concepts: "poll the operation status before proceeding with dependent requests"; overlapping work returns `423 Locked`. |
| Delete (rollback) | `DELETE /projects/{project_id}/branches/{branch_id}/roles/{role_name}`, `DELETE .../branches/{id}`, `DELETE /projects/{id}` | "You can't delete a branch that has child branches" (key-concepts) |
| Rate limits | 700 req/min (~11/s), 40 req/s burst per route, 10/s for org API key creation; 429 on excess | https://neon.com/docs/reference/api/key-concepts |
| Endpoint state | `init / active / idle` (scale to zero) | OpenAPI `EndpointState` |

### 4.3 Auth for a Neon "connect" flow

| Option | Facts | Source and quote |
|---|---|---|
| API key pasted by user | Personal (all org projects where the user is a member), Organization (admins only), Project-scoped (admins only; "Single specified project"); shown once | https://neon.com/docs/manage/api-keys: "Only organization **Admins** can create organization or project-scoped keys." "the secret token will be displayed only once" |
| OAuth (oauth2.neon.tech, OIDC, PKCE) | Scopes `urn:neoncloud:projects:{create,read,update,delete,permission}` and `urn:neoncloud:orgs:*`; add `offline`/`offline_access` for refresh token; BUT partners only | https://neon.com/docs/guides/oauth-integration: "We only provide OAuth integrations for partners we have active commercial relationships with." Discovery: https://oauth2.neon.tech/.well-known/openid-configuration; endpoints `https://oauth2.neon.tech/oauth2/auth` and `/oauth2/token`. |
| Vercel Marketplace (Vercel-managed) | Neon account + project created through Vercel; Vercel injects env vars; billing on Vercel invoice; resources managed in Vercel | https://neon.com/docs/guides/vercel-managed-integration: "Create additional databases (each becomes a new Neon project)" is done in Vercel. Cannot coexist with the Neon-managed integration in the same Vercel project. |
| Vercel "Neon-managed" connectable account | Existing Neon project linked to a Vercel project; branches `preview/<git-branch>` per preview deployment | https://neon.com/docs/guides/neon-managed-vercel-integration |

---

## 5. EMAIL: Resend

### 5.1 Domain records (what the recipe must write)

Sources: https://resend.com/docs/api-reference/domains/create-domain , /get-domain , /dashboard/domains/manage-domains , /dashboard/domains/dmarc , /dashboard/domains/custom-return-path , /dashboard/receiving/custom-domains , /knowledge-base/vercel (all .md, accessed 2026-09-29).

| Record | Type / name (relative to the verified domain) / value | Notes and quote |
|---|---|---|
| DKIM | TXT, `resend._domainkey`, value `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GN...` (per-domain RSA public key, ~200 chars) | API example: `{"record":"DKIM","name":"resend._domainkey","value":"p=MIGf...","type":"TXT","status":"not_started","ttl":"Auto"}`. Key is unique per domain: cannot be predicted before `POST /domains`. |
| SPF (Return-Path MX) | MX, `send` (Return-Path default; `custom_return_path` overrides), value `feedback-smtp.us-east-1.amazonses.com`, priority 10 | Region is embedded in the value. "Do not use the same priority for multiple records." (Resend Vercel guide) |
| SPF (TXT) | TXT, `send`, value `v=spf1 include:amazonses.com ~all` (the GET response shows it wrapped in literal quotes: `"\"v=spf1 include:amazonses.com ~all\""`) | Normalise quoting when comparing. |
| SPF/return path as CNAME (NEW) | CNAME records instead of MX+TXT for domains created after Aug 2026; two CNAMEs (Return-Path subdomain and an `r`-prefixed sibling, e.g. `outbound` and `routbound`) | https://resend.com/docs/dashboard/domains/manage-domains: "SPF-related records are not always shown as TXT and MX records. For domains created after August 2026, Resend may generate CNAME records instead, which point to hosts that carry all the necessary information for SPF-related verification. Therefore, make sure to always add the exact records shown in your domain's **Records** tab". custom-return-path page: "With a Return-Path of `outbound`, you'll be shown records for both `outbound.example.com` and `routbound.example.com`, and both need to be added". Values for the CNAME variant are not shown in any doc example: unverified. A CNAME "cannot co-exist with any other record on the same subdomain". |
| Tracking (optional) | CNAME, `links` (your `tracking_subdomain`), `links1.resend-dns.com` | create response example; only applied "if a `tracking_subdomain` is configured and verified". |
| Inbound MX (optional, `capabilities.receiving = enabled`) | MX, subdomain (docs example `inbound`), value `inbound-smtp.us-east-1.amazonaws.com`, priority 10 | Webhook example: `{"record":"Receiving MX","name":"inbound.yourdomain.tld","type":"MX","priority":10,"value":"inbound-smtp.us-east-1.amazonaws.com","status":"pending"}`. https://resend.com/docs/dashboard/receiving/custom-domains: "you will *not* receive emails at Resend if the required `MX` record is not the lowest priority value for the domain" so put it on a subdomain; only the us-east-1 hostname is shown in docs, other regions unverified. |
| DMARC (suggested by Resend, not generated) | TXT, `_dmarc`, `v=DMARC1; p=none; rua=mailto:dmarcreports@example.com;` | dmarc page: "To ensure you don't accidentally introduce breaking changes to your email sending, we suggest starting with a policy of `p=none;`". Prereq: "An email must pass either SPF or DKIM checks (but not necessarily both) to achieve DMARC compliance". |
| Naming inconsistency | `name` is relative (`send`, `resend._domainkey`, `links`) in create response but FQDN in others (`links.example.com` in GET, `inbound.yourdomain.tld` in webhook) | Recipe must canonicalise names. |
| Subdomain mapping | For sending subdomain `updates.example.com`, Resend's Vercel guide says "Omit your domain from the record values ... paste only `send` (or `send.subdomain` if you're using a subdomain)" | knowledge-base/vercel |
| Cloudflare proxy | Do not proxy CNAMEs | add-a-domain: "when shown a CNAME, make sure *not* to use proxying features (e.g., Cloudflare's orange cloud) for that record, as it will prevent verification from completing." |
| Recommendation | send from a subdomain | https://resend.com/docs/dashboard/domains/introduction: "We recommend sending your emails from one or more subdomains (e.g., `updates.example.com`) instead of your root domain to isolate your sending reputation" |

### 5.2 Domains API

| Purpose | Endpoint | Facts |
|---|---|---|
| Create | `POST https://api.resend.com/domains` `{name, region, custom_return_path, open_tracking, click_tracking, tracking_subdomain, tls: opportunistic/enforced, capabilities:{sending, receiving}}` | `region` default `us-east-1`, values `us-east-1`, `eu-west-1`, `sa-east-1`, `ap-northeast-1`. `custom_return_path` default `send`; rules: <=63 chars, starts with a letter, ends letter/number, letters/numbers/hyphens. Response includes `id`, `status: not_started`, `records[]`. Team-scoped plan domain limits apply ("The number of domains your team can add is set by your plan"). No dry-run/preview. |
| Verify | `POST /domains/{domain_id}/verify` | "Calling this API endpoint triggers an **asynchronous domain verification process**. The domain will be temporarily marked as `pending` regardless of its current status while the verification is in progress." Returns `{"object":"domain","id":...}` only. |
| Get | `GET /domains/{domain_id}` | `status`, `records[]` each with `status`, `capabilities`. |
| Update | `PATCH /domains/{domain_id}` | TLS, tracking, capabilities. NOT `custom_return_path`, NOT region. |
| List | `GET /domains` (`limit`, `after`, `before`) | |
| Delete | `DELETE /domains/{domain_id}` | |
| Claim (domain verified in another Resend team) | `POST` Claim Domain -> TXT `record` to add -> Verify Domain Claim -> poll Get Domain Claim until `completed` | https://resend.com/docs/dashboard/domains/claim ; a claim yields a brand-new domain with new DKIM keys. |
| Status values | `not_started, pending, verified, partially_verified, partially_failed, failed, temporary_failure` | manage-domains: `failed`: "Resend was unable to detect the DNS records within 72 hours"; `temporary_failure`: previously verified domain lost a record, rechecked for 72 h. |
| Timing | "often verify within 15 minutes of adding the DNS records. However, DNS changes can occasionally take up to 72 hours"; after 72 h use "Restart verification" | https://resend.com/docs/add-a-domain |
| Webhooks | `domain.created`, `domain.updated`, `domain.deleted`; payload includes `status` and per-record `records[].status`; signed via Svix headers (`svix-id`, `svix-timestamp`, ...) | https://resend.com/docs/webhooks/event-types , /webhooks/domains/updated , /webhooks/verify-webhooks-requests |
| Immutable after create | Region: "Add the same domain again, selecting the new region." (numbered steps: delete the current domain, re-add with the new region, update DNS records) ; Return-Path: "cannot be changed afterwards" | https://resend.com/docs/dashboard/domains/regions ; custom-return-path |
| Rate limit | "The default maximum rate limit is **10 requests per second per team**"; 429 `daily_quota_exceeded` / `monthly_quota_exceeded`; headers `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`, `retry-after` | https://resend.com/docs/api-reference/rate-limit |
| Diagnostics | Resend suggests https://dns.email/ to check public visibility | add-a-domain |

### 5.3 API keys and scoping

| Item | Value | Source and quote |
|---|---|---|
| Create key | `POST /api-keys` `{name (<=50 chars), permission: full_access / sending_access, domain_id?}`; response `{id, object:"api_key", token:"re_..."}` | https://resend.com/docs/api-reference/api-keys/create-api-key: "`sending_access`: Can only send emails." "Restrict an API key to send emails only from a specific domain. This is only used when the `permission` is set to `sending_access`." |
| After creation | value cannot be viewed again; only name editable via API | https://resend.com/docs/dashboard/api-keys/introduction: "You cannot view or edit an API key value after it has been created." "The API only updates the key's name, while permission and domain can only be edited in the Dashboard." |
| Env var name | `RESEND_API_KEY` | https://resend.com/docs/send-with-vercel-functions: "The API key must be stored in an environment variable called `RESEND_API_KEY`." |
| Webhook secret | shown on webhook details page / returned by create/get webhook; docs give no fixed env var name (name is Mosshatch's choice, e.g. `RESEND_WEBHOOK_SECRET`) | https://resend.com/docs/webhooks/verify-webhooks-requests |

### 5.4 Resend OAuth (for a "connect Resend" button)

| Item | Value | Source and quote |
|---|---|---|
| Flow | OAuth 2.1 authorization code + mandatory PKCE (S256); public or confidential clients | https://resend.com/docs/guides/building-a-resend-oauth-client : "Resend implements OAuth 2.0 and 2.1, including Proof Key for Code Exchange (PKCE) for authorization code exchanges." |
| Endpoints | authorize `https://api.resend.com/oauth/authorize` (browser redirect); token `https://api.resend.com/oauth/token`; register `POST /oauth/register` (RFC 7591); token revoke `/oauth/revoke`; grants `GET /oauth/grants` and `DELETE /oauth/grants/{grant_id}` | https://resend.com/docs/api-reference/oauth/authorize , /token |
| Scopes | `emails:send` (send-only routes), `full_access` (every other route, i.e. domains and api-keys) | "`full_access` is required for every other API route." |
| Token lifetimes | access JWT (ES256) 900 s; refresh 60 days rotating with reuse detection; code single-use, 10 min | token page: "Access tokens are JWTs signed with `ES256`, valid for 900 seconds. Refresh tokens are opaque strings, valid for 60 days from whenever they were last issued, and rotate on every use." |
| Client registration | prefer pre-registration or Client ID Metadata Document | "Because Resend does not offer self-service verification or domain-ownership checks yet, pre-register remote third-party clients rather than registering them dynamically" |
| Implication | Creating a domain needs `full_access`; then mint a narrow `sending_access` key for the app and stop using the OAuth token at runtime | derived from scopes above |

### 5.5 Vercel Marketplace path for Resend

https://resend.com/docs/guides/vercel-marketplace-integration : installing creates a Resend account linked to the Vercel account and provisions an API key; https://resend.com/docs/knowledge-base/vercel : "If you installed Resend through the Vercel Marketplace, Vercel manages the lifecycle of your Resend team, API keys, and domains. These resources cannot be deleted from the Resend dashboard". Resend "Auto Configure" uses Domain Connect ("This uses Domain Connect to automatically configure your DNS records") for Vercel and Cloudflare DNS hosts.

### 5.6 Env vars summary for Resend

`RESEND_API_KEY` only (official). Sender address, webhook secret, and region are app config (not provider-defined names).

---

## 6. PROPAGATION: how to check DNS change status honestly

### 6.1 Public DoH endpoints (verified live today)

| | Cloudflare | Google |
|---|---|---|
| JSON endpoint | `GET https://cloudflare-dns.com/dns-query?name=<n>&type=<t>` with header `accept: application/dns-json` (also `https://one.one.one.one/dns-query`) | `GET https://dns.google/resolve?name=<n>&type=<t>` (JSON, GET only) |
| Wire-format (RFC 8484) endpoint | same URL, GET `?dns=` or POST `application/dns-message` | `https://dns.google/dns-query` (GET and POST) |
| Params | `name` (required), `type` (default A; text or number), `do`, `cd` | `name` (1-253 chars, punycode), `type` (default 1), `cd`, `ct`, `do`, `edns_client_subnet` |
| JSON fields | `Status, TC, RD, RA, AD, CD, Question[], Answer[{name,type,TTL,data}], Authority[]` | same schema plus `Comment` (e.g. "Response from 173.245.58.162." names the upstream authoritative server) |
| Auth | "No authentication is required to send requests to this API." | none |
| CORS | live response header `access-control-allow-origin: *` | live response header `access-control-allow-origin: *`, `cache-control: private, max-age=1800` on a negative answer |
| Formal spec | Cloudflare: "The DNS over HTTPS JSON format does not have a formal RFC, which means behavior might be different between providers. Additionally, there might be small changes in behavior in the future. For critical use cases, it is recommended to use the DNS over HTTPS wireformat" | Google originated the JSON schema (Cloudflare: "Cloudflare has chosen to follow the same schema as Google's DNS over HTTPS resolver.") |
| Rate limits | no numeric limit published. https://developers.cloudflare.com/1.1.1.1/infrastructure/network-operators/ : "Operators using 1.1.1.1 for typical Internet-facing applications and/or users should not encounter any rate limiting ... In some rare cases, security scanning use-cases or proxied traffic may be rate limited"; "Avoid ... proxying all queries from a single IP address at high rates"; "A high rate of \"uncacheable\" responses (such as SERVFAIL ...) against the same domain may be rate limited to protect upstream, authoritative nameservers". Errors: 400, 413, 415, 504. | no numeric limit published. https://developers.google.com/speed/public-dns/docs/doh : 429 Too Many Requests - "The client has sent too many requests in a given amount of time. Clients should stop sending requests until the time specified in the Retry-After header (a relative time in seconds)." Other codes 400, 413, 414, 415, 500, 501, 502. |
| ToS | https://developers.cloudflare.com/1.1.1.1/terms-of-use/ (Last updated Apr 30, 2026): "By using 1.1.1.1 Public DNS Resolver ... you agree to the Cloudflare Website and Online Services Terms of Use". Those terms (effective August 1, 2025, section 7): "You may not use the Websites or Online Services in any manner that could damage, disable, overburden, disrupt or impair any Cloudflare servers or APIs" | https://developers.google.com/speed/public-dns/terms (Last modified June 24, 2020): "By using the Google Public DNS service and its APIs, you consent to be bound by the Google APIs Terms of Service". APIs ToS (Last modified November 9, 2021), API Limitations: "Google sets and enforces limits on your use of the APIs ... You agree to, and will not attempt to circumvent, such limitations documented with each API." |
| Cache refresh tools | Purge Cache page (https://developers.cloudflare.com/1.1.1.1/faq/ "What is Purge Cache?") | Flush Cache tool, needs reCAPTCHA, cannot flush ECS-geo domains, "TTLs ... are generally limited to six hours even if the actual TTL is longer" (https://developers.google.com/speed/public-dns/faq) |
| Doc dates | make-api-requests page "Last updated May 5, 2026"; dns-json page undated | DoH JSON page "Last updated 2024-09-03 UTC" |

Live checks I ran (2026-09-29 ~19:49-19:55 UTC through the sandbox proxy):
- Cloudflare: `HTTP/2 200`, `content-type: application/dns-json`, `access-control-allow-origin: *`; `_dmarc.resend.com TXT` returned `Status 0`, `TTL 300`.
- Google: `HTTP/2 200`, `content-type: application/json; charset=UTF-8`, `cache-control: private, max-age=1800`; a NODATA answer carried `Authority` SOA with `TTL 1800` and SOA minimum field 1800 (negative-cache TTL = SOA minimum, as RFC 2308 says).
- Same-name repeated queries do NOT give a monotonic countdown. `iana.org A` sampled 6 times ~7 s apart: Cloudflare TTLs 206, 2823, 2909, 2700, 2617, 3230; Google TTLs 2777, 1433, 2763, 2754, 1411, 1403. `resend.com TXT` at Google returned 300, 300, 287 with different RRset ordering. Cause (inference, not stated by vendors): anycast resolvers hold many independent caches. Consequence: a single resolver answer is a sample, RRset order is not stable (compare as sets), and remaining TTL is an upper bound on that cache node only.

### 6.2 Recommended check order (authoritative first)

1. Pre-write snapshot from the AUTHORITATIVE servers only (never from public resolvers for names that may not exist yet). RFC 2308 section 3/5: "The TTL of this record is set from the minimum of the MINIMUM field of the SOA record and the TTL of the SOA itself, and indicates how long a resolver may cache the negative answer." A public probe of a not-yet-written name can prime a negative cache for up to SOA-minimum seconds and make the change look slower.
2. Find the delegation the world uses: ask the parent (TLD registry servers) for the zone's NS set (a referral), not a recursive resolver; compare with the NS the registrar reports having set. Query every NS directly, `RD=0`, expect `AA=1` (RFC 1035 4.1.1: "AA ... specifies that the responding name server is an authority for the domain name in question section"; "RD ... directs the name server to pursue the query recursively"), retry over TCP when `TC=1`. **Not testable from this sandbox** (UDP/53 intercepted, section 1); whether Vercel Functions permit outbound UDP/53 is unverified (their limits page mentions only "Network connections (TCP sockets, HTTP requests)" under file descriptors).
3. After the write, poll every authoritative NS until all return the desired RRset (compare sets, normalise names/quotes/case).
4. Then sample public resolvers via DoH (Cloudflare + Google, optionally more): a record is "spread" only after K consecutive matching samples from each (design proposal: K=2, jittered 5-60 s backoff, honour `Retry-After`, never burst).
5. Provider-side truth where it exists: Vercel `GET /v6/domains/{domain}/config` (`misconfigured`, `configuredBy`) and project-domain `verified`; Resend `GET /domains/{id}` per-record `status` and `domain.updated` webhook; Netlify site/domain state (`ssl`, `custom_domain`) and `POST /sites/{id}/ssl`; Neon `operations[].status`. These reflect what the provider itself can see, which is the only propagation that matters for their verification.
6. End-to-end: HTTPS request to the apex and www expecting the provider's response; for `.dev` and `.app` a valid cert is mandatory (HSTS preload, below).

### 6.3 TTL, caching and negative-caching facts

| Fact | Source and quote |
|---|---|
| TTL is unsigned 31-bit; RRset members share one TTL | RFC 2181 (https://www.rfc-editor.org/rfc/rfc2181.txt) s8: "a maximum value of 2147483647"; s5.2: "the use of differing TTLs in an RRSet is hereby deprecated, the TTLs of all RRs in an RRSet must be the same." |
| Negative answers are cached, TTL from SOA | RFC 2308 (https://www.rfc-editor.org/rfc/rfc2308.txt) s3, s5 (quoted in 6.2). s1: "negative caching should no longer be seen as an optional part of a DNS resolver." |
| Resolvers may serve stale data during outages | RFC 8767 "Serving Stale Data to Improve DNS Resiliency" (https://www.rfc-editor.org/rfc/rfc8767.txt): a resolver may answer with expired data when authoritative servers are unreachable, so "old value still visible" can outlast TTL. |
| DoH HTTP cache lifetime = smallest TTL | RFC 8484 s5.1: "The assigned freshness lifetime of a DoH HTTP response MUST be less than or equal to the smallest TTL in the Answer section of the DNS response." Do not add your own HTTP cache in front of DoH probes. |
| Google caps cached TTLs | "these are generally limited to six hours even if the actual TTL is longer" (Google Public DNS FAQ). Cloudflare's cap: not documented (unverified). |
| Cloudflare authoritative TTL bounds | DNS-only: 60 s (30 s Enterprise) to 1 day; Auto = 300 s; proxied records are always Auto (300 s) - https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/ (Last updated Apr 16, 2026); API: "Value must be between 60 and 86400, with the minimum reduced to 30 for Enterprise zones." |
| Lower TTL first, then change | Vercel: "we recommend updating your existing DNS record to \"lower\" the TTL (for example 60 seconds) and waiting for the old TTL to expire" before the switch; "Ideally, about 24 hours in advance of changes, you should shorten the DNS TTL to 60s" (https://vercel.com/docs/domains/working-with-dns). Netlify: old TTLs must expire before cert issuance. |
| Vendor timing claims (do not display as ETAs) | Vercel: nameserver change up to 24-48 h; Netlify: "a full day"; Resend: usually 15 min, up to 72 h. Use as timeouts, not predictions. |

### 6.4 CNAME at the apex and the alternatives

| Fact | Source and quote |
|---|---|
| CNAME exclusivity | RFC 1034 s3.6.2 (https://www.rfc-editor.org/rfc/rfc1034.txt): "If a CNAME RR is present at a node, no other data should be present"; RFC 2181 s10.1: exactly one of "one CNAME record exists" or "one or more records exist, none being CNAME records". The apex always has SOA and NS, so apex CNAME is invalid. |
| ANAME is not a standard | draft-ietf-dnsop-aname rev 04: "Unlike CNAME, an ANAME can coexist with other record types."; datatracker state: "Expired" (expires 2020-01-09), IESG "I-D Exists" (https://datatracker.ietf.org/doc/draft-ietf-dnsop-aname/). ALIAS/ANAME/flattening are vendor-specific server-side synthesis. |
| HTTPS/SVCB AliasMode | RFC 9460 s2.4.2: "The primary purpose of AliasMode is to allow aliasing at the zone apex, where CNAME is not allowed"; client support is incomplete (Vercel: "not all clients can support"). |
| Cloudflare CNAME flattening | https://developers.cloudflare.com/dns/cname-flattening/ (Last updated Jun 24, 2026): apex CNAME accepted and flattened to A/AAAA; "If the final CNAME target has no A/AAAA records (a dangling CNAME), CNAME flattening returns an empty response (NODATA)... This can make it appear as if the DNS record is not propagating."; flattening all CNAMEs "may cause the verification to fail" for third-party CNAME verification (Resend DKIM/return-path CNAME variant, tracking CNAME). |
| Vercel DNS | Type `ALIAS` exists ("similar to a `CNAME` record, but can only be used at the zone apex. The target domain must return `A` or `AAAA` record"); Vercel itself says ALIAS/ANAME are unnecessary because anycast "already provides the steering", and asks for an A record. |
| Netlify | Prefers ALIAS/ANAME/flattened CNAME -> `apex-loadbalancer.netlify.com`, falls back to A `75.2.60.5`. Opposite vendor guidance to Vercel: the recipe must be provider-specific and check whether the registrar DNS supports ALIAS. |
| Registrar DNS support | Gandi LiveDNS supports `ALIAS` (record type list "A, AAAA, ALIAS, CAA, CDS, CNAME, DNAME, DS, HTTPS, ..."; `rrset_ttl` min 300, max 2592000; https://api.gandi.net/docs/livedns/). Porkbun supports `ALIAS`, `HTTPS` as "masked" records that cannot be recreated by its zone-restore. Cloudflare flattening. Netlify DNS lists no ALIAS. Namecheap: unverified (blocked). |

### 6.5 Conflicts with existing records (what a plan must detect)

- Same-name exclusivity: Cloudflare create-record notes: "A/AAAA records cannot exist on the same name as CNAME records." "NS records cannot exist on the same name as any other record type." (https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/).
- Domain Connect's rule set (a reusable conflict spec) - https://github.com/Domain-Connect/spec (raw `Domain Connect Spec Draft.adoc`, version 2.3, revision 67, dated 3-02-2025): "CNAME record conflicts with TXT, MX, AAAA, A and existing CNAME records, and any other records of these types conflict with an existing CNAME record. Note: CNAME records cannot be at the root of the zone."; "NS records conflict with all other records."; "MX, SRV records always conflict with records of the same type"; "A and AAAA records conflict with any other A and/or AAAA record, to avoid IPv4 and IPv6 pointing to different services."; TXT conflicts controlled by `txtConflictMatchingMode` None/All/Prefix.
- Porkbun DNS API returns `RECORD_CONFLICT` with `conflictingRecords` ("a CNAME is exclusive of every other type there (RFC 1034)") and refuses a second apex SPF with `SPF_CONFLICT` ("Two SPF records at one name is a permerror under RFC 7208 4.5") - https://porkbun.com/llms-full.txt (API v3.44).
- Recipe-specific conflicts: Vercel apex needs no AAAA ("Remove all AAAA records for the apex"); stale `_acme-challenge` TXT interferes with Vercel validation; Resend MX on the same host as existing mail MX (use a subdomain); Resend CNAME variant needs a free hostname; only one SPF TXT per name (send subdomain is separate from apex SPF, so no merge is needed for the `send.*` host, but an apex SPF for a user's mailbox provider must not be duplicated).

### 6.6 How registrar/DNS APIs report a write: what can be derived from each

| API | Write semantics | Change-status signal | Source and quote |
|---|---|---|---|
| Porkbun v3.44 (https://porkbun.com/llms/dns , /llms-full.txt) | per-record `create/edit/delete`; `dryRun: true` on create ("validate only ... returns wouldSucceed"); TTL min from account settings, "typically 600"; zone limit 2,500 records | none about propagation; **write succeeds even when the domain is delegated elsewhere** | https://porkbun.com/llms-full.txt (v3.44): "a DNS write is accepted and stored even when the domain is NOT delegated to our nameservers ... so the write changed nothing that resolves, and this field [`warnings`] says so." `GET /dns/preflight/{domain}` check `nameservers-ours`: "Writes to it keep succeeding and change nothing visible." Also `cname-exclusivity`, `spf-duplicate`, `dnssec-active` (blocker: "the domain goes dark rather than degrading"). History/undo: `GET /dns/history/{domain}`, `GET /dns/diff/{domain}/{id}`, `POST /dns/restore/{domain}` ("Restore points are taken automatically: before the first write to a zone in each hour"). Rate-limited endpoints return 429 + `Retry-After`. |
| Cloudflare DNS | `POST /zones/{zone_id}/dns_records`, batch endpoint | none; batch: "Cloudflare will execute the batched operations in a single database transaction, [but] the propagation of changes is not atomic" and the batch page lists the fixed execution order Deletes, Patches, Puts, Posts | https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/batch/ |
| AWS Route 53 | `ChangeResourceRecordSets` returns a Change | `GetChange` status PENDING or INSYNC | https://docs.aws.amazon.com/Route53/latest/APIReference/API_GetChange.html : "PENDING indicates that the changes in this request have not propagated to all Amazon Route 53 DNS servers managing the hosted zone ... INSYNC indicates that the changes have propagated to all Route 53 DNS servers managing the hosted zone." This is the best example of a provider "in flight" state, but it covers only the provider's own authoritative fleet, not resolver caches. |
| Vercel DNS | per-record POST/PATCH/DELETE, TTL default 60 | none | section 2.2 |
| Netlify DNS | per-record POST/DELETE; "Edit = add new then delete old" | none | section 3 |
| Gandi LiveDNS | rrset-based (`rrset_ttl` min 300) | not examined | https://api.gandi.net/docs/livedns/ |
| Namecheap | not verified | | blocked by egress policy (section 1) |

**Conclusion for "DNS write in flight" (design proposal, sourced from the rows above):** do not derive it from the API response. Derive it from the difference between the desired RRset and what each authoritative NS returns (plus provider-native PENDING states where they exist), and treat a `nameservers-ours` mismatch as a distinct `not_delegated` blocked state rather than "in flight".

### 6.7 Domain Connect as prior art (declarative template + conflict + revert)

https://github.com/Domain-Connect/spec (v2.3 draft): providers discover a DNS host via a `_domainconnect` TXT record, then apply a template `POST {urlAPI}/v2/domainTemplates/providers/{providerId}/services/{serviceId}/apply` (OAuth async flow) or a browser-redirect synchronous flow; template record types "A, AAAA, CNAME, MX, TXT, SRV, or SPFM"; conflicts on apply return an error enumerating conflicting records, `force` overrides ("Others may decide to apply their template anyway using the 'force' parameter"); revert endpoint `POST .../revert?domain=&host=` (optional; 501 if unsupported); `essential` flag on records and `multiInstance` template flag; SPF merge rules. On verification: "the Service Provider can not assume the changes were applied to DNS." and "it is recommend [sic] that enablement of a service be based on verification of changes to DNS." Resend and Vercel docs say their "Auto Configure" uses Domain Connect. Whether Vercel/Netlify/Neon/Resend publish Domain Connect templates in the public Templates repo could not be enumerated (GitHub API 403): unverified.

### 6.8 HTTPS-only TLDs (affects what "spread" means)

- `.dev`: https://get.dev/ : "The .dev top-level domain is included on the HSTS preload list, making HTTPS required on all connections to .dev websites".
- Live check `https://hstspreload.org/api/v2/status?domain=dev` -> `"status": "preloaded"`; same for `app` -> `"preloaded"`; `com`, `ai`, `io`, `studio` -> `"unknown"` (not preloaded as TLDs).
- Implication: on `.dev`/`.app`, DNS may be fully converged yet browsers show a hard error until the host's certificate is issued (Vercel: Let's Encrypt HTTP-01 on `/.well-known/acme-challenge/`; Netlify: Let's Encrypt, requires old TTLs expired). The creature's final "spread" state must include a certificate check.

---

## 7. Environment variables and scopes master table

| Service | Variable | Value | Sensitivity | Target scope | Source |
|---|---|---|---|---|---|
| Neon | `DATABASE_URL` | pooled URI (`...-pooler...?sslmode=require`) | secret | prod + preview at runtime | Neon Vercel integrations, Drizzle guide |
| Neon | `DATABASE_URL_UNPOOLED` | direct URI | secret | build/migration step; Drizzle Kit | same |
| Neon | `PGHOST`, `PGHOST_UNPOOLED`, `PGUSER`, `PGDATABASE`, `PGPASSWORD` | parts | secret (`PGPASSWORD`) | optional | vercel-managed-integration |
| Neon | `POSTGRES_URL`, `POSTGRES_*` | legacy aliases | secret | only if legacy code | neon-managed-vercel-integration |
| Neon | `NEON_AUTH_BASE_URL`, `VITE_NEON_AUTH_URL` | Neon Auth endpoints | public (VITE_) | only if Neon Auth used | vercel-managed-integration |
| Resend | `RESEND_API_KEY` | `re_...` `sending_access` key limited to `domain_id` | secret | prod + preview (use a separate key per environment) | Resend Vercel Functions guide |
| Mosshatch-defined | e.g. `RESEND_WEBHOOK_SECRET`, `MAIL_FROM` | | secret / plain | | not provider-defined |
| Vercel API (for Mosshatch itself) | `VERCEL_ACCESS_TOKEN` in Vercel's own examples | user token | secret | server only | https://vercel.com/docs/accounts/access-tokens |
| Netlify API | `NETLIFY_AUTH_TOKEN` is not verified from docs fetched; `NETLIFY_SITE_ID` is ("NETLIFY_SITE_ID") | | | | get-started-with-api |

Vercel env var write rules: `type: sensitive` allowed only for `production`/`preview` targets ("If the Development environment is selected, you will be unable to enable the switch."), `upsert=true` for idempotent apply, 64 KB total per deployment. Netlify: `scopes` (builds/functions/runtime/post-processing; Pro+) and per-`context` values (`production`, `deploy-preview`, `branch-deploy`, `branch`, `dev`, `dev-server`, `all`), `is_secret`.

---

## 8. Proposed recipe data model (design proposal; the sourced facts it relies on are cited in sections 2-7)

Principles taken from the evidence:
- Every DNS record and variable carries a `source` (static, `provider_reported`, `provider_generated`, `suggested`) and a `previewFidelity` (`exact`, `provider_supplied`, `pending_provider_create`) so the UI can say truthfully what it can and cannot show before applying (Vercel config is readable pre-attach; Resend records exist only after `POST /domains`).
- Records are compared as canonical tuples (type, FQDN lower-cased, RRset as a set, TXT unquoted/concatenated) because Resend names are sometimes relative and sometimes FQDN, SPF TXT values sometimes carry literal quotes, and public resolvers reorder RRsets.
- Preconditions capture an authoritative-only snapshot (for conflict detection, old TTL and rollback) and block on `nameservers-ours`.
- Steps are idempotent-by-construction where the provider allows it (`upsert=true` on Vercel env; Neon operations polled to `finished`; Resend create is not idempotent, so recipes store `resend.domain.id` and reuse it).
- Approval: a human passkey covers anything billable or touching live DNS.

### 8.1 Recipe (declarative plan) example

```json
{
  "schema": "mosshatch.recipe/1",
  "id": "rcp_example_01",
  "kind": "wire",
  "domain": "example.dev",
  "zone": "example.dev",
  "createdAt": "2026-09-29T20:00:00Z",
  "planFingerprint": "sha256:<hash of resolved records+variables+steps>",
  "targets": {
    "hosting": {
      "provider": "vercel",
      "connection": "conn_vercel",
      "projectId": "prj_EXAMPLE",
      "teamId": "team_EXAMPLE",
      "hostnames": ["example.dev", "www.example.dev"],
      "primary": "www.example.dev",
      "apexRedirectsToPrimary": true
    },
    "postgres": {
      "provider": "neon",
      "connection": "conn_neon",
      "mode": "reuse",
      "projectId": "proj-example-123",
      "branchId": "br-example-456",
      "database": "neondb",
      "role": "mosshatch_app"
    },
    "email": {
      "provider": "resend",
      "connection": "conn_resend",
      "sendingDomain": "updates.example.dev",
      "region": "us-east-1",
      "customReturnPath": "send",
      "receiving": false,
      "tracking": false
    }
  },
  "connections": {
    "conn_vercel": {"auth": "access_token", "tokenScope": "project", "credentialRef": "vault://conn_vercel", "requires": ["projects.domains:write", "projects.env:write", "domains.config:read"]},
    "conn_neon": {"auth": "api_key", "keyType": "project_scoped", "credentialRef": "vault://conn_neon", "requires": ["projects:read", "branches.roles:write"]},
    "conn_resend": {"auth": "oauth2_pkce", "grantedScopes": ["full_access"], "credentialRef": "vault://conn_resend", "runtimeCredential": "sending_access key minted in step resend.apikey"}
  },
  "preconditions": [
    {"id": "pc_ns", "check": "authoritative_nameservers_are_ours", "onFail": "block", "why": "registrar DNS API accepts writes for zones nobody queries"},
    {"id": "pc_snapshot", "check": "capture_rrset_snapshot", "names": ["@", "www", "send.updates", "resend._domainkey.updates", "_dmarc"], "source": "authoritative_only"},
    {"id": "pc_no_cname_clash", "check": "no_cname_exclusivity_conflict", "onFail": "block"},
    {"id": "pc_no_apex_aaaa", "check": "no_record", "type": "AAAA", "name": "@", "reason": "vercel does not support IPv6 for custom domains", "onFail": "offer_delete"}
  ],
  "dns": {
    "defaultTtl": 300,
    "records": [
      {
        "id": "rec_apex_a", "purpose": "hosting.apex",
        "type": "A", "name": "@", "value": "76.76.21.21", "ttl": 300,
        "source": {"kind": "provider_reported", "provider": "vercel", "call": "GET /v6/domains/{domain}/config?projectIdOrName={projectId}", "path": "$.recommendedIPv4[?(@.rank==1)].value[0]"},
        "previewFidelity": "provider_supplied",
        "conflict": {"policy": "replace_same_name_type", "forbidSameName": ["CNAME"]},
        "essential": true
      },
      {
        "id": "rec_www_cname", "purpose": "hosting.www",
        "type": "CNAME", "name": "www", "value": "d1d4fc829fe7bc7c.vercel-dns-017.com", "ttl": 300,
        "source": {"kind": "provider_reported", "provider": "vercel", "call": "GET /v6/domains/{domain}/config?projectIdOrName={projectId}", "path": "$.recommendedCNAME[?(@.rank==1)].value"},
        "previewFidelity": "provider_supplied",
        "conflict": {"policy": "fail", "forbidSameName": ["A", "AAAA", "TXT", "MX", "CNAME"]},
        "essential": true
      },
      {
        "id": "rec_resend_dkim", "purpose": "email.dkim",
        "type": "TXT", "name": "resend._domainkey.updates", "value": null, "ttl": 300,
        "source": {"kind": "provider_generated", "provider": "resend", "call": "POST /domains", "path": "$.records[?(@.record=='DKIM')]"},
        "previewFidelity": "pending_provider_create",
        "conflict": {"policy": "fail", "forbidSameName": ["CNAME"]},
        "essential": true
      },
      {
        "id": "rec_resend_return_mx", "purpose": "email.return_path",
        "type": "MX", "name": "send.updates", "priority": 10, "value": "feedback-smtp.us-east-1.amazonses.com", "ttl": 300,
        "source": {"kind": "provider_generated", "provider": "resend", "call": "POST /domains", "path": "$.records[?(@.record=='SPF' && @.type=='MX')]"},
        "previewFidelity": "pending_provider_create",
        "shapeMayChange": "resend may return CNAME records instead of MX+TXT for domains created after Aug 2026; always copy provider records verbatim",
        "conflict": {"policy": "fail", "forbidSameName": ["CNAME"]},
        "essential": true
      },
      {
        "id": "rec_resend_spf_txt", "purpose": "email.spf",
        "type": "TXT", "name": "send.updates", "value": "v=spf1 include:amazonses.com ~all", "ttl": 300,
        "source": {"kind": "provider_generated", "provider": "resend", "call": "POST /domains", "path": "$.records[?(@.record=='SPF' && @.type=='TXT')]"},
        "previewFidelity": "pending_provider_create",
        "compare": {"stripOuterQuotes": true, "caseSensitive": false},
        "conflict": {"policy": "fail", "forbidSameName": ["CNAME"]},
        "essential": true
      },
      {
        "id": "rec_dmarc", "purpose": "email.dmarc",
        "type": "TXT", "name": "_dmarc", "value": "v=DMARC1; p=none; rua=mailto:dmarcreports@example.dev;", "ttl": 300,
        "source": {"kind": "suggested", "provider": "resend", "doc": "https://resend.com/docs/dashboard/domains/dmarc"},
        "previewFidelity": "exact",
        "optional": true,
        "conflict": {"policy": "skip_if_exists"},
        "essential": false
      }
    ]
  },
  "variables": [
    {
      "name": "DATABASE_URL", "sensitive": true,
      "valueFrom": {"step": "neon.uri.pooled", "path": "$.uri"},
      "note": "pooled host (-pooler); app runtime",
      "targets": [{"provider": "vercel", "kind": "project_env", "projectId": "prj_EXAMPLE", "environments": ["production", "preview"], "type": "sensitive", "upsert": true}]
    },
    {
      "name": "DATABASE_URL_UNPOOLED", "sensitive": true,
      "valueFrom": {"step": "neon.uri.direct", "path": "$.uri"},
      "note": "direct host; drizzle-kit / migrations",
      "targets": [{"provider": "vercel", "kind": "project_env", "projectId": "prj_EXAMPLE", "environments": ["production", "preview"], "type": "sensitive", "upsert": true}]
    },
    {
      "name": "RESEND_API_KEY", "sensitive": true,
      "valueFrom": {"step": "resend.apikey", "path": "$.token"},
      "note": "sending_access key restricted to the sending domain",
      "targets": [{"provider": "vercel", "kind": "project_env", "projectId": "prj_EXAMPLE", "environments": ["production", "preview"], "type": "sensitive", "upsert": true}]
    }
  ],
  "steps": [
    {"id": "vercel.config.read", "provider": "vercel", "call": "GET /v6/domains/example.dev/config?projectIdOrName=prj_EXAMPLE", "mutates": false},
    {"id": "neon.role", "provider": "neon", "call": "POST /projects/proj-example-123/branches/br-example-456/roles", "mutates": true, "warns": "may drop existing connections to the active compute", "rollback": {"call": "DELETE /projects/proj-example-123/branches/br-example-456/roles/mosshatch_app"}},
    {"id": "neon.uri.pooled", "provider": "neon", "after": ["neon.role"], "call": "GET /projects/proj-example-123/connection_uri?database_name=neondb&role_name=mosshatch_app&pooled=true", "mutates": false},
    {"id": "neon.uri.direct", "provider": "neon", "after": ["neon.role"], "call": "GET /projects/proj-example-123/connection_uri?database_name=neondb&role_name=mosshatch_app&pooled=false", "mutates": false},
    {"id": "resend.domain", "provider": "resend", "call": "POST /domains", "body": {"name": "updates.example.dev", "region": "us-east-1", "custom_return_path": "send", "capabilities": {"sending": "enabled", "receiving": "disabled"}}, "mutates": true, "costsMoney": false, "rollback": {"call": "DELETE /domains/{resend.domain.id}", "note": "region and return-path are immutable; change = delete + re-add + new DKIM"}},
    {"id": "resend.apikey", "provider": "resend", "after": ["resend.domain"], "call": "POST /api-keys", "body": {"name": "mosshatch-example.dev-prod", "permission": "sending_access", "domain_id": "{resend.domain.id}"}, "mutates": true, "rollback": {"call": "DELETE /api-keys/{id}"}},
    {"id": "dns.apply", "provider": "registrar_dns", "after": ["vercel.config.read", "resend.domain"], "op": "write_records", "records": ["rec_apex_a", "rec_www_cname", "rec_resend_dkim", "rec_resend_return_mx", "rec_resend_spf_txt", "rec_dmarc"], "dryRunFirst": true, "mutates": true, "rollback": {"op": "restore_rrset_snapshot", "snapshot": "pc_snapshot"}},
    {"id": "vercel.domain.apex", "provider": "vercel", "after": ["dns.apply"], "call": "POST /v10/projects/prj_EXAMPLE/domains", "body": {"name": "example.dev", "redirect": "www.example.dev", "redirectStatusCode": 308}, "mutates": true, "rollback": {"call": "DELETE /v9/projects/prj_EXAMPLE/domains/example.dev"}},
    {"id": "vercel.domain.www", "provider": "vercel", "after": ["dns.apply"], "call": "POST /v10/projects/prj_EXAMPLE/domains", "body": {"name": "www.example.dev"}, "mutates": true, "rollback": {"call": "DELETE /v9/projects/prj_EXAMPLE/domains/www.example.dev"}},
    {"id": "vercel.env", "provider": "vercel", "after": ["neon.uri.pooled", "neon.uri.direct", "resend.apikey"], "call": "POST /v10/projects/prj_EXAMPLE/env?upsert=true", "variables": ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "RESEND_API_KEY"], "mutates": true, "rollback": {"op": "delete_created_env_vars_and_restore_prior_values_if_known"}},
    {"id": "resend.verify", "provider": "resend", "after": ["dns.apply"], "gate": "check.dns.email.authoritative", "call": "POST /domains/{resend.domain.id}/verify", "mutates": true}
  ],
  "checks": [
    {"id": "check.dns.hosting.authoritative", "kind": "dns_authoritative", "records": ["rec_apex_a", "rec_www_cname"], "expect": "all_nameservers_return_desired_rrset", "queryFlags": {"rd": false}, "timeoutSec": 900},
    {"id": "check.dns.email.authoritative", "kind": "dns_authoritative", "records": ["rec_resend_dkim", "rec_resend_return_mx", "rec_resend_spf_txt"], "expect": "all_nameservers_return_desired_rrset", "queryFlags": {"rd": false}, "timeoutSec": 900},
    {"id": "check.dns.public", "kind": "dns_public_sample", "resolvers": ["cloudflare-doh", "google-doh"], "records": "all_required", "expect": "consecutive_matches>=2 per resolver", "poll": {"initialSec": 5, "maxSec": 60, "jitter": 0.3, "honorRetryAfter": true}, "timeoutSec": 7200},
    {"id": "check.vercel.config", "kind": "provider_status", "provider": "vercel", "call": "GET /v6/domains/{domain}/config?projectIdOrName=prj_EXAMPLE", "expect": {"misconfigured": false, "configuredBy": ["A", "CNAME"]}},
    {"id": "check.vercel.verified", "kind": "provider_status", "provider": "vercel", "call": "GET /v9/projects/prj_EXAMPLE/domains/{domain}", "expect": {"verified": true}},
    {"id": "check.resend.domain", "kind": "provider_status", "provider": "resend", "call": "GET /domains/{resend.domain.id}", "expect": {"status": "verified"}, "alsoOn": "webhook:domain.updated", "timeoutSec": 259200},
    {"id": "check.neon.op", "kind": "provider_status", "provider": "neon", "call": "GET /projects/proj-example-123/operations/{operation_id}", "expect": {"status": "finished"}},
    {"id": "check.neon.sql", "kind": "sql", "connection": "DATABASE_URL", "statement": "select 1", "expect": "ok"},
    {"id": "check.https", "kind": "https", "urls": ["https://example.dev/", "https://www.example.dev/"], "expect": {"tlsValid": true, "status": [200, 301, 308]}, "why": "example.dev is on the HSTS preload list (.dev), so DNS alone is not 'spread'"}
  ],
  "rollback": {
    "order": "reverse_of_steps",
    "snapshots": {"pc_snapshot": "rrsets captured from authoritative servers before the write; also stored as registrar restore point when the registrar API offers one"},
    "irreversible": ["neon role password disclosure", "emails already sent", "resend DKIM key rotation on delete/re-add"],
    "afterRollback": "re-run check.dns.public against the restored RRsets; cached new values may persist for max(new TTL, negative TTL)"
  },
  "approval": {
    "passkeyRequired": true,
    "reasons": ["writes live DNS records", "may create billable provider resources (neon project, resend plan) if mode != reuse"],
    "diffShownToHuman": ["dns.records", "variables (names, targets, environments, no values)", "steps with costsMoney != false"]
  }
}
```

### 8.2 Runtime status object (what the UI/creature reads; derived, never written by providers)

```json
{
  "recipeId": "rcp_example_01",
  "asOf": "2026-09-29T20:14:30Z",
  "records": [
    {
      "recordId": "rec_apex_a",
      "phase": "authoritative_partial",
      "registrarWrite": {
        "acceptedAt": "2026-09-29T20:10:02Z",
        "providerRef": "rec_12345",
        "warnings": []
      },
      "authoritative": {
        "nameservers": [
          {
            "host": "ns1.dns.mosshatch.example",
            "rcode": "NOERROR",
            "aa": true,
            "answers": [
              "76.76.21.21"
            ],
            "ttl": 300,
            "matches": true
          },
          {
            "host": "ns2.dns.mosshatch.example",
            "rcode": "NOERROR",
            "aa": true,
            "answers": [],
            "matches": false
          }
        ],
        "agree": 1,
        "of": 2
      },
      "public": [
        {
          "resolver": "cloudflare-doh",
          "samples": 0,
          "consecutiveMatches": 0
        },
        {
          "resolver": "google-doh",
          "samples": 0,
          "consecutiveMatches": 0
        }
      ],
      "cacheWindow": {
        "basis": "max(previousTtl, soaMinimum)",
        "previousTtl": 3600,
        "negativeTtl": 1800,
        "notAfter": "2026-09-29T21:10:02Z",
        "isUpperBound": true
      }
    }
  ],
  "derived": {
    "dnsWriteInFlight": true,
    "reason": "1 of 2 authoritative nameservers still lack rec_apex_a",
    "shedding": 0.3,
    "sheddingBasis": {
      "api": 0.1,
      "authoritative": 0.2,
      "publicResolvers": 0.0,
      "providerConfirmed": 0.0
    },
    "blocked": null
  }
}```

### 8.3 Derivation rules for `phase`, `dnsWriteInFlight` and `shedding`

| Phase (per record) | Condition | Notes |
|---|---|---|
| `planned` | not yet sent | preview only |
| `blocked_not_delegated` | authoritative NS set != the NS set Mosshatch DNS serves | Porkbun-style APIs still return success here (section 6.6), so this is NOT "in flight" |
| `blocked_conflict` | precondition found a CNAME-exclusivity or duplicate-SPF clash | Domain Connect / Porkbun conflict rules (6.5) |
| `registrar_accepted` | DNS API 2xx (and `warnings` empty) | weight 0.10 in the sample scoring |
| `authoritative_partial` | some but not all NS return desired RRset | weight 0.40 x (agree/of) |
| `authoritative_live` | every NS returns desired RRset with AA=1 | starts the resolver-cache window |
| `resolvers_partial` | at least one DoH sample matches, not yet K consecutive per resolver | weight up to 0.30 |
| `resolvers_converged` | K consecutive matching samples on Cloudflare and Google | |
| `provider_confirmed` | provider-native check passes (Vercel `misconfigured:false` + `verified:true`; Resend `status:verified`) | weight 0.20; this is what unlocks the next recipe step |
| `served` | end-to-end HTTPS/SMTP check passes (cert valid, mandatory on `.dev`/`.app`) | terminal "fully spread" |
| `stalled` | `now` past the vendor timeout (Resend 72 h; Netlify/Vercel documented day-scale) without progress | show the vendor's own timeout guidance |

`dnsWriteInFlight = exists record with phase in {registrar_accepted, authoritative_partial, authoritative_live, resolvers_partial}` OR any provider-native PENDING (Route 53-style) status. Weights (0.10/0.40/0.30/0.20) are an illustrative UI proposal, not vendor data.

Polling hygiene (from the vendor statements in 6.1): sample public DoH at jittered 5-60 s intervals, stop on `Retry-After`/429, spread requests, never sample not-yet-written names on public resolvers (negative-cache priming, RFC 2308), and compare RRsets as sets.

---

## 9. Design implications for Phase 4 (each traces to a finding above)

1. Split a wire-it recipe into `plan` (read-only: Vercel config, Neon connection-URI shape, existing-zone snapshot) and `apply`; show three preview grades (exact / provider-supplied / pending-provider-create). Resend's DKIM and its record shape cannot be previewed without creating the provider-side domain.
2. Treat provider record values as data, never constants: Vercel A `76.76.21.21` vs `216.198.79.1`, per-project CNAME target; Resend TXT+MX vs CNAME variant after Aug 2026; Netlify per-site `*.netlify.app` and High-Performance Edge exceptions.
3. Provider-specific apex strategy table: Vercel -> A only; Netlify -> ALIAS/flattened CNAME to `apex-loadbalancer.netlify.com` if the registrar DNS offers ALIAS, else A `75.2.60.5`; recommend `www` primary for both when external DNS. Capability-flag ALIAS support per registrar DNS backend (Gandi and Porkbun yes; Netlify DNS no; Namecheap unknown).
4. Connect flows: Vercel = pasted project/team-scoped token now, connectable-account integration (needs Vercel approval, 30-min single-use code) as the polished path; Sign in with Vercel is not yet viable for API access. Neon = pasted project-scoped key (OAuth is partner-only) or Vercel marketplace. Resend = OAuth 2.1+PKCE (`full_access` needed for domains) then mint and store only a domain-restricted `sending_access` key for runtime.
5. Keep secrets in the Mosshatch vault: Vercel sensitive vars are write-only and cannot target `development`; Neon/Resend tokens are shown once. Recipes store `valueFrom` references, never values, and the human approval diff shows names, environments and types only.
6. Two Neon URLs, two roles: pooled `DATABASE_URL` for runtime, direct `DATABASE_URL_UNPOOLED` for Drizzle Kit/migrations; new roles can drop live connections (warn on apply).
7. Async everywhere: Neon operations must reach `finished`; Resend verify returns immediately with `pending`; Vercel `verified`/`misconfigured` are independent of DNS visibility. Model each as a check with its own timeout.
8. Derive "shedding" from measured convergence (authoritative first, then Cloudflare+Google DoH samples requiring consecutive matches) and provider confirmation, not from API acceptance or timers. Show `blocked_not_delegated` distinctly. Because the same DoH endpoint returned TTLs 206..3230 s for one name within 40 s, show ranges/confidence, not a countdown.
9. Keep an upper-bound "cache window" = max(old TTL, SOA minimum) per changed name, and lower TTLs ahead of risky cutovers (Vercel/Netlify advice); use a low TTL (300 s, Vercel/Resend guidance; Cloudflare/Gandi floors 60/300 s, Porkbun typical 600 s) for all wired records and surface the floor per backend.
10. For `.dev`/`.app`, add a TLS certificate check to the terminal state (HSTS preload verified today).
11. Rollback = reverse steps + authoritative RRset snapshot (+ registrar restore points where offered, e.g. Porkbun `POST /dns/restore`), with an explicit irreversible list (immutable Resend region/return-path; deleting and re-adding rotates DKIM; Neon role creation may drop connections).
12. Consider implementing Domain Connect on the Mosshatch DNS side so third parties (Resend already documents Auto Configure for Vercel/Cloudflare) can apply templates; its conflict, `force`, `essential`, revert and "verify by DNS, not by redirect" rules map directly onto this recipe model.
13. Respect rate limits in the executor: Vercel domain create 100/min per owner, env create 120/min, DNS record create 50/min; Neon 700/min and 423 Locked on overlapping operations; Resend 10 req/s per team; Netlify 500/min; Google DoH 429 + Retry-After; Cloudflare DoH no published number but throttles high-rate single-IP and SERVFAIL-heavy traffic.
14. Marketplace-managed resources (Resend or Neon installed via Vercel) cannot be deleted from the provider dashboard and their env vars are managed by Vercel: a recipe must detect this and refuse to fight it.

---

## 10. Unverified / could not be verified (and why)

- Vercel: whether a project-scoped `vcp_` token (or a connectable-account integration token with only Projects scopes) may call the domain-level `GET /v6/domains/{domain}/config`; if not, a team-scoped token or the Domain read scope is needed for the pre-attach preview.
- Vercel: literal TXT verification value format (`vc-domain-verify=...`) for project domains (only `_vercel.{domain}` naming for team claim is in OpenAPI text); full list of the "pool of anycast IPs" beyond `76.76.21.21` and `216.198.79.1`; whether an env-var change needs a redeploy to take effect (not in the pages fetched); how to read certificate issuance state via API (not examined). No authenticated API call was made, so response shapes are from docs/OpenAPI only.
- Vercel Functions: whether outbound UDP/53 (or TCP/53) to arbitrary authoritative servers works; no doc statement found. Sandbox UDP/53 is intercepted (SERVFAIL for all servers), so direct authoritative querying was not testable here. A fallback worker or DoH-only degradation may be needed.
- Netlify: TXT domain-ownership verification records; whether an authorization-code OAuth exchange exists (swagger only declares `implicit`); `NETLIFY_AUTH_TOKEN` naming from primary docs.
- Neon: whether Mosshatch can become an OAuth partner; the newer `Credentials` (scoped credential) API surface was seen in the endpoint index but not examined; exact behaviour of "Lakebase Postgres" rename for API consumers.
- Resend: exact hostnames/values of the post-Aug-2026 CNAME record variant (DKIM and return-path); inbound MX hostnames for regions other than us-east-1; whether `POST /domains` returns records in the CNAME variant today; per-plan domain limits (pricing page not fetched; not needed for the recipe).
- Namecheap DNS API (`setHosts` replace-all semantics etc.): docs blocked by a Cloudflare bot challenge whose challenge host is rejected by the egress proxy; treated as **blocked by egress policy**, no alternate source used. OpenSRS/Tucows, Enom, ResellerClub DNS APIs not examined (the wholesale registrar is decided elsewhere).
- Domain Connect: whether Vercel, Netlify, Neon or Resend publish templates in the public repo (GitHub API returned 403).
- Cloudflare and Google numeric DoH rate limits: none published; behaviour under sustained automated use by a commercial service, and whether it is within their terms, needs legal reading (see below).
- DMARC placement for subdomain senders (`_dmarc.updates` vs `_dmarc` at the organisational domain) was not checked against RFC 7489 here; Resend's own doc uses `_dmarc.<verified domain>`.
- Weights and thresholds in section 8.3 (0.10/0.40/0.30/0.20, K=2, 5-60 s) are design proposals, not vendor data.

## 10.1 Items for a lawyer or accountant

- Automated commercial use of Google Public DNS / Cloudflare 1.1.1.1 DoH endpoints as a production dependency (Google APIs ToS "API Limitations"; Cloudflare Online Services terms "overburden ... APIs"): confirm acceptable use or choose a paid/contracted resolver API.
- Holding customers' third-party API credentials (Vercel/Neon/Resend tokens, Neon role passwords) in the Mosshatch vault: liability, breach-notification and provider partner-terms implications (Vercel Integrations Marketplace Agreement, Neon partner/OAuth terms, Resend terms).
- Reselling or wrapping provider resources (Resend/Neon via Vercel Marketplace vs direct) and who is the contracting party for billing.

---

## 11. Source index (all accessed 2026-09-29)

Vercel: https://vercel.com/docs/domains/working-with-domains/add-a-domain.md ; https://vercel.com/kb/guide/a-record-and-caa-with-vercel.md ; https://vercel.com/docs/domains/troubleshooting.md ; https://vercel.com/docs/domains/working-with-dns.md ; https://vercel.com/docs/domains/managing-dns-records.md ; https://vercel.com/docs/rest-api/reference/endpoints/projects/add-a-domain-to-a-project.md ; .../verify-project-domain.md ; .../get-a-project-domain.md ; .../domains/get-a-domain-s-configuration.md ; .../dns/create-a-dns-record.md ; .../projects/create-one-or-more-environment-variables.md ; https://openapi.vercel.sh/ (11.5 MB OpenAPI) ; https://vercel.com/docs/limits.md ; https://vercel.com/docs/accounts/access-tokens.md ; https://vercel.com/docs/sign-in-with-vercel.md and /scopes-and-permissions.md and /tokens.md ; https://vercel.com/docs/integrations/create-integration.md , /submit-integration.md , /vercel-api-integrations.md ; https://vercel.com/docs/connect.md ; https://vercel.com/docs/environment-variables/sensitive-environment-variables.md ; https://vercel.com/docs/functions/limitations.md.

Netlify: https://docs.netlify.com/manage/domains/configure-domains/configure-external-dns.md ; .../dns-records.md ; .../netlify-name-servers.md ; https://docs.netlify.com/manage/domains/manage-domains/assign-a-domain-to-your-site-app.md ; .../manage-multiple-domains.md ; https://docs.netlify.com/manage/domains/troubleshooting-tips.md ; .../troubleshooting/check-dns-propagation.md ; https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api.md ; https://open-api.netlify.com/swagger.json (v2.60.0) ; https://docs.netlify.com/llms.txt.

Neon: https://neon.com/docs/connect/connection-pooling.md ; https://neon.com/docs/guides/vercel-managed-integration.md ; https://neon.com/docs/guides/neon-managed-vercel-integration.md ; https://neon.com/docs/guides/drizzle.md ; https://neon.com/docs/reference/api-reference.md ; https://neon.com/docs/reference/api/key-concepts.md ; https://neon.com/docs/manage/api-keys.md ; https://neon.com/docs/guides/oauth-integration.md ; https://neon.com/api_spec/release/v2.json.

Resend: https://resend.com/docs/add-a-domain.md ; /dashboard/domains/introduction.md , /manage-domains.md , /custom-return-path.md , /regions.md , /dmarc.md , /tracking.md , /claim.md ; /dashboard/receiving/custom-domains.md ; /api-reference/domains/create-domain.md , /verify-domain.md , /get-domain.md , /update-domain.md , /list-domains.md ; /api-reference/api-keys/create-api-key.md ; /dashboard/api-keys/introduction.md ; /api-reference/rate-limit.md ; /guides/building-a-resend-oauth-client.md ; /api-reference/oauth/authorize.md , /token.md , /list-grants.md , /revoke-grant.md ; /guides/vercel-marketplace-integration.md ; /knowledge-base/vercel.md , /how-do-i-avoid-conflicting-with-my-mx-records.md , /what-if-my-domain-is-not-verifying.md ; /send-with-vercel-functions.md ; /webhooks/event-types.md , /webhooks/domains/updated.md , /webhooks/verify-webhooks-requests.md ; https://resend.com/docs/llms.txt.

DNS / propagation: https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/ and /dns-json/ ; https://developers.cloudflare.com/1.1.1.1/infrastructure/network-operators/ ; https://developers.cloudflare.com/1.1.1.1/faq/ ; https://developers.cloudflare.com/1.1.1.1/terms-of-use/ ; https://www.cloudflare.com/website-terms/ ; https://developers.google.com/speed/public-dns/docs/doh/json and /docs/doh ; https://developers.google.com/speed/public-dns/faq ; https://developers.google.com/speed/public-dns/terms ; https://developers.google.com/terms ; https://developers.cloudflare.com/dns/cname-flattening/index.md ; https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/index.md ; https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/index.md and /batch/index.md ; https://docs.aws.amazon.com/Route53/latest/APIReference/API_GetChange.html and API_ChangeInfo.html ; https://porkbun.com/llms/dns , https://porkbun.com/llms-full.txt , https://porkbun.com/api/json/v3/documentation ; https://api.gandi.net/docs/livedns/ ; https://github.com/Domain-Connect/spec (raw adoc) ; https://www.rfc-editor.org/rfc/rfc1034.txt , rfc1035.txt , rfc2181.txt , rfc2308.txt , rfc8484.txt , rfc8767.txt , rfc9460.txt ; https://datatracker.ietf.org/doc/draft-ietf-dnsop-aname/ ; https://get.dev/ ; https://hstspreload.org/api/v2/status?domain=<tld>.

Own live measurements: DoH probes described in section 6.1 (Cloudflare and Google, 2026-09-29 19:49-19:55 UTC); UDP/53 interception test (section 1).
