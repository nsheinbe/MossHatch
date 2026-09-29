# KMS choice and envelope-encryption design for the Nest secrets vault

Project: Mosshatch (Phase 0). Researcher: live-verified pass. Today: 2026-09-29. Every fact below was fetched on 2026-09-29 unless a line says otherwise. Raw fetches are saved in `working-directory/research/kms/` (files named in the source table at the end).

## TL;DR

1. Recommendation: AWS KMS, symmetric `SYMMETRIC_DEFAULT` (AES-256-GCM) keys, single Region us-east-1 (Vercel default region iad1 maps to us-east-1), one KEK per environment (prod, staging, dev), reached from Vercel functions through OIDC federation (`AssumeRoleWithWebIdentity`), no static AWS keys anywhere.
2. Why AWS: of the three clouds, only AWS documents key policy/IAM conditions on the encryption context (`kms:EncryptionContext:*`), logs that context in CloudTrail by default, has a server-side `ReEncrypt` (re-wrap DEKs, change context, values untouched), 100,000 req/s default shared quota in us-east-1, 99.999% SLA, and Vercel ships an AWS credentials provider.
3. Cost (AWS, us-east-1, 3 KEKs, $0.03 per 10,000 requests after 20,000 free): about $3.00-$3.84/month at 1,000 secrets and $3.57-$92.97/month at 100,000 secrets, for 2-300 reveals per secret per month with no DEK caching. Key fees are $1 per key-month; requests dominate only at the top end.
4. Rejected: Azure Key Vault standard (RSA-only wrap, no AAD; AES/oct-HSM is Premium public preview, no SLA; Managed HSM $3.20/hour is about $2,336/month), HashiCorp Vault (you would run or rent a cluster; HCP price page blocked, secondary sources say about $1,152/month+), Vercel KMS (beta, signing only, "does not support symmetric keys"). GCP Cloud KMS is a credible runner-up (key $0.06/version-month) but has no ReEncrypt, Data Access audit logs off by default, and no IAM condition on AAD.
5. Design: fresh random 256-bit DEK per secret write (`GenerateDataKey`, KeySpec AES_256) with `EncryptionContext = {app, env, owner_id, secret_id}` (opaque IDs only: it is logged in plaintext); local AES-256-GCM (96-bit random nonce, 16-byte tag, AAD binds row identity and version). One DEK encrypts one value, so the NIST 2^32-invocation limit is irrelevant. Do not use the AWS Encryption SDK for MVP: its ciphertext cannot be re-wrapped with KMS `ReEncrypt`.
6. Blast radius: whoever can run code in the production Vercel project can call `kms:Decrypt` for any wrapped DEK they can read. KMS does not stop that; it gives revocation (deny role sessions, disable key), an independent audit trail, and DB-only leaks stay ciphertext. Pin the trust policy to `environment:production` only.
7. Not verifiable from primary sources today: KMS latency from Vercel regions (no published numbers, plan a measurement), HCP Vault list prices (hashicorp.com is behind a Vercel Security Checkpoint), and a few Vercel behaviours (token revocation, team-slug reuse). See "Unverified".

---

## 1. Method and limits of this research

- Primary sources only where possible: AWS/GCP/Azure/Vercel/HashiCorp docs and price lists, NIST, npm registry. Access date for every source: 2026-09-29.
- Prices that are JavaScript-rendered were read from machine endpoints: AWS Price List bulk JSON (`publicationDate 2026-09-11T12:46:01Z`), Azure Retail Prices API. The AWS pricing page itself shows unrendered placeholders for the per-10,000 request price; its worked example ("$0.03 / 10,000 requests") agrees with the bulk JSON.
- Blocked/unavailable: `hashicorp.com/products/vault/pricing`, `cloud.hashicorp.com/pricing/vault` return a "Vercel Security Checkpoint" (HTTP 429) to curl and to headless Chromium. This is site bot protection, not an org egress policy (`connect_rejected` entries in the proxy status concerned other hosts: rdap.nic.io, rdap.nic.co, brunhild.challenges.cloudflare.com). Recorded as unverified.
- No Vercel-to-KMS latency was measured: the sandbox has no AWS credentials and is not on Vercel. See "Unverified".
- NIST SP 800-38D PDF text extraction renders superscripts flat (2^32 appears as "232"); quotes below restore the exponent in brackets.

---

## 2. Provider comparison

### 2.1 Price (USD, list, as fetched 2026-09-29)

| Item | AWS KMS (us-east-1) | GCP Cloud KMS (software, symmetric) | Azure Key Vault Standard | Azure Key Vault Premium / Managed HSM | Vercel KMS (beta) | HCP Vault Dedicated |
|---|---|---|---|---|---|---|
| Price per key per month | $1.00 per customer-managed key, same for multi-Region primary and each replica; first and second rotation each add $1/month, capped after the second (so up to $3/month per key) | $0.000082192/hour per active key version = about $0.06/month; every key version that is Enabled, Disabled, or Scheduled for destruction is billed | No per-key fee for software-protected keys | Premium HSM-protected RSA 2048 key $1.00/key-month (advanced HSM key types are tiered from $5.00 down to $0.40); Managed HSM pool "Standard B1" $3.20/hour = about $2,336/month | No per-key or per-issuer charge | Cluster billed hourly (see note) |
| Price per 10,000 requests | $0.03 (all symmetric crypto ops incl. GenerateDataKey, Decrypt, ReEncrypt); free tier 20,000 requests/month across all Regions | $0.03 per 10,000 crypto operations (software); only Autokey keys get 10,000 free ops/month | $0.03 per 10,000 operations (RSA 2048); $0.15 per 10,000 for "advanced" key operations | $0.03 and $0.15 per 10,000 operations plus per-key HSM fee | $0.03 per 10,000 signing ops (RS256/PS256) or $0.15 (other algorithms); 5,000 free/month on Hobby | n/a |
| Rotation charge | See key row | Rotation itself free | $1.00 per scheduled rotation ("Automated Key Rotation") | same | n/a | n/a |
| Symmetric envelope ops available | Yes (GenerateDataKey/Encrypt/Decrypt/ReEncrypt) | Yes (Encrypt/Decrypt, 64 KiB max plaintext) | RSA-OAEP wrap/unwrap only in Standard | AES-GCM/AES-KW only via Premium oct-HSM (public preview) or Managed HSM | No (signing only, no HS* keys) | Yes (Transit) |

Notes on HCP Vault: the official tiers page says "Development tier clusters are only charged an hourly base cost while Essentials and Standard tier clusters have an additional flat-rate hourly cost per Vault client." Dollar amounts are unverified from a primary source; one secondary source (infisical.com blog, low confidence) lists Development about $0.62/hour (about $450/month), Essentials small about $1.58/hour (about $1,152/month) plus $72.92 per client per month. The Development tier "is not subject to the HashiCorp Cloud SLA" and lacks "high availability, audit logging and metrics".

### 2.2 Request quotas (symmetric crypto operations)

