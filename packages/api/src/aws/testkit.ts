import crypto from "node:crypto";
import { canonicalJson } from "../util/bytes.ts";
import type { AwsFetch } from "./http.ts";
import { signV4 } from "../vault/kms/aws.ts";

/**
 * An in-memory AWS for tests (no network): the Vercel token exchange, STS AssumeRoleWithWebIdentity, KMS (GenerateDataKey,
 * Decrypt, GenerateMac, VerifyMac), S3 (Object Lock PutObject, ListObjectsV2, GetObject, GetObjectLockConfiguration) and
 * CloudTrail LookupEvents over the KMS calls it served. It enforces what the adapters rely on: exact encryption context on
 * Decrypt, the key named in KeyId, per-role key permissions (AccessDenied otherwise), write-once keys and retention headers.
 * It is a double for our request shapes, not a model of AWS: the live account is checked by docs/AWS-SETUP.md "Verify".
 */

export interface FakeKey { arn: string; spec: "SYMMETRIC_DEFAULT" | "HMAC_256"; material: Buffer; enabled: boolean }
export interface FakeRole { arn: string; allow: Record<string, string[]> /* key ARN -> KMS operations */; s3?: boolean; cloudtrail?: boolean }
export interface FakeRequest { url: string; method: string; headers: Record<string, string>; body: string }

const ACCOUNT = "111122223333";
export const fakeKeyArn = (n: number) => `arn:aws:kms:us-east-1:${ACCOUNT}:key/${crypto.createHash("md5").update(String(n)).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")}`;
export const fakeRoleArn = (name: string) => `arn:aws:iam::${ACCOUNT}:role/${name}`;

export class FakeAws {
  requests: FakeRequest[] = [];
  keys = new Map<string, FakeKey>();
  roles = new Map<string, FakeRole>();
  /** Tokens STS accepts: token -> its `aud`. */
  validTokens = new Map<string, string>();
  /** The audience every role's trust policy requires. */
  requiredAudience: string;
  sessions = new Map<string, { role: string; secret: string; token: string; expires: Date }>();
  blobs = new Map<string, { keyArn: string; context: string; dk: Buffer }>();
  trail: { eventID: string; eventTime: string; eventName: string; keyArn: string; principal: string; context: Record<string, string> | null; errorCode?: string }[] = [];
  buckets = new Map<string, { lock: { enabled: boolean; mode: "COMPLIANCE" | "GOVERNANCE"; days: number } | null; objects: Map<string, { body: string; retainUntil: string; mode: string }> }>();
  stsDurations: number[] = [];
  stsDeny = false;
  exchangeFails = false;
  constructor(private o: { now?: () => Date; audience?: string; listPageSize?: number } = {}) { this.requiredAudience = o.audience ?? "https://vercel.com/nsheinbe-labs"; }

  private now() { return this.o.now?.() ?? new Date(); }
  addKey(n: number, spec: FakeKey["spec"]): string { const arn = fakeKeyArn(n); this.keys.set(arn, { arn, spec, material: crypto.randomBytes(32), enabled: true }); return arn; }
  addRole(name: string, r: Omit<FakeRole, "arn">): string { const arn = fakeRoleArn(name); this.roles.set(arn, { arn, ...r }); return arn; }
  addBucket(name: string, lock: { enabled: boolean; mode: "COMPLIANCE" | "GOVERNANCE"; days: number } | null = { enabled: true, mode: "COMPLIANCE", days: 35 }) { this.buckets.set(name, { lock, objects: new Map() }); }

