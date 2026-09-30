import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { LocalVaultKms, ALL_KMS_ACTIONS } from "./kms/local.ts";
import { AwsVaultKms, signV4, type FetchLike } from "./kms/aws.ts";
import { trustAllows, vaultTrustPolicy, type OidcTrustConfig } from "./kms/trust.ts";
import { KmsError, VAULT_APP, type VaultEncryptionContext } from "./kms/types.ts";

/**
 * The KMS-side controls, proved against the local fake only. ST-06 to ST-09 and ST-11 name the staging account in the
 * plan; nothing here touched AWS, so these prove the policy model and the code paths, not IAM itself.
 */

const ctxFor = (env: "dev" | "preview" | "prod", owner = crypto.randomUUID(), secret = crypto.randomUUID()): VaultEncryptionContext => ({ app: VAULT_APP, env, owner_id: owner, secret_id: secret });
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof KmsError ? e.code : String(e); } };

describe("KMS fake behaves like AWS KMS where the vault depends on it", () => {
  it("a wrapped key decrypts only with the exact same encryption context", async () => {
    const kms = new LocalVaultKms();
    const k = kms.currentKek("vault-prod");
    const c = ctxFor("prod");
    const dk = await kms.generateDataKey("vault-prod", k, c);
    expect((await kms.decrypt("vault-prod", k, dk.ciphertextBlob, c)).equals(dk.plaintext)).toBe(true);
    expect(await code(kms.decrypt("vault-prod", k, dk.ciphertextBlob, { ...c, secret_id: crypto.randomUUID() }))).toBe("InvalidCiphertextException");
    expect(await code(kms.decrypt("vault-prod", k, dk.ciphertextBlob, { ...c, owner_id: crypto.randomUUID() }))).toBe("InvalidCiphertextException");
    expect(await code(kms.decrypt("vault-prod", kms.currentKek("vault-nonprod"), dk.ciphertextBlob, c))).toBe("IncorrectKeyException");
  });
  it("a disabled key fails, and enabling it again restores decrypt", async () => {
    const kms = new LocalVaultKms();
    const k = kms.currentKek("vault-prod"); const c = ctxFor("prod");
    const dk = await kms.generateDataKey("vault-prod", k, c);
    await kms.disableKey(k);
    expect(await code(kms.decrypt("vault-prod", k, dk.ciphertextBlob, c))).toBe("DisabledException");
    expect(await code(kms.generateDataKey("vault-prod", k, c))).toBe("DisabledException");
    await kms.enableKey(k);
    expect(await code(kms.decrypt("vault-prod", k, dk.ciphertextBlob, c))).toBe("ok");
  });
  it("every call lands in the trail with its encryption context, refused calls included", async () => {
    const kms = new LocalVaultKms();
    const c = ctxFor("dev");
    await kms.generateDataKey("vault-nonprod", kms.currentKek("vault-nonprod"), c);
    await code(kms.as("role/attacker").decrypt(kms.currentKek("vault-nonprod"), Buffer.alloc(77), c));
    const t = await kms.trail();
    expect(t.map((e) => [e.eventName, e.principal, e.errorCode])).toEqual([["GenerateDataKey", "role/vault-nonprod", null], ["Decrypt", "role/attacker", "InvalidCiphertextException"]]);
    expect(t[0]!.encryptionContext).toEqual(c);
  });
});

