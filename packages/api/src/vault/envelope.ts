import crypto from "node:crypto";
import { canonicalJson } from "../util/bytes.ts";
import { KmsError, VAULT_APP, type SecretEnv, type VaultEncryptionContext, type VaultKekClass, type VaultKmsPort, type VaultRole } from "./kms/types.ts";

/**
 * Envelope encryption for vault values (PLAN 4.3b Secrets). One fresh data key per value from `GenerateDataKey`
 * (AES_256), AES-256-GCM locally with a fresh random 96-bit nonce and a 16-byte tag enforced on both sides, and AAD
 * that binds the ciphertext to its row. The AAD is the RFC 8785 (JCS) canonical JSON of the row identity:
 * `{alg, domain_id, env, format_version, kek_class, kind, name, secret_id, user_id, version}` for a secret, and
 * `{alg, connection_id, credential_id, domain_id, env, format_version, kek_class, kind, service, user_id, version}` for a
 * stored provider credential. JCS is unambiguous the way a length-prefixed concatenation is (every string is quoted and
 * escaped, keys are sorted), and it is the same canonical form the step-up challenge uses.
 *
 * The AAD carries the KEK class, never the KEK ARN, so `ReEncrypt` onto a new KEK of the same class (rotation or the
 * compromise drill) keeps every ciphertext valid, while a row moved between classes fails. The AAD is recomputed from the
 * row at decrypt and never stored. The plaintext data key is zeroed after use and nothing is cached.
 */

export const FORMAT_VERSION = 1;
export const ALG = "A256GCM";
export const MAX_VALUE_BYTES = 16 * 1024;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

export interface SecretAad {
  kind: "secret";
  user_id: string;
  domain_id: string;
  secret_id: string;
  name: string;
  env: SecretEnv;
  version: number;
  kek_class: VaultKekClass;
}
export interface ConnectionAad {
  kind: "connection";
  user_id: string;
  domain_id: string;
  connection_id: string;
  credential_id: string;
  service: string;
  env: SecretEnv;
  version: 1;
  kek_class: VaultKekClass;
}
export type AadFields = SecretAad | ConnectionAad;

/** A decrypt that failed authentication: tampered ciphertext, nonce or tag, a swapped row, or a wrong AAD field. */
export class VaultIntegrityError extends Error {
  override name = "VaultIntegrityError";
  constructor() { super("vault_integrity"); }
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The canonical AAD bytes. Refuses malformed fields rather than encoding them (fail closed). */
export function aadBytes(f: AadFields): Buffer {
  const ids = f.kind === "secret" ? [f.user_id, f.domain_id, f.secret_id] : [f.user_id, f.domain_id, f.connection_id, f.credential_id];
  if (!ids.every((x) => typeof x === "string" && ID.test(x))) throw new VaultIntegrityError();
  if (!Number.isInteger(f.version) || f.version < 1) throw new VaultIntegrityError();
  if (!["dev", "preview", "prod"].includes(f.env) || !["vault-prod", "vault-nonprod"].includes(f.kek_class)) throw new VaultIntegrityError();
  return Buffer.from(canonicalJson({ format_version: FORMAT_VERSION, alg: ALG, ...f }), "utf8");
}

/** Encryption context sent to KMS: opaque ids only, because CloudTrail logs it in plaintext. */
export function kmsContext(env: SecretEnv, ownerId: string, recordId: string): VaultEncryptionContext {
  return { app: VAULT_APP, env, owner_id: ownerId, secret_id: recordId };
}

export interface Sealed { ciphertext: Buffer; nonce: Buffer; tag: Buffer; wrappedDek: Buffer; kekRef: string; kekClass: VaultKekClass }

/** Resolve or reject within `ms`; a KMS call never holds a request longer than its budget (3 s, no retry loop). */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new KmsError("Timeout")), ms); })]);
  } finally { if (t) clearTimeout(t); }
}

export async function seal(kms: VaultKmsPort, role: VaultRole, context: VaultEncryptionContext, aad: AadFields, plaintext: Buffer, timeoutMs = 3000): Promise<Sealed> {
  if (plaintext.length < 1 || plaintext.length > MAX_VALUE_BYTES) throw new RangeError("vault value size");
  const aadBuf = aadBytes(aad);
  const kekRef = kms.currentKek(aad.kek_class);
  const dk = await withTimeout(kms.generateDataKey(role, kekRef, context), timeoutMs);
  try {
    if (dk.plaintext.length !== 32) throw new KmsError("KMSInternalException");
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const c = crypto.createCipheriv("aes-256-gcm", dk.plaintext, nonce, { authTagLength: TAG_BYTES });
    c.setAAD(aadBuf);
    const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
    return { ciphertext, nonce, tag: c.getAuthTag(), wrappedDek: dk.ciphertextBlob, kekRef: dk.keyId, kekClass: aad.kek_class };
  } finally {
    dk.plaintext.fill(0);
  }
}

export interface Opened { value: Buffer }

/**
 * Decrypt one row. The tag must be exactly 16 bytes and the nonce 12 (a truncated tag is refused before GCM sees it),
 * the data key is unwrapped under the stored KEK with the row's own context, and any authentication failure is a
 * `VaultIntegrityError`. KMS failures surface as `KmsError`.
 */
export async function open(kms: VaultKmsPort, role: VaultRole, context: VaultEncryptionContext, aad: AadFields, s: { ciphertext: Buffer | null; nonce: Buffer; tag: Buffer; wrappedDek: Buffer | null; kekRef: string }, timeoutMs = 3000): Promise<Buffer> {
  if (!s.ciphertext || !s.wrappedDek) throw new VaultIntegrityError();
  if (s.tag.length !== TAG_BYTES || s.nonce.length !== NONCE_BYTES || s.ciphertext.length > MAX_VALUE_BYTES) throw new VaultIntegrityError();
  const aadBuf = aadBytes(aad);
  let dek: Buffer;
  try { dek = await withTimeout(kms.decrypt(role, s.kekRef, s.wrappedDek, context), timeoutMs); }
  catch (e) {
    // A context mismatch or a blob from another key is an integrity failure of the row, not an outage.
    if (e instanceof KmsError && (e.code === "InvalidCiphertextException" || e.code === "IncorrectKeyException")) throw new VaultIntegrityError();
    throw e;
  }
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", dek, s.nonce, { authTagLength: TAG_BYTES });
    d.setAAD(aadBuf);
    d.setAuthTag(s.tag);
    return Buffer.concat([d.update(s.ciphertext), d.final()]);
  } catch { throw new VaultIntegrityError(); }
  finally { dek.fill(0); }
}