  fetch: AwsFetch = async (url, init) => {
    const body = init.body ?? "";
    this.requests.push({ url, method: init.method, headers: { ...init.headers }, body });
    const u = new URL(url);
    const reply = (status: number, b: string) => ({ status, text: async () => b });
    if (u.host === "oidc.vercel.com" && u.pathname === "/~token") {
      if (this.exchangeFails) return reply(403, JSON.stringify({ error: "forbidden" }));
      const { token, aud } = JSON.parse(body) as { token: string; aud: string };
      if (!this.validTokens.has(token)) return reply(401, JSON.stringify({ error: "invalid token" }));
      const t = "exchanged." + crypto.randomBytes(8).toString("hex");
      this.validTokens.set(t, aud);
      return reply(200, JSON.stringify({ token: t, expiry: Math.floor(this.now().getTime() / 1000) + 3600 }));
    }
    if (u.host === "sts.us-east-1.amazonaws.com") return this.sts(new URLSearchParams(body), reply);
    const auth = /Credential=([^/]+)\//.exec(init.headers.authorization ?? "")?.[1];
    const session = auth ? this.sessions.get(auth) : undefined;
    if (!session || session.token !== init.headers["x-amz-security-token"] || session.expires <= this.now()) return reply(403, JSON.stringify({ __type: "UnrecognizedClientException" }));
    // Recompute the SigV4 signature with the session's secret: a request that was not signed exactly as sent is refused.
    const signedNames = (/SignedHeaders=([^,]+)/.exec(init.headers.authorization ?? "")?.[1] ?? "").split(";");
    const signedHeaders = Object.fromEntries(signedNames.filter((n) => !["host", "x-amz-date", "x-amz-security-token"].includes(n)).map((n) => [n, init.headers[n] ?? ""]));
    const service = u.host.split(".").includes("s3") ? "s3" : u.host.split(".")[0]!;
    const expected = signV4({ method: init.method, host: u.host, path: u.pathname, query: u.search.slice(1), headers: signedHeaders, body, region: "us-east-1", service, amzDate: init.headers["x-amz-date"]!, credentials: { accessKeyId: auth!, secretAccessKey: session.secret, sessionToken: session.token } });
    if (expected.authorization !== init.headers.authorization) return reply(403, JSON.stringify({ __type: "InvalidSignatureException" }));
    const role = this.roles.get(session.role)!;
    if (u.host === "kms.us-east-1.amazonaws.com") return this.kms(role, init.headers["x-amz-target"]!.replace("TrentService.", ""), JSON.parse(body), reply);
    if (u.host === "cloudtrail.us-east-1.amazonaws.com") {
      if (!role.cloudtrail) return reply(400, JSON.stringify({ __type: "AccessDeniedException" }));
      const events = this.trail.filter((e) => e.eventName === "Decrypt").map((e) => ({ CloudTrailEvent: JSON.stringify({
        eventSource: "kms.amazonaws.com", eventName: e.eventName, eventID: e.eventID, eventTime: e.eventTime, userIdentity: { arn: e.principal },
        requestParameters: { keyId: e.keyArn, encryptionContext: e.context }, resources: [{ type: "AWS::KMS::Key", ARN: e.keyArn }], ...(e.errorCode ? { errorCode: e.errorCode } : {}),
      }) }));
      return reply(200, JSON.stringify({ Events: events }));
    }
    const m = /^([a-z0-9-]+)\.s3\.us-east-1\.amazonaws\.com$/.exec(u.host);
    if (m) {
      if (!role.s3) return reply(403, "<Error><Code>AccessDenied</Code></Error>");
      return this.s3(m[1]!, init.method, u, init.headers, body, reply);
    }
    return reply(404, "");
  };

  private sts(p: URLSearchParams, reply: (s: number, b: string) => { status: number; text(): Promise<string> }) {
    if (p.get("Action") !== "AssumeRoleWithWebIdentity" || p.get("Version") !== "2011-06-15") return reply(400, "<ErrorResponse><Error><Code>InvalidAction</Code></Error></ErrorResponse>");
    this.stsDurations.push(Number(p.get("DurationSeconds")));
    const aud = this.validTokens.get(p.get("WebIdentityToken") ?? "");
    if (aud === undefined) return reply(400, "<ErrorResponse><Error><Code>InvalidIdentityToken</Code><Message>bad token</Message></Error></ErrorResponse>");
    const role = this.roles.get(p.get("RoleArn") ?? "");
    if (this.stsDeny || !role || aud !== this.requiredAudience) return reply(403, "<ErrorResponse><Error><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error></ErrorResponse>");
    const id = "ASIA" + crypto.randomBytes(8).toString("hex").toUpperCase();
    const secret = crypto.randomBytes(20).toString("base64");
    const token = crypto.randomBytes(24).toString("base64");
    const expires = new Date(this.now().getTime() + Number(p.get("DurationSeconds") ?? 3600) * 1000);
    this.sessions.set(id, { role: role.arn, secret, token, expires });
    return reply(200, `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>${id}</AccessKeyId><SecretAccessKey>${secret}</SecretAccessKey><SessionToken>${token}</SessionToken><Expiration>${expires.toISOString()}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`);
  }

