# AWS setup for the production deployment

What this sets up: the AWS side of Mosshatch's key management for the owner's invite-only dogfood purchases (D-058). That is
Vercel OIDC federation (no static AWS keys), two KMS keys the app needs (HMAC and PII) plus two optional vault keys, a write-once
S3 bucket for the audit anchor and the erasure ledger, and the IAM roles that tie them together. Everything is in **us-east-1**.

The code side is `packages/api/src/aws/` (`oidc.ts`, `kms.ts`, `s3.ts`, `production.ts`) and the production branch of
`bootFromEnv` in `packages/api/src/boot.ts`.

Values used below:

| Placeholder | Value |
|---|---|
| Vercel team slug | `nsheinbe-labs` (team id `team_qxpNXfBGSsHy99tHQ9J0ugL1`) |
| Vercel project | `mosshatch` (project id `prj_R1HZBGGMawLICQ3xkbfo28sETQ7v`) |
| OIDC issuer (Team issuer mode) | `https://oidc.vercel.com/nsheinbe-labs` |
| OIDC `sub` pinned in every trust policy | `owner:nsheinbe-labs:project:mosshatch:environment:production` |
| `<ACCOUNT_ID>` | your 12-digit AWS account id (top-right menu in the console) |
| `<AUDIENCE>` | the random value you generate in step 2 |
| `<BUCKET>` | the bucket name you choose in step 5, for example `mosshatch-anchor-<ACCOUNT_ID>` |
| `<MAC_KEY_ID>`, `<PII_KEY_ID>`, `<VAULT_PROD_KEY_ID>`, `<VAULT_NONPROD_KEY_ID>` | the key ids KMS shows after step 4 (`mrk-…` for multi-Region keys) |

Issuer, audience and `sub` formats were checked against https://vercel.com/docs/oidc/aws and
https://vercel.com/docs/oidc/reference (accessed 2026-10-01).

Paste every JSON document below exactly, after replacing the `<…>` placeholders. Nothing in this file is a secret; the
`<AUDIENCE>` value is sensitive (treat it like a password) and lives only in IAM and in a Vercel Sensitive variable.

---

## 0. Before you start: the AWS Free plan

- **The Free plan closes the account automatically** after 6 months or when the credits run out, whichever comes first; you
  then have 90 days to upgrade before AWS deletes the account's resources
  (https://aws.amazon.com/free/free-tier-faqs/, accessed 2026-10-01). Deleting the account deletes the KMS keys, and **a lost
  KMS key makes every value encrypted under it unreadable forever** (registrant contacts, registrar profile passwords, transfer
  auth codes, vault secrets). **Upgrade to the Paid plan before the first real purchase.** Upgrading keeps your remaining credits
  (Billing and Cost Management, then Account plan, then Upgrade plan).
- Do **not** create an AWS Organization or a Control Tower landing zone yet: doing either ends the Free plan credits at once and
  upgrades the account. PLAN 4.3b Loss radius wants separate production, staging and log-archive accounts in an Organization;
  that is deferred (see "Departures from PLAN" at the end).
- Everything used here (IAM, STS, KMS, S3 with Object Lock, CloudTrail event history) is available on the Free plan. KMS
  customer-managed keys are not free (USD 1 a month each) and are paid from the credits.
- Protect the root user: hardware security key or authenticator MFA on root, no root access keys. Use an IAM Identity Center
  user or an IAM admin user with MFA for everything below.
- Set the console Region selector (top right) to **US East (N. Virginia) us-east-1** before steps 4 and 5. IAM is global.
- Recommended: Billing and Cost Management, then Budgets, then Create budget, "Monthly cost budget" of USD 10 with an email alert.

## 1. Vercel: check the OIDC issuer mode

In Vercel: team `nsheinbe-labs`, project `mosshatch`, Settings, then Security, then "Secure backend access with OIDC
federation". It must be **enabled** with **Issuer Mode: Team**. (With Global mode the issuer would be
`https://oidc.vercel.com` and every `oidc.vercel.com/nsheinbe-labs` below would change; stay on Team.)

## 2. Generate the custom audience

PLAN 4.3b pins the trust policy to a random 32-byte audience, so a leaked `x-vercel-oidc-token` header (whose default audience
is `https://vercel.com/nsheinbe-labs`) is not enough to assume the role. Generate it once on your own machine:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

