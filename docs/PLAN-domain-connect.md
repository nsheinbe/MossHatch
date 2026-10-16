# Connect a domain without giving it away

Last updated 2026-10-16. Plan only. No application code in this change.

A buyer keeps the name registered at Moss Hatch and keeps it on Openprovider nameservers. Moss Hatch is the Domain Connect DNS provider, because Openprovider is not one. Direct host integrations and an AI record assistant use the same write path. Every write goes through the existing Openprovider `/v1` DNS calls.

## Openprovider API version

Already `/v1`. No migration piece and no migration pull request.

| | |
|---|---|
| Production | `https://api.openprovider.eu/v1` (`PRODUCTION_URL` in `packages/registrar/src/openprovider/transport.ts`) |
| Sandbox | `https://api.sandbox.openprovider.nl/v1` (`SANDBOX_URL`, same file) |
| Selection | `OpenproviderAdapter` uses production when `mode === "live"`, otherwise sandbox. `OPENPROVIDER_ENV` chooses sandbox vs production credentials. It does not choose a path. |
| Call sites | Login, domains, customers, and DNS are relative to that base. DNS today is `GET /dns/zones/{name}`, `GET /dns/zones/{name}/records`, and `PUT /dns/zones/{name}`. |
| Proof | `packages/api/src/registrar-rpc/serve.test.ts` asserts the production URL. Recorded sandbox fixtures use the `/v1` sandbox host. `docs/registrar-parity.md` records the same. A search of the tree finds `v1beta` only in docs that describe the retirement, never in a request. |

Openprovider says `/v1` is functionally identical to `/v1beta` and that moving is a base-URL change (`https://docs.openprovider.com/doc/dns.swagger`: no new `/v1beta` integrations after September 2026, `/v1beta` off on 30 June 2027). That would have been the whole migration. It is already done.

Do not start using `records.update` or `records.replace`, and do not send `add` and `remove` in one body. Sandbox on 2026-09-30: combined add+remove applied the add and silently dropped the remove. The allow-list in `packages/registrar/src/openprovider/allowlist.ts` permits only one of `add` or `remove` per `PUT`. Re-verify on the sandbox before widening that.

## Decision

Keep authoritative DNS at Openprovider (`ns1.openprovider.nl`, `ns2.openprovider.be`, `ns3.openprovider.eu`). Do not run Moss Hatch nameservers. Do not point nameservers at the host by default.

Openprovider signs zones it hosts and has no Domain Connect discovery. The workaround is to implement Domain Connect ourselves, synchronous flow first:

1. Publish a `_domainconnect` TXT on each hosted zone.
2. Serve the settings document.
3. On a signed apply URL, show the records and write them only after the owner confirms.
4. Async OAuth is a later piece. Most services only implement sync, and sync is the flow they will call on us.

Hosts whose records are per-project (Vercel, Resend, Fly, Railway) do not get a hardcoded template. They use a recipe or a pasted value, then the same apply. Hosts that require an apex alias or their own nameservers get a guided delegation through the nameserver change that already exists.

## What is already built

Usable, but not a connect flow a buyer can find.

- DNS read and edit when the zone is on the provider nameservers: `GET/POST/PUT/PATCH/DELETE /api/v1/domains/:fqdn/dns`, snapshots, rollback. `packages/api/src/domain-mgmt/dns.ts`, `apps/web/src/ui/DnsTab.tsx`.
- Nameserver change and DS edits behind passkey step-up `domain.nameservers.change`. Lock is on by default at registration.
- Recipes `hosting-vercel`, `email-resend`, `postgres-neon`: plan hash, recompute-before-apply, `writeZoneLocked`, approval `dns.sensitive.approve` when the diff is sensitive or a provider object is created. API only. No web screen. Credential kind `oauth_refresh` is stored and never minted.
- Sensitive classification, 120 DNS writes an hour, pre-write snapshot, audit, registrar kill switch `registrar_writes_paused`.
- Dangling-target scan for recipe CNAMEs only. `dns.verify` is named in `docs/PLAN.md` and is not registered.

Gaps that block "connect this":