| Provider | Default | Notes |
|---|---|---|
| AWS KMS | 100,000 requests/second shared, in us-east-1, us-west-2, eu-west-1; 20,000 shared in us-east-2, eu-central-1, eu-west-2, ap-northeast-1, ap-southeast-1/2, eu-south-2; 10,000 shared elsewhere | Shared across Decrypt, Encrypt, GenerateDataKey, GenerateDataKeyWithoutPlaintext, GenerateMac, GenerateRandom, ReEncrypt, VerifyMac. "All AWS KMS request quotas are adjustable" (except CloudHSM key store) |
| GCP Cloud KMS | Software usage 6,000,000 tokens/minute, soft enforced; a software-backed crypto op costs 100 tokens, so about 60,000 ops/minute, about 1,000 ops/second (my arithmetic; dynamic limits are seeded from your prior usage) | Quota model changed Feb 16, 2026; the old 60,000 QPM per-project crypto quota's metrics "can no longer be monitored" since Aug 31, 2026 |
| Azure Key Vault Standard | RSA 2,048-bit software key: 4,000 transactions per 10 seconds per vault per region (about 400/s); HSM key 2,000 per 10 s | Throttling is weighted by key size |
| Vercel KMS | Not stated in the pricing/limits page beyond "at most one pending key at a time during rotation" | signing only |
| Mosshatch need | Even 30M requests/month is an average of 11.6 requests/second | AWS headroom is about four orders of magnitude |

### 2.3 Feature and API coverage

| Requirement | AWS KMS | GCP Cloud KMS | Azure Key Vault | HashiCorp Vault Transit | Vercel KMS |
|---|---|---|---|---|---|
| Automatic rotation | Symmetric keys: yes; default 365 days, configurable 90-2560 days; on-demand rotation too; old key material retained until key deletion; ciphertext decrypts transparently | Yes for symmetric: `rotationPeriod` at least 24 hours; new key version, data not re-encrypted, old versions billed until destroyed | Rotation policy per key; minimum interval 7 days; $1 per scheduled rotation | `auto_rotate_period`; `rewrap` endpoint upgrades ciphertext | Rotation with grace period for signing keys |
| Multi-region | Multi-Region keys: same key ID and key material in each Region; each replica $1/month | Multi-region locations (e.g. `us`); Cloud KMS regional metrics count against the serving region | Single-region vault; replicated to paired region in the same geography (Microsoft-managed failover), or backup/restore | Performance replication (Standard tier) | n/a |
| Key policy / IAM | Key policy is primary control; IAM can only allow if the key policy permits; no principal (incl. root) has access unless explicitly allowed | IAM roles such as `roles/cloudkms.cryptoKeyEncrypterDecrypter`; IAM Conditions (resource.name etc.) | RBAC / access policies | Vault policies | Deployment-OIDC "project-grant" policy |
| Encryption context / AAD | Encryption context (AAD) on all symmetric ops; can be a policy condition (`kms:EncryptionContext:key`, `kms:EncryptionContextKeys`); written to CloudTrail | `additionalAuthenticatedData` on Encrypt/Decrypt (up to 64 KiB for SOFTWARE keys); no documented IAM condition on it | REST `aad` field exists but only for authenticated symmetric algorithms (AES-GCM), which need Premium oct-HSM (preview) or Managed HSM; Standard vault RSA-OAEP wrap has no context | `associated_data` (AEAD) and `context` (key derivation) | n/a |
| Server-side re-wrap | `ReEncrypt` (also changes encryption context) | None; decrypt then encrypt (2 ops) | None documented; unwrap then wrap | `rewrap` | n/a |
| Audit log | CloudTrail logs all KMS ops incl. Decrypt and GenerateDataKey, with encryption context; first trail copy of management events free | Admin Activity always on; Data Access logs (Decrypt is DATA_READ) "disabled by default" except BigQuery | Diagnostic logging to a storage account you configure; available within 10 minutes | Audit devices (HCP Development tier: none) | Not researched |
| SLA | 99.999% monthly uptime commitment per Region | 99.95% direct, 99.99% via service account | Not verified (SLA page did not resolve) | HCP Essentials 99.9% (per docs) | Beta, no SLA claim seen |
| Vercel auth without static keys | OIDC provider + `sts:AssumeRoleWithWebIdentity`; Vercel ships `@vercel/oidc-aws-credentials-provider` | Workload Identity Federation pool/provider; service-account impersonation | Entra ID federated credential (`ClientAssertionCredential` + `getVercelOidcToken`) | Vault JWT/OIDC auth with JWKS URL and `bound_claims` (Vercel-specific setup not researched) | OIDC token is the credential (native) |

### 2.4 Vercel-native and HashiCorp options

- Vercel KMS (docs: `vercel.com/docs/kms`, last updated Sept 7, 2026): "Vercel Key Management Service (KMS) gives you managed signing keys that live on Vercel." "KMS supports RS256, RS384, RS512, the PS* and ES* families ... KMS does not support symmetric ( HS* ) keys." It has no encrypt/decrypt/wrap API, so it cannot be the KEK. Potentially useful later to sign agent scoped tokens (JWTs) without a static signing key. Package `@vercel/kms` 0.3.0 (npm, modified 2026-09-24).
- Vercel sensitive environment variables (Secret type) are write-only after saving and are the wrong place for a KEK anyway; they are fine for non-secret config such as the role ARN and key alias.
- HashiCorp Vault Transit: `associated_data` AAD, `context`, `rewrap`, auto-rotate, all documented. Cost is running or renting a cluster. Rejected for Phase 0 (ops burden, price, and Development tier has no HA/audit).

---

## 3. Authenticating a Vercel function to the KMS with no long-lived credentials

### 3.1 What Vercel provides (quotes)