describe("ST-06: the key policy denies a wrong principal, a human SSO role and the web role's own Decrypt outside the vault role (fake)", () => {
  it("only the class's vault role decrypts; a human with kms:* in IAM is still denied by the key policy", async () => {
    const kms = new LocalVaultKms();
    const k = kms.currentKek("vault-prod"); const c = ctxFor("prod");
    const dk = await kms.generateDataKey("vault-prod", k, c);
    kms.setIdentityPolicy("sso/AdministratorAccess", [...ALL_KMS_ACTIONS]);
    kms.setIdentityPolicy("role/web", ["kms:Decrypt", "kms:GenerateDataKey"]);
    expect(await code(kms.as("sso/AdministratorAccess").decrypt(k, dk.ciphertextBlob, c))).toBe("AccessDeniedException");
    expect(await code(kms.as("role/web").decrypt(k, dk.ciphertextBlob, c))).toBe("AccessDeniedException");
    expect(await code(kms.as("role/someone-else").decrypt(k, dk.ciphertextBlob, c))).toBe("AccessDeniedException");
    expect(await code(kms.decrypt("vault-prod", k, dk.ciphertextBlob, c))).toBe("ok");
  });
  it("the vault role's use is pinned to its env values, the app and the exact context key set", async () => {
    const kms = new LocalVaultKms();
    const k = kms.currentKek("vault-prod");
    expect(await code(kms.generateDataKey("vault-prod", k, ctxFor("dev")))).toBe("AccessDeniedException");
    expect(await code(kms.generateDataKey("vault-prod", k, { ...ctxFor("prod"), app: "other" }))).toBe("AccessDeniedException");
    expect(await code(kms.generateDataKey("vault-prod", k, { ...ctxFor("prod"), extra: "x" } as never))).toBe("AccessDeniedException");
    const { secret_id: _s, ...missing } = ctxFor("prod");
    expect(await code(kms.generateDataKey("vault-prod", k, missing as never))).toBe("AccessDeniedException");
  });
});

describe("ST-07: only the pinned production token can assume the vault role (trust-policy evaluator)", () => {
  const cfg: OidcTrustConfig = { issuerHost: "oidc.vercel.com/mosshatch", team: "mosshatch", project: "web", environment: "production", audience: crypto.randomBytes(32).toString("base64url"), providerArn: "arn:aws:iam::111122223333:oidc-provider/oidc.vercel.com/mosshatch" };
  const policy = vaultTrustPolicy(cfg);
  const good = { iss: "https://oidc.vercel.com/mosshatch", aud: cfg.audience, sub: "owner:mosshatch:project:web:environment:production", durationSeconds: 900 };
  it("the production token with the custom audience is allowed", () => { expect(trustAllows(policy, cfg, good)).toBe(true); });
  it("a wrong audience, the default audience, a preview sub, another project's sub, another issuer or a long session are refused", () => {
    for (const [why, req] of [
      ["wrong audience", { ...good, aud: crypto.randomBytes(32).toString("base64url") }],
      ["default audience", { ...good, aud: "https://vercel.com/mosshatch" }],
      ["preview sub", { ...good, sub: "owner:mosshatch:project:web:environment:preview" }],
      ["other project", { ...good, sub: "owner:mosshatch:project:cards:environment:production" }],
      ["other team", { ...good, sub: "owner:mosshatch2:project:web:environment:production" }],
      ["other issuer", { ...good, iss: "https://oidc.vercel.com/someone" }],
      ["session over an hour", { ...good, durationSeconds: 7200 }],
    ] as const) expect(trustAllows(policy, cfg, req), why).toBe(false);
  });
  it("the policy refuses a weak audience at generation time", () => {
    expect(() => vaultTrustPolicy({ ...cfg, audience: "short" })).toThrow();
  });
});

describe("ST-08: the runtime roles are denied everything outside GenerateDataKey and Decrypt (fake)", () => {
  it("CreateGrant, PutKeyPolicy, ScheduleKeyDeletion, DisableKey, Encrypt and ReEncrypt are AccessDenied for both runtime roles", async () => {
    const kms = new LocalVaultKms();
    for (const role of ["role/vault-prod", "role/vault-nonprod"]) {
      for (const cls of ["vault-prod", "vault-nonprod"] as const) {
        for (const a of ["kms:CreateGrant", "kms:PutKeyPolicy", "kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:Encrypt", "kms:ReEncryptFrom", "kms:ReEncryptTo"] as const) {
          expect(await code(kms.as(role).other(a, kms.currentKek(cls))), `${role} ${a}`).toBe("AccessDeniedException");
        }
      }
    }
    // The operator re-wraps but cannot Decrypt.
    const k = kms.currentKek("vault-prod"); const c = ctxFor("prod");
    const dk = await kms.generateDataKey("vault-prod", k, c);
    expect(await code(kms.decrypt("operator", k, dk.ciphertextBlob, c))).toBe("AccessDeniedException");
  });
});

