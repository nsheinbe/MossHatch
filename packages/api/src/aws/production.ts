import crypto from "node:crypto";
import type { KmsPort, PiiPort } from "../ports.ts";
import { S3ObjectLockAnchorSink, type AnchorSink } from "../ops/anchor.ts";
import { S3ObjectLockErasureLedger, type ErasureLedger } from "../ops/erasure.ts";
import { CloudTrailLookupEvents, UnwiredCloudTrail, VaultKeyDecrypts, type CloudTrailPort } from "../ops/kms-reconcile.ts";
import { AwsVaultKms } from "../vault/kms/aws.ts";
import { KmsError, type VaultKmsPort } from "../vault/kms/types.ts";
import { PINNED_AWS_REGION, platformFetch, type AwsCallOptions, type AwsFetch } from "./http.ts";
import { AwsKms, AwsPii, isKmsKeyArn } from "./kms.ts";
import { AwsAuthError, vercelOidcTokenSource, webIdentityCredentials, type OidcTokenSource } from "./oidc.ts";
import { AwsS3, isPlainBucketName, S3Error } from "./s3.ts";

/**
 * Production key management and the write-once stores, from environment variables (names in docs/AWS-SETUP.md).
 *
 *   MH_AWS_ROLE_ARN              app role: GenerateMac/VerifyMac on the MAC key, GenerateDataKey/Decrypt on the PII key,
 *                                write-once puts and reads on the anchor bucket, cloudtrail:LookupEvents
 *   MH_OIDC_AUDIENCE             optional custom `aud` (PLAN: random 32 bytes, base64url); absent = Vercel's default audience
 *   MH_AWS_REGION                optional; must be us-east-1 if set (Vercel's own AWS_REGION is never read)
 *   MH_KMS_MAC_KEY_ARN           HMAC_256 key (GENERATE_VERIFY_MAC)
 *   MH_KMS_PII_KEY_ARN           SYMMETRIC_DEFAULT key
 *   MH_ANCHOR_BUCKET             Object Lock bucket (anchors/ and erasures/)
 *   MH_ANCHOR_RETAIN_DAYS        optional, default 3650: COMPLIANCE retention set on every object written
 *   vault (optional as a group; absent = Nest routes answer 503 vault_unavailable):
 *   MH_KMS_VAULT_PROD_KEY_ARN, MH_KMS_VAULT_NONPROD_KEY_ARN, MH_AWS_VAULT_PROD_ROLE_ARN, MH_AWS_VAULT_NONPROD_ROLE_ARN, DATABASE_URL_VAULT
 *
 * Reason codes (never values): aws_oidc_not_configured, kms_not_configured, anchor_not_configured, vault_not_configured,
 * aws_region_not_pinned; after a live probe: aws_oidc_failed:<code>, kms_probe_failed:<code>, anchor_probe_failed:<code>,
 * anchor_bucket_not_compliance_locked.
 */

export interface ProductionAwsConfig {
  region: string;
  appRoleArn: string;
  audience?: string;
  macKeyArn: string;
  piiKeyArn: string;
  anchorBucket: string;
  retainDays: number;
  vault: { prodKeyArn: string; nonprodKeyArn: string; prodRoleArn: string; nonprodRoleArn: string; databaseUrl: string } | null;
}

const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@\/-]{1,128}$/;
const VAULT_VARS = ["MH_KMS_VAULT_PROD_KEY_ARN", "MH_KMS_VAULT_NONPROD_KEY_ARN", "MH_AWS_VAULT_PROD_ROLE_ARN", "MH_AWS_VAULT_NONPROD_ROLE_ARN", "DATABASE_URL_VAULT"] as const;