- `dns_hosted_here` defaults false. Registration in `packages/api/src/orders/machine.ts` (`createDomainRow`) does not set it. `isHostedNs` in `packages/api/src/domain-mgmt/common.ts` is true only for names ending in `.systemdns.com` (OpenSRS). The same suffix check is in `packages/api/src/transfers/driver.ts`. The DNS tab's editability uses `getDns().hosted`, which for Openprovider checks `OP_NAMESERVERS`, so editing can work while the overview says the zone is elsewhere.
- Record types on the port are A, AAAA, CNAME, MX, SRV, TXT. No CAA. `replaceZone` drops types it cannot express, including CAA. TXT longer than 254 characters is refused (`packages/registrar/src/dns.ts`). Openprovider's own help says TXT is 255 characters and shows a long DKIM value as several quoted strings in one record (`https://support.openprovider.eu/hc/en-us/articles/216648808-DNS-Records`). Google's 2048-bit DKIM does not fit one 255-character string.
- No ALIAS, ANAME, or apex CNAME. Openprovider says aliases at the apex are unsupported. TTL is sent as 900 and is not a customer field. Accepted TTLs are 900, 3600, 10800, 21600, 43200, 86400; anything else is stored as 86400.
- A signed-in person can change MX, apex A, and SPF with no passkey. Agents and recipes cannot. That residual risk stays until DC-16. Connect-sourced writes do not inherit it: they confirm, and a sensitive diff needs a passkey.
- `addDs` on the Openprovider adapter always rejects (`dnssec_dnskey_required`). Hosted zones are already signed by Openprovider. The DNS tab still offers a manual DS form.

## Shared contract

Defined in DC-02. Later pieces do not invent a second diff.

```ts
type ConnectSource = "preset" | "domainconnect" | "recipe" | "pasted" | "ai";

interface ConnectPlan {
  v: 1;
  source: ConnectSource;
  source_id: string;       // preset id, "providerId/serviceId", or recipe id
  source_version: number;
  domain_id: string;
  fqdn: string;
  zone_before: string;     // zoneHash of the live zone the diff was computed from
  dns: { add: DnsRecord[]; remove: DnsRecord[] };
  warnings: { code: string; message: string }[];
  blocked: { code: string; message: string } | null;
  sensitive: { type: string; name: string; reasons: string[] }[];
}
```

`plan_hash` is SHA-256 of the canonical plan, same idea as `planHash` in `packages/api/src/recipes/plan.ts`. Apply recomputes against a fresh zone read. A different hash is `409 plan_changed` and writes nothing.

Blocked codes, at least: `dns_not_hosted`, `needs_alias`, `cname_at_apex`, `cname_conflict`, `spf_duplicate`, `txt_too_long`, `unsupported_type`, `wildcard_refused`.

Apply always calls `writeZoneLocked` in `packages/api/src/domain-mgmt/dns.ts`. No second writer. Snapshots, the per-domain lock, read-back, and `registrar_writes_paused` stay as they are.

SPF merge (`SPFM` in Domain Connect) is a pure function next to the plan type: one `v=spf1` TXT at a name, mechanisms appended, a second SPF never added. Domain Connect's conflict rules are the checker: CNAME exclusive at a name, no CNAME at the apex, MX/SRV of the same type conflict, A and AAAA at a name are replaced when the template says the host must not be split (Vercel apex).

## Flags

Rows in `flags` (`name text`, `value jsonb`), the same table as `orders_paused`. Missing or not `true` means off. Inserted by the migration of the piece that first reads them, default `false`.

A flag-off route answers `404`, not `403`. The web asks `GET /api/v1/connect/capabilities` and hides what is off.

| Flag | Piece | Off means |
|---|---|---|
| `connect.apply` | DC-04 | No connect plan or apply routes |
| `connect.presets` | DC-05 | Preset ids 404; apply of a preset 404 |
| `connect.ui` | DC-06 | Web shows no Connect section |
| `domainconnect.discovery` | DC-07 | No settings URL; no `_domainconnect` TXT job |
| `domainconnect.apply` | DC-08 | Signed apply URL 404; discovery may still advertise nothing |
| `connect.vercel` | DC-10 | Connect sheet has no Vercel row |
| `connect.resend` | DC-11 | Connect sheet has no Resend row |
| `connect.verify` | DC-12 | No propagation or certificate job |
| `connect.delegate` | DC-13 | No "this host needs their nameservers" panel |
| `connect.ai` | DC-14 | No propose route |
| `connect.dns_stepup` | DC-16 | Manual DNS tab stays ungated, as today |

`domainconnect.async` is not created until DC-15.

## Pieces

Each piece is one pull request, tests green with its flag off, and safe to merge before the next. Order is the order to merge. A piece may be written against the interface of an earlier piece that is already on the branch it merges into.