describe("ST-09: a prod wrapped key sent to vault-nonprod is AccessDenied (fake)", () => {
  it("the nonprod role cannot decrypt a prod key or generate under the prod KEK, and vice versa", async () => {
    const kms = new LocalVaultKms();
    const kp = kms.currentKek("vault-prod"), kn = kms.currentKek("vault-nonprod");
    const cp = ctxFor("prod"), cd = ctxFor("dev");
    const prod = await kms.generateDataKey("vault-prod", kp, cp);
    const dev = await kms.generateDataKey("vault-nonprod", kn, cd);
    expect(await code(kms.decrypt("vault-nonprod", kp, prod.ciphertextBlob, cp))).toBe("AccessDeniedException");
    expect(await code(kms.decrypt("vault-prod", kn, dev.ciphertextBlob, cd))).toBe("AccessDeniedException");
    expect(await code(kms.generateDataKey("vault-nonprod", kp, cp))).toBe("AccessDeniedException");
    // Relabelling the context to dev does not help: the context no longer matches the blob.
    expect(await code(kms.decrypt("vault-nonprod", kp, prod.ciphertextBlob, { ...cp, env: "dev" }))).toBe("AccessDeniedException");
  });
});

describe("ST-11: the auto-deny blocks Decrypt for an existing session and is removable (fake)", () => {
  it("an explicit role Deny stops Decrypt at once and lifting it restores service", async () => {
    const kms = new LocalVaultKms();
    const k = kms.currentKek("vault-prod"); const c = ctxFor("prod");
    const dk = await kms.generateDataKey("vault-prod", k, c);
    await kms.attachRoleDeny("vault-prod");
    expect(await code(kms.decrypt("vault-prod", k, dk.ciphertextBlob, c))).toBe("AccessDeniedException");
    expect(await code(kms.generateDataKey("vault-prod", k, c))).toBe("AccessDeniedException");
    await kms.removeRoleDeny("vault-prod");
    expect(await code(kms.decrypt("vault-prod", k, dk.ciphertextBlob, c))).toBe("ok");
  });
  it("a per-owner key-policy Deny blocks one tenant without an outage", async () => {
    const kms = new LocalVaultKms();
    const k = kms.currentKek("vault-prod");
    const a = ctxFor("prod"), b = ctxFor("prod");
    const da = await kms.generateDataKey("vault-prod", k, a), db = await kms.generateDataKey("vault-prod", k, b);
    await kms.denyOwner(k, a.owner_id);
    expect(await code(kms.decrypt("vault-prod", k, da.ciphertextBlob, a))).toBe("AccessDeniedException");
    expect(await code(kms.decrypt("vault-prod", k, db.ciphertextBlob, b))).toBe("ok");
  });
});

describe("ReEncrypt", () => {
  it("moves a wrapped key to another KEK of the class without exposing it; needs ReEncryptFrom and ReEncryptTo", async () => {
    const kms = new LocalVaultKms();
    const old = kms.currentKek("vault-prod"); const c = ctxFor("prod");
    const dk = await kms.generateDataKey("vault-prod", old, c);
    const fresh = await kms.createKey("vault-prod");
    const r = await kms.reEncrypt("operator", { ciphertextBlob: dk.ciphertextBlob, sourceKeyId: old, sourceContext: c, destinationKeyId: fresh, destinationContext: c });
    expect(r.keyId).toBe(fresh);
    expect((await kms.decrypt("vault-prod", fresh, r.ciphertextBlob, c)).equals(dk.plaintext)).toBe(true);
    expect(await code(kms.reEncrypt("vault-prod", { ciphertextBlob: dk.ciphertextBlob, sourceKeyId: old, sourceContext: c, destinationKeyId: fresh, destinationContext: c }))).toBe("AccessDeniedException");
    await kms.disableKey(old);
    expect(await code(kms.reEncrypt("operator", { ciphertextBlob: dk.ciphertextBlob, sourceKeyId: old, sourceContext: c, destinationKeyId: fresh, destinationContext: c }))).toBe("DisabledException");
  });
});