It prints 43 characters of `A-Z a-z 0-9 _ -`. That is `<AUDIENCE>`. The app exchanges its default token for one with this
audience at Vercel's token exchange (the mechanism `@vercel/oidc` uses; https://vercel.com/docs/oidc/aws#custom-audience)
before calling STS.

## 3. IAM identity provider for Vercel

IAM, then Identity providers, then Add provider:

- Provider type: **OpenID Connect**
- Provider URL: `https://oidc.vercel.com/nsheinbe-labs`
- Audience: `<AUDIENCE>` (only this one; do not add `https://vercel.com/nsheinbe-labs`)
- Add provider. The provider ARN is `arn:aws:iam::<ACCOUNT_ID>:oidc-provider/oidc.vercel.com/nsheinbe-labs`.

## 4. KMS keys

KMS, then Customer managed keys, then Create key. Create them with **Regionality: Multi-Region key** (a key cannot be made
multi-Region later; a replica in us-east-2, PLAN Loss radius, can then be added at any time for USD 1 a month). On the
"Define key administrative permissions" and "Define key usage permissions" pages select nobody; you replace the whole key
policy in step 7, after the roles exist. Do not schedule deletion of any of these keys, ever, once real data exists.

| Alias | Key type | Key usage | Key spec | Automatic rotation | Needed for |
|---|---|---|---|---|---|
| `mosshatch-prod-mac` | Symmetric | Generate and verify MAC | `HMAC_256` | not available for HMAC keys | boot (audit chain, pointers, rate limits, email codes) |
| `mosshatch-prod-pii` | Symmetric | Encrypt and decrypt | `SYMMETRIC_DEFAULT` | on, every 365 days | boot (registrant contacts, registrar profile passwords, auth codes) |
| `mosshatch-prod-vault-prod` | Symmetric | Encrypt and decrypt | `SYMMETRIC_DEFAULT` | on, every 365 days | optional: the Nest, customers' `prod` secrets |
| `mosshatch-prod-vault-nonprod` | Symmetric | Encrypt and decrypt | `SYMMETRIC_DEFAULT` | on, every 365 days | optional: the Nest, customers' `dev` and `preview` secrets |

The Nest (vault) is a second launch (D-058). **For the first purchases create only the first two keys.** Without the vault
variables the Nest routes answer 503 `vault_unavailable` and `audit.kms_reconcile` raises `kms.reconcile_not_configured`.

Copy each key's **ARN** (not the alias ARN): `arn:aws:kms:us-east-1:<ACCOUNT_ID>:key/mrk-…`. The app refuses alias ARNs.

## 5. S3 bucket for the audit anchor and the erasure ledger

S3, then Create bucket (Region us-east-1):

- Bucket type: General purpose. Name: `<BUCKET>`, lowercase letters, digits and hyphens only, **no dots**.
- Object Ownership: ACLs disabled. Block **all** public access: on.
- Bucket Versioning: **Enable** (Object Lock requires it).
- Default encryption: SSE-S3 (no extra KMS key or cost).
- Advanced settings, Object Lock: **Enable**, and acknowledge.
- Create bucket. Then open the bucket, Properties, Object Lock, Edit: Default retention **Enable**, Default retention mode
  **Compliance**, Default retention period **35 days**. Save. (The app sets its own longer COMPLIANCE retention on every
  object it writes; the default is the floor for anything written without one. Boot refuses a bucket without a COMPLIANCE
  default: `anchor_bucket_not_compliance_locked`.)

Compliance mode means **nobody, including the root user, can delete or overwrite a locked object version before its retention
date**, and the bucket cannot be deleted while it holds one. With the default `MH_ANCHOR_RETAIN_DAYS` of 3650 that is ten years
per anchor (one small object a day, a few MB in total, well under a cent a month). If you would rather commit to less during
dogfooding, set `MH_ANCHOR_RETAIN_DAYS` to, for example, `400` before the first deployment that writes anchors. It cannot be
shortened for objects already written.

Bucket policy (Permissions, then Bucket policy, then Edit), refusing anything that is not TLS:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::<BUCKET>", "arn:aws:s3:::<BUCKET>/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

## 6. IAM roles

