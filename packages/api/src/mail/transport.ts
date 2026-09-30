import type { Config, EmailMessage, EmailPort } from "../ports.ts";

/**
 * Resend over HTTPS. UNVERIFIED against the network: no request in this repository has reached Resend; the tests
 * check the request shape against a fake fetch. Click and open tracking are configured per domain in Resend (off for
 * these emails, PLAN 4.6 row 43), not per request.
 */
export class ResendTransport implements EmailPort {
  constructor(private o: { apiKey: string; from: string; fetch?: typeof fetch; baseUrl?: string }) {
    if (!o.apiKey) throw new Error("resend_api_key_missing");
  }
  async send(msg: EmailMessage): Promise<{ id: string }> {
    const f = this.o.fetch ?? fetch;
    const res = await f((this.o.baseUrl ?? "https://api.resend.com") + "/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.o.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": msg.dedupeKey },
      body: JSON.stringify({ from: this.o.from, to: msg.to, subject: msg.subject, text: msg.text }),
    });
    if (!res.ok) {
      // Status only: the response body may echo the address.
      throw Object.assign(new Error("resend_failed"), { name: "ResendError", code: `http_${res.status}`, retryable: res.status === 429 || res.status >= 500 });
    }
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw Object.assign(new Error("resend_no_id"), { name: "ResendError" });
    return { id: body.id };
  }
}

/** Local and preview: nothing leaves the process. Logs the kind and dedupe key only (no address, no body). */
export class LogOnlyEmail implements EmailPort {
  private seen = new Set<string>();
  constructor(private log: (line: string) => void = (l) => console.info(l)) {}
  async send(msg: EmailMessage) {
    if (!this.seen.has(msg.dedupeKey)) { this.seen.add(msg.dedupeKey); this.log(`mail(log-only) kind=${msg.kind} key=${msg.dedupeKey}`); }
    return { id: "log_" + msg.dedupeKey };
  }
}

export function createEmailTransport(config: Pick<Config, "mode">, deps: { resend?: ConstructorParameters<typeof ResendTransport>[0]; log?: (l: string) => void }): EmailPort {
  if (config.mode === "local" || config.mode === "preview") return new LogOnlyEmail(deps.log);
  if (!deps.resend) throw new Error("resend_not_configured");
  return new ResendTransport(deps.resend);
}