describe("AWS adapter (never calls AWS)", () => {
  it("the SigV4 signer reproduces the AWS test-suite vector get-vanilla", () => {
    const s = signV4({
      method: "GET", host: "example.amazonaws.com", path: "/", headers: {}, body: "", region: "us-east-1", service: "service", amzDate: "20150830T123600Z",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    });
    expect(s.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });

  const recorder = (reply: (target: string, body: any) => { status: number; body: unknown }) => {
    const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
    const fetch: FetchLike = async (url, init) => { const b = JSON.parse(init.body); seen.push({ url, headers: init.headers, body: b }); const r = reply(init.headers["x-amz-target"]!, b); return { status: r.status, text: async () => JSON.stringify(r.body) }; };
    return { seen, fetch };
  };
  const keks = { "vault-prod": "arn:aws:kms:us-east-1:111122223333:key/prod", "vault-nonprod": "arn:aws:kms:us-east-1:111122223333:key/nonprod" };

  it("sends documented request shapes to the pinned region, signed per role, KeyId always set", async () => {
    const r = recorder((t, b) => t.endsWith("GenerateDataKey") ? { status: 200, body: { KeyId: b.KeyId, Plaintext: Buffer.alloc(32, 1).toString("base64"), CiphertextBlob: "YmxvYg==" } } : { status: 200, body: { KeyId: b.KeyId, Plaintext: Buffer.alloc(32, 1).toString("base64") } });
    const roles: string[] = [];
    const kms = new AwsVaultKms({ region: "us-east-1", keks, fetch: r.fetch, credentials: async (role) => { roles.push(role); return { accessKeyId: "ASIAEXAMPLE", secretAccessKey: "x", sessionToken: "session" }; } });
    const c = ctxFor("prod");
    await kms.generateDataKey("vault-prod", keks["vault-prod"], c);
    await kms.decrypt("vault-prod", keks["vault-prod"], Buffer.from("blob"), c);
    expect(r.seen.map((s) => s.url)).toEqual(["https://kms.us-east-1.amazonaws.com/", "https://kms.us-east-1.amazonaws.com/"]);
    expect(r.seen[0]!.headers["x-amz-target"]).toBe("TrentService.GenerateDataKey");
    expect(r.seen[0]!.body).toEqual({ KeyId: keks["vault-prod"], KeySpec: "AES_256", EncryptionContext: c });
    expect(r.seen[1]!.body).toEqual({ KeyId: keks["vault-prod"], CiphertextBlob: Buffer.from("blob").toString("base64"), EncryptionContext: c });
    expect(r.seen[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/\d{8}\/us-east-1\/kms\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/);
    expect(roles).toEqual(["vault-prod", "vault-prod"]);
  });
  it("maps KMS error types, refuses a Decrypt answered by another key, and times out without retrying", async () => {
    const c = ctxFor("prod");
    const denied = new AwsVaultKms({ region: "us-east-1", keks, credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), fetch: recorder(() => ({ status: 400, body: { __type: "com.amazonaws.kms#AccessDeniedException", message: "not for you" } })).fetch });
    expect(await code(denied.decrypt("vault-prod", keks["vault-prod"], Buffer.from("x"), c))).toBe("AccessDeniedException");
    const other = new AwsVaultKms({ region: "us-east-1", keks, credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), fetch: recorder(() => ({ status: 200, body: { KeyId: "arn:other", Plaintext: "AA==" } })).fetch });
    expect(await code(other.decrypt("vault-prod", keks["vault-prod"], Buffer.from("x"), c))).toBe("IncorrectKeyException");
    let calls = 0;
    const slow = new AwsVaultKms({ region: "us-east-1", keks, timeoutMs: 50, credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }),
      fetch: (_u, init) => { calls++; return new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("t"), { name: "TimeoutError" })))); } });
    expect(await code(slow.decrypt("vault-prod", keks["vault-prod"], Buffer.from("x"), c))).toBe("Timeout");
    expect(calls).toBe(1);
    expect(() => new AwsVaultKms({ region: "", keks, credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), fetch: recorder(() => ({ status: 200, body: {} })).fetch })).toThrow();
  });
});