IAM, then Roles, then Create role, then **Web identity**: Identity provider `oidc.vercel.com/nsheinbe-labs`, Audience
`<AUDIENCE>`. Skip the permissions page, name the role, create it. Then open the role and:

- Trust relationships, Edit trust policy: paste the trust policy below (the same for every role).
- Summary, Edit, Maximum session duration: **1 hour**.
- Permissions, Add permissions, Create inline policy, JSON: paste that role's permission policy.

Trust policy (all roles):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "VercelMosshatchProductionOnly",
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/oidc.vercel.com/nsheinbe-labs" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.vercel.com/nsheinbe-labs:aud": "<AUDIENCE>",
          "oidc.vercel.com/nsheinbe-labs:sub": "owner:nsheinbe-labs:project:mosshatch:environment:production"
        }
      }
    }
  ]
}
```

Preview, development and builds of other projects cannot assume these roles (their `sub` differs). A rename of the Vercel team
or project changes the `sub` (a team rename also changes the issuer) and needs this policy changed first
(https://vercel.com/docs/oidc/reference, "Team and project name changes").

### 6a. `mosshatch-app` (required)

Inline policy name `mosshatch-app`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "MacKey",
      "Effect": "Allow",
      "Action": ["kms:GenerateMac", "kms:VerifyMac"],
      "Resource": "arn:aws:kms:us-east-1:<ACCOUNT_ID>:key/<MAC_KEY_ID>",
      "Condition": { "StringEquals": { "kms:MacAlgorithm": "HMAC_SHA_256" } }
    },
    {
      "Sid": "PiiKey",
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
      "Resource": "arn:aws:kms:us-east-1:<ACCOUNT_ID>:key/<PII_KEY_ID>",
      "Condition": {
        "StringEquals": { "kms:EncryptionContext:app": "mosshatch", "kms:EncryptionContext:purpose": "pii" },
        "ForAllValues:StringEquals": { "kms:EncryptionContextKeys": ["app", "purpose", "aad_sha256"] }
      }
    },
    {
      "Sid": "AnchorAndLedgerWriteOnce",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:PutObjectRetention", "s3:GetObject"],
      "Resource": ["arn:aws:s3:::<BUCKET>/anchors/*", "arn:aws:s3:::<BUCKET>/erasures/*"]
    },
    {
      "Sid": "AnchorAndLedgerList",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<BUCKET>",
      "Condition": { "StringEquals": { "s3:prefix": ["anchors/", "erasures/"] } }
    },
    {
      "Sid": "BootProbeReadsTheLock",
      "Effect": "Allow",
      "Action": "s3:GetBucketObjectLockConfiguration",
      "Resource": "arn:aws:s3:::<BUCKET>"
    },
    {
      "Sid": "KmsReconcileReadsEventHistory",
      "Effect": "Allow",
      "Action": "cloudtrail:LookupEvents",
      "Resource": "*"
    },
    {
      "Sid": "NeverAdministers",
      "Effect": "Deny",
      "Action": [
        "kms:CreateGrant", "kms:PutKeyPolicy", "kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:ReEncrypt*", "kms:Encrypt",
        "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:BypassGovernanceRetention", "s3:PutBucket*", "s3:DeleteBucket*", "s3:PutLifecycleConfiguration",
        "iam:*", "sts:AssumeRole"
      ],
      "Resource": "*"
    }
  ]
}
```

(`cloudtrail:LookupEvents` has no resource-level permissions, hence `*`. It is used only when the vault is configured.)

### 6b. `mosshatch-vault-prod` and `mosshatch-vault-nonprod` (optional, only with the vault keys)

