/**
 * The vault's key-service port (PLAN 4.3b Secrets). Shaped after AWS KMS: `GenerateDataKey`, `Decrypt` and `ReEncrypt`
 * with an encryption context that must match exactly, keys addressed by ARN, and errors named as KMS names them.
 *
 * Two vault KEKs, one per class: `vault-prod` wraps customers' `prod` secrets, `vault-nonprod` their `dev` and `preview`
 * secrets. Each class has its own IAM role; the class always comes from the stored row, never from the request. Re-wrap
 * runs under a separate `operator` role that the web deployment cannot assume.
 */

export type VaultKekClass = "vault-prod" | "vault-nonprod";
export type SecretEnv = "dev" | "preview" | "prod";
export const SECRET_ENVS: readonly SecretEnv[] = ["dev", "preview", "prod"];

/** Roles that call KMS. `vault-prod` and `vault-nonprod` are the runtime roles; `operator` re-wraps and never serves requests. */
export type VaultRole = VaultKekClass | "operator";

/** Plaintext in CloudTrail: opaque ids only. The key policy pins `app` and `env` and the exact key set. */
export interface VaultEncryptionContext {
  app: string;
  env: SecretEnv;
  owner_id: string;
  secret_id: string;
}

export const kekClassFor = (env: SecretEnv): VaultKekClass => (env === "prod" ? "vault-prod" : "vault-nonprod");

export type KmsErrorCode =
  | "AccessDeniedException"
  | "InvalidCiphertextException"
  | "IncorrectKeyException"
  | "DisabledException"
  | "KMSInvalidStateException"
  | "NotFoundException"
  | "ThrottlingException"
  | "KMSInternalException"
  | "KMSInvalidMacException"
  | "Timeout"
  | "Unavailable";

/** A KMS failure. The message is the code only: no key material, context or ciphertext ever rides on it. */
export class KmsError extends Error {
  override name = "KmsError";
  constructor(public readonly code: KmsErrorCode) { super(code); }
}

export interface GenerateDataKeyResult { plaintext: Buffer; ciphertextBlob: Buffer; keyId: string }

export interface VaultKmsPort {
  readonly mode: "local" | "aws";
  /** The current KEK for a class (an ARN). New writes use it; existing rows name their own KEK in `kek_ref`. */
  currentKek(cls: VaultKekClass): string;
  generateDataKey(role: VaultRole, keyId: string, context: VaultEncryptionContext): Promise<GenerateDataKeyResult>;
  /** `keyId` is always passed (a wrapped key from another KEK is refused, not silently accepted). */
  decrypt(role: VaultRole, keyId: string, ciphertextBlob: Buffer, context: VaultEncryptionContext): Promise<Buffer>;
  /** Server-side re-wrap: the data key never leaves KMS. Needs ReEncryptFrom on the source and ReEncryptTo on the destination. */
  reEncrypt(role: VaultRole, input: { ciphertextBlob: Buffer; sourceKeyId: string; sourceContext: VaultEncryptionContext; destinationKeyId: string; destinationContext: VaultEncryptionContext }): Promise<{ ciphertextBlob: Buffer; keyId: string }>;
}

/** A CloudTrail-shaped record of one KMS call (the fake writes these; production reads the trail). */
export interface KmsTrailEvent {
  eventId: string;
  at: Date;
  eventName: "GenerateDataKey" | "Decrypt" | "ReEncrypt" | "DisableKey" | "EnableKey" | "PutKeyPolicy" | "CreateKey" | "PutRolePolicy" | "DeleteRolePolicy" | string;
  principal: string;
  keyId: string | null;
  encryptionContext: Record<string, string> | null;
  errorCode: KmsErrorCode | null;
}

/** Administrative operations used by the compromise drill. In AWS these run under the break-glass or incident identity. */
export interface VaultKmsAdmin {
  createKey(cls: VaultKekClass): Promise<string>;
  setCurrentKek(cls: VaultKekClass, keyId: string): Promise<void>;
  disableKey(keyId: string): Promise<void>;
  enableKey(keyId: string): Promise<void>;
  /** Explicit IAM Deny on kms:Decrypt (and GenerateDataKey) for a role: reversible, unlike DisableKey. */
  attachRoleDeny(role: VaultRole): Promise<void>;
  removeRoleDeny(role: VaultRole): Promise<void>;
  /** Key-policy Deny on one tenant (`kms:EncryptionContext:owner_id`): blocks one customer without an outage. */
  denyOwner(keyId: string, ownerId: string): Promise<void>;
  /** Restrict a key to the operator role only (drill step: the source key during migration). */
  restrictToOperator(keyId: string): Promise<void>;
  trail(from?: Date, to?: Date): Promise<KmsTrailEvent[]>;
}

export const VAULT_APP = "mosshatch-nest";