  private kms(role: FakeRole, op: string, b: Record<string, any>, reply: (s: number, b: string) => { status: number; text(): Promise<string> }) {
    const err = (t: string) => reply(400, JSON.stringify({ __type: `com.amazonaws.kms#${t}`, message: "fake" }));
    const keyArn = String(b.KeyId ?? "");
    const key = this.keys.get(keyArn);
    const record = (errorCode?: string) => this.trail.push({ eventID: crypto.randomUUID(), eventTime: this.now().toISOString(), eventName: op, keyArn, principal: role.arn + "/session", context: b.EncryptionContext ?? null, errorCode });
    if (!key) { record("NotFoundException"); return err("NotFoundException"); }
    if (!(role.allow[keyArn] ?? []).includes(op)) { record("AccessDeniedException"); return err("AccessDeniedException"); }
    if (!key.enabled) { record("DisabledException"); return err("DisabledException"); }
    const ctx = canonicalJson(b.EncryptionContext ?? {});
    switch (op) {
      case "GenerateDataKey": {
        if (key.spec !== "SYMMETRIC_DEFAULT" || b.KeySpec !== "AES_256") return err("InvalidKeyUsageException");
        const dk = crypto.randomBytes(32);
        const blob = crypto.randomBytes(48).toString("base64");
        this.blobs.set(blob, { keyArn, context: ctx, dk });
        record();
        return reply(200, JSON.stringify({ KeyId: keyArn, Plaintext: dk.toString("base64"), CiphertextBlob: blob }));
      }
      case "Decrypt": {
        const e = this.blobs.get(String(b.CiphertextBlob));
        if (!e) { record("InvalidCiphertextException"); return err("InvalidCiphertextException"); }
        if (e.keyArn !== keyArn) { record("IncorrectKeyException"); return err("IncorrectKeyException"); }
        if (e.context !== ctx) { record("InvalidCiphertextException"); return err("InvalidCiphertextException"); }
        record();
        return reply(200, JSON.stringify({ KeyId: keyArn, Plaintext: e.dk.toString("base64"), EncryptionAlgorithm: "SYMMETRIC_DEFAULT" }));
      }
      case "GenerateMac":
      case "VerifyMac": {
        if (key.spec !== "HMAC_256" || b.MacAlgorithm !== "HMAC_SHA_256") return err("InvalidKeyUsageException");
        const msg = Buffer.from(String(b.Message), "base64");
        if (msg.length < 1 || msg.length > 4096) return err("ValidationException");
        const mac = crypto.createHmac("sha256", key.material).update(msg).digest();
        record();
        if (op === "GenerateMac") return reply(200, JSON.stringify({ KeyId: keyArn, Mac: mac.toString("base64"), MacAlgorithm: "HMAC_SHA_256" }));
        const given = Buffer.from(String(b.Mac), "base64");
        if (given.length !== mac.length || !crypto.timingSafeEqual(given, mac)) return err("KMSInvalidMacException");
        return reply(200, JSON.stringify({ KeyId: keyArn, MacValid: true, MacAlgorithm: "HMAC_SHA_256" }));
      }
      default: return err("UnsupportedOperationException");
    }
  }

