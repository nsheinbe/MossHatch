import { currentInvite } from "./waitlist";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api, ApiError } from "./api";

export type RecoveryPath = "codes_email" | "email_only";

/** The recovery banner from /me: a request still open (pending, cooling_off) or the hold after one finished (holding). */
export interface RecoveryBanner {
  id: string;
  status: "pending" | "cooling_off" | "holding";
  path: RecoveryPath;
  startedAt: string | null;
  coolingOffUntil: string | null;
  holdUntil: string | null;
}

export interface Me {
  user: { id: string; email: string };
  /** Suspended credentials are the ones a recovery paused (30 days; signing in with one undoes the recovery). */
  credentials: { id: string; label: string; alg?: number; backupEligible?: boolean; backupState?: boolean; transports?: string[]; createdAt?: string; lastUsedAt?: string | null; suspended?: boolean; revoked?: boolean }[];
  addresses: { id: string; address: string; kind: string; verified: boolean }[];
  recovery?: RecoveryBanner | null;
  hold?: { active: boolean; allHeldUntil: string | null; secretRevealUntil: string | null };
  /** Invite-only live gate (server): whether this account may use the shop. Absent from older servers, read as no in an invite build. */
  live_access?: boolean;
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

/** An abandoned browser view must not finish a factor enrollment or sign-in. */
function assertCeremonyActive(active: () => boolean): void {
  if (!active()) throw new DOMException("Ceremony abandoned", "AbortError");
}

type RegistrationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];

/**
 * Recovery step 1: ask for the emailed code. On `codes_email` it goes out at once; on `email_only` the first ask starts a
 * 72-hour wait and an ask after the wait sends it. The answer is the same whether or not the address has an account.
 */
export const recoveryStart = (email: string, path: RecoveryPath) => api("POST", "/api/v1/auth/recovery/start", { email, path });

/**
 * Step 2: redeem the emailed code (with a saved recovery code on `codes_email`). Both are spent here; the server answers
 * with options for the new passkey and a 30-minute registration ticket (the pre-auth cookie).
 */
export async function recoveryRedeem(email: string, code: string, recoveryCode?: string): Promise<RegistrationOptions> {
  const { options } = await api<{ options: RegistrationOptions }>("POST", "/api/v1/auth/recovery/redeem", { email, code, recoveryCode });
  return options;
}

/**
 * Step 3: create the new passkey, which completes the recovery and signs in. Without options (the prompt was closed after a
 * redeem), fresh ones come from the registration ticket, so the spent codes are not needed again. Returns when the hold ends.
 */
export async function recoveryPasskey(options?: RegistrationOptions, active: () => boolean = () => true): Promise<{ holdUntil: string | null }> {
  const optionsJSON = options ?? (await api<{ options: RegistrationOptions }>("POST", "/api/v1/auth/register/options", {})).options;
  assertCeremonyActive(active);
  const response = await startRegistration({ optionsJSON });
  assertCeremonyActive(active);
  const out = await api<{ holdUntil?: string | null }>("POST", "/api/v1/auth/register/verify", { response });
  return { holdUntil: out.holdUntil ?? null };
}

/** Cancel a recovery that has not finished, from a signed-in session (the emailed cancel link has its own page). */
export const recoveryCancel = () => api<{ ok: boolean; cancelled: boolean }>("POST", "/api/v1/auth/recovery/cancel", {});

export const signOut = () => api("POST", "/api/v1/auth/logout", {});

// ---- passkeys ----------------------------------------------------------------------------------------------------------------------------
export interface PasskeyView { id: string; label: string; alg: number; backupEligible: boolean; backupState: boolean; transports: string[]; createdAt: string; lastUsedAt: string | null; suspended: boolean; revoked: boolean }
export const listPasskeys = async () => (await api<{ passkeys: PasskeyView[] }>("GET", "/api/v1/passkeys")).passkeys;
/** After the `passkey.add` step-up is committed: the browser makes the new passkey, then it is added with the action id. From a click of its own. */
export async function addPasskey(actionId: string, active: () => boolean = () => true): Promise<PasskeyView> {
  const { options } = await api<{ options: RegistrationOptions }>("POST", "/api/v1/auth/register/options", {});
  assertCeremonyActive(active);
  const registration = await startRegistration({ optionsJSON: options });
  assertCeremonyActive(active);
  return (await api<{ credential: PasskeyView }>("POST", "/api/v1/passkeys", { registration }, { "X-MH-Action-Id": actionId })).credential;
}
/** `confirmLast` removes the last live passkey (only with recovery codes left; the server refuses otherwise). */
export const removePasskey = (id: string, confirmLast = false) => api("DELETE", `/api/v1/passkeys/${encodeURIComponent(id)}`, confirmLast ? { confirmLast: true } : undefined);
export const revokeAll = () => api("POST", "/api/v1/auth/sessions/revoke-all", {});