Same trust policy. Inline policy for `mosshatch-vault-prod`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "VaultProdKek",
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
      "Resource": "arn:aws:kms:us-east-1:<ACCOUNT_ID>:key/<VAULT_PROD_KEY_ID>",
      "Condition": {
        "StringEquals": { "kms:EncryptionContext:app": "mosshatch-nest", "kms:EncryptionContext:env": "prod" },
        "ForAllValues:StringEquals": { "kms:EncryptionContextKeys": ["app", "env", "owner_id", "secret_id"] }
      }
    },
    {
      "Sid": "NeverAdministers",
      "Effect": "Deny",
      "Action": ["kms:CreateGrant", "kms:PutKeyPolicy", "kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:ReEncrypt*", "kms:Encrypt", "iam:*", "sts:AssumeRole"],
      "Resource": "*"
    }
  ]
}
```

For `mosshatch-vault-nonprod`, the same document with `<VAULT_NONPROD_KEY_ID>`, the Sid `VaultNonprodKek`, and the `env`
condition replaced by `"kms:EncryptionContext:env": ["dev", "preview"]` (keep it under `StringEquals`; a list there means
"any of"). A `prod` wrapped key sent to `vault-nonprod` is then AccessDenied (ST-09). Re-wrap (`ReEncrypt`) belongs to a separate
operator role that Vercel cannot assume; it is not created now.

## 7. Key policies

KMS, then each key, then Key policy, then Switch to policy view, then Edit. Replace the whole policy. The first statement is the
standard one that lets the account's IAM manage the key (without it the key becomes unmanageable); the second lets the role
use it; the third is PLAN's "human principals are denied Decrypt" (and MAC use), so only the role can unwrap or MAC.

`mosshatch-prod-mac`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "AccountAdministers", "Effect": "Allow", "Principal": { "AWS": "arn:aws:iam::<ACCOUNT_ID>:root" }, "Action": "kms:*", "Resource": "*" },
    {
      "Sid": "AppRoleMacs", "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<ACCOUNT_ID>:role/mosshatch-app" },
      "Action": ["kms:GenerateMac", "kms:VerifyMac"], "Resource": "*",
      "Condition": { "StringEquals": { "kms:MacAlgorithm": "HMAC_SHA_256" } }
    },
    {
      "Sid": "OnlyTheAppRoleMacs", "Effect": "Deny", "Principal": "*",
      "Action": ["kms:GenerateMac", "kms:VerifyMac"], "Resource": "*",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "arn:aws:iam::<ACCOUNT_ID>:role/mosshatch-app" } }
    }
  ]
}
```

`mosshatch-prod-pii`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "AccountAdministers", "Effect": "Allow", "Principal": { "AWS": "arn:aws:iam::<ACCOUNT_ID>:root" }, "Action": "kms:*", "Resource": "*" },
    {
      "Sid": "AppRoleEnvelopes", "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<ACCOUNT_ID>:role/mosshatch-app" },
      "Action": ["kms:GenerateDataKey", "kms:Decrypt"], "Resource": "*",
      "Condition": { "StringEquals": { "kms:EncryptionContext:app": "mosshatch", "kms:EncryptionContext:purpose": "pii" } }
    },
    {
      "Sid": "OnlyTheAppRoleDecrypts", "Effect": "Deny", "Principal": "*",
      "Action": ["kms:Decrypt", "kms:ReEncrypt*", "kms:CreateGrant"], "Resource": "*",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "arn:aws:iam::<ACCOUNT_ID>:role/mosshatch-app" } }
    }
  ]
}
```

`mosshatch-prod-vault-prod` (optional): the PII policy with `mosshatch-app` replaced by `mosshatch-vault-prod`, the Sids
`VaultProdRole` and `OnlyTheVaultProdRoleDecrypts`, and the condition
`{ "StringEquals": { "kms:EncryptionContext:app": "mosshatch-nest", "kms:EncryptionContext:env": "prod" } }`.
`mosshatch-prod-vault-nonprod` (optional): the same with `mosshatch-vault-nonprod` and `"kms:EncryptionContext:env": ["dev", "preview"]`.

The "Deny everyone else Decrypt" statements also stop you, from the console, from decrypting. That is intended. If you ever must,
the root user can edit the key policy (it is logged in CloudTrail).

## 8. Vercel environment variables

Vercel, project `mosshatch`, Settings, Environment Variables. Scope every one of these to **Production only** and mark them
**Sensitive** (PLAN 4.3b rule 2: nothing Production-scoped is also Preview or Development).

| Name | Value | Required |
|---|---|---|
| `MH_AWS_ROLE_ARN` | `arn:aws:iam::<ACCOUNT_ID>:role/mosshatch-app` | yes |
| `MH_OIDC_AUDIENCE` | `<AUDIENCE>` (43 characters) | yes for this setup (if absent, the app uses Vercel's default audience, which this trust policy rejects) |
| `MH_KMS_MAC_KEY_ARN` | ARN of `mosshatch-prod-mac`, `arn:aws:kms:us-east-1:<ACCOUNT_ID>:key/<MAC_KEY_ID>` | yes |
| `MH_KMS_PII_KEY_ARN` | ARN of `mosshatch-prod-pii` | yes |
| `MH_ANCHOR_BUCKET` | `<BUCKET>` | yes |
| `MH_ANCHOR_RETAIN_DAYS` | days of COMPLIANCE retention per object; default `3650` | no |
| `MH_AWS_REGION` | `us-east-1` (the only accepted value; the code pins it anyway and never reads Vercel's `AWS_REGION`) | no |
| `MH_KMS_VAULT_PROD_KEY_ARN` | ARN of `mosshatch-prod-vault-prod` | vault only |
| `MH_KMS_VAULT_NONPROD_KEY_ARN` | ARN of `mosshatch-prod-vault-nonprod` | vault only |
| `MH_AWS_VAULT_PROD_ROLE_ARN` | `arn:aws:iam::<ACCOUNT_ID>:role/mosshatch-vault-prod` | vault only |
| `MH_AWS_VAULT_NONPROD_ROLE_ARN` | `arn:aws:iam::<ACCOUNT_ID>:role/mosshatch-vault-nonprod` | vault only |
| `DATABASE_URL_VAULT` | the vault database login (PLAN 4.3b rotation table) | vault only |

The vault group is all-or-nothing: some but not all of the five gives `vault_not_configured`. Never add `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` or any other static AWS credential. Redeploy production after changing variables.

Production also needs the variables the app already had (`DATABASE_URL`, `DATABASE_URL_CRON`, `MH_ORIGIN`, `CRON_SECRET`,
Resend). Stripe live and the live registrar (Openprovider through the `mosshatch-registrar` project) are in `docs/GO-LIVE.md`.

## 9. Verify

After the production redeploy, request any API route that is not the waitlist or the lookup, for example
`https://mosshatch.com/api/health/ticks`. Production boots only when everything is configured, so today it answers 503 with
the codes still missing. **When the AWS side is right, the reason lists only live-money codes** (before `docs/GO-LIVE.md` is done):