  private s3(bucketName: string, method: string, u: URL, h: Record<string, string>, body: string, reply: (s: number, b: string) => { status: number; text(): Promise<string> }) {
    const bucket = this.buckets.get(bucketName);
    if (!bucket) return reply(404, "<Error><Code>NoSuchBucket</Code></Error>");
    if (h["x-amz-content-sha256"] !== crypto.createHash("sha256").update(body).digest("hex")) return reply(400, "<Error><Code>XAmzContentSHA256Mismatch</Code></Error>");
    const key = decodeURIComponent(u.pathname.slice(1));
    if (method === "PUT") {
      if (h["content-md5"] !== crypto.createHash("md5").update(body).digest("base64")) return reply(400, "<Error><Code>BadDigest</Code></Error>");
      if (!bucket.lock?.enabled && h["x-amz-object-lock-mode"]) return reply(400, "<Error><Code>InvalidRequest</Code></Error>");
      if (h["if-none-match"] === "*" && bucket.objects.has(key)) return reply(412, "<Error><Code>PreconditionFailed</Code></Error>");
      if (bucket.objects.has(key)) return reply(403, "<Error><Code>AccessDenied</Code></Error>"); // a locked object version cannot be replaced by the app role
      bucket.objects.set(key, { body, retainUntil: h["x-amz-object-lock-retain-until-date"] ?? "", mode: h["x-amz-object-lock-mode"] ?? "" });
      return reply(200, "");
    }
    if (method !== "GET") return reply(405, "<Error><Code>MethodNotAllowed</Code></Error>");
    if (u.searchParams.has("object-lock")) {
      if (!bucket.lock) return reply(404, "<Error><Code>ObjectLockConfigurationNotFoundError</Code></Error>");
      return reply(200, `<ObjectLockConfiguration><ObjectLockEnabled>${bucket.lock.enabled ? "Enabled" : ""}</ObjectLockEnabled><Rule><DefaultRetention><Mode>${bucket.lock.mode}</Mode><Days>${bucket.lock.days}</Days></DefaultRetention></Rule></ObjectLockConfiguration>`);
    }
    if (u.searchParams.get("list-type") === "2") {
      const prefix = u.searchParams.get("prefix") ?? "";
      const all = [...bucket.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(u.searchParams.get("continuation-token") ?? 0);
      const size = this.o.listPageSize ?? 1000;
      const page = all.slice(start, start + size);
      const more = start + size < all.length;
      return reply(200, `<ListBucketResult>${page.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + size}</NextContinuationToken>` : ""}</ListBucketResult>`);
    }
    const o = bucket.objects.get(key);
    return o ? reply(200, o.body) : reply(404, "<Error><Code>NoSuchKey</Code></Error>");
  }
}

/**
 * A complete production AWS in the fake: the app role (MAC + PII + bucket + CloudTrail), two vault roles each allowed only its
 * own KEK, a COMPLIANCE-locked bucket, a valid Vercel token, and the matching environment variables.
 */
export function fakeProductionAws(o: { audience?: string; now?: () => Date; listPageSize?: number } = {}) {
  const custom = o.audience ?? crypto.randomBytes(32).toString("base64url");
  const aws = new FakeAws({ audience: custom, now: o.now, listPageSize: o.listPageSize });
  const mac = aws.addKey(1, "HMAC_256"), pii = aws.addKey(2, "SYMMETRIC_DEFAULT"), vp = aws.addKey(3, "SYMMETRIC_DEFAULT"), vn = aws.addKey(4, "SYMMETRIC_DEFAULT");
  const app = aws.addRole("mosshatch-app", { allow: { [mac]: ["GenerateMac", "VerifyMac"], [pii]: ["GenerateDataKey", "Decrypt"] }, s3: true, cloudtrail: true });
  const vaultProd = aws.addRole("mosshatch-vault-prod", { allow: { [vp]: ["GenerateDataKey", "Decrypt"] } });
  const vaultNonprod = aws.addRole("mosshatch-vault-nonprod", { allow: { [vn]: ["GenerateDataKey", "Decrypt"] } });
  aws.addBucket("mosshatch-audit-anchor");
  const oidcToken = "eyJhbGciOiJSUzI1NiJ9.FAKE_VERCEL_OIDC_TOKEN_CANARY.sig";
  aws.validTokens.set(oidcToken, "https://vercel.com/nsheinbe-labs");
  const env = {
    MH_AWS_ROLE_ARN: app, MH_OIDC_AUDIENCE: custom, MH_KMS_MAC_KEY_ARN: mac, MH_KMS_PII_KEY_ARN: pii, MH_ANCHOR_BUCKET: "mosshatch-audit-anchor",
  } as Record<string, string>;
  const vaultEnv = { MH_KMS_VAULT_PROD_KEY_ARN: vp, MH_KMS_VAULT_NONPROD_KEY_ARN: vn, MH_AWS_VAULT_PROD_ROLE_ARN: vaultProd, MH_AWS_VAULT_NONPROD_ROLE_ARN: vaultNonprod };
  return { aws, env, vaultEnv, oidcToken, keys: { mac, pii, vaultProd: vp, vaultNonprod: vn }, roles: { app, vaultProd, vaultNonprod } };
}
