import { currentInvite } from "./waitlist";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api, ApiError } from "./api";

export type RecoveryPath = "codes_email" | "email_only";
export interface RecoveryBanner {
  id: string; status: "pending" | "cooling_off" | "holding"; path: RecoveryPath;
  startedAt: string | null; coolingOffUntil: string | null; holdUntil: string | null;
}
export interface PasskeyView {
  id: string; label: string; backupEligible?: boolean; backupState?: boolean;
  createdAt?: string; suspended?: boolean; revoked?: boolean;
}
export interface Me {
  user: { id: string; email: string };
  credentials: PasskeyView[];
  addresses: { id: string; address: string; kind: string; verified: boolean }[];
  recovery?: RecoveryBanner | null;
  recoveryCodesRemaining?: number;
  hold?: { active: boolean; allHeldUntil: string | null; secretRevealUntil: string | null };
  /** Invite-only live gate (server): whether this account may use the shop. Absent from older servers, read as no in an invite build. */
  live_access?: boolean;
}

type RegistrationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];
/** The caller invalidates a closed view before any next request is sent. No credential goes in a store. */
export function assertCeremonyActive(active: () => boolean): void {
  if (!active()) throw new DOMException("The ceremony was cancelled", "AbortError");
}

export async function whoAmI(): Promise<Me | null> {
  const out = await api<Me & { signedIn: boolean }>("GET", "/api/v1/session");
  return out.signedIn ? out : null;
}

/** Step 1 of sign-up: the server emails a one-time code. The answer is the same whether or not the address has an account. */
export const signupStart = (email: string) => api("POST", "/api/v1/auth/signup/start", { email, invite: currentInvite() ?? undefined });

/** Step 2: verify the code, then create the passkey. Returns the recovery codes, shown once. */
export async function signupVerify(email: string, code: string, active: () => boolean = () => true): Promise<{ recoveryCodes: string[] }> {
  const { options } = await api<{ options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("POST", "/api/v1/auth/signup/verify", { email, code, invite: currentInvite() ?? undefined });
  assertCeremonyActive(active);
  const response = await startRegistration({ optionsJSON: options });
  assertCeremonyActive(active);
  const out = await api<{ recoveryCodes?: string[] }>("POST", "/api/v1/auth/register/verify", { response });
  return { recoveryCodes: out.recoveryCodes ?? [] };
}

export async function signIn(active: () => boolean = () => true): Promise<void> {
  const { options } = await api<{ options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("POST", "/api/v1/auth/login/options", {});
  assertCeremonyActive(active);
  const response = await startAuthentication({ optionsJSON: options });
  assertCeremonyActive(active);
  await api("POST", "/api/v1/auth/login/verify", { response });
}

/** Existing exact-change passkey.add approval is required; the current passkey verifies the addition first. */
export async function addPasskey(actionId: string, active: () => boolean = () => true): Promise<PasskeyView> {
  const { options } = await api<{ options: RegistrationOptions }>("POST", "/api/v1/auth/register/options", {});
  assertCeremonyActive(active);
  const registration = await startRegistration({ optionsJSON: options });
  assertCeremonyActive(active);
  return (await api<{ credential: PasskeyView }>("POST", "/api/v1/passkeys", { registration }, { "X-MH-Action-Id": actionId })).credential;
}

export const recoveryStart = (email: string, path: RecoveryPath) => api("POST", "/api/v1/auth/recovery/start", { email, path });
export async function recoveryRedeem(email: string, code: string, recoveryCode?: string): Promise<void> {
  await api("POST", "/api/v1/auth/recovery/redeem", { email, code, recoveryCode });
}
/** After redeem, retry the registration ticket, never the spent codes. A separate click opens the browser prompt. */
export async function recoveryPasskey(active: () => boolean = () => true): Promise<void> {
  const { options } = await api<{ options: RegistrationOptions }>("POST", "/api/v1/auth/register/options", {});
  assertCeremonyActive(active);
  const response = await startRegistration({ optionsJSON: options });
  assertCeremonyActive(active);
  await api("POST", "/api/v1/auth/register/verify", { response });
}
export const recoveryCancel = () => api<{ ok: boolean; cancelled: boolean }>("POST", "/api/v1/auth/recovery/cancel", {});

export const signOut = () => api("POST", "/api/v1/auth/logout", {});
export const revokeAll = () => api("POST", "/api/v1/auth/sessions/revoke-all", {});

/** Plain-language text for the error codes a person can hit. Never echoes server text. */
export function explain(e: unknown): string {
  if (!(e instanceof ApiError)) {
    const name = (e as { name?: string } | null)?.name;
    if (name === "AbortError") return "Cancelled. Start again when you are ready.";
    if (name === "NotAllowedError") return "The passkey prompt was closed or timed out. Try again.";
    return "Something went wrong. Try again.";
  }
  switch (e.code) {
    case "rate_limited": return "Too many tries. Wait a little, then try again.";
    case "invalid_code": case "bad_code": return "That code did not work. Check it or ask for a new one.";
    case "not_configured": return "Accounts are not connected in this preview.";
    case "unauthorized": return "Your session or registration ticket has ended. Start again.";
    case "recovery_not_open": return "This recovery was cancelled or has already finished.";
    case "recovery_hold": return "Passkey changes are on hold while account recovery is open or its hold is running.";
    case "credential_exists": return "That passkey is already on your account. Choose a different device or security key.";
    case "registration_failed": case "invalid_challenge": return "The passkey could not be created. Try again.";
    case "params_changed": case "action_executed": case "action_expired": return "This approval is no longer usable. Confirm the change again.";
    case "hardened_mode_requires_device_bound": return "Your account requires a passkey that stays on one device, such as a security key.";
    case "terms_not_accepted": return "Accept the terms and the registration agreement to continue.";
    case "invalid_contact": return "Check the contact details. The phone number looks like +1.5555550100.";
    case "email_not_verified": return "Use one of your verified email addresses for the registrant contact.";
    case "contact_required": return "Add your registrant contact first.";
    case "name_unavailable": return "Someone else just took that name. Nothing was charged.";
    case "network": return "The connection failed. Check your network.";
    default: return e.status === 503 ? "Accounts are not connected in this preview." : "That did not work. Try again.";
  }
}
