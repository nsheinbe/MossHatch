import crypto from "node:crypto";
import { canonicalJson } from "../../util/bytes.ts";
import {
  KmsError, VAULT_APP, type GenerateDataKeyResult, type KmsErrorCode, type KmsTrailEvent, type VaultEncryptionContext,
  type VaultKekClass, type VaultKmsAdmin, type VaultKmsPort, type VaultRole,
} from "./types.ts";

/**
 * A local KMS that behaves like AWS KMS where the vault depends on it (the documented behaviour in
 * docs/research/tech-kms-envelope-encryption.md; nothing here was checked against a live account):
 *  - a data key wrapped with one encryption context decrypts only with the exact same context (InvalidCiphertextException);
 *  - Decrypt with a KeyId that is not the blob's key fails (IncorrectKeyException);
 *  - a disabled key fails (DisabledException), a key pending deletion fails (KMSInvalidStateException);
 *  - authorisation needs an Allow in both the key policy and the caller's identity policy, and any explicit Deny wins
 *    (AccessDeniedException), including encryption-context conditions and the per-owner deny;
 *  - ReEncrypt needs ReEncryptFrom on the source key and ReEncryptTo on the destination, and the data key never leaves;
 *  - every call, allowed or refused, lands in a CloudTrail-shaped log with its encryption context.
 * It is a test and development double. Production uses `AwsVaultKms`.
 */

export type KmsAction =
  | "kms:GenerateDataKey" | "kms:Decrypt" | "kms:ReEncryptFrom" | "kms:ReEncryptTo" | "kms:Encrypt"
  | "kms:CreateGrant" | "kms:PutKeyPolicy" | "kms:ScheduleKeyDeletion" | "kms:DisableKey";
export const ALL_KMS_ACTIONS: readonly KmsAction[] = ["kms:GenerateDataKey", "kms:Decrypt", "kms:ReEncryptFrom", "kms:ReEncryptTo", "kms:Encrypt", "kms:CreateGrant", "kms:PutKeyPolicy", "kms:ScheduleKeyDeletion", "kms:DisableKey"];

export interface PolicyStatement {
  sid: string;
  effect: "Allow" | "Deny";
  /** Exact principals, `*`, or a prefix pattern ending in `*` (for example `sso/*`). */
  principals: string[];
  actions: KmsAction[];
  /** StringEquals on `kms:EncryptionContext:<key>`; an array means any of the values. */
  contextEquals?: Record<string, string | string[]>;
  /** ForAllValues:StringEquals on `kms:EncryptionContextKeys`, plus every listed key present (the exact key set). */
  contextKeys?: string[];
}

interface FakeKey { id: string; cls: VaultKekClass; material: Buffer; state: "Enabled" | "Disabled" | "PendingDeletion"; policy: PolicyStatement[] }

const ENVS_OF: Record<VaultKekClass, string[]> = { "vault-prod": ["prod"], "vault-nonprod": ["dev", "preview"] };
const CONTEXT_KEYS = ["app", "env", "owner_id", "secret_id"];
const RUNTIME_DENIES: KmsAction[] = ["kms:CreateGrant", "kms:PutKeyPolicy", "kms:ScheduleKeyDeletion", "kms:DisableKey"];

export const principalOf = (role: VaultRole | string) => (role.includes("/") ? role : `role/${role}`);

/** The key policy the plan specifies for a vault KEK (4.3b Secrets and Loss radius). */
export function defaultKeyPolicy(cls: VaultKekClass): PolicyStatement[] {
  return [
    { sid: "RuntimeUse", effect: "Allow", principals: [`role/${cls}`], actions: ["kms:GenerateDataKey", "kms:Decrypt"], contextEquals: { app: VAULT_APP, env: ENVS_OF[cls] }, contextKeys: CONTEXT_KEYS },
    { sid: "OperatorRewrap", effect: "Allow", principals: ["role/operator"], actions: ["kms:ReEncryptFrom", "kms:ReEncryptTo"], contextEquals: { app: VAULT_APP, env: ENVS_OF[cls] }, contextKeys: CONTEXT_KEYS },
    { sid: "HumansNeverDecrypt", effect: "Deny", principals: ["sso/*", "user/*"], actions: ["kms:Decrypt", "kms:ReEncryptFrom"] },
    { sid: "OnlyBreakGlassDestroys", effect: "Deny", principals: ["*"], actions: ["kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:PutKeyPolicy", "kms:CreateGrant"] },
  ];
}

