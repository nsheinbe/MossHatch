import { currentInvite } from "./waitlist";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api, ApiError } from "./api";

export interface Me {
  user: { id: string; email: string };
  credentials: { id: string; label: string; backup_eligible: boolean; created_at?: string }[];
  addresses: { id: string; address: string; kind: string; verified: boolean }[];
  recovery?: { banner?: string | null } | null;
}

export async function whoAmI(): Promise<Me | null> {
  const out = await api<Me & { signedIn: boolean }>("GET", "/api/v1/session");
  return out.signedIn ? out : null;
}

/** Step 1 of sign-up: the server emails a one-time code. The answer is the same whether or not the address has an account. */
export const signupStart = (email: string) => api("POST", "/api/v1/auth/signup/start", { email, invite: currentInvite() ?? undefined });

/** Step 2: verify the code, then create the passkey. Returns the recovery codes, shown once. */
export async function signupVerify(email: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const { options } = await api<{ options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("POST", "/api/v1/auth/signup/verify", { email, code, invite: currentInvite() ?? undefined });
  const response = await startRegistration({ optionsJSON: options });
  const out = await api<{ recoveryCodes?: string[] }>("POST", "/api/v1/auth/register/verify", { response });
  return { recoveryCodes: out.recoveryCodes ?? [] };
}

export async function signIn(): Promise<void> {
  const { options } = await api<{ options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("POST", "/api/v1/auth/login/options", {});
  const response = await startAuthentication({ optionsJSON: options });
  await api("POST", "/api/v1/auth/login/verify", { response });
}

export const signOut = () => api("POST", "/api/v1/auth/logout", {});
export const revokeAll = () => api("POST", "/api/v1/auth/sessions/revoke-all", {});

/** Plain-language text for the error codes a person can hit. Never echoes server text. */
export function explain(e: unknown): string {
  if (!(e instanceof ApiError)) {
    const name = (e as { name?: string } | null)?.name;
    if (name === "NotAllowedError") return "The passkey prompt was closed or timed out. Try again.";
    return "Something went wrong. Try again.";
  }
  switch (e.code) {
    case "rate_limited": return "Too many tries. Wait a little, then try again.";
    case "invalid_code": case "bad_code": return "That code did not work. Check it or ask for a new one.";
    case "not_configured": return "Accounts are not connected in this preview.";
    case "terms_not_accepted": return "Accept the terms and the registration agreement to continue.";
    case "invalid_contact": return "Check the contact details. The phone number looks like +1.5555550100.";
    case "email_not_verified": return "Use one of your verified email addresses for the registrant contact.";
    case "contact_required": return "Add your registrant contact first.";
    case "name_unavailable": return "Someone else just took that name. Nothing was charged.";
    case "network": return "The connection failed. Check your network.";
    default: return e.status === 503 ? "Accounts are not connected in this preview." : "That did not work. Try again.";
  }
}