### DC-01 — Tell the truth about where DNS is hosted

Depends on nothing. Do this before any connect UI.

`isHostedNs` becomes "every nameserver is one this registrar serves," from the adapter (`OP_NAMESERVERS` for Openprovider, SystemDNS for OpenSRS), not a hardcoded `.systemdns.com` suffix. `createDomainRow` sets `dns_hosted_here` from the nameservers just stored. The transfer-in insert in `packages/api/src/transfers/driver.ts` uses the same helper. A one-shot sync of existing rows sets the column from `domains.nameservers` only (no registrar call).

Files: `packages/api/src/domain-mgmt/common.ts`, `packages/api/src/orders/machine.ts`, `packages/api/src/transfers/driver.ts`, their tests, `apps/web/src/ui/DnsTab.tsx` only if the sentence is wrong once the flag matches `getDns().hosted`.

Acceptance:

- A domain registered with `ns1.openprovider.nl`, `ns2.openprovider.be`, `ns3.openprovider.eu` has `dns_hosted_here` true.
- A domain on `ns1.systemdns.com` and `ns2.systemdns.com` still has it true.
- Any other set is false, and `GET /dns` stays `hosted: false`.
- Changing nameservers to a foreign pair flips the column false inside the existing step-up handler.

Conflict: high. `machine.ts`, `driver.ts`, and `common.ts` are on the live registration and transfer paths. Keep the diff to the helper and the two inserts.

### DC-02 — Plan type and checkers

Depends on nothing for the pure module. Tests that need a hosted zone use the mock registrar.

New `packages/api/src/connect/plan.ts` and `plan.test.ts`. No route, no migration, no edit to `dns.ts` beyond imports if a helper must be exported. Prefer duplicating nothing: call `diffZones`, `checkShape`, `sensitiveOf`, `validateZone`, `zoneHash`.

Acceptance:

- Same input and same live zone produce the same hash.
- A CNAME beside an A at `www` is `cname_conflict`. An apex CNAME is `cname_at_apex`.
- Two `v=spf1` TXT values at the apex become one merged TXT (`include:_spf.google.com` added to an existing record) or `spf_duplicate` if merge is refused.
- A wildcard name is `wildcard_refused`.
- A plan that only restates the live zone has empty add and remove.

Conflict: low, new directory. Do not edit `packages/api/src/recipes/`.

### DC-03 — Records the templates need

Depends on DC-02 only for the `txt_too_long` and `unsupported_type` codes. Three commits or three PRs if review wants them split. Suggested split: DC-03a, DC-03b, DC-03c.

**DC-03a.** `replaceZone` on Openprovider must not delete CAA, TLSA, SSHFP, or any other type the port does not model. Today `fromWire` returns null and the record is removed. Keep those wire rows and put them back on the write. The port's public `DnsRecord` union can stay as it is.

**DC-03b.** Add CAA to `DnsRecord` and the allow-list of types Openprovider documents (A, AAAA, CNAME, MX, SPF, SRV, TXT, NS, TLSA, SSHFP, CAA). Customer edits and connect plans may create `issue` / `issuewild` / `iodef`. NS at a non-apex name stays refused: Openprovider does not delegate subdomains. SPF as a type stays unused; SPF is a TXT.

**DC-03c.** A TXT longer than 255 characters is sent as one Openprovider value with the quoted-chunk form their help page shows, and read back into one logical string. `validateZone`'s 254 cap becomes provider-specific. OpenSRS SystemDNS, if that adapter is still in the path, keeps the short cap. Connect plans for a Google DKIM key of a few hundred characters are not `txt_too_long` on Openprovider.

Acceptance:

- A zone that already has a CAA survives `replaceZone` of an unrelated A record.
- A connect plan can add `CAA 0 issue "letsencrypt.org"` and read it back.
- A 400-character DKIM TXT round-trips as one record in `getDns`.
- Combined `add`+`remove` is still refused by the allow-list.

Conflict: high in `packages/registrar/src/port.ts`, `packages/registrar/src/dns.ts`, `packages/registrar/src/openprovider/adapter.ts`, `allowlist.ts`, and the contract tests. Do not touch registration, pricing, or auth-code code in the adapter. Meta is in this package.

### DC-04 — Apply

Depends on DC-01 and DC-02. CAA and long TXT wait for DC-03 but are not required to merge apply.

Flag `connect.apply`.