/** Identity (IAM role) policies: the runtime roles may call only GenerateDataKey and Decrypt, with explicit denies. */
function defaultIdentity(): Map<string, { allow: Set<KmsAction>; deny: Set<KmsAction> }> {
  const m = new Map<string, { allow: Set<KmsAction>; deny: Set<KmsAction> }>();
  for (const r of ["role/vault-prod", "role/vault-nonprod"]) m.set(r, { allow: new Set(["kms:GenerateDataKey", "kms:Decrypt"]), deny: new Set(RUNTIME_DENIES) });
  m.set("role/operator", { allow: new Set(["kms:ReEncryptFrom", "kms:ReEncryptTo"]), deny: new Set(["kms:Decrypt", ...RUNTIME_DENIES]) });
  return m;
}

const matchPrincipal = (pattern: string, p: string) => pattern === "*" || pattern === p || (pattern.endsWith("*") && p.startsWith(pattern.slice(0, -1)));

function conditionsHold(s: PolicyStatement, ctx: Record<string, string> | null): boolean {
  if (s.contextEquals) {
    if (!ctx) return false;
    for (const [k, v] of Object.entries(s.contextEquals)) { const want = Array.isArray(v) ? v : [v]; if (!want.includes(ctx[k] as string)) return false; }
  }
  if (s.contextKeys) {
    if (!ctx) return false;
    const keys = Object.keys(ctx);
    if (!keys.every((k) => s.contextKeys!.includes(k)) || !s.contextKeys.every((k) => keys.includes(k))) return false;
  }
  return true;
}

export interface LocalVaultKmsOptions {
  clock?: { now(): Date }; account?: string; region?: string;
  /** Local and preview only: derive the two initial keys from a root so values survive a restart. Tests leave it unset (random keys). */
  root?: Buffer;
}

export class LocalVaultKms implements VaultKmsPort, VaultKmsAdmin {
  readonly mode = "local" as const;
  private keys = new Map<string, FakeKey>();
  private current = new Map<VaultKekClass, string>();
  private identity = defaultIdentity();
  private roleDenies = new Set<string>();
  readonly events: KmsTrailEvent[] = [];
  /** Fault injection: every call fails with Unavailable while true (the "KMS stub down" of ST-13). */
  down = false;
  /** Every call hangs until the caller's timeout (ST-13, ST-18 timeout). */
  hang = false;
  /** One-shot errors, consumed in order by the next calls. */
  failNext: KmsErrorCode[] = [];
  /** Counters by operation, for "nothing was decrypted" assertions. */
  calls = { GenerateDataKey: 0, Decrypt: 0, ReEncrypt: 0 };
  private clock: { now(): Date };
  private arnPrefix: string;

  constructor(o: LocalVaultKmsOptions = {}) {
    this.clock = o.clock ?? { now: () => new Date() };
    this.arnPrefix = `arn:aws:kms:${o.region ?? "us-east-1"}:${o.account ?? "000000000000"}:key/`;
    for (const cls of ["vault-prod", "vault-nonprod"] as const) this.current.set(cls, this.makeKey(cls, o.root));
  }

  private makeKey(cls: VaultKekClass, root?: Buffer): string {
    let uuid: string = crypto.randomUUID(), material = crypto.randomBytes(32);
    if (root) {
      const h = crypto.createHmac("sha256", root).update("vault-kek:" + cls).digest("hex");
      uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
      material = crypto.createHmac("sha256", root).update("vault-kek-material:" + uuid).digest();
    }
    const id = this.arnPrefix + uuid;
    this.keys.set(id, { id, cls, material, state: "Enabled", policy: defaultKeyPolicy(cls) });
    return id;
  }

  private log(eventName: string, principal: string, keyId: string | null, ctx: Record<string, string> | null, errorCode: KmsErrorCode | null) {
    this.events.push({ eventId: crypto.randomUUID(), at: this.clock.now(), eventName, principal, keyId, encryptionContext: ctx ? { ...ctx } : null, errorCode });
  }

  private async gate(): Promise<void> {
    if (this.hang) await new Promise(() => undefined);
    if (this.down) throw new KmsError("Unavailable");
    const e = this.failNext.shift();
    if (e) throw new KmsError(e);
  }

  /** AWS evaluation: explicit Deny anywhere wins; otherwise both the key policy and the identity policy must Allow. */
  authorize(principal: string, action: KmsAction, key: FakeKey, ctx: Record<string, string> | null): boolean {
    if (this.roleDenies.has(principal) && (action === "kms:Decrypt" || action === "kms:GenerateDataKey" || action === "kms:ReEncryptFrom")) return false;
    const id = this.identity.get(principal);
    if (id?.deny.has(action)) return false;
    for (const s of key.policy) if (s.effect === "Deny" && s.actions.includes(action) && s.principals.some((p) => matchPrincipal(p, principal)) && conditionsHold(s, ctx)) return false;
    const keyAllows = key.policy.some((s) => s.effect === "Allow" && s.actions.includes(action) && s.principals.some((p) => matchPrincipal(p, principal)) && conditionsHold(s, ctx));
    return keyAllows && !!id?.allow.has(action);
  }