- (https://vercel.com/docs/oidc, accessed 2026-09-29) "Secure backend access with OIDC federation is available on all plans". "Cloud providers such as Amazon Web Services, Google Cloud Platform, and Microsoft Azure can trust these tokens and exchange them for short-lived credentials. This way, you can avoid storing long-lived credentials as Vercel environment variables."
- Functions: "When your application invokes a Vercel Function, the OIDC token is set to the x-vercel-oidc-token header on the Function's Request object." "Vercel does not generate a fresh OIDC token for each execution. It reuses a token for up to 90 minutes. Function tokens have a Time to Live (TTL) of two hours."
- Builds: "When you run a build, Vercel automatically generates a new token and assigns it to the VERCEL_OIDC_TOKEN environment variable."
- Issuer modes: Team (recommended) `https://oidc.vercel.com/<team>`, or Global `https://oidc.vercel.com`.
- (https://vercel.com/docs/oidc/reference) Claims: `sub` = `owner:[TEAM_SLUG]:project:[PROJECT_NAME]:environment:[ENVIRONMENT]` where environment is `development`, `preview`, `production`, or a Custom Environment slug. "Build tokens expire after one hour. Function tokens for preview and production expire after two hours. development tokens expire after 12 hours." Extra claims `owner_id`, `project_id`, `custom_environment_id`, `user_id` (development only). "If you change the name of your team or project, the claims within the OIDC token will reflect the new names."
- Function limitation: "you cannot execute the getVercelOidcToken() function directly at the module level because the token is only available in the Request object as the x-vercel-oidc-token header."
- Fluid compute (https://vercel.com/docs/fluid-compute): "multiple invocations can share the same physical instance (a global state/process) concurrently." Relevant to in-memory DEK caches.
- Vercel regions (https://vercel.com/docs/regions): table row `iad1 | us-east-1 | Washington, D.C., USA`; (https://vercel.com/docs/functions/configuring-functions/region) "By default, Vercel Functions execute in Washington, D.C., USA ( iad1 ) for all new projects". Pro/Enterprise can use multiple regions; failover regions are Enterprise.

### 3.2 AWS path (recommended)

- (https://vercel.com/docs/oidc/aws) Create an IAM OIDC provider with URL `https://oidc.vercel.com/[TEAM_SLUG]` and audience `https://vercel.com/[TEAM_SLUG]`; create a role whose trust policy uses `Principal.Federated = arn:aws:iam::<acct>:oidc-provider/oidc.vercel.com/<team>`, `Action = sts:AssumeRoleWithWebIdentity`, and conditions `oidc.vercel.com/<team>:sub` = `owner:<team>:project:<project>:environment:production` and `:aud` = `https://vercel.com/<team>`. Store the role ARN in `AWS_ROLE_ARN`.
- "AWS_REGION is not stable by default. Vercel sets AWS_REGION automatically to your function's execution region ... To prevent this, declare AWS_REGION as an environment variable in your Vercel project with the value set to the AWS region where your resources live." Pin `AWS_REGION=us-east-1` for KMS calls.
- Helper: (https://vercel.com/docs/oidc/reference) `awsCredentialsProvider()` "exchanges the OIDC token for short-lived credentials with AWS by calling the AssumeRoleWithWebIdentity operation." npm: `@vercel/oidc-aws-credentials-provider` 3.3.9 (modified 2026-09-22), depends on `@vercel/oidc` 3.8.9 and `@aws-sdk/credential-provider-web-identity`; `@aws-sdk/client-kms` 3.1143.0.
- (https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html) "Calling AssumeRoleWithWebIdentity does not require the use of AWS security credentials." Session duration default "3600 seconds"; range 900 up to the role's max session duration (1-12 hours). Set the role's maximum session duration to the minimum (1 hour) to shorten stolen-credential life.
- Limitation that matters (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html): for a generic OIDC provider AWS maps only `amr`, `aud` (from `azp` or `aud`), `email`, `oaud`, `sub` to condition keys. The immutable `project_id` and `owner_id` claims cannot be used in the trust policy, so trust is anchored on the human-readable `sub` (team slug and project name). See blast radius and unverified list.

### 3.3 GCP path (runner-up)

- (https://vercel.com/docs/oidc/gcp) Create a Workload Identity pool + OIDC provider (issuer `https://oidc.vercel.com/[TEAM_SLUG]`), "Assign the google.subject mapping to assertion.sub", impersonate a service account whose principal is `principal://iam.googleapis.com/projects/<n>/locations/global/workloadIdentityPools/vercel/subject/owner:<team>:project:<project>:environment:production`. Code uses `ExternalAccountClient` with `getVercelOidcToken` as subject-token supplier.
- (https://docs.cloud.google.com/iam/docs/workload-identity-federation) GCP is more flexible than AWS here: "You can define up to 50 custom attributes" and "An attribute condition is a CEL expression that can check assertion attributes", so `assertion.project_id` (immutable) can be enforced.

### 3.4 Azure path

- (https://vercel.com/docs/oidc/azure) Entra ID app registration + federated credential; the docs list "Security : Azure Key Vault and Azure App Configuration" among reachable services. Not chosen because of the Key Vault capability gaps below.

---

## 4. Envelope-encryption facts and design

### 4.1 AES-256-GCM nonce and key-usage rules (NIST SP 800-38D, 2007, still the current standard)

- Source: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf (accessed 2026-09-29). Uniqueness requirement (section 8): "The probability that the authenticated encryption function ever will be invoked with the same IV and the same key on two (or more) distinct sets of input data shall be no greater than 2-32 [that is 2^-32]." Section 8.2.2 RBG-based construction: "the length of the random field shall be at least 96 bits". Section 8.3: "The total number of invocations of the authenticated encryption function shall not exceed 2[^]32, including all IV lengths and all instances of the authenticated encryption function with the given key." (this limit applies to the RBG-based construction, which is what a random 96-bit nonce is). Section 5.2.1.1 recommends 96-bit IVs: "it is recommended that implementations restrict support to the length of 96 bits".
- NIST status page (https://csrc.nist.gov/pubs/sp/800/38/d/final): "Planning Note (03/06/2024): NIST has decided to revise this publication." Second pre-draft call for comments, 2026-06-01 (https://csrc.nist.gov/pubs/sp/800/38/d/r1/2prd): "there is no actual draft document available". So the 2^32 rule stands today.
- Consequence for Nest: if every secret value gets its own fresh random 256-bit DEK and each DEK encrypts exactly one plaintext (or at most a handful of versions), invocation count per key is 1, far below 2^32, and a random 96-bit nonce collision under a single-use key is irrelevant. This is also the cloud vendors' advice: GCP (https://docs.cloud.google.com/kms/docs/envelope-encryption) "Generate a new DEK every time you write the data. This means you don't need to rotate the DEKs." and "Do not use the same DEK to encrypt data from two different users." AWS (https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html): "It's best to use data keys once, or just a few times, to mitigate this key exhaustion."
- The KEK side has no 2^32 concern on AWS: (https://docs.aws.amazon.com/kms/latest/cryptographic-details/crypto-primitives.html) "AWS KMS uses a key derivation function (KDF) to derive per-call keys for every encryption under an AWS KMS key." (Symmetric KMS keys are "AES-256-GCM": https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html.)
- Node `crypto` (https://nodejs.org/api/crypto.html): `cipher.setAAD()` "must be called before cipher.update()"; in GCM "authTagLength ... defaults to 16 bytes"; for the decipher, since v26.0.0 "Using GCM tag lengths other than 128 bits without specifying the authTagLength option when creating decipher is not allowed anymore" and "If no tag is provided, or if the cipher text has been tampered with, decipher.final() will throw". Design rule: always pass `authTagLength: 16` on both sides and never accept a shorter tag.

### 4.2 Using AAD / encryption context to bind a wrapped DEK to secret + user + environment

- AWS (https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html): "AWS KMS uses the encryption context as additional authenticated data (AAD) to support authenticated encryption. The encryption context is cryptographically bound to the ciphertext so that the same encryption context is required to decrypt the data." "The encryption context is not secret and not encrypted. It appears in plaintext in AWS CloudTrail Logs". "Because the encryption context is logged, it must not contain sensitive information." Policy use: "The kms:EncryptionContext: and kms:EncryptionContextKeys condition keys allow (or deny) a permission only when the request includes particular encryption context keys or key–value pairs." GenerateDataKey: "If you specify an EncryptionContext, you must specify the same encryption context (a case-sensitive exact match) when decrypting the encrypted data key. Otherwise, the request to decrypt fails with an InvalidCiphertextException." Decrypt: encryption context is "optional, but it is strongly recommended", and "specifying the KMS key is always recommended as a best practice" (pass `KeyId` so a wrapped DEK from a different key is rejected).
- Design:
  - KMS `EncryptionContext` = `{ app: "mosshatch-nest", env: "production", owner_id: "<opaque id>", secret_id: "<opaque id>" }`. Use opaque IDs, never names, emails or paths, because CloudTrail stores it in plaintext (AWS prescriptive guidance says the same: https://docs.aws.amazon.com/prescriptive-guidance/latest/encryption-best-practices/kms.html "If you use encryption context, it shouldn't contain any sensitive information").
  - Local AES-GCM AAD (defence in depth, and to cover things KMS never sees) = canonical length-prefixed bytes of `format_version || secret_id || owner_id || env || value_version || kek_arn`. It stops row/column swaps and cross-environment replay even if the KMS context were mis-set. It cannot prevent rollback to an older valid version by a DB writer who also edits the version column; that needs external state (hash-chained audit log).
  - Encryption context is static: it cannot carry the acting agent token or the passkey approval id (they differ per reveal and must match at decrypt time). Record those in an application audit log and correlate with the CloudTrail event; do not try to put them in the context.
  - Key policy: allow the Vercel role only `kms:GenerateDataKey` and `kms:Decrypt` with `StringEquals kms:EncryptionContext:app = mosshatch-nest` and `kms:EncryptionContext:env = <that key's env>`, plus `ForAllValues:StringEquals kms:EncryptionContextKeys = [app, env, owner_id, secret_id]` (condition keys documented in the AWS pages above; the exact policy JSON was not tested).
- GCP: `additionalAuthenticatedData` is supported ("For SOFTWARE ... keys the AAD must be no larger than 64KiB", https://docs.cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys/encrypt). I found no IAM Conditions attribute for AAD (the IAM condition attribute reference lists `resource.*`, `request.time`, `request.path` and the service-specific `api.getAttribute`; no `cloudkms` entry appears), so it is integrity-only, not policy-enforceable, and whether it appears in Data Access audit entries is unverified.
- Azure: REST `aad` ("Additional data to authenticate but not encrypt/decrypt when using authenticated crypto algorithms") exists for AES-GCM but symmetric keys are "Azure Key Vault Premium ... currently in public preview ... Preview features are provided as-is, with no service-level agreement, and aren't recommended for production workloads." Standard vault wrap is RSA-OAEP-256 only.

### 4.3 Key hierarchy options

| Option | KEK count | AWS monthly key cost | Blast radius / isolation | Verdict |
|---|---|---|---|---|
| A. One KEK for everything | 1 | $1 | Dev/staging code paths share prod key | No |
| B. One KEK per environment (prod, staging, dev) | 3 | $3 (up to $9 at steady state after two rotations each) | Separate role + key policy per environment; a preview/dev compromise cannot decrypt prod | Recommended for MVP |
| C. One KEK per tenant/user | N tenants | $1 x N: e.g. 200 tenants = $200/month; 20,000 tenants = $20,000/month (illustrative: 5 secrets per user); AWS quota 100,000 keys per Region | Cryptographic tenant isolation, per-tenant revoke | Too costly for a flat-fee registrar; keep as a future premium/BYOK feature |
| D. One KMS key + per-tenant branch keys via AWS Encryption SDK Hierarchical keyring | 1 KMS key + DynamoDB table | $1 + DynamoDB (not costed) | Tenant-level keys cached locally; JS supported in Node from ESDK 4.1.x; "Content encrypted with the AWS KMS Hierarchical keyring can only be decrypted with the AWS KMS Hierarchical keyring." | Revisit if per-tenant crypto isolation becomes a requirement |
| E. Two-level with cached project keys wrapped by KMS, per-secret DEKs wrapped locally | 1 KEK + project keys | $1 | Fewer KMS calls but CloudTrail no longer shows per-secret reveals; plaintext project keys live in memory | Unnecessary at these volumes |

Tenant isolation without per-tenant KEKs: encryption-context binding plus app authorisation. CloudTrail then shows which `secret_id`/`owner_id` was decrypted.

### 4.4 DEK caching trade-offs

- Facts: AWS ESDK (https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/data-key-caching.html) "Data key caching is an optional feature of the AWS Encryption SDK that you should use cautiously." (https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/thresholds.html) "As a rule, use the minimum amount of caching that is required to meet your cost and performance goals." and "because your plaintext data keys are cached (in memory, by default), try to minimize the time that the keys are saved." AWS on disabled keys: "resources encrypted with data keys protected by the KMS key are not affected until the the KMS key is used again, such as to decrypt the data key" (https://docs.aws.amazon.com/kms/latest/developerguide/enabling-keys.html).
- Trade-offs for Nest: (1) A cache hides reveals from CloudTrail (only misses are logged), so the application audit log must be the system of record. (2) A cache survives an emergency key disable or role revoke until TTL/instance recycle. (3) Fluid compute shares one process across concurrent invocations, so the cache is shared across requests; it must be keyed by (secret_id, wrapped_dek hash) and never returned without a fresh authorisation check. (4) JavaScript cannot guarantee zeroisation (`Buffer.fill(0)` is best-effort). (5) Saving is worthless here: 30M decrypts/month cost $90.
- Decision: default no cache (TTL 0). If burst reads ever need it, cap at 5-30 seconds and 1,000 entries, behind a config flag that the emergency runbook flips off.

### 4.5 Rotation and re-wrap procedure (values are never re-encrypted)

Facts:
- AWS automatic rotation (https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html): "Key rotation changes only the current key material". "When you use the rotated KMS key to decrypt ciphertext, AWS KMS uses the key material that was used to encrypt it." "Key rotation has no effect on the data that the KMS key protects. It does not rotate the data keys that the KMS key generated or re-encrypt any data protected by the KMS key. Key rotation will not mitigate the effect of a compromised data key." "AWS KMS retains all key material for a KMS key with AWS_KMS origin, even if key rotation is disabled. AWS KMS deletes key material only when you delete the KMS key." Default period 365 days; `RotationPeriodInDays` "Valid Range: Minimum value of 90. Maximum value of 2560."
- `ReEncrypt` (https://docs.aws.amazon.com/kms/latest/APIReference/API_ReEncrypt.html): "Decrypts ciphertext and then reencrypts it entirely within AWS KMS." It can change the key or "reencrypt ciphertext under the same KMS key, such as to change the encryption context of a ciphertext." Needs `kms:ReEncryptFrom` on the source and `kms:ReEncryptTo` on the destination. "it cannot decrypt ciphertext produced by other libraries, such as the AWS Encryption SDK".
- GCP: rotation "doesn't re-encrypt your data"; "Previous key versions remain active and incur costs until they are destroyed"; no re-encrypt API, so 2 operations per DEK (https://docs.cloud.google.com/kms/docs/re-encrypt-data: "Key rotation does not re-encrypt already encrypted data with the newly generated key version. You need to re-encrypt the data yourself").

Procedure (AWS, planned KEK migration or post-incident):
1. Create the new KEK (different key ID, same policy shape, own alias `alias/mosshatch-nest-<env>-<yyyymm>`). Automatic rotation of the same key is hygiene, not a substitute.
2. Every row already stores `kek_arn` and `wrapped_dek`, so the app can read mixed state. Deploy the writer to use the new KEK for new secrets.
3. Run a resumable batch under an admin identity that is not the Vercel role (needs ReEncryptFrom/To only): for each row, `ReEncrypt(CiphertextBlob=wrapped_dek, SourceKeyId=old, SourceEncryptionContext=ctx, DestinationKeyId=new, DestinationEncryptionContext=ctx)` then `UPDATE ... SET wrapped_dek=$new, kek_arn=$newArn WHERE id=$id AND wrapped_dek=$old` (compare-and-swap so retries are idempotent). Plaintext DEKs never leave KMS; the AES-GCM value ciphertext, nonce and tag are untouched.
4. Verify by sampling full reveals; watch for `InvalidCiphertextException`/AccessDenied in CloudTrail.
5. `DisableKey` on the old key ("unusable right away (subject to eventual consistency)"), hold for a soak period, then `ScheduleKeyDeletion` (waiting period 7-30 days, default 30; "Deleting an AWS KMS key is destructive ... and is irreversible").
- Cost: one request per DEK: 100,000 DEKs is 100,000 requests = $0.30 before the free tier ($0.24 after 20,000 free).
- If a DEK (not the KEK) is suspected compromised: re-encrypt that value with a new DEK and rotate the underlying customer secret at its source; KEK rotation does not help.

### 4.6 AWS Encryption SDK versus GenerateDataKey + Node crypto

What the SDK adds (https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/): a self-describing message format that stores encrypted data keys and encryption context "in plaintext in the header of the encrypted message"; keyrings including multi-keyring (wrap under several KEKs, e.g. two Regions); default algorithm suite "AES-GCM with an HMAC-based extract-and-expand key derivation function (HKDF), signing, and a 256-bit encryption key" (HKDF-derived per-message key, ECDSA P-384 signature, IV always 12 bytes and tag 16 bytes); key commitment ("Algorithm suites without key commitment do not validate the data key before decrypting. As a result, these algorithm suites might decrypt a single ciphertext into different plaintext messages."); a caching CMM with thresholds (max age required; max messages 1 to 2^32); a Hierarchical keyring. JS package `@aws-crypto/client-node` 5.0.2 (npm modified 2026-07-23; 5.0.0 published 2026-04-23); the Node keyring constructor accepts a `clientProvider`, so Vercel credentials can be injected.

What it costs you here:
- Lock-in: "The AWS Encryption SDK cannot decrypt the ciphertext that the AWS KMS Encrypt or ReEncrypt operations return", and KMS ReEncrypt cannot handle SDK messages, so DEK re-wrap becomes decrypt-and-re-encrypt the whole message in your process (plaintext exposure; I found no header-only re-wrap API).
- The signing suite is meaningless for a single-writer/single-reader server ("Use these suites only when the users who encrypt data and those who decrypt are equally trusted" applies to no-signing suites) and costs CPU; the non-signing committing suite is the sensible pick if you adopt it.
- Encryption context sits in the message header in plaintext (fine, it is non-secret) but your DB row already stores it.

Plain approach (recommended): `GenerateDataKey(KeySpec=AES_256, EncryptionContext)` per write, Node `aes-256-gcm` with 12-byte random nonce and 16-byte tag, persist `{format_version, kek_arn, wrapped_dek, nonce, ciphertext, tag}`; about 40 lines, `KMS ReEncrypt` works, and the format is yours. Add a format-version byte to the AAD so a later move to the ESDK or a committing scheme is a per-row migration. Trade: you own the format review; get a second reviewer on the AAD canonicalisation and nonce handling. GCM is not key-committing, but with server-generated random DEKs no attacker chooses keys.

### 4.7 Blast radius if the Vercel project's OIDC identity is compromised

Assumptions: OIDC trust is `sub = owner:<team>:project:<project>:environment:production`.
- Who holds that identity: any code executing in the production deployment (function code and its dependencies) gets `x-vercel-oidc-token` and can exchange it; any production build gets `VERCEL_OIDC_TOKEN` ("Build tokens expire after one hour"), so a malicious dependency or build script in a production build is in scope; anyone with team access who can deploy to production. Preview builds get `environment:preview` tokens, and `vercel env pull` gives a developer `environment:development` token (12 hours, `user_id` claim): none of these match a production-pinned trust policy. That is the main reason for `StringEquals` on `sub` and never a wildcard.
- What an attacker can do: while a token/role session is valid (function token up to 2 hours; STS session 3,600 s by default, and I did not check what value Vercel's helper requests), call `kms:GenerateDataKey` and `kms:Decrypt` allowed by the policy. To decrypt anything they also need the wrapped DEKs and ciphertexts, i.e. the Neon connection string, which is probably reachable from the same runtime. Realistically: production code execution equals decrypt-all-reachable-secrets. KMS does not prevent it.
- What KMS still buys: (1) a DB-only leak (SQL injection, Neon breach, backup theft) yields ciphertext and wrapped DEKs only; (2) the KEK never leaves the HSM ("Your plaintext KMS keys never leave the HSMs", AWS KMS FAQ), so nothing can be exfiltrated for offline use, and access ends when you cut it; (3) CloudTrail records every Decrypt/GenerateDataKey with encryption context, independent of the app (which the attacker may have tampered with); (4) encryption-context conditions confine the role to this application's ciphertexts; (5) revocation is fast (4.8).
- Hardening steps in order of value: pin `sub` to production only; role max session duration 1 hour; alarm on Decrypt volume/`secret_id` diversity per role session; reconcile CloudTrail Decrypt counts against the app audit log (a mismatch signals bypass of the passkey gate); split projects later so a small "reveal" service has `Decrypt` and the main app has `GenerateDataKey` only (a compromised main app then cannot read old secrets; OIDC roles are per project/environment, not per function); lock down who can deploy to production and review dependency install scripts.
- AWS-specific weakness: only `sub`/`aud` can be conditioned. Project and team names are mutable ("the claims ... will reflect the new names") and the IDs cannot be conditioned; whether a released team slug can be claimed by someone else is unverified. GCP WIF could condition on `assertion.project_id`. Mitigation on AWS: rename team/project only with a paired trust-policy change, and monitor `AssumeRoleWithWebIdentity` in CloudTrail for unknown `sub` values.

### 4.8 Emergency revoke procedure (AWS)

Stage 1, stop decrypt (minutes):
1. IAM: on the Vercel-assumed role choose "Revoke active sessions" (adds a deny with `aws:TokenIssueTime` earlier than now). AWS: "you can immediately revoke all permissions to the role's credentials issued before a certain point in time"; "Permissions assigned to temporary security credentials are evaluated each time they are used to make an AWS request"; caveat "It might take a few minutes for policy updates to take effect."
2. Stop new sessions: edit the role trust policy to deny (or delete the IAM OIDC provider `oidc.vercel.com/<team>`). Vercel's side: no documented way to revoke an issued OIDC token (unverified); tokens die by TTL (functions 2 hours).
3. Kill switch: `DisableKey` on the affected KEK, or attach an explicit `Deny kms:Decrypt` to the key policy/role. "When you disable a KMS key, it becomes unusable right away (subject to eventual consistency)." All reveals stop; reversible. Turn off any DEK cache flag first or expect a lag up to the cache TTL.
4. On Vercel: redeploy after removing the offending code, rotate other environment secrets (Neon URL, Stripe, Resend keys), review team members and deploy keys.
Stage 2, scope (hours): query CloudTrail (event history covers 90 days free) for `eventSource=kms.amazonaws.com`, `eventName in (Decrypt, GenerateDataKey)`, the role's session ARN and time window; `requestParameters.encryptionContext` gives `owner_id` and `secret_id` for each reveal ("The log entry shows exactly which KMS keys was used to encrypt or decrypt specific data referenced by the encryption context"). Every revealed secret must be treated as leaked: notify owners and rotate the underlying secret values at their sources.
Stage 3, recover (days): execute the 4.5 migration to a fresh KEK under a new role/trust policy, then `ScheduleKeyDeletion` on the old key after the soak period. Re-enable service only after the new role's trust policy is re-scoped.
Rehearse before launch. GCP's rotation guide says "Validate your key rotation procedures before a real-life security incident occurs" (https://docs.cloud.google.com/kms/docs/key-rotation); apply the same to this runbook on a staging key.

---

## 5. Recommendation and cost estimate

Recommended: AWS KMS (us-east-1), customer-managed symmetric keys, one per environment, automatic rotation on (365 days), Vercel OIDC federation, CloudTrail trail delivering to S3 (first management-event copy free), no DEK cache.

Why it beats the alternatives for this product:
- Policy-enforced binding of a wrapped DEK to secret + user + environment via encryption context (AWS-only among the three).
- Server-side `ReEncrypt` gives cheap, safe re-wrap without touching values.
- Default audit trail includes the context; GCP's Data Access logs are opt-in.
- First-class Vercel integration (helper package, `iad1 = us-east-1` mapping, all-plan OIDC).
- Highest default quota (100,000/s) and strongest stated SLA (99.999%).
- Cost is dominated by $1/key, which does not matter at 3 keys.
Costs of choosing AWS: $1 versus $0.06 per key (irrelevant at 3 keys); trust policy can only condition on mutable `sub`; you need an AWS account for one service.

### Assumptions (state them to the team)

- Monthly writes = 10% of secrets (create or change), each with a fresh DEK: 1 `GenerateDataKey` request per write.
- Reveal = 1 `Decrypt` request; list/metadata views do not decrypt; no DEK caching (conservative).
- Reveals per secret per month: Low 2 (humans checking occasionally), Medium 30 (daily agent/CI injection), High 300 (about 10 per day, chatty agents).
- Price $0.03 per 10,000 requests; 20,000 free requests per month once (account-wide, all Regions); requests in us-east-1.
- Keys: 3 (prod, staging, dev). Rotation adds $1/month per key after the first rotation and another $1/month after the second, then capped (steady state $3 per key = $9 for three).
- CloudTrail: first management-event copy to S3 is free; S3 storage not costed; a second trail copy would be $2.00 per 100,000 events (1,000 secrets at Medium = 30,100 events = $0.60; 100,000 secrets at Medium = 3,010,000 events = $60.20).
- Not counted: Vercel, Neon, data transfer, DynamoDB (hierarchical keyring), multi-Region replica (+$1/month per replica key).

### AWS monthly cost (3 KEKs unless stated)

| Secrets | Reveals/secret/month | Requests/month | Request cost | Total, 1 KEK | Total, 3 KEKs | 3 KEKs at steady state (+$6 rotation) | Avg req/s |
|---|---|---|---|---|---|---|---|
| 1,000 | 2 | 2,100 | $0.00 | $1.00 | $3.00 | $9.00 | 0.001 |
| 1,000 | 30 | 30,100 | $0.03 | $1.03 | $3.03 | $9.03 | 0.012 |
| 1,000 | 300 | 300,100 | $0.84 | $1.84 | $3.84 | $9.84 | 0.116 |
| 100,000 | 2 | 210,000 | $0.57 | $1.57 | $3.57 | $9.57 | 0.081 |
| 100,000 | 30 | 3,010,000 | $8.97 | $9.97 | $11.97 | $17.97 | 1.161 |
| 100,000 | 300 | 30,010,000 | $89.97 | $90.97 | $92.97 | $98.97 | 11.578 |

Headline: about $3-$4 per month at 1,000 secrets and about $4-$93 per month at 100,000 secrets (about $10-$99 with rotation steady state), depending on reveal frequency. Re-wrap of all DEKs: $0.30 at 100,000 secrets.

### Comparison at the same assumptions (one active key, no CloudTrail-equivalent cost)

| Secrets | Reveals | AWS (1 key) | GCP software (1 key version) | Azure Standard (RSA-2048 wrap, no AAD) |
|---|---|---|---|---|
| 1,000 | 2 / 30 / 300 | $1.00 / $1.03 / $1.84 | $0.07 / $0.15 / $0.96 | $0.01 / $0.09 / $0.90 |
| 100,000 | 2 / 30 / 300 | $1.57 / $9.97 / $90.97 | $0.69 / $9.09 / $90.09 | $0.63 / $9.03 / $90.03 |

GCP's free tier for ops applies only to Autokey keys, so it is not applied. Azure Standard's low number carries the gaps in section 2.3; Azure symmetric AES needs Premium preview or Managed HSM (about $2,336/month for the pool alone).

Peak-rate sanity check: even a 100x burst over the High average (about 1,160 req/s) is about 1% of the us-east-1 default AWS quota.

---

## 6. Findings table (claim, source, access date, quote, confidence)

All access dates 2026-09-29.

| # | Claim | Source URL | Quote | Confidence |
|---|---|---|---|---|
| 1 | AWS KMS key costs $1/month, same for multi-Region primary and replicas | https://aws.amazon.com/kms/pricing/ | "Each AWS KMS key that you create in AWS KMS costs $1/month (prorated hourly)." | high |
| 2 | First and second rotation add $1/month each, then capped | https://aws.amazon.com/kms/pricing/ | "the first and second rotation of the key adds $1/month (prorated hourly) in cost. This price increase is capped at the second rotation" | high |
| 3 | AWS requests $0.03 per 10,000 in us-east-1 | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/awskms/current/us-east-1/index.json (publicationDate 2026-09-11) | "$0.03 per 10000 KMS requests in US East (N. Virginia)"; pricing page example: "x $0.03 / 10,000 requests" | high |
| 4 | Same $1/key and $0.03/10k in eu-central-1, us-west-2, eu-west-1 | AWS Price List JSON for those Regions (same URL pattern) | USD 1.0 per Keys, 0.000003 per Request | high |
| 5 | Free tier 20,000 requests/month across all Regions; no charge for generated data keys beyond the call | https://aws.amazon.com/kms/pricing/ | "AWS KMS provides a free tier of 20,000 requests/month calculated across all Regions"; "There is no monthly charge for data keys or data key pairs that AWS KMS generates beyond the charge for the API call." | high |
| 6 | AWS symmetric crypto quota 100,000/s shared in us-east-1, us-west-2, eu-west-1 | https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html | "100,000 (shared) in the following Regions: US East (N. Virginia), us-east-1" ; "All AWS KMS request quotas are adjustable" | high |
| 7 | AWS SLA 99.999% | https://aws.amazon.com/kms/sla/ | "a Monthly Uptime Percentage for each AWS region ... of at least 99.999%" | high |
| 8 | Encryption context is AAD, bound to ciphertext, logged in plaintext | https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html | "AWS KMS uses the encryption context as additional authenticated data (AAD) to support authenticated encryption."; "It appears in plaintext in AWS CloudTrail Logs" | high |
| 9 | Encryption context usable as policy condition | same | "allow (or deny) a permission only when the request includes particular encryption context keys or key–value pairs" | high |
| 10 | Mismatched context fails decrypt of data key | https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html | "the request to decrypt fails with an InvalidCiphertextException" | high |
| 11 | ReEncrypt is server-side and can change context | https://docs.aws.amazon.com/kms/latest/APIReference/API_ReEncrypt.html | "Decrypts ciphertext and then reencrypts it entirely within AWS KMS."; "such as to change the encryption context of a ciphertext" | high |
| 12 | KMS cannot ReEncrypt Encryption SDK ciphertext | same | "it cannot decrypt ciphertext produced by other libraries, such as the AWS Encryption SDK" | high |
| 13 | Rotation keeps old material, does not re-encrypt or fix compromised data keys | https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html | "Key rotation will not mitigate the effect of a compromised data key."; "AWS KMS retains all key material ... AWS KMS deletes key material only when you delete the KMS key." | high |
| 14 | Rotation period default 365, range 90-2560 | https://docs.aws.amazon.com/kms/latest/APIReference/API_EnableKeyRotation.html | "Valid Range: Minimum value of 90. Maximum value of 2560." | high |
| 15 | Multi-Region keys share key ID and material | https://docs.aws.amazon.com/kms/latest/developerguide/multi-region-keys-overview.html | "Each set of related multi-Region keys has the same key material and key ID" | high |
| 16 | Key policy is primary control | https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html | "Key policies are the primary way to control access to KMS keys." | high |
| 17 | CloudTrail logs all KMS ops including Decrypt/GenerateDataKey; first management copy free | https://docs.aws.amazon.com/kms/latest/developerguide/logging-using-cloudtrail.html ; https://aws.amazon.com/cloudtrail/pricing/ | "cryptographic operations, such as GenerateDataKey and Decrypt"; "You can deliver one copy of your ongoing management events to your Amazon Simple Storage Service (S3) bucket for free by creating trails." | high |
| 18 | KMS uses per-call derived keys | https://docs.aws.amazon.com/kms/latest/cryptographic-details/crypto-primitives.html | "AWS KMS uses a key derivation function (KDF) to derive per-call keys for every encryption under an AWS KMS key." | high |
| 19 | Encrypt limit 4,096 bytes; SYMMETRIC_DEFAULT is AES-256-GCM | https://docs.aws.amazon.com/kms/latest/APIReference/API_Encrypt.html ; https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html | "Encrypts plaintext of up to 4,096 bytes using a KMS key."; "SYMMETRIC_DEFAULT represents AES-256-GCM" | high |
| 20 | Disable is immediate; deletion waits 7-30 days and is irreversible | https://docs.aws.amazon.com/kms/latest/developerguide/enabling-keys.html ; .../deleting-keys.html | "it becomes unusable right away (subject to eventual consistency)"; "waiting period of 7 – 30 days. The default waiting period is 30" | high |
| 21 | IAM role sessions can be revoked; policy changes take minutes | https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html ; .../id_credentials_temp_control-access_disable-perms.html | "you can immediately revoke all permissions to the role's credentials issued before a certain point in time"; "It might take a few minutes for policy updates to take effect." | high |
| 22 | STS web identity needs no AWS credentials; default session 3600 s | https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html | "Calling AssumeRoleWithWebIdentity does not require the use of AWS security credentials."; "By default, the value is set to 3600 seconds." | high |
| 23 | AWS maps only amr/aud/email/oaud/sub for generic OIDC | https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html | Default table rows: amr, aud (azp), email, oaud, sub | medium (table read from flattened text) |
| 24 | Vercel OIDC on all plans; helper exchanges via AssumeRoleWithWebIdentity | https://vercel.com/docs/oidc ; https://vercel.com/docs/oidc/reference | "Secure backend access with OIDC federation is available on all plans"; "exchanges the OIDC token for short-lived credentials with AWS by calling the AssumeRoleWithWebIdentity operation" | high |
| 25 | Vercel token reuse and TTLs | https://vercel.com/docs/oidc ; https://vercel.com/docs/oidc/reference | "It reuses a token for up to 90 minutes. Function tokens have a Time to Live (TTL) of two hours."; "Build tokens expire after one hour ... development tokens expire after 12 hours." | high |
| 26 | Vercel sub claim format | https://vercel.com/docs/oidc/reference | "owner:[TEAM_SLUG]:project:[PROJECT_NAME]:environment:[ENVIRONMENT]" | high |
| 27 | Vercel AWS trust policy example and AWS_REGION warning | https://vercel.com/docs/oidc/aws | "AWS_REGION is not stable by default." | high |
| 28 | Vercel iad1 = us-east-1 and is default function region | https://vercel.com/docs/regions ; https://vercel.com/docs/functions/configuring-functions/region | table row "iad1 us-east-1 Washington, D.C., USA"; "By default, Vercel Functions execute in Washington, D.C., USA ( iad1 )" | high (mapping label), medium (network co-location inferred) |
| 29 | Fluid compute shares process state | https://vercel.com/docs/fluid-compute | "multiple invocations can share the same physical instance (a global state/process) concurrently" | high |
| 30 | Vercel GCP OIDC uses WIF with sub mapping | https://vercel.com/docs/oidc/gcp | "Assign the google.subject mapping to assertion.sub" | high |
| 31 | GCP key version about $0.06/month; ops $0.03/10k; Disabled/Scheduled versions billed | https://cloud.google.com/kms/pricing | "500 key versions at $0.06: $30.00."; "A key version is active if it is in any of these states: Enabled, Disabled, Scheduled for destruction" | high |
| 32 | GCP free ops only for Autokey; rotation free but re-encrypt counted | https://cloud.google.com/kms/pricing | "Monthly free cryptographic key operations only apply to operations performed using key versions created using Cloud KMS Autokey."; "Re-encrypting data to use the new key version counts toward your cryptographic key operations." | high |
| 33 | GCP software quota 6,000,000 TPM, 100 tokens per op, soft | https://docs.cloud.google.com/kms/quotas | "Software usage ... Minute 6,000,000 TPM ... Soft"; "Software-backed keys All cryptographic operations Software usage: 100" | medium (ops/s is my arithmetic) |
| 34 | GCP AAD supported, 64 KiB for software | https://docs.cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys/encrypt | "For SOFTWARE , EXTERNAL , and EXTERNAL_VPC keys the AAD must be no larger than 64KiB." | high |
| 35 | GCP rotationPeriod at least 24h; rotation does not re-encrypt | https://docs.cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys ; https://docs.cloud.google.com/kms/docs/key-rotation | "Must be at least 24 hours and at most 876,000 hours."; "Rotating keys creates new active key versions, but doesn't re-encrypt your data" | high |
| 36 | GCP Data Access audit logs off by default; Decrypt is DATA_READ | https://docs.cloud.google.com/logging/docs/audit ; https://docs.cloud.google.com/kms/docs/audit-logging | "Except for BigQuery, Data Access audit logs are disabled by default because they can generate large volumes of data." | high |
| 37 | GCP DEK guidance | https://docs.cloud.google.com/kms/docs/envelope-encryption | "Generate a new DEK every time you write the data."; "Do not use the same DEK to encrypt data from two different users." | high |
| 38 | GCP SLA | https://cloud.google.com/kms/sla | ">=99.95%" direct, ">=99.99%" via service account | high |
| 39 | GCP WIF can map custom attributes and use CEL conditions | https://docs.cloud.google.com/iam/docs/workload-identity-federation | "You can define up to 50 custom attributes"; "An attribute condition is a CEL expression" | high |
| 40 | Azure Standard ops $0.03/10k, advanced $0.15/10k; rotation $1; Managed HSM B1 $3.20/h; Premium HSM RSA-2048 key $1 | https://prices.azure.com/api/retail/prices (Key Vault, eastus; pricing page https://azure.microsoft.com/en-us/pricing/details/key-vault/ is JS-rendered "$-") | Standard/Operations 0.03 per 10K; Standard/Advanced Key Operations 0.15 per 10K; Automated Key Rotation 1.0 per Rotation; Standard B1 Instance 3.2 per Hour; Premium HSM-protected RSA 2048-bit key 1.0 | high |
| 41 | Azure Standard vault throughput | https://learn.microsoft.com/en-us/azure/key-vault/general/service-limits | RSA 2,048-bit software key "All other transactions" 4,000 per 10 s per vault per region | medium (table flattened) |
| 42 | Azure symmetric keys only Premium preview | https://learn.microsoft.com/en-us/azure/key-vault/keys/about-keys-details | "Symmetric (oct-HSM / AES) key support in Azure Key Vault Premium is currently in public preview." | high |
| 43 | Azure REST aad exists for authenticated algorithms | https://learn.microsoft.com/en-us/rest/api/keyvault/keys/wrap-key/wrap-key | "Additional data to authenticate but not encrypt/decrypt when using authenticated crypto algorithms." | high |
| 44 | Azure rotation minimum 7 days | https://learn.microsoft.com/en-us/azure/key-vault/keys/how-to-configure-key-rotation | "The minimum value is seven days from creation and seven days from expiration time." | high |
| 45 | Azure regional replication is paired-region only, single region deployment | https://learn.microsoft.com/en-us/azure/reliability/reliability-key-vault | "Key Vault resources are deployed into a single Azure region." | high |
| 46 | Vercel KMS is signing only | https://vercel.com/docs/kms ; https://vercel.com/docs/kms/pricing | "KMS does not support symmetric ( HS* ) keys."; "$0.03 per 10,000 operations" (standard), "$0.15 per 10,000 operations" (advanced) | high |
| 47 | HCP Vault pricing model and Dev tier limits | https://developer.hashicorp.com/hcp/docs/vault/get-started/deployment-considerations/tiers-and-features | "Development tier clusters are only charged an hourly base cost while Essentials and Standard tier clusters have an additional flat-rate hourly cost per Vault client." | high (model), unverified (dollars) |
| 48 | Vault Transit AAD/rewrap | https://developer.hashicorp.com/vault/api-docs/secret/transit | "associated_data ... also known as additional data or AAD"; "use the rewrap endpoint" | high |
| 49 | ESDK default suite and IV/tag sizes | https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/supported-algorithms.html | "The length of the initialization vector (IV) is always 12 bytes. The length of the authentication tag is always 16 bytes." | high |
| 50 | ESDK stores context in plaintext header; caching guidance | .../concepts.html ; .../data-key-caching.html ; .../thresholds.html | "includes the encryption context in plaintext in the header of the encrypted message"; "you should use cautiously"; "use the minimum amount of caching" | high |
| 51 | ESDK cannot read KMS Encrypt/ReEncrypt ciphertext | https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/introduction.html | "The AWS Encryption SDK cannot decrypt the ciphertext that the AWS KMS Encrypt or ReEncrypt operations return." | high |
| 52 | ESDK Hierarchical keyring in JS Node | .../use-hierarchical-keyring.html | "Version 4.1. x and later of the AWS Encryption SDK for JavaScript for JavaScript Node.js." | high |
| 53 | NIST GCM uniqueness and 2^32 limit | https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf | see 4.1 | high |
| 54 | NIST revising SP 800-38D, no draft yet | https://csrc.nist.gov/pubs/sp/800/38/d/r1/2prd | "there is no actual draft document available" | high |
| 55 | Node GCM API details | https://nodejs.org/api/crypto.html | "In GCM mode, the authTagLength option is not required but can be used to set the length of the authentication tag ... and defaults to 16 bytes." | high |
| 56 | AWS KMS key quota 100,000 per Region | https://docs.aws.amazon.com/kms/latest/developerguide/resource-limits.html | "AWS KMS keys: 100,000" | high |
| 57 | npm versions | `npm view` (registry.npmjs.org) | @aws-crypto/client-node 5.0.2; @aws-sdk/client-kms 3.1143.0; @vercel/oidc-aws-credentials-provider 3.3.9; @vercel/oidc 3.8.9; @google-cloud/kms 6.2.1; @azure/keyvault-keys 4.10.2; @vercel/kms 0.3.0 | high |

---

## 7. Unverified (and why)

1. KMS request latency from Vercel regions to AWS/GCP/Azure endpoints: no provider publishes numbers in the pages fetched, and this sandbox is not on Vercel. Plan: deploy a throwaway function in iad1 (and one candidate second region) that times 1,000 sequential `GenerateDataKey` and `Decrypt` calls with cold and warm credentials, record p50/p95/p99. Vercel's region table only labels iad1 as `us-east-1`; actual network co-location is inferred.
2. HCP Vault Dedicated dollar prices: official pricing pages sit behind a Vercel Security Checkpoint (HTTP 429, also from headless Chromium). Only a secondary source (infisical.com blog) gives numbers.
3. Whether `ReEncrypt` under the same key ID moves a wrapped DEK onto the current rotated key material: the fetched docs do not say. Not needed for the recommended design.
4. Whether Vercel can revoke an already-issued OIDC token: no documentation found; TTLs are the only documented bound.
5. Whether a renamed or deleted Vercel team slug can be registered by another party (which would matter because AWS trust is anchored on `sub` containing the slug).
6. Exact `sub` and lifetime of tokens visible to production build scripts beyond "Build tokens expire after one hour"; I assume `environment:production` for production builds.
7. Whether GCP Data Access audit entries for `Decrypt` include the AAD; and whether any IAM Condition can reference AAD (negative finding: none seen in the attribute reference).
8. Azure Managed HSM's AES-GCM/AAD behaviour and Azure Key Vault SLA figure (SLA page did not resolve to Key Vault text); Azure RBAC role names for wrap/unwrap.
9. Vault JWT auth with Vercel's OIDC issuer: the general JWKS/`bound_claims` features are documented; a Vercel-specific walkthrough was not researched.
10. GCP effective ops/second (about 1,000) is derived from 6,000,000 TPM / 100 tokens; the quota is dynamic and soft.
11. Whether AWS's rotation charge is $1 per additional key version up to 3 versions (my reading of "first and second rotation ... capped") versus another billing shape; the Price List describes "$1 per customer managed KMS key version".
12. Exact IAM/key-policy JSON for the encryption-context conditions was not tested against a live account.
13. Existence of a header-only "re-wrap" API in the Encryption SDK for JavaScript: none found in docs or package types checked.
14. HCP Vault Secrets status not checked; not needed.
15. CloudTrail S3 storage cost for the KMS event volume, and any org-level AWS account structure (separate audit account) not researched.

---

## 8. Source files saved locally (evidence)

Directory `working-directory/research/kms/`

- AWS: `aws-pricing.txt`, `aws-kms-pricelist.json`, `pl-eu-central-1.json`, `pl-us-west-2.json`, `pl-eu-west-1.json`, `aws-rps.txt`, `aws-encctx.txt`, `aws-rot.txt`, `aws-enablerot.txt`, `aws-mrk.txt`, `aws-reencrypt.txt`, `aws-gdk.txt`, `aws-decrypt-api.txt`, `aws-encrypt-api.txt`, `aws-keyspec.txt`, `aws-keypolicies.txt`, `aws-cloudtrail.txt`, `aws-ct-pricing.txt`, `aws-sla.txt`, `aws-faq.txt`, `aws-cd-crypto-primitives.txt`, `aws-arwwi.txt`, `aws-revoke.txt`, `aws-revoke-sessions.txt`, `aws-enable-keys.txt`, `aws-delete-keys.txt`, `aws-condkeys.txt`, `aws-reslimits.txt`, `aws-pg-kms.txt`, `esdk-*.txt`
- GCP: `gcp-pricing.txt`, `gcp-quotas.txt`, `gcp-audit.txt`, `gcp-logging-audit.txt`, `gcp-envelope.txt`, `gcp-rot.txt`, `gcp-reenc.txt`, `gcp-loc.txt`, `gcp-encrypt-ref.txt`, `gcp-cryptokey-ref.txt`, `gcp-sla.txt`, `gcp-wif.txt`, `gcp-iam-attr.txt`
- Azure: `az-pricing.txt`, `az-prices.json`, `az-limits.txt`, `az-keys.txt`, `az-keys-details.txt`, `az-wrap-ref.txt`, `az-rot.txt`, `az-log.txt`, `az-dr.txt`
- Vercel: `vercel-oidc.txt`, `vercel-oidc-aws.txt`, `vercel-oidc-gcp.txt`, `vercel-oidc-azure.txt`, `vercel-oidc-ref.txt`, `vkms.txt`, `vkms-pricing.txt`, `v-regions.txt`, `v-fn-region.txt`, `v-fluid.txt`, `v-sensenv.txt`, `vgraph.json`
- HashiCorp: `vault-transit.txt`, `vault-transit-overview.txt`, `vault-jwt.txt`, `hcp-tiers.txt`, `hcp-defs.txt`, `infisical-hcp.txt` (secondary), `hcp-pricing.txt` (checkpoint page)
- Other: `sp800-38d.pdf/.txt`, `nist38d.txt`, `nist38d-2prd.txt`, `node-crypto.txt`