```json
{"error":{"code":"not_configured","reason":"stripe_secret_key_missing,stripe_webhook_secret_missing,registrar_mode_not_live,registrar_provider_not_openprovider,registrar_rpc_url_missing,registrar_rpc_secret_missing"}}
```

because the boot probe has just, live: exchanged the OIDC token for the custom audience, called `AssumeRoleWithWebIdentity`
(900 seconds), generated and verified a MAC, sealed and opened a throwaway PII value, and read the bucket's Object Lock
configuration. It writes nothing to the bucket. A failed boot is retried at most once a minute per function instance.

| Code in `reason` | Meaning and fix |
|---|---|
| `database_not_configured`, `origin_not_configured`, `cron_secret_not_configured` | `DATABASE_URL`, `MH_ORIGIN` or `CRON_SECRET` (32+ characters) missing |
| `aws_oidc_not_configured` | `MH_AWS_ROLE_ARN` missing or not a role ARN, or `MH_OIDC_AUDIENCE` not 43 base64url characters |
| `kms_not_configured` | `MH_KMS_MAC_KEY_ARN` or `MH_KMS_PII_KEY_ARN` missing, an alias, outside us-east-1, or the same key twice |
| `anchor_not_configured` | `MH_ANCHOR_BUCKET` missing or not a dot-free bucket name, or `MH_ANCHOR_RETAIN_DAYS` not a whole number |
| `vault_not_configured` | some but not all of the five vault variables |
| `aws_region_not_pinned` | `MH_AWS_REGION` set to something other than `us-east-1` |
| `aws_oidc_failed:oidc_token_missing` | the function received no `x-vercel-oidc-token`: OIDC federation is off for the project (step 1) |
| `aws_oidc_failed:oidc_audience_exchange_failed` | Vercel's token exchange refused the custom audience; check step 1, then `MH_OIDC_AUDIENCE` |
| `aws_oidc_failed:sts:AccessDenied` | trust policy mismatch: the `aud` (step 3 audience vs `MH_OIDC_AUDIENCE`), the `sub` (team, project, environment) or the provider ARN |
| `aws_oidc_failed:sts:InvalidIdentityToken` | provider URL wrong (must be `https://oidc.vercel.com/nsheinbe-labs`) or the audience is not registered on the provider |
| `kms_probe_failed:AccessDeniedException` | the role's inline policy or the key policy does not allow the call (check both, and the key ARNs) |
| `kms_probe_failed:NotFoundException` | a key ARN points at a key that does not exist in us-east-1 |
| `kms_probe_failed:DisabledException`, `…KMSInvalidStateException` | the key is disabled or pending deletion (cancel deletion at once) |
| `anchor_probe_failed:AccessDenied` | `s3:GetBucketObjectLockConfiguration` missing from the role, or a wrong bucket |
| `anchor_probe_failed:NoSuchBucket` | bucket name or Region wrong |
| `anchor_probe_failed:ObjectLockConfigurationNotFoundError`, `anchor_bucket_not_compliance_locked` | Object Lock not enabled at creation (make a new bucket), or the default retention is not Compliance |
| `stripe_*`, `registrar_*`, `openprovider_*`, `vercel_env_not_production` | the live money paths: `docs/GO-LIVE.md` steps 3 to 7 list each code |