export function productionAwsFromEnv(env: Record<string, string | undefined>): { reasons: string[]; config: ProductionAwsConfig | null } {
  const reasons: string[] = [];
  const region = env.MH_AWS_REGION ?? PINNED_AWS_REGION;
  if (region !== PINNED_AWS_REGION) reasons.push("aws_region_not_pinned");
  const appRoleArn = env.MH_AWS_ROLE_ARN;
  const audience = env.MH_OIDC_AUDIENCE || undefined;
  if (!appRoleArn || !ROLE_ARN.test(appRoleArn) || (audience !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(audience))) reasons.push("aws_oidc_not_configured");
  const inRegion = (arn: string | undefined) => isKmsKeyArn(arn) && arn.split(":")[3] === PINNED_AWS_REGION;
  if (!inRegion(env.MH_KMS_MAC_KEY_ARN) || !inRegion(env.MH_KMS_PII_KEY_ARN) || env.MH_KMS_MAC_KEY_ARN === env.MH_KMS_PII_KEY_ARN) reasons.push("kms_not_configured");
  const retainRaw = env.MH_ANCHOR_RETAIN_DAYS ?? "3650";
  const retainDays = /^\d{1,5}$/.test(retainRaw) ? Number(retainRaw) : NaN;
  if (!isPlainBucketName(env.MH_ANCHOR_BUCKET) || !(retainDays >= 1)) reasons.push("anchor_not_configured");
  const present = VAULT_VARS.filter((k) => !!env[k]);
  let vault: ProductionAwsConfig["vault"] = null;
  if (present.length) {
    const ok = present.length === VAULT_VARS.length && inRegion(env.MH_KMS_VAULT_PROD_KEY_ARN) && inRegion(env.MH_KMS_VAULT_NONPROD_KEY_ARN)
      && env.MH_KMS_VAULT_PROD_KEY_ARN !== env.MH_KMS_VAULT_NONPROD_KEY_ARN
      && ROLE_ARN.test(env.MH_AWS_VAULT_PROD_ROLE_ARN!) && ROLE_ARN.test(env.MH_AWS_VAULT_NONPROD_ROLE_ARN!) && env.MH_AWS_VAULT_PROD_ROLE_ARN !== env.MH_AWS_VAULT_NONPROD_ROLE_ARN;
    if (!ok) reasons.push("vault_not_configured");
    else vault = { prodKeyArn: env.MH_KMS_VAULT_PROD_KEY_ARN!, nonprodKeyArn: env.MH_KMS_VAULT_NONPROD_KEY_ARN!, prodRoleArn: env.MH_AWS_VAULT_PROD_ROLE_ARN!, nonprodRoleArn: env.MH_AWS_VAULT_NONPROD_ROLE_ARN!, databaseUrl: env.DATABASE_URL_VAULT! };
  }
  if (reasons.length) return { reasons, config: null };
  return { reasons, config: { region, appRoleArn: appRoleArn!, audience, macKeyArn: env.MH_KMS_MAC_KEY_ARN!, piiKeyArn: env.MH_KMS_PII_KEY_ARN!, anchorBucket: env.MH_ANCHOR_BUCKET!, retainDays, vault } };
}

export interface ProductionAwsAdapters {
  kms: AwsKms & KmsPort;
  pii: PiiPort;
  s3: AwsS3;
  anchorSink: AnchorSink;
  erasureLedger: ErasureLedger;
  cloudTrail: CloudTrailPort;
  vaultKms: VaultKmsPort | null;
}

export interface AwsDeps {
  fetch?: AwsFetch;
  tokenSource?: OidcTokenSource;
  clock?: { now(): Date };
}

