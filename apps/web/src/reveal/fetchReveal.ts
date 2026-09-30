import { SecretValue } from "./secretValue";

/**
 * The one request that carries a secret value to the browser: `POST /api/v1/secrets/{id}/reveal` with the committed
 * `secret.reveal` action id. It calls `fetch` directly (no shared client, no retry, no cache, no error reporter), decodes with
 * `TextDecoder`, and throws only `RevealError`, whose message is a fixed code. A parse error from a truncated body is discarded
 * because V8 quotes the input in `SyntaxError` messages (ST-19). Nothing here logs.
 */
export type RevealFailure =
  | "network" | "truncated" | "bad_response" | "step_up_required" | "rate_limited" | "secret_changed" | "vault_unavailable" | "not_found" | "error";

export class RevealError extends Error {
  constructor(public readonly code: RevealFailure, public readonly status = 0) { super(code); this.name = "RevealError"; }
}

const KNOWN: readonly RevealFailure[] = ["step_up_required", "rate_limited", "secret_changed", "vault_unavailable", "not_found"];

export async function fetchReveal(secretId: string, actionId: string, f: typeof fetch = fetch): Promise<SecretValue> {
  let res: Response;
  try {
    res = await f(`/api/v1/secrets/${encodeURIComponent(secretId)}/reveal`, {
      method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-MH-Client": "web", "X-MH-Action-Id": actionId },
      body: "{}",
    });
  } catch { throw new RevealError("network"); }
  if (!res.ok) {
    // An error body never carries a value, but only a known code is kept; anything else becomes "error".
    let code: RevealFailure = "error";
    try {
      const b = JSON.parse(new TextDecoder().decode(await res.arrayBuffer())) as { error?: { code?: unknown } };
      const c = b?.error?.code;
      if (typeof c === "string" && (KNOWN as readonly string[]).includes(c)) code = c as RevealFailure;
    } catch { /* discarded */ }
    throw new RevealError(code, res.status);
  }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await res.arrayBuffer())); }
  catch { throw new RevealError("truncated", res.status); }
  const b = body as { secret_id?: unknown; value?: unknown } | null;
  if (!b || typeof b !== "object" || typeof b.value !== "string" || b.secret_id !== secretId) throw new RevealError("bad_response", res.status);
  const v = new SecretValue(b.value);
  b.value = undefined;
  return v;
}

/** Plain words for a failed reveal. Never includes anything from the response. */
export function revealText(e: unknown): string {
  const code = e instanceof RevealError ? e.code : "error";
  switch (code) {
    case "step_up_required": return "That needs your passkey again. Nothing was shown.";
    case "rate_limited": return "Too many reveals just now. Wait a minute, then try again.";
    case "secret_changed": return "The secret changed while you were confirming. Try again to see the new version.";
    case "vault_unavailable": return "The Nest cannot open values right now. Nothing was shown.";
    case "not_found": return "That secret is gone. Nothing was shown.";
    case "truncated": case "bad_response": return "The value did not arrive whole, so nothing was shown. Try again.";
    case "network": return "The connection failed. Nothing was shown.";
    default: return "The reveal did not work. Nothing was shown.";
  }
}
