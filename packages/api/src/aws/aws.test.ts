import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AwsAuthError, runWithOidcToken, vercelOidcTokenSource, webIdentityCredentials } from "./oidc.ts";
import { AwsKms, AwsPii, piiContext } from "./kms.ts";
import { AwsS3, S3Error } from "./s3.ts";
import { buildProductionAws, probeProductionAws, productionAwsFromEnv } from "./production.ts";
import { fakeProductionAws, FakeAws } from "./testkit.ts";
import { KmsError, type VaultEncryptionContext } from "../vault/kms/types.ts";
import { S3ObjectLockAnchorSink } from "../ops/anchor.ts";
import { S3ObjectLockErasureLedger, erasureHash } from "../ops/erasure.ts";
import { LocalPii } from "../kms.ts";
import { VaultKeyDecrypts, UnwiredCloudTrail, type CloudTrailPort } from "../ops/kms-reconcile.ts";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as { code?: string }).code ?? (e as Error).message);
const env0 = { VERCEL_DEPLOYMENT_ID: "dpl_test" };

function setup(o: Parameters<typeof fakeProductionAws>[0] = {}) {
  const f = fakeProductionAws(o);
  const cfg = productionAwsFromEnv({ ...f.env, ...f.vaultEnv, DATABASE_URL_VAULT: "postgres://vault@db/x" });
  expect(cfg.reasons).toEqual([]);
  const adapters = buildProductionAws(cfg.config!, env0, { fetch: f.aws.fetch, tokenSource: () => f.oidcToken });
  return { ...f, cfg: cfg.config!, adapters };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("Vercel OIDC to AWS credentials (fake STS)", () => {
  it("exchanges for the custom audience, then AssumeRoleWithWebIdentity in us-east-1 for 900 seconds, cached across calls", async () => {
    const f = fakeProductionAws();
    const creds = webIdentityCredentials({ roleArn: f.roles.app, region: "us-east-1", sessionName: "mh-dpl_1", audience: f.env.MH_OIDC_AUDIENCE, tokenSource: () => f.oidcToken, fetch: f.aws.fetch });
    const a = await creds(); const b = await creds();
    expect(a.accessKeyId).toMatch(/^ASIA/);
    expect(b).toEqual(a);
    const sts = f.aws.requests.filter((r) => r.url.startsWith("https://sts.us-east-1.amazonaws.com/"));
    expect(sts).toHaveLength(1);
    const form = new URLSearchParams(sts[0]!.body);
    expect(form.get("DurationSeconds")).toBe("900");
    expect(form.get("RoleArn")).toBe(f.roles.app);
    expect(form.get("RoleSessionName")).toBe("mh-dpl_1");
    // The original token went only to the exchange; STS received the exchanged token.
    expect(form.get("WebIdentityToken")).toMatch(/^exchanged\./);
    expect(f.aws.requests.filter((r) => r.body.includes(f.oidcToken)).map((r) => new URL(r.url).host)).toEqual(["oidc.vercel.com"]);
  });
  it("refreshes a minute before the session expires", async () => {
    let now = new Date("2026-10-01T00:00:00Z");
    const f = fakeProductionAws({ now: () => now });
    const creds = webIdentityCredentials({ roleArn: f.roles.app, region: "us-east-1", sessionName: "s", audience: f.env.MH_OIDC_AUDIENCE, tokenSource: () => f.oidcToken, fetch: f.aws.fetch, clock: { now: () => now } });
    const a = await creds();
    now = new Date(now.getTime() + 13 * 60_000); expect((await creds()).accessKeyId).toBe(a.accessKeyId);
    now = new Date(now.getTime() + 2 * 60_000); expect((await creds()).accessKeyId).not.toBe(a.accessKeyId);
    expect(f.aws.stsDurations).toEqual([900, 900]);
  });
  it("without the custom audience the default Vercel token goes straight to STS", async () => {
    const aws = new FakeAws({ audience: "https://vercel.com/nsheinbe-labs" });
    const role = aws.addRole("r", { allow: {} });
    aws.validTokens.set("tok", "https://vercel.com/nsheinbe-labs");
    await webIdentityCredentials({ roleArn: role, region: "us-east-1", sessionName: "s", tokenSource: () => "tok", fetch: aws.fetch })();
    expect(aws.requests.map((r) => new URL(r.url).host)).toEqual(["sts.us-east-1.amazonaws.com"]);
  });
  it("fails with codes only, and the token never reaches a log, an error or another host", async () => {
    const f = fakeProductionAws();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const mk = (o: Partial<Parameters<typeof webIdentityCredentials>[0]>) => webIdentityCredentials({ roleArn: f.roles.app, region: "us-east-1", sessionName: "s", audience: f.env.MH_OIDC_AUDIENCE, tokenSource: () => f.oidcToken, fetch: f.aws.fetch, ...o });
    const errs: unknown[] = [];
    const run = async (p: () => Promise<unknown>) => { try { await p(); } catch (e) { errs.push(e); } };
    await run(mk({ tokenSource: () => null }));
    f.aws.stsDeny = true; await run(mk({}));
    f.aws.stsDeny = false; await run(mk({ audience: crypto.randomBytes(32).toString("base64url") }));  // trust policy expects another aud
    f.aws.exchangeFails = true; await run(mk({}));
    f.aws.exchangeFails = false; await run(mk({ audience: undefined, tokenSource: () => "not-a-valid-token" }));
    expect(errs.map((e) => (e as AwsAuthError).code)).toEqual(["oidc_token_missing", "sts:AccessDenied", "sts:AccessDenied", "oidc_audience_exchange_failed", "sts:InvalidIdentityToken"]);
    for (const e of errs) {
      expect(e).toBeInstanceOf(AwsAuthError);
      expect(JSON.stringify({ m: (e as Error).message, s: (e as Error).stack })).not.toContain(f.oidcToken);
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(f.aws.requests.filter((r) => JSON.stringify(r).includes(f.oidcToken)).every((r) => new URL(r.url).host === "oidc.vercel.com")).toBe(true);
  });
  it("refuses an unpinned Region, a malformed role ARN and a session longer than an hour", () => {
    const base = { roleArn: "arn:aws:iam::111122223333:role/x", region: "us-east-1", sessionName: "s", tokenSource: () => "t", fetch: new FakeAws().fetch };
    expect(() => webIdentityCredentials({ ...base, region: "" })).toThrow();
    expect(() => webIdentityCredentials({ ...base, roleArn: "role/x" })).toThrow(AwsAuthError);
    expect(() => webIdentityCredentials({ ...base, durationSeconds: 7200 })).toThrow(AwsAuthError);
  });
  it("the token source reads the request scope, then Vercel's request context, then VERCEL_OIDC_TOKEN", () => {
    const src = vercelOidcTokenSource({ VERCEL_OIDC_TOKEN: "from-env" });
    expect(src()).toBe("from-env");
    const sym = Symbol.for("@vercel/request-context");
    (globalThis as Record<symbol, unknown>)[sym] = { get: () => ({ headers: { "x-vercel-oidc-token": "from-context" } }) };
    try {
      expect(src()).toBe("from-context");
      expect(runWithOidcToken("from-header", () => src())).toBe("from-header");
      expect(runWithOidcToken(null, () => src())).toBe("from-context");
    } finally { delete (globalThis as Record<symbol, unknown>)[sym]; }
    expect(vercelOidcTokenSource({})()).toBeNull();
  });
});

describe("AWS KMS for ctx.kms (HMAC) and ctx.pii (envelope)", () => {
  it("GenerateMac: 32 bytes, deterministic, separated by purpose, verified by VerifyMac, any input length", async () => {
    const { adapters, keys, aws } = setup();
    const k = adapters.kms;
    expect(k.mode).toBe("aws");
    const a = await k.hmac("audit", Buffer.from("row"));
    expect(a).toHaveLength(32);
    expect((await k.hmac("audit", Buffer.from("row"))).equals(a)).toBe(true);
    expect((await k.hmac("pointer", Buffer.from("row"))).equals(a)).toBe(false);
    expect(await k.verify("audit", Buffer.from("row"), a)).toBe(true);
    expect(await k.verify("pointer", Buffer.from("row"), a)).toBe(false);
    expect(await k.verify("audit", Buffer.from("rov"), a)).toBe(false);
    expect(await k.hmac("audit", crypto.randomBytes(64 * 1024))).toHaveLength(32);   // pre-hashed: inside KMS's 4,096-byte message limit
    const macCalls = aws.requests.filter((r) => r.headers["x-amz-target"] === "TrentService.GenerateMac").map((r) => JSON.parse(r.body));
    expect(macCalls.every((b) => b.KeyId === keys.mac && b.MacAlgorithm === "HMAC_SHA_256")).toBe(true);
  });
  it("PII: GenerateDataKey + local AES-GCM; the context binds the AAD (as a hash), so another AAD is refused by KMS", async () => {
    const { adapters, keys, aws } = setup();
    const env = await adapters.pii.encrypt("Ada Lovelace", "registrant:u1:name");
    expect(env).toMatchObject({ v: 1, alg: "A256GCM", kek: keys.pii });
    expect(env.wk).toBeTruthy();
    expect(await adapters.pii.decrypt(env, "registrant:u1:name")).toBe("Ada Lovelace");
    expect(await code(adapters.pii.decrypt(env, "registrant:u2:name"))).toBe("InvalidCiphertextException");
    // CloudTrail sees the context: opaque, no AAD and no plaintext.
    const logged = JSON.stringify(aws.trail);
    expect(logged).not.toContain("registrant:u1");
    expect(logged).not.toContain("Ada");
    expect(aws.trail.find((e) => e.eventName === "GenerateDataKey")!.context).toEqual(piiContext("registrant:u1:name"));
  });
  it("PII: refuses a local envelope, an envelope naming another key, and tampered ciphertext", async () => {
    const { adapters } = setup();
    const local = await new LocalPii().encrypt("x", "a");
    expect(await code(adapters.pii.decrypt(local, "a"))).toBe("IncorrectKeyException");
    const env = await adapters.pii.encrypt("secret", "a");
    expect(await code(adapters.pii.decrypt({ ...env, kek: "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000" }, "a"))).toBe("IncorrectKeyException");
    const ct = Buffer.from(env.ct, "base64"); ct[0]! ^= 1;
    await expect(adapters.pii.decrypt({ ...env, ct: ct.toString("base64") }, "a")).rejects.toThrow();
  });
  it("AccessDenied from a key policy or role surfaces as KmsError(AccessDeniedException); a disabled key as DisabledException", async () => {
    const f = fakeProductionAws();
    const opts = { region: "us-east-1", credentials: webIdentityCredentials({ roleArn: f.roles.vaultProd, region: "us-east-1", sessionName: "s", audience: f.env.MH_OIDC_AUDIENCE, tokenSource: () => f.oidcToken, fetch: f.aws.fetch }), fetch: f.aws.fetch };
    const kms = new AwsKms({ ...opts, macKeyArn: f.keys.mac });          // the vault role has no right to the MAC key
    const e = await kms.hmac("audit", Buffer.from("x")).catch((x) => x);
    expect(e).toBeInstanceOf(KmsError); expect(e.code).toBe("AccessDeniedException");
    const { adapters, aws, keys } = setup();
    aws.keys.get(keys.pii)!.enabled = false;
    expect(await code(adapters.pii.encrypt("x", "a"))).toBe("DisabledException");
  });
  it("the fake checks every SigV4 signature: a body altered after signing is refused", async () => {
    const { aws, adapters, keys } = setup();
    await adapters.kms.hmac("audit", Buffer.from("warm"));      // a session exists
    const [id, sess] = [...aws.sessions.entries()][0]!;
    const creds = async () => ({ accessKeyId: id, secretAccessKey: sess.secret, sessionToken: sess.token });
    const honest = new AwsKms({ region: "us-east-1", fetch: aws.fetch, credentials: creds, macKeyArn: keys.mac });
    expect(await honest.hmac("audit", Buffer.from("x"))).toHaveLength(32);
    // Same request with the message swapped after signing: a valid KMS call in every other respect.
    const tampered = new AwsKms({ region: "us-east-1", credentials: creds, macKeyArn: keys.mac,
      fetch: (u, i) => aws.fetch(u, { ...i, body: i.body?.replace(/"Message":"[^"]+"/, `"Message":"${Buffer.from("other").toString("base64")}"`) }) });
    expect(await code(tampered.hmac("audit", Buffer.from("x")))).toBe("AccessDeniedException");
  });
  it("refuses key aliases and keys outside the pinned Region", () => {
    const f = fakeProductionAws();
    const base = { region: "us-east-1", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), fetch: f.aws.fetch };
    expect(() => new AwsKms({ ...base, macKeyArn: "arn:aws:kms:us-east-1:111122223333:alias/mosshatch-mac" })).toThrow();
    expect(() => new AwsPii({ ...base, piiKeyArn: f.keys.pii.replace("us-east-1", "us-west-2") })).toThrow();
  });
});

describe("vault KEKs through the vault roles", () => {
  const ctx = (env: "prod" | "dev"): VaultEncryptionContext => ({ app: "mosshatch-nest", env, owner_id: "u1", secret_id: "s1" });
  it("each class uses its own role and key; a prod wrapped key sent to vault-nonprod is AccessDenied (ST-09 shape); operator is never available", async () => {
    const { adapters, keys } = setup();
    const v = adapters.vaultKms!;
    const dk = await v.generateDataKey("vault-prod", v.currentKek("vault-prod"), ctx("prod"));
    expect(dk.keyId).toBe(keys.vaultProd);
    expect((await v.decrypt("vault-prod", keys.vaultProd, dk.ciphertextBlob, ctx("prod"))).equals(dk.plaintext)).toBe(true);
    expect(await code(v.decrypt("vault-nonprod", keys.vaultProd, dk.ciphertextBlob, ctx("prod")))).toBe("AccessDeniedException");
    expect(await code(v.decrypt("vault-prod", keys.vaultProd, dk.ciphertextBlob, ctx("dev")))).toBe("InvalidCiphertextException");
    expect(await code(v.decrypt("operator", keys.vaultProd, dk.ciphertextBlob, ctx("prod")))).toBe("AccessDeniedException");
  });
  it("CloudTrail reconcile sees vault-key Decrypts only (PII Decrypts write no reveal row)", async () => {
    const { adapters, keys } = setup();
    const v = adapters.vaultKms!;
    const dk = await v.generateDataKey("vault-prod", keys.vaultProd, ctx("prod"));
    await v.decrypt("vault-prod", keys.vaultProd, dk.ciphertextBlob, ctx("prod"));
    await adapters.pii.decrypt(await adapters.pii.encrypt("x", "a"), "a");
    const events = await adapters.cloudTrail.listDecryptEvents(new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ keyId: keys.vaultProd, encryptionContext: ctx("prod") });
    const inner: CloudTrailPort = { listDecryptEvents: async () => [{ eventId: "1", at: new Date(), keyId: "11111111-2222-3333-4444-555555555555" }, { eventId: "2", at: new Date(), keyId: "arn:aws:kms:us-east-1:1:key/other" }] };
    expect((await new VaultKeyDecrypts(inner, ["arn:aws:kms:us-east-1:1:key/11111111-2222-3333-4444-555555555555"]).listDecryptEvents(new Date(), new Date())).map((e) => e.eventId)).toEqual(["1"]);
  });
  it("without the vault there is no CloudTrail to join: an unwired port that never reports success", async () => {
    const f = fakeProductionAws();
    const cfg = productionAwsFromEnv(f.env).config!;
    const a = buildProductionAws(cfg, env0, { fetch: f.aws.fetch, tokenSource: () => f.oidcToken });
    expect(a.vaultKms).toBeNull();
    expect(a.cloudTrail).toBeInstanceOf(UnwiredCloudTrail);
    await expect(a.cloudTrail.listDecryptEvents(new Date(), new Date())).rejects.toThrow("kms_reconcile_not_configured");
  });
});

describe("write-once anchor bucket (fake S3 with Object Lock)", () => {
  const rec = (id: string, at: string) => ({ v: 1 as const, id, anchoredAt: at, heads: [{ chain_id: "c", seq: 1, head_mac: "ab" }], anchorMac: "00" });
  it("puts with If-None-Match, Content-MD5 and a COMPLIANCE retention date; a second put of the same anchor is refused", async () => {
    const now = new Date("2026-10-01T00:00:00Z");
    const f = fakeProductionAws({ now: () => now, listPageSize: 2 });
    const cfg = productionAwsFromEnv({ ...f.env, MH_ANCHOR_RETAIN_DAYS: "400" }).config!;
    const a = buildProductionAws(cfg, env0, { fetch: f.aws.fetch, tokenSource: () => f.oidcToken, clock: { now: () => now } });
    const r1 = rec("a1", "2026-10-01T00:00:00.000Z");
    const { ref } = await a.anchorSink.put(r1);
    expect(ref).toBe("s3://mosshatch-audit-anchor/anchors/2026-10-01T00-00-00-000Z_a1.json");
    const obj = f.aws.buckets.get("mosshatch-audit-anchor")!.objects.get("anchors/2026-10-01T00-00-00-000Z_a1.json")!;
    expect(obj.mode).toBe("COMPLIANCE");
    expect(obj.retainUntil).toBe("2027-11-05T00:00:00.000Z");
    await expect(a.anchorSink.put(r1)).rejects.toThrow("anchor_exists");
    expect(JSON.parse(obj.body)).toEqual(r1);   // unchanged
    const put = f.aws.requests.find((r) => r.method === "PUT")!;
    expect(put.headers["if-none-match"]).toBe("*");
    expect(put.headers.authorization).toMatch(/SignedHeaders=content-md5;content-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-object-lock-mode;x-amz-object-lock-retain-until-date;x-amz-security-token,/);
  });
  it("lists across pages, oldest first, and fetches only the newest N when asked", async () => {
    const f = fakeProductionAws({ listPageSize: 2 });
    const a = buildProductionAws(productionAwsFromEnv(f.env).config!, env0, { fetch: f.aws.fetch, tokenSource: () => f.oidcToken });
    for (let d = 1; d <= 5; d++) await a.anchorSink.put(rec("a" + d, `2026-10-0${d}T00:00:00.000Z`));
    expect((await a.anchorSink.list()).map((x) => x.id)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    const before = f.aws.requests.length;
    expect((await a.anchorSink.list({ last: 2 })).map((x) => x.id)).toEqual(["a4", "a5"]);
    expect(f.aws.requests.slice(before).filter((r) => !r.url.includes("list-type")).length).toBe(2);
  });
  it("the erasure ledger is write-once and idempotent", async () => {
    const f = fakeProductionAws();
    const a = buildProductionAws(productionAwsFromEnv(f.env).config!, env0, { fetch: f.aws.fetch, tokenSource: () => f.oidcToken });
    const e = { userHash: erasureHash("u1"), erasedAt: "2026-10-01T00:00:00.000Z" };
    await a.erasureLedger.append(e); await a.erasureLedger.append(e);
    expect(await a.erasureLedger.list()).toEqual([e]);
    await expect(new S3ObjectLockErasureLedger(a.s3, "mosshatch-audit-anchor").append({ userHash: "u1", erasedAt: "x" })).rejects.toThrow("erasure_entry_invalid");
  });
  it("S3 errors carry the S3 code only; a role without bucket rights gets AccessDenied", async () => {
    const f = fakeProductionAws();
    const s3 = new AwsS3({ region: "us-east-1", fetch: f.aws.fetch, credentials: webIdentityCredentials({ roleArn: f.roles.vaultProd, region: "us-east-1", sessionName: "s", audience: f.env.MH_OIDC_AUDIENCE, tokenSource: () => f.oidcToken, fetch: f.aws.fetch }) });
    const e = await new S3ObjectLockAnchorSink(s3, "mosshatch-audit-anchor").put(rec("x", "2026-10-01T00:00:00.000Z")).catch((x) => x);
    expect(e).toBeInstanceOf(S3Error); expect(e.code).toBe("AccessDenied");
    expect(await code(s3.getObject({ Bucket: "Bad.Name", Key: "k" }))).toBe("InvalidBucketName");
  });
});

describe("production configuration and the live probe", () => {
  it("names each missing piece by code", () => {
    const f = fakeProductionAws();
    expect(productionAwsFromEnv({}).reasons).toEqual(["aws_oidc_not_configured", "kms_not_configured", "anchor_not_configured"]);
    expect(productionAwsFromEnv({ ...f.env, MH_AWS_REGION: "us-west-2" }).reasons).toEqual(["aws_region_not_pinned"]);
    expect(productionAwsFromEnv({ ...f.env, MH_OIDC_AUDIENCE: "short" }).reasons).toEqual(["aws_oidc_not_configured"]);
    expect(productionAwsFromEnv({ ...f.env, MH_KMS_PII_KEY_ARN: f.env.MH_KMS_MAC_KEY_ARN }).reasons).toEqual(["kms_not_configured"]);
    expect(productionAwsFromEnv({ ...f.env, MH_ANCHOR_BUCKET: "has.dots" }).reasons).toEqual(["anchor_not_configured"]);
    expect(productionAwsFromEnv({ ...f.env, MH_KMS_VAULT_PROD_KEY_ARN: f.keys.vaultProd }).reasons).toEqual(["vault_not_configured"]);
    expect(productionAwsFromEnv(f.env)).toMatchObject({ reasons: [], config: { region: "us-east-1", vault: null, retainDays: 3650 } });
  });
  it("probes STS, KMS and the bucket's Object Lock live, and reports what failed", async () => {
    const ok = setup();
    expect(await probeProductionAws(ok.adapters, ok.cfg)).toEqual([]);
    const gov = setup(); gov.aws.buckets.get("mosshatch-audit-anchor")!.lock = { enabled: true, mode: "GOVERNANCE", days: 35 };
    expect(await probeProductionAws(gov.adapters, gov.cfg)).toEqual(["anchor_bucket_not_compliance_locked"]);
    const denied = setup(); denied.aws.stsDeny = true;
    expect(await probeProductionAws(denied.adapters, denied.cfg)).toEqual(["aws_oidc_failed:sts:AccessDenied"]);
    const noMac = setup(); noMac.aws.roles.get(noMac.roles.app)!.allow[noMac.keys.mac] = [];
    expect(await probeProductionAws(noMac.adapters, noMac.cfg)).toEqual(["kms_probe_failed:AccessDeniedException"]);
    const noBucket = setup(); noBucket.aws.buckets.clear();
    expect(await probeProductionAws(noBucket.adapters, noBucket.cfg)).toEqual(["anchor_probe_failed:NoSuchBucket"]);
  });
});