/** Plain-language text for the error codes a person can hit. Never echoes server text. */
export function explain(e: unknown): string {
  if (!(e instanceof ApiError)) {
    const name = (e as { name?: string } | null)?.name;
    if (name === "AbortError") return "The passkey request was cancelled.";
    if (name === "NotAllowedError") return "The passkey prompt was closed or timed out. Try again.";
    return "Something went wrong. Try again.";
  }
  switch (e.code) {
    case "rate_limited": return "Too many tries. Wait a little, then try again.";
    case "invalid_code": case "bad_code": return "That code did not work. Check it or ask for a new one.";
    case "not_configured": return "Accounts are not connected in this preview.";
    case "terms_not_accepted": return "Accept the terms and the registration agreement to continue.";
    case "tld_terms_not_accepted": return "Accept the registry terms for this extension to continue.";
    case "auto_renew_consent_required": return "Tick the auto-renew authorisation, or leave auto-renew off.";
    case "invalid_contact": return "Check the contact details. The phone can be written any usual way, like (310) 555-0100 or +44 20 7946 0958, with the country it belongs to.";
    // The session ended (15 minutes idle, 8 hours in all, or revoked elsewhere): lib/session.ts opens sign-in for the forms that can; this is the fallback.
    case "unauthorized": return "Your session has ended. Sign in again, then try once more.";
    case "csrf": case "ambiguous_credentials": return "This page is out of date. Reload it, then try again.";
    case "internal": return "Something went wrong on our side. Try again in a moment; if it keeps happening, write to support@mosshatch.com.";
    case "email_not_verified": return "Use one of your verified email addresses for the registrant contact.";
    case "email_unverified": return "Confirm your email address first, then try again.";
    case "contact_required": return "Add your registrant contact first.";
    case "name_unavailable": return "Someone else just took that name. Nothing was charged.";
    case "recovery_not_open": return "This recovery was cancelled or has already finished. Start again if you still need it.";
    // Passkeys (Your account): adding and removing.
    case "credential_exists": return "That passkey is already on your account.";
    case "registration_failed": case "invalid_challenge": return "The passkey could not be created. Try again.";
    case "recovery_hold": return "Passkeys cannot change while an account recovery is open or on hold.";
    case "confirm_required": return "This is your last passkey. Tick the box to confirm, and keep your recovery codes safe: they become your only way in.";
    case "last_credential_no_recovery_codes": return "This is your last passkey and no recovery codes are left, so it cannot be removed.";
    case "credential_suspended": return "A passkey paused by a recovery cannot be removed until the recovery ends.";
    case "hardened_mode_requires_device_bound": return "Your account only accepts passkeys that stay on one device.";
    case "params_changed": return "Something changed while you were signing. Try again.";
    case "not_verified": return "Confirm your email address first.";
    case "network": return "The connection failed. Check your network.";
    // Checkout refusals (docs/AUDIT-2026-10-07.md F9): each says what happened to the money and what to do next.
    case "orders_paused": case "sell_gate": case "global_daily_cap": case "global_total_cap":
      return "New registrations are paused for a little while. Nothing was charged and the name is not held. Try again later.";
    case "registrar_unavailable": return "Our registrar isn't taking registrations right now. Nothing was charged. Try again in a little while.";
    case "price_not_standard": return "This name has a premium or non-standard price, which we don't sell. Nothing was charged.";
    case "documents_unavailable": return "The terms for this purchase couldn't be loaded, so checkout is paused. Nothing was charged.";
    case "payment_unavailable": return "Secure checkout couldn't open just now. Nothing was charged. Try again.";
    case "mode_inconsistent": case "sample_price_in_live": return "Checkout is unavailable right now. Nothing was charged.";
    case "unsupported_tld": return "We don't sell that extension yet.";
    case "invalid_term": return "That registration period isn't available for this extension.";
    case "invite_required": return "Buying is open to invited accounts for now. Join the waitlist to get an invite.";
    case "new_account_daily_registrations": case "new_account_exposure":
      return "New accounts have a daily limit on registrations. Nothing was charged. Try again tomorrow, or write to support@mosshatch.com.";
    case "review_hold": case "screening_hold": return "We need to check this order before it can go ahead. Nothing was charged. Write to support@mosshatch.com.";
    case "account_frozen": case "account_inactive": return "This account can't buy right now. Write to support@mosshatch.com.";
    case "idempotency_key_reuse": case "request_in_progress": return "That checkout is already being opened. Wait a moment, then try again.";
    case "not_payable": return "This order can no longer be paid here. Write to support@mosshatch.com and we will sort it out.";
    default: return e.status === 503 ? "This isn't available right now. Nothing was charged. Try again in a little while." : "That did not work. Try again.";
  }
}