`POST /api/v1/domains/:fqdn/connect/plans` stores a `ConnectPlan` for one hour (same shape as `recipe_applications`, new table `connect_plans` so recipe rows stay untouched). `POST .../connect/plans/:id/apply` with `plan_hash` recomputes, then enqueues `connect.apply`, which calls `writeZoneLocked`. Session principal only. A sensitive diff requires step-up `connect.apply` binding `plan_hash`, domain, and the sensitive names, registered like `dns.sensitive.approve`. One approval, one plan. Rate limit 30 plans an hour and the existing DNS write limit.

Audit: `connect.planned`, `connect.apply_requested`, `connect.applied`, `connect.failed`. Notice email on sensitive changes reuses the DNS notice, and names the source.

Acceptance:

- Flag false: both routes 404, and no registrar call.
- Flag true, empty diff: 200, no `replaceZone`.
- Flag true, apex A added: 202, snapshot row, zone read-back matches, audit `connect.applied`.
- Zone changed between plan and apply: 409 `plan_changed`, zone unchanged.
- Sensitive plan without step-up: 403 `approval_required`. With a consumed approval for a different hash: 409.
- `registrar_writes_paused` true: no write.

Conflict: medium. New files under `packages/api/src/connect/`, one line in `packages/api/src/routes.ts`, one new migration. Take the next free migration number at branch time (highest in tree now is `1120_openprovider_live.sql`). Do not edit `0650` or `0660`. `routes.ts` is a one-line conflict with anyone adding a module.

### DC-05 — Presets for hosts with stable records

Depends on DC-04. DKIM presets wait for DC-03c. No preset ships an IP that the host says is per-account.

Flag `connect.presets`.

Versioned modules in `packages/api/src/connect/presets/`. Each exports id, version, title, the inputs it still needs (a hostname, a verification token), and `build(live, input) -> ConnectPlan`. Values that are global and documented are constants with the doc URL in a comment. Values that are per-site are inputs, never guessed.

Ship in this piece:

| Preset | Records | Source to pin in the comment |
|---|---|---|
| `github-pages` | Apex A `185.199.108.153`, `.109.153`, `.110.153`, `.111.153` and the four AAAA addresses; CNAME `www` to the `<user>.github.io` the person types | https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site |
| `webflow` | Apex A and `www` CNAME plus `_webflow` TXT, all three values pasted from the site's publishing panel. Do not hardcode `198.202.211.1` / `cdn.webflow.com` as if they cannot change; the preset may offer them as the labeled default from https://help.webflow.com/hc/en-us/articles/44474625240211-How-to-update-DNS-records-when-migrating-a-live-site-to-Webflow and require the verification token as input | same |
| `render` | Apex A `216.24.57.1` when they have no ALIAS; CNAME `www` to the `*.onrender.com` name they paste | https://render.com/docs/configure-other-dns |
| `google-workspace` | MX `@` `smtp.google.com` priority 1; TXT SPF `v=spf1 include:_spf.google.com ~all` merged; TXT `_dmarc` as input. DKIM is a second preset once DC-03c exists, value pasted from the Admin console | https://support.google.com/a/answer/16004259 |
| `microsoft-365` | Inputs only: MX target, two DKIM CNAMEs, verification TXT. SPF merged as `include:spf.protection.outlook.com`. No guessed tenant host | https://learn.microsoft.com/en-us/microsoft-365/admin/get-help-with-domains/create-dns-records-at-any-dns-hosting-provider |

