import crypto from "node:crypto";
import { b64u, sha256 } from "../util/bytes.ts";

/** Minimal CBOR encoder for the shapes WebAuthn attestation objects and COSE keys need. */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    return Buffer.from([(major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported");
}

export interface VirtualAuthenticatorOpts {
  alg?: -7 | -257;
  backupEligible?: boolean;
  backupState?: boolean;
  userVerified?: boolean;
  origin: string;
  rpId: string;
}

/** A software authenticator for tests: creates "none"-attestation credentials and signs assertions (ES256 or RS256). */
export class VirtualAuthenticator {
  readonly credentialId: Buffer;
  private privateKey: crypto.KeyObject;
  private publicKey: crypto.KeyObject;
  signCount = 0;
  alg: -7 | -257;
  backupEligible: boolean;
  backupState: boolean;
  userVerified: boolean;
  userHandle: Buffer | null = null;
  constructor(public opts: VirtualAuthenticatorOpts) {
    this.alg = opts.alg ?? -7;
    this.backupEligible = opts.backupEligible ?? false;
    this.backupState = opts.backupState ?? false;
    this.userVerified = opts.userVerified ?? true;
    this.credentialId = crypto.randomBytes(32);
    const kp = this.alg === -7 ? crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }) : crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = kp.privateKey; this.publicKey = kp.publicKey;
  }
  get id(): string { return b64u(this.credentialId); }

  private flags(attested: boolean): number {
    return 0x01 | (this.userVerified ? 0x04 : 0) | (this.backupEligible ? 0x08 : 0) | (this.backupState ? 0x10 : 0) | (attested ? 0x40 : 0);
  }
  private coseKey(): Buffer {
    const jwk = this.publicKey.export({ format: "jwk" }) as { x?: string; y?: string; n?: string; e?: string };
    if (this.alg === -7) return cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
    return cbor(new Map<number, unknown>([[1, 3], [3, -257], [-1, Buffer.from(jwk.n!, "base64url")], [-2, Buffer.from(jwk.e!, "base64url")]]));
  }
  private authData(attested: boolean): Buffer {
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.signCount);
    const parts = [sha256(this.opts.rpId), Buffer.from([this.flags(attested)]), counter];
    if (attested) {
      const len = Buffer.alloc(2); len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.coseKey());
    }
    return Buffer.concat(parts);
  }

  /** navigator.credentials.create() result for the given creation options. */
  create(options: { challenge: string; user?: { id: string } }): { id: string; rawId: string; type: "public-key"; response: { clientDataJSON: string; attestationObject: string; transports: string[] }; clientExtensionResults: object } {
    if (options.user?.id) this.userHandle = Buffer.from(options.user.id, "base64url");
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.opts.origin, crossOrigin: false }));
    const att = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData(true)]]));
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ["internal"] }, clientExtensionResults: {} };
  }

  /** navigator.credentials.get() result. `challenge` is the base64url challenge from the options. */
  get(options: { challenge: string }, overrides: { origin?: string; userHandle?: Buffer | null } = {}) {
    this.signCount += 1;
    const authData = this.authData(false);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: overrides.origin ?? this.opts.origin, crossOrigin: false }));
    const signed = Buffer.concat([authData, sha256(clientData)]);
    const sig = this.alg === -7 ? crypto.sign("sha256", signed, this.privateKey) : crypto.sign("sha256", signed, { key: this.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
    const uh = overrides.userHandle === undefined ? this.userHandle : overrides.userHandle;
    return {
      id: this.id, rawId: this.id, type: "public-key" as const,
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: uh ? b64u(uh) : undefined },
      clientExtensionResults: {},
    };
  }
}
