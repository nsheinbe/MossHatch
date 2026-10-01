import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { LocalVaultKms } from "./kms/local.ts";
import { aadBytes, kmsContext, open, seal, VaultIntegrityError, type SecretAad } from "./envelope.ts";
import { KmsError } from "./kms/types.ts";
import { normalizeSecretName } from "./names.ts";

const id = () => crypto.randomUUID();
const base = (): SecretAad => ({ kind: "secret", user_id: id(), domain_id: id(), secret_id: id(), name: "DATABASE_URL", env: "prod", version: 1, kek_class: "vault-prod" });

async function sealed(kms: LocalVaultKms, aad = base(), value = "postgres://user:pw@db/app") {
  const ctx = kmsContext(aad.env, aad.user_id, aad.secret_id);
  const s = await seal(kms, aad.kek_class, ctx, aad, Buffer.from(value));
  return { aad, ctx, s, value };
}
const row = (s: Awaited<ReturnType<typeof sealed>>["s"]) => ({ ciphertext: s.ciphertext, nonce: s.nonce, tag: s.tag, wrappedDek: s.wrappedDek, kekRef: s.kekRef });

describe("AAD canonicalisation (JCS)", () => {
  it("is the RFC 8785 form: keys sorted, strings quoted and escaped, no whitespace, independent of field order", () => {
    const a = base();
    const shuffled = Object.fromEntries(Object.entries(a).reverse()) as unknown as SecretAad;
    expect(aadBytes(a).equals(aadBytes(shuffled))).toBe(true);
    const text = aadBytes(a).toString("utf8");
    expect(text.startsWith('{"alg":"A256GCM","domain_id":')).toBe(true);
    expect(text).not.toMatch(/\s/);
    const keys = Object.keys(JSON.parse(text));
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual(["alg", "domain_id", "env", "format_version", "kek_class", "kind", "name", "secret_id", "user_id", "version"]);
  });
  it("is unambiguous: moving characters between adjacent fields changes the bytes (what length-prefixing buys)", () => {
    const a = { ...base(), name: "AB" };
    expect(aadBytes(a).equals(aadBytes({ ...a, name: "A" }))).toBe(false);
    // A quote or backslash cannot forge a field boundary: it is escaped.
    expect(() => aadBytes({ ...a, name: 'A","env":"dev' })).not.toThrow();
    expect(aadBytes({ ...a, name: 'A","env":"dev' }).toString()).toContain('\\"env\\"');
  });
  it("refuses malformed identity fields instead of encoding them (fail closed)", () => {
    expect(() => aadBytes({ ...base(), secret_id: "not-a-uuid" })).toThrow(VaultIntegrityError);
    expect(() => aadBytes({ ...base(), version: 0 })).toThrow(VaultIntegrityError);
    expect(() => aadBytes({ ...base(), env: "staging" as never })).toThrow(VaultIntegrityError);
  });
});

describe("ST-01: changing any one AAD field makes decrypt fail", () => {
  it("format and algorithm are bound (checked by the canonical prefix), and each row field fails on its own", async () => {
    const kms = new LocalVaultKms();
    const { aad, ctx, s, value } = await sealed(kms);
    expect((await open(kms, "vault-prod", ctx, aad, row(s))).toString()).toBe(value);
    const variants: [string, Partial<SecretAad>][] = [
      ["domain_id", { domain_id: id() }], ["secret_id", { secret_id: id() }], ["user_id", { user_id: id() }], ["name", { name: "DATABASE_URL2" }],
      ["env", { env: "preview", kek_class: "vault-prod" }], ["version", { version: 2 }], ["kek_class", { kek_class: "vault-nonprod" }], ["kind", { kind: "connection" as never }],
    ];
    for (const [field, change] of variants) {
      await expect(open(kms, "vault-prod", ctx, { ...aad, ...change } as SecretAad, row(s)), field).rejects.toBeInstanceOf(VaultIntegrityError);
    }
    // format_version and alg are constants of this code; a different constant is a different AAD (proved on the bytes).
    const bytes = aadBytes(aad).toString();
    expect(bytes).toContain('"format_version":1');
    expect(bytes).toContain('"alg":"A256GCM"');
  });
});

