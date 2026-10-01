import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { AppContext } from "./ports.ts";
import { fromB64u } from "./util/bytes.ts";

export const SUPPORTED_ALGS = [-7, -257] as const;
export const CEREMONY_TTL_MS = 120_000;

export function registrationOptions(ctx: AppContext, u: { userHandle: Buffer; email: string; label?: string; existingCredentialIds?: string[] }) {
  return generateRegistrationOptions({
    rpName: "Mosshatch", rpID: ctx.config.rpId, userName: u.email, userDisplayName: u.email,
    userID: new Uint8Array(u.userHandle), attestationType: "none", timeout: CEREMONY_TTL_MS,
    supportedAlgorithmIDs: [...SUPPORTED_ALGS],
    excludeCredentials: (u.existingCredentialIds ?? []).map((id) => ({ id })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
}

export interface VerifiedRegistration {
  credentialId: string; publicKey: Buffer; alg: number; signCount: number; transports: string[];
  backupEligible: boolean; backupState: boolean;
}

/** Verify a registration ceremony. Fails on a wrong origin or RP ID, missing user verification, or an unsupported algorithm. */
export async function verifyRegistration(ctx: AppContext, response: RegistrationResponseJSON, expectedChallenge: string): Promise<VerifiedRegistration> {
  const v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: ctx.config.allowedOrigins, expectedRPID: ctx.config.rpId, requireUserVerification: true, supportedAlgorithmIDs: [...SUPPORTED_ALGS] });
  if (!v.verified || !v.registrationInfo) throw new Error("registration_not_verified");
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  const alg = coseAlg(credential.publicKey);
  if (!SUPPORTED_ALGS.includes(alg as -7 | -257)) throw new Error("unsupported_algorithm");
  return {
    credentialId: credential.id, publicKey: Buffer.from(credential.publicKey), alg, signCount: credential.counter,
    transports: (credential.transports ?? []) as string[], backupEligible: credentialDeviceType === "multiDevice", backupState: credentialBackedUp,
  };
}

/** Read `alg` (label 3) from a COSE_Key with a tiny CBOR reader: maps of small ints, negative ints and byte strings only. */
export function coseAlg(pub: Uint8Array): number {
  const b = Buffer.from(pub);
  let pos = 0;
  const readHead = (): { major: number; value: number } => {
    const first = b[pos++]!; const major = first >> 5; const info = first & 31;
    if (info < 24) return { major, value: info };
    if (info === 24) return { major, value: b[pos++]! };
    if (info === 25) { const v = (b[pos]! << 8) | b[pos + 1]!; pos += 2; return { major, value: v }; }
    throw new Error("cose: unsupported length");
  };
  try {
    const m = readHead();
    if (m.major !== 5) return 0;
    for (let i = 0; i < m.value; i++) {
      const k = readHead();
      const key = k.major === 0 ? k.value : -1 - k.value;
      const v = readHead();
      if (v.major === 2) { pos += v.value; continue; }
      if (key === 3) return v.major === 0 ? v.value : -1 - v.value;
    }
  } catch { return 0; }
  return 0;
}

/** Options for an assertion. `challenge` is supplied by step-up (a digest that binds the action); login uses a random one. */
export function assertionOptions(ctx: AppContext, o: { challenge?: string | Uint8Array<ArrayBuffer>; allowCredentialIds?: string[] }) {
  return generateAuthenticationOptions({
    rpID: ctx.config.rpId, userVerification: "required", timeout: CEREMONY_TTL_MS,
    challenge: o.challenge, allowCredentials: o.allowCredentialIds?.map((id) => ({ id })),
  });
}

export interface StoredCredential { credentialId: string; publicKey: Buffer; signCount: number; transports?: string[]; backupEligible: boolean }

export interface VerifiedAssertion { newCounter: number; userVerified: boolean; backupEligible: boolean; backupState: boolean }

/**
 * Verify an assertion against a stored credential. The library is stateless (a valid assertion verifies twice),
 * so single use is enforced by the caller consuming the challenge first. Attestation is `none`.
 */
export async function verifyAssertion(ctx: AppContext, response: AuthenticationResponseJSON, expectedChallenge: string, cred: StoredCredential): Promise<VerifiedAssertion> {
  const v = await verifyAuthenticationResponse({
    response, expectedChallenge, expectedOrigin: ctx.config.allowedOrigins, expectedRPID: ctx.config.rpId, requireUserVerification: true,
    credential: { id: cred.credentialId, publicKey: new Uint8Array(cred.publicKey), counter: cred.signCount, transports: cred.transports as never },
  });
  if (!v.verified) throw new Error("assertion_not_verified");
  const info = v.authenticationInfo;
  // Flags come from the authenticator data: bit 3 (BE) and bit 4 (BS).
  const flags = fromB64u(response.response.authenticatorData)[32]!;
  const be = (flags & 0x08) !== 0, bs = (flags & 0x10) !== 0;
  void info.credentialDeviceType;
  return { newCounter: info.newCounter, userVerified: info.userVerified, backupEligible: be, backupState: bs };
}

/** The challenge value from a response's clientDataJSON, used to find the stored ceremony. */
export function challengeOf(response: { response: { clientDataJSON: string } }): string {
  return (JSON.parse(fromB64u(response.response.clientDataJSON).toString()) as { challenge: string }).challenge;
}