  private usable(key: FakeKey) {
    if (key.state === "Disabled") throw new KmsError("DisabledException");
    if (key.state === "PendingDeletion") throw new KmsError("KMSInvalidStateException");
  }

  private wrap(key: FakeKey, dek: Buffer, ctx: Record<string, string>): Buffer {
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key.material, nonce, { authTagLength: 16 });
    c.setAAD(Buffer.from(canonicalJson(ctx)));
    const ct = Buffer.concat([c.update(dek), c.final()]);
    const uuid = Buffer.from(key.id.slice(key.id.lastIndexOf("/") + 1).replace(/-/g, ""), "hex");
    return Buffer.concat([Buffer.from([1]), uuid, nonce, ct, c.getAuthTag()]);
  }

  private keyOfBlob(blob: Buffer): FakeKey | undefined {
    if (blob.length !== 1 + 16 + 12 + 32 + 16 || blob[0] !== 1) return undefined;
    const hex = blob.subarray(1, 17).toString("hex");
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return [...this.keys.values()].find((k) => k.id.endsWith("/" + uuid));
  }

  private unwrap(key: FakeKey, blob: Buffer, ctx: Record<string, string>): Buffer {
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", key.material, blob.subarray(17, 29), { authTagLength: 16 });
      d.setAAD(Buffer.from(canonicalJson(ctx)));
      d.setAuthTag(blob.subarray(61, 77));
      return Buffer.concat([d.update(blob.subarray(29, 61)), d.final()]);
    } catch { throw new KmsError("InvalidCiphertextException"); }
  }

  currentKek(cls: VaultKekClass): string { return this.current.get(cls)!; }

  /** Call as an arbitrary principal (tests of wrong principals and humans). */
  as(principal: string) {
    return {
      generateDataKey: (keyId: string, ctx: VaultEncryptionContext) => this.gdk(principal, keyId, ctx),
      decrypt: (keyId: string, blob: Buffer, ctx: VaultEncryptionContext) => this.dec(principal, keyId, blob, ctx),
      other: (action: KmsAction, keyId: string) => this.otherAction(principal, action, keyId),
    };
  }

  async generateDataKey(role: VaultRole, keyId: string, context: VaultEncryptionContext): Promise<GenerateDataKeyResult> {
    return this.gdk(principalOf(role), keyId, context);
  }
  async decrypt(role: VaultRole, keyId: string, ciphertextBlob: Buffer, context: VaultEncryptionContext): Promise<Buffer> {
    return this.dec(principalOf(role), keyId, ciphertextBlob, context);
  }

  private async gdk(principal: string, keyId: string, context: VaultEncryptionContext): Promise<GenerateDataKeyResult> {
    this.calls.GenerateDataKey++;
    const ctx = { ...context } as Record<string, string>;
    try {
      await this.gate();
      const key = this.keys.get(keyId);
      if (!key) throw new KmsError("NotFoundException");
      if (!this.authorize(principal, "kms:GenerateDataKey", key, ctx)) throw new KmsError("AccessDeniedException");
      this.usable(key);
      const dek = crypto.randomBytes(32);
      const blob = this.wrap(key, dek, ctx);
      this.log("GenerateDataKey", principal, keyId, ctx, null);
      return { plaintext: dek, ciphertextBlob: blob, keyId };
    } catch (e) {
      this.log("GenerateDataKey", principal, keyId, ctx, e instanceof KmsError ? e.code : "KMSInternalException");
      throw e;
    }
  }

  private async dec(principal: string, keyId: string, blob: Buffer, context: VaultEncryptionContext): Promise<Buffer> {
    this.calls.Decrypt++;
    const ctx = { ...context } as Record<string, string>;
    try {
      await this.gate();
      const key = this.keyOfBlob(blob);
      if (!key) throw new KmsError("InvalidCiphertextException");
      if (keyId !== key.id) throw new KmsError("IncorrectKeyException");
      if (!this.authorize(principal, "kms:Decrypt", key, ctx)) throw new KmsError("AccessDeniedException");
      this.usable(key);
      const out = this.unwrap(key, blob, ctx);
      this.log("Decrypt", principal, key.id, ctx, null);
      return out;
    } catch (e) {
      this.log("Decrypt", principal, keyId, ctx, e instanceof KmsError ? e.code : "KMSInternalException");
      throw e;
    }
  }

  async reEncrypt(role: VaultRole, i: { ciphertextBlob: Buffer; sourceKeyId: string; sourceContext: VaultEncryptionContext; destinationKeyId: string; destinationContext: VaultEncryptionContext }) {
    this.calls.ReEncrypt++;
    const principal = principalOf(role);
    const sctx = { ...i.sourceContext } as Record<string, string>, dctx = { ...i.destinationContext } as Record<string, string>;
    try {
      await this.gate();
      const src = this.keyOfBlob(i.ciphertextBlob);
      if (!src) throw new KmsError("InvalidCiphertextException");
      if (src.id !== i.sourceKeyId) throw new KmsError("IncorrectKeyException");
      const dst = this.keys.get(i.destinationKeyId);
      if (!dst) throw new KmsError("NotFoundException");
      if (!this.authorize(principal, "kms:ReEncryptFrom", src, sctx) || !this.authorize(principal, "kms:ReEncryptTo", dst, dctx)) throw new KmsError("AccessDeniedException");
      this.usable(src); this.usable(dst);
      const dek = this.unwrap(src, i.ciphertextBlob, sctx);
      const out = this.wrap(dst, dek, dctx);
      dek.fill(0);
      this.log("ReEncrypt", principal, src.id, sctx, null);
      return { ciphertextBlob: out, keyId: dst.id };
    } catch (e) {
      this.log("ReEncrypt", principal, i.sourceKeyId, sctx, e instanceof KmsError ? e.code : "KMSInternalException");
      throw e;
    }
  }

  private async otherAction(principal: string, action: KmsAction, keyId: string): Promise<void> {
    const key = this.keys.get(keyId);
    if (!key) throw new KmsError("NotFoundException");
    const ok = this.authorize(principal, action, key, null);
    this.log(action.slice(4), principal, keyId, null, ok ? null : "AccessDeniedException");
    if (!ok) throw new KmsError("AccessDeniedException");
  }

  /** Test configuration: give a principal an identity policy (for example a human SSO role with `kms:*`). */
  setIdentityPolicy(principal: string, allow: KmsAction[], deny: KmsAction[] = []) { this.identity.set(principal, { allow: new Set(allow), deny: new Set(deny) }); }
  keyState(keyId: string) { return this.keys.get(keyId)?.state; }
  keyClass(keyId: string) { return this.keys.get(keyId)?.cls; }

  // Administrative operations (the break-glass identity; logged like CloudTrail management events).
  async createKey(cls: VaultKekClass): Promise<string> { const id = this.makeKey(cls); this.log("CreateKey", "role/break-glass", id, null, null); return id; }
  async setCurrentKek(cls: VaultKekClass, keyId: string): Promise<void> {
    const k = this.keys.get(keyId);
    if (!k || k.cls !== cls) throw new KmsError("NotFoundException");
    this.current.set(cls, keyId);
  }
  async disableKey(keyId: string): Promise<void> { const k = this.keys.get(keyId); if (!k) throw new KmsError("NotFoundException"); k.state = "Disabled"; this.log("DisableKey", "role/break-glass", keyId, null, null); }
  async enableKey(keyId: string): Promise<void> { const k = this.keys.get(keyId); if (!k) throw new KmsError("NotFoundException"); k.state = "Enabled"; this.log("EnableKey", "role/break-glass", keyId, null, null); }
  async attachRoleDeny(role: VaultRole): Promise<void> { this.roleDenies.add(principalOf(role)); this.log("PutRolePolicy", "role/incident", null, null, null); }
  async removeRoleDeny(role: VaultRole): Promise<void> { this.roleDenies.delete(principalOf(role)); this.log("DeleteRolePolicy", "role/incident", null, null, null); }
  roleDenied(role: VaultRole): boolean { return this.roleDenies.has(principalOf(role)); }
  async denyOwner(keyId: string, ownerId: string): Promise<void> {
    const k = this.keys.get(keyId); if (!k) throw new KmsError("NotFoundException");
    k.policy.push({ sid: `DenyOwner-${ownerId}`, effect: "Deny", principals: ["*"], actions: ["kms:Decrypt", "kms:GenerateDataKey"], contextEquals: { owner_id: ownerId } });
    this.log("PutKeyPolicy", "role/break-glass", keyId, null, null);
  }
  async restrictToOperator(keyId: string): Promise<void> {
    const k = this.keys.get(keyId); if (!k) throw new KmsError("NotFoundException");
    k.policy = k.policy.filter((s) => s.sid !== "RuntimeUse");
    this.log("PutKeyPolicy", "role/break-glass", keyId, null, null);
  }
  async trail(from?: Date, to?: Date): Promise<KmsTrailEvent[]> {
    return this.events.filter((e) => (!from || e.at >= from) && (!to || e.at < to));
  }
}