describe("ST-02: tampering fails closed", () => {
  it("a flipped ciphertext bit, a flipped nonce bit, a 4-byte tag, a flipped tag bit and a swapped wrapped key all fail", async () => {
    const kms = new LocalVaultKms();
    const a = await sealed(kms), b = await sealed(kms);
    const flip = (x: Buffer, i = 0) => { const y = Buffer.from(x); y[i] = y[i]! ^ 1; return y; };
    const cases: [string, ReturnType<typeof row>][] = [
      ["ciphertext", { ...row(a.s), ciphertext: flip(a.s.ciphertext) }],
      ["nonce", { ...row(a.s), nonce: flip(a.s.nonce, 11) }],
      ["tag truncated to 4 bytes", { ...row(a.s), tag: a.s.tag.subarray(0, 4) }],
      ["tag bit", { ...row(a.s), tag: flip(a.s.tag, 15) }],
      ["wrapped_dek swapped between rows", { ...row(a.s), wrappedDek: b.s.wrappedDek }],
      ["ciphertext moved from another row", { ...row(a.s), ciphertext: b.s.ciphertext, nonce: b.s.nonce, tag: b.s.tag }],
    ];
    for (const [name, r] of cases) await expect(open(kms, "vault-prod", a.ctx, a.aad, r), name).rejects.toBeInstanceOf(VaultIntegrityError);
  });
});

describe("nonce uniqueness and data-key hygiene", () => {
  it("every seal uses a fresh 96-bit nonce and a fresh data key, even for the same value and row", async () => {
    const kms = new LocalVaultKms();
    const aad = base();
    const nonces = new Set<string>(), wrapped = new Set<string>(), cts = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const { s } = await sealed(kms, aad, "same value");
      expect(s.nonce.length).toBe(12);
      expect(s.tag.length).toBe(16);
      nonces.add(s.nonce.toString("hex")); wrapped.add(s.wrappedDek.toString("hex")); cts.add(s.ciphertext.toString("hex"));
    }
    expect(nonces.size).toBe(300);
    expect(wrapped.size).toBe(300);
    expect(cts.size).toBe(300);
    expect(kms.calls.GenerateDataKey).toBe(300);
  });
  it("the plaintext data key returned by KMS is zeroed after use", async () => {
    const kms = new LocalVaultKms();
    let seen: Buffer | undefined;
    const orig = kms.generateDataKey.bind(kms);
    kms.generateDataKey = async (...a) => { const r = await orig(...a); seen = r.plaintext; return r; };
    await sealed(kms);
    expect(seen!.equals(Buffer.alloc(32))).toBe(true);
  });
  it("values over 16 KiB are refused before KMS is called", async () => {
    const kms = new LocalVaultKms();
    const aad = base();
    await expect(seal(kms, "vault-prod", kmsContext("prod", aad.user_id, aad.secret_id), aad, Buffer.alloc(16 * 1024 + 1, 97))).rejects.toThrow(RangeError);
    expect(kms.calls.GenerateDataKey).toBe(0);
  });
  it("a KMS outage surfaces as KmsError, not as an integrity failure", async () => {
    const kms = new LocalVaultKms();
    const a = await sealed(kms);
    kms.down = true;
    await expect(open(kms, "vault-prod", a.ctx, a.aad, row(a.s))).rejects.toBeInstanceOf(KmsError);
  });
});

describe("secret names", () => {
  it("normalises, then enforces the grammar, the scanner rules and the reserved list", () => {
    expect(normalizeSecretName(" database_url ")).toEqual({ ok: true, name: "DATABASE_URL" });
    expect(normalizeSecretName("ＡＰＩ_KEY")).toEqual({ ok: true, name: "API_KEY" }); // full-width letters fold under NFKC
    expect(normalizeSecretName("1ABC")).toMatchObject({ ok: false, reason: "grammar" });
    expect(normalizeSecretName("A-B")).toMatchObject({ ok: false, reason: "grammar" });
    expect(normalizeSecretName("A".repeat(129))).toMatchObject({ ok: false, reason: "length" });
    expect(normalizeSecretName("A".repeat(200))).toMatchObject({ ok: false, reason: "length" });
    expect(normalizeSecretName("sk_live_abc")).toMatchObject({ ok: false, reason: "scanner" });
    expect(normalizeSecretName("MH_TEST_CANARY_NAME")).toMatchObject({ ok: false, reason: "scanner" });
    for (const r of ["NODE_OPTIONS", "node_options", "PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "GIT_SSH_COMMAND", "SSL_CERT_FILE", "HTTPS_PROXY", "PYTHONSTARTUP"]) {
      expect(normalizeSecretName(r), r).toMatchObject({ ok: false, reason: "reserved" });
    }
  });
});