export function buildProductionAws(cfg: ProductionAwsConfig, env: Record<string, string | undefined>, deps: AwsDeps = {}): ProductionAwsAdapters {
  const fetch = deps.fetch ?? platformFetch;
  const tokenSource = deps.tokenSource ?? vercelOidcTokenSource(env);
  // CloudTrail shows this as the session name: the deployment id, opaque and useful when matching events to a deploy.
  const sessionName = "mh-" + (env.VERCEL_DEPLOYMENT_ID ?? "production");
  const creds = (roleArn: string) => webIdentityCredentials({ roleArn, region: cfg.region, sessionName, audience: cfg.audience, tokenSource, fetch, clock: deps.clock });
  const app: AwsCallOptions = { region: cfg.region, credentials: creds(cfg.appRoleArn), fetch, clock: deps.clock };
  const s3 = new AwsS3(app);
  const now = () => (deps.clock ?? { now: () => new Date() }).now();
  let vaultKms: VaultKmsPort | null = null;
  let cloudTrail: CloudTrailPort = new UnwiredCloudTrail("vault_not_configured");
  if (cfg.vault) {
    const v = cfg.vault;
    const byRole = { "vault-prod": creds(v.prodRoleArn), "vault-nonprod": creds(v.nonprodRoleArn) };
    vaultKms = new AwsVaultKms({
      region: cfg.region, keks: { "vault-prod": v.prodKeyArn, "vault-nonprod": v.nonprodKeyArn }, fetch, clock: deps.clock,
      // The re-wrap `operator` role is never assumable from Vercel (PLAN 4.3b): asking for it is refused here and by IAM.
      credentials: async (role) => { if (role === "operator") throw new AwsAuthError("operator_role_not_available"); return byRole[role](); },
    });
    cloudTrail = new VaultKeyDecrypts(new CloudTrailLookupEvents({ region: cfg.region, credentials: app.credentials, fetch, clock: deps.clock }), [v.prodKeyArn, v.nonprodKeyArn]);
  }
  return {
    kms: new AwsKms({ ...app, macKeyArn: cfg.macKeyArn }),
    pii: new AwsPii({ ...app, piiKeyArn: cfg.piiKeyArn }),
    s3,
    anchorSink: new S3ObjectLockAnchorSink(s3, cfg.anchorBucket, cfg.retainDays, now),
    erasureLedger: new S3ObjectLockErasureLedger(s3, cfg.anchorBucket, cfg.retainDays, now),
    cloudTrail,
    vaultKms,
  };
}

const codeOf = (e: unknown) => e instanceof AwsAuthError || e instanceof KmsError || e instanceof S3Error ? e.code : "Unexpected";

/**
 * A live check at boot, with no customer data: STS through OIDC, a MAC generated and verified, a PII value sealed and opened,
 * and the anchor bucket's Object Lock configuration read (COMPLIANCE default retention required). Returns reason codes; empty
 * when everything answered. The vault keys are not exercised here (that needs a vault role session and a real secret).
 */
export async function probeProductionAws(a: Pick<ProductionAwsAdapters, "kms" | "pii" | "s3">, cfg: Pick<ProductionAwsConfig, "anchorBucket">): Promise<string[]> {
  const reasons: string[] = [];
  const probe = crypto.randomBytes(16);
  try {
    const mac = await a.kms.hmac("audit", probe);
    if (!(await a.kms.verify("audit", probe, mac))) reasons.push("kms_probe_failed:MacMismatch");
    const env = await a.pii.encrypt("mosshatch-boot-probe", "boot_probe:" + probe.toString("hex"));
    if ((await a.pii.decrypt(env, "boot_probe:" + probe.toString("hex"))) !== "mosshatch-boot-probe") reasons.push("kms_probe_failed:RoundTrip");
  } catch (e) {
    // A credential failure is reported once, as itself; the anchor check would fail the same way.
    if (e instanceof AwsAuthError) return [`aws_oidc_failed:${e.code}`];
    reasons.push(`kms_probe_failed:${codeOf(e)}`);
  }
  try {
    const lock = await a.s3.objectLockConfiguration(cfg.anchorBucket);
    if (!lock.enabled || lock.mode !== "COMPLIANCE") reasons.push("anchor_bucket_not_compliance_locked");
  } catch (e) {
    reasons.push(e instanceof AwsAuthError ? `aws_oidc_failed:${e.code}` : `anchor_probe_failed:${codeOf(e)}`);
  }
  return [...new Set(reasons)];
}