Then, in the AWS console, CloudTrail, Event history (us-east-1): you should see `AssumeRoleWithWebIdentity` with the role
`mosshatch-app` and session name `mh-dpl_…`, then `GenerateMac`, `VerifyMac`, `GenerateDataKey` and `Decrypt` from
`assumed-role/mosshatch-app/…`. Event history is on by default, free, and keeps 90 days of management events (KMS calls
included); no trail is needed for that.

## Monthly cost estimate

Prices from https://aws.amazon.com/kms/pricing/ and https://aws.amazon.com/s3/pricing/ (accessed 2026-09-29/2026-10-01).

| Item | First purchases (2 keys) | With the vault (4 keys) |
|---|---|---|
| KMS keys, USD 1 per key-month | USD 2.00 | USD 4.00 |
| KMS rotation surcharge (USD 1 a month per key after each of its first two yearly rotations; PII and vault keys) | 0 in year 1, USD 1 in year 2, USD 2 from year 3 | 0, USD 3, USD 6 |
| KMS requests, USD 0.03 per 10,000 after the 20,000 a month free | about USD 0 (a purchase is a few dozen requests; each cold start's probe is 4) | about USD 0 |
| S3 storage and requests (a few KB a day) | under USD 0.01 | under USD 0.01 |
| STS, IAM, CloudTrail event history | free | free |
| **Total** | **about USD 2 a month** (USD 4 by year 3) | **about USD 4 a month** (USD 10 by year 3) |

Optional later: a us-east-2 replica of each key, USD 1 a month each (PLAN Loss radius); a CloudTrail trail to an Object Lock
bucket (the first copy of management events is free; S3 storage is cents). All of it is paid from the credits while they last.

## Departures from PLAN, and what is still open

- **One AWS account.** PLAN wants separate production, staging and log-archive accounts, with the anchor bucket in the
  log-archive account. Creating an Organization ends the Free plan credits, so for dogfooding everything is in one account and
  the anchor bucket is protected by COMPLIANCE Object Lock instead of an account boundary. Move it before the public launch.
- **No break-glass role yet.** PLAN Loss radius denies `ScheduleKeyDeletion`, `DisableKey` and `PutKeyPolicy` to everyone but a
  hardware-key break-glass role. Here the app roles deny themselves those actions and the account administrator keeps them.
  Until then: never schedule a key deletion; if you must, the 30-day window is the default, keep it.
- **No multi-Region replicas yet** (the keys are created multi-Region so replicas can be added without a re-wrap).
- **No CloudTrail alarms yet** (PLAN 4.3b Operations: `ScheduleKeyDeletion`, `DisableKey`, `PutKeyPolicy`, `CreateGrant`,
  unknown `sub`). They need a trail plus EventBridge or CloudWatch; a later task.
- **`audit.kms_reconcile`** reads CloudTrail event history (`LookupEvents`) and joins vault-key Decrypts to reveal rows. With
  the vault off it raises `kms.reconcile_not_configured` on every run instead of passing. The `LookupEvents` adapter is tested
  only against a fake; its first live run happens when the vault is configured.
- **The backup key** (PLAN Loss radius item 6) and the nightly off-Neon backup are not part of this setup.
- **Staging** has no AWS wiring; it keeps refusing the vault (503) and uses the local HMAC and PII doubles.