Not in this piece: Vercel (per-project A and CNAME from their API), Resend (per-domain DKIM), Railway apex (no A record, ALIAS required: https://docs.railway.com/networking/domains/working-with-domains), Cloudflare Pages apex (nameservers must be Cloudflare's: https://developers.cloudflare.com/pages/configuration/custom-domains/), Fly (addresses come from `fly ips` and they say the addresses can change).

Acceptance:

- Each preset's plan against an empty zone matches a fixture.
- GitHub preset refuses a wildcard.
- Google preset against an existing `v=spf1 include:_spf.example.com ~all` yields one TXT containing both includes.
- Render preset on a request for an ALIAS answers `blocked: needs_alias` rather than inventing a CNAME at the apex.
- Flag false: `POST /connect/plans` with `source: "preset"` is 404.

Conflict: low if it stays inside `packages/api/src/connect/`.

### DC-06 — Connect section in the domain panel

Depends on DC-04 and DC-05.

Flag `connect.ui`. New `apps/web/src/ui/ConnectTab.tsx`, lazy from `DomainPanel.tsx`. Lists presets the capabilities endpoint returns. Shows add and remove in full. Confirm posts apply. Sensitive plans mount the existing `StepUp` component. Rollback stays on the DNS tab; the success line links there.

Acceptance, by the web tests already used for the DNS tab if those exist, otherwise a component test plus a manual note in the PR:

- Flag off: the tab is absent and no connect request is made.
- Flag on, GitHub preset: the four A records are visible before confirm; confirm calls apply with the hash the plan returned.
- A 409 `plan_changed` shows the new plan and does not claim success.
- `needs_alias` shows the delegation sentence from DC-13 only when that flag is also on; otherwise it says the host cannot be attached while DNS stays here.

Conflict: medium. `apps/web/src/ui/DomainPanel.tsx` is small and shared. Do not restyle `DnsTab.tsx`.

### DC-07 — Domain Connect discovery

Depends on DC-01.

Flag `domainconnect.discovery`.

When the flag is on and `dns_hosted_here` is true, a job ensures one TXT: name `_domainconnect`, value the settings host (a config value, not a hard-coded production name in library code). It does not rewrite the rest of the zone. It uses the single-record add path, not `replaceZone`.

Public unauthenticated:

- `GET /v2/domainconnect/:domain/settings` returns `providerId` `mosshatch.com`, `providerName`, `urlSyncUX`, `urlAPI`. No `urlAsyncUX` until DC-15.
- `GET /v2/domainTemplates/providers/:providerId/services/:serviceId` returns 200 only for an onboarded template, else 404.

Spec: Domain Connect synchronous flow, https://www.domainconnect.org/getting-started/ and https://github.com/Domain-Connect/spec. Apply is not implemented here. Settings must 404 the domain when we do not host it, so a service does not redirect a customer into a consent page that cannot write.

Acceptance:

- Flag off: settings 404, job does not write a TXT.
- Flag on, hosted domain: settings JSON, and `getDns` shows `_domainconnect`.
- Flag on, foreign nameservers: settings 404, no TXT write.
- Unknown template id: 404.

Conflict: low, new routes. The TXT job calls `writeZoneLocked` or a narrower "add this TXT if absent" helper. Prefer the narrow helper so a discovery run cannot delete mail records. That helper is new and still takes the zone lock and a snapshot if it changes anything.

### DC-08 — Signed sync apply and consent

Depends on DC-04, DC-07, and DC-03b if a template contains CAA. SPF merge from DC-02.

Flag `domainconnect.apply`. Discovery stays dark about apply until this flag is on (`urlSyncUX` omitted while apply is off).

Flow, matching what Vercel documents for a DNS provider (`https://vercel.com/docs/domains/domain-connect`):

1. Service redirects the browser to `{urlSyncUX}/v2/domainTemplates/providers/{providerId}/services/{serviceId}/apply` with `domain`, template variables, `redirect_uri`, `state`, `sig`, `key`.
2. We verify RSA-SHA256 over the query string excluding `sig` and `key`, using the TXT at `{key}.{syncPubKeyDomain}`. Bad signature is an error redirect, no DNS write.
3. Template must be in our allow-list (DC-09), fetched from the Domain Connect templates repository and pinned by content hash. A template that is merely syntactically valid is not applied.
4. Variables are substituted only into fields the template marked. The result is a `ConnectPlan` with `source: "domainconnect"`.
5. Consent page lists every record, the provider name, and the conflicts. Cancel redirects back with `error=access_denied` and `error_description=user_cancel`.
6. Confirm requires a Moss Hatch session for that domain. Sensitive diffs require the `connect.apply` passkey. Then DC-04 apply runs.
7. Success redirects to `redirect_uri` with `state`. The redirect host must be the template's `syncRedirectDomain`. We check that even though Cloudflare does not, because a bad redirect is an open redirect.

`groupId` selects record groups. `SPFM` uses the merger. A template CNAME at `@` is `needs_alias` or, if we later add flattening, not silently stored as an illegal CNAME. `NS` records in a template are refused (they would move the zone off Openprovider). `REDIR301` / `REDIR302` are refused (we have no redirect product).

Acceptance:

- Unsigned or bad signature: no plan row, redirect with `invalid_request`.
- Signature good, template not allow-listed: `invalid_request`, no write.
- Signature good, allow-listed, user cancels: no write, `access_denied`.
- User confirms a non-sensitive TXT: record exists at Openprovider, redirect has the original `state`.
- User confirms an MX: passkey required; without it the redirect does not happen and the zone is unchanged.
- `redirect_uri` on another host: refused before consent.

Conflict: medium. New pages under the web app and new routes. Session and step-up code are imported, not rewritten.

### DC-09 — Allow-list the first service templates

Depends on DC-08. One PR per provider after the first, so a bad template does not block the others. The first PR lands the loader: pull the JSON, check the hash, refuse if `version` moves without a new hash.

Operational onboarding is not code. Moss Hatch has to be listed as a DNS provider and each service has to be willing to redirect to us. Send these only after DC-08 works on a real name:

| Service | Ask | Template |
|---|---|---|
| Domain Connect directory | Be listed on https://www.domainconnect.org/dns-providers/ | Our settings URL |
| Google Workspace | The form on https://www.domainconnect.org/service-providers/ and `google-workspace-domainconnect@google.com` | Their Workspace template, once they send it |
| Microsoft 365 | `domainconnect@microsoft.com` | `microsoft.com.o365.json` in https://github.com/Domain-Connect/Templates |
| Shopify | `domainconnect@shopify.com` | Shopify Website template, listed on the service-provider page |
| Squarespace | `domain-connect@squarespace.com` | Squarespace Website template |
| Framer | `support@framer.com` | Framer Domain and Framer Subdomain templates |
| Resend | `team@resend.com` | Resend template. Keep the existing recipe until the template's records match what `email-resend` writes |

Vercel is a Domain Connect DNS provider (`domainconnect@vercel.com`, https://vercel.com/docs/domains/domain-connect), not a service that publishes "point this name at my project" into someone else's DNS. Do not file that onboarding for the keep-the-nameservers product. A customer who moves nameservers to `ns1.vercel-dns.com`–`ns4.vercel-dns.com` leaves our zone; their email templates would then be Vercel's problem. Our Vercel path is DC-10.

Cloudflare is in the same position: they apply templates only for zones on Cloudflare nameservers, sync only, signature required (https://developers.cloudflare.com/dns/reference/domain-connect/, updated 2026-09-23). We do not onboard with them for this product.

Acceptance for each provider PR:

- The pinned template applies on a fixture zone and the resulting records match the template.
- A template whose fetched body does not match the pin is not served and not applied.
- An `NS` or apex `CNAME` in a fetched template fails the pin review (the PR does not merge that pin).

Conflict: low, files under `packages/api/src/connect/templates/`.

### DC-10 — Vercel on the connect sheet

Depends on DC-06. Does not reimplement `hosting-vercel`.

Flag `connect.vercel`. The sheet collects the same pasted project token the vault already stores (`PUT /api/v1/domains/:fqdn/connections/vercel`, kind `pasted_token`) and then calls the existing recipe plan and apply. The UI shows the recipe plan (apex A from `recommendedIPv4`, `www` CNAME from `recommendedCNAME`, conflicting AAAA removed). OAuth (`oauth_refresh`) is not built here. The token stays in the vault; the sheet never displays it again.

Acceptance:

- The sheet's plan equals `hosting-vercel` for the same fake provider facts.
- No new call to `api.vercel.com` except through `vercelAdapter`.
- Disconnect still removes the recipe's records through the existing disconnect path.

Conflict: high if it edits `packages/api/src/recipes/registry.ts` or `providers.ts`. Avoid that. UI and a thin client only.

### DC-11 — Resend on the connect sheet

Depends on DC-06. Same rule: call `email-resend`, do not fork it.

Flag `connect.resend`. If DC-09's Resend Domain Connect template is live, the sheet prefers that and hides the recipe. Until then the recipe remains the path, because the DKIM value exists only after Resend creates the domain.

Conflict: same as DC-10. Stay out of `registry.ts`.

### DC-12 — Prove it propagated

Depends on DC-04.

Flag `connect.verify`. Register the missing `dns.verify` job. After a connect apply: read the desired set from each authoritative nameserver (DoH to those servers if UDP/53 is not available from the web project; the registrar project may do the UDP query). Then three matching answers from Cloudflare and Google DoH, 30 seconds apart. For `.dev` and `.app`, also require a successful HTTPS handshake with a certificate for that name. Provider checks where we already have a client: Vercel `misconfigured` / `verified`, Resend per-record status. Timeouts are limits, not ETAs. The panel says "not visible yet" until the job says so.

Do not query public resolvers for a name before the write (negative caching, RFC 2308).

Acceptance:

- A fake authoritative server that still has the old A keeps the plan in `shedding`.
- Three matching samples flip it to `spread`.
- A `.dev` name with the right A and a TLS failure stays short of `spread`.
- Flag off: the job is not enqueued.

Conflict: medium. `packages/api/src/jobs/engine.ts` already reserves a concurrency cap for `dns.verify` and does not register a handler. Add the handler beside connect, not inside the orders machine.

### DC-13 — When the host cannot be served here

Depends on DC-06. Uses the existing `POST /nameservers` step-up. No new registrar method.

Flag `connect.delegate`.

The sheet explains, and offers the nameserver form, for:

- Cloudflare Pages on the apex. Subdomains can be a CNAME to `<project>.pages.dev` and are a preset instead. Apex requires Cloudflare nameservers (https://developers.cloudflare.com/pages/configuration/custom-domains/).
- Railway on the apex. They publish no A record (https://docs.railway.com/integrations/api/manage-domains). A `www` CNAME plus their TXT verification is a preset; the apex is delegation or a host that flattens CNAMEs.
- Wix "pointing", when the customer says Wix told them to change nameservers. A connect-by-records mode, if Wix still shows A and CNAME values, is a preset with pasted values, not a hardcoded address.

The nameserver change still refuses a signed zone moving to unsigned DNS (`dnssec_would_break`). The sheet says to remove DNSSEC first, and does not auto-remove the Openprovider key.

Acceptance:

- Choosing Cloudflare Pages apex does not call `replaceZone`.
- Submitting their nameservers without step-up is 403, via the existing route.
- A pasted Railway CNAME for `www` still works as a preset when `connect.presets` is on.

Conflict: low. Copy and a link to the nameserver form in `DnsTab`.

### DC-14 — AI proposes a diff and does not apply it

Depends on DC-02 and DC-04.

Flag `connect.ai`.

`POST /api/v1/domains/:fqdn/connect/propose` accepts pasted text or an image. The model returns only a `ConnectPlan` draft. The server runs the same checkers as DC-02 and drops anything they reject. The response is a plan the person confirms through DC-04. There is no tool, function call, or code path from the model to `replaceZone`, the registrar port, or `writeZoneLocked`. Prompt text is untrusted data, including text that says it is the system. Rate limit 10 proposals an hour. The plan's `source` is `ai`, and the consent line says the records were inferred.

Acceptance:

- A fixture model that returns an apex CNAME yields `blocked: cname_at_apex` and no plan id that can be applied.
- A fixture model that returns a valid A record yields a plan; nothing is written until apply.
- The propose handler's imports do not include the registrar port. A test can assert that by reading the module graph, or by a fake that throws if `replaceZone` is called during propose.
- Flag off: 404.

Conflict: low, new file. Do not add the model client to the registrar package.

### DC-15 — Async Domain Connect

Depends on DC-08 in production for at least one real template. Not scheduled with the first presets.

OAuth for a service to apply a template without the browser redirect. The Domain Connect getting-started note says only a fraction of DNS providers implement async and that onboarding is manual per service. Build it when a named service says they will not do sync. Until then `urlAsyncUX` stays absent. Flag `domainconnect.async`, default false.

### DC-16 — Passkey on sensitive edits from the DNS tab

Independent. High conflict. Do it after connect writes are live, not before.

Flag `connect.dns_stepup`. The session handlers in `packages/api/src/domain-mgmt/dns.ts` (`dnsAddHandler`, `dnsPutHandler`, `dnsPatchHandler`, `dnsDeleteHandler`, `rollbackHandler`) require `connect.apply` or a dedicated `dns.write` step-up when `sensitiveOf` is non-empty. Agents and recipes already require approval. This closes the gap the DNS module comments call D-034.

ICANN transfer policy is about nameserver and contact changes not being gated more loosely than unlock. Nameserver changes are already step-up. This piece gates record edits, which is a tighter control, not a looser one.

Acceptance:

- Flag off: today's behavior, including the sensitive-change email.
- Flag on: an apex A without step-up is 403 and the zone is unchanged; with step-up it writes.
- A non-sensitive TXT (a label that is not `_`, `www`, apex, or a mail token) still writes without a passkey.

Conflict: high. `dns.ts` and `DnsTab.tsx`.

## How a request moves

```
preset | Domain Connect URL | recipe | pasted | AI
                    |
                    v
              ConnectPlan (DC-02 checkers)
                    |
         blocked? ---- yes --> explain, no write
                    |
         sensitive? -- yes --> passkey (connect.apply)
                    |
                    v
         writeZoneLocked --> Openprovider PUT /v1/dns/zones/{name}
                             one of add or remove, then the other, then read-back
                    |
                    v
              snapshot + audit + dns.verify
```

Domain Connect discovery sits beside this. It only adds `_domainconnect`. It never runs a template by itself.

## Security

- The model and the incoming template are data. The server decides the diff. Apply checks the hash again.
- Templates are pinned. Signatures are required on sync apply. `redirect_uri` is confined to `syncRedirectDomain`.
- No wildcard presets (GitHub's takeover warning: https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
- Disconnect of a recipe still deletes the records that recipe added, after a plan. Presets store the records they added on the plan row so a later "remove this preset" can name them and pass `assertSafeDiff`.
- DNSSEC stays on for Openprovider-hosted zones. Delegation to unsigned DNS stays refused.
- Registrar lock is unchanged. Connect does not unlock, does not issue an auth code, and does not change contacts.
- Velocity fuse on nameserver changes stays in the adapter. Connect record writes count against the DNS write rate limit.
- Audit rows name source, plan id, and hash. They do not store token values or the raw model prompt if the prompt might contain a secret the person pasted; store a hash of the prompt and the plan.

## Files Meta is likely to be in

Touch these only in the piece that names them, and keep the hunk small.

| File | Who else needs it |
|---|---|
| `packages/api/src/orders/machine.ts` | Registration. DC-01 only |
| `packages/api/src/transfers/driver.ts` | Transfer-in. DC-01 only |
| `packages/api/src/domain-mgmt/common.ts` | Anything in domain management. DC-01 only |
| `packages/api/src/domain-mgmt/dns.ts` | DNS tab behavior. DC-16, and a call from DC-04 only if `writeZoneLocked` must grow a parameter. Prefer not to change it |
| `packages/api/src/domain-mgmt/routes.ts` | Do not add connect routes here |
| `packages/registrar/src/openprovider/adapter.ts` and `allowlist.ts` | DC-03 only, DNS functions |
| `packages/registrar/src/port.ts`, `dns.ts` | DC-03 |
| `packages/api/src/recipes/*` | DC-10 and DC-11 must not edit these |
| `packages/api/src/routes.ts` | One import line, DC-04 |
| `apps/web/src/ui/DomainPanel.tsx` | DC-06 |
| `packages/db/migrations/*` | New file only. Never renumber an existing one |

New code lives in `packages/api/src/connect/` and `apps/web/src/ui/ConnectTab.tsx`.

## What this does not build

- A Moss Hatch anycast DNS network.
- A `/v1beta` client, or a switch to `records.update` / `records.replace`.
- Openprovider DNS templates as the customer feature. Their template API is a reseller convenience. Our presets and Domain Connect pins are the product.
- Hardcoded Vercel addresses (`76.76.21.21` or `216.198.79.1`). The recipe reads `recommendedIPv4` and `recommendedCNAME`.
- Async Domain Connect before a service asks for it.
- OAuth to every host. Pasted least-scope tokens for Vercel and Resend are enough until a host's template exists.

## Risks

- Openprovider has no ALIAS, so Railway apex and Netlify's preferred apex target (`apex-loadbalancer.netlify.com`) cannot be expressed. Netlify's documented fallback is an A record (our research note: `75.2.60.5` in the external-DNS doc). Re-read that doc in the preset PR before pinning it. Render's A `216.24.57.1` has the same staleness risk.
- A `replaceZone` from older code still deletes CAA until DC-03a is merged. Do not run connect apply against production before that if any customer zone might already contain CAA.
- Long DKIM fails until DC-03c. Do not advertise Google Workspace as done in the sheet before that preset exists.
- `dns_hosted_here` is wrong for current Openprovider domains until DC-01. Discovery must not trust the column before that ships.
- Domain Connect onboarding is a human conversation with each vendor. The code can be ready and still have no Google or Microsoft redirect.
- One reseller credential. The allow-list and the kill switch are the bound. Connect does not widen the allow-list except for the record types in DC-03.
- Production Openprovider has not been called, per `docs/registrar-parity.md`. Sandbox behavior is the evidence. DC-03 re-records sandbox fixtures if the wire body changes.
