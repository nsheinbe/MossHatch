import type { EmailPort } from "../ports.ts";
import type { AlertNotifier } from "./services.ts";

const ADDRESS = /^[^\s@<>,;]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;

/** The operator inbox for pages (`MH_ALERT_EMAIL`), or null when it is unset or not one plain address. */
export function alertAddressFromEnv(env: Record<string, string | undefined>): string | null {
  const v = env.MH_ALERT_EMAIL?.trim();
  return v && ADDRESS.test(v) ? v.toLowerCase() : null;
}

/** One line of what to do, for the warnings that are emailed (alerts.ts `email`). Operator facts only, never a customer value. */
const GUIDANCE: Record<string, string> = {
  registrar_balance_underfunded: "The registrar's available balance, less what is reserved, no longer covers one registration above the sell-gate floor. Checkout refuses every new order (sell_gate) until the balance is topped up at the registrar, or the floor is lowered (flags.sell_gate.min_funds_minor). The hourly balance job closes this alert by itself once funds cover a registration.",
};

/**
 * Pages reach a person. Every alert is still logged; a page is also emailed to the operator inbox, once per alert id, and so is a
 * warning raised with `email` (a condition a person must act on where auto-safe would not help). Without an address the notifier only
 * logs, which is what left the 2026-10-03 page unseen until auto-safe paused registrar writes (docs/AUDIT-2026-10-07.md). The mail
 * carries the alert's kind and opaque subject only, never a customer value.
 */
export function createAlertNotifier(o: { email: EmailPort; to: string | null; log?: (line: string) => void }): AlertNotifier {
  const log = o.log ?? ((line: string) => console.warn(line));
  return {
    async notify(a) {
      log(`alert ${a.severity} ${a.kind}`);
      const page = a.severity === "page";
      if (!o.to || !(page || a.email)) return;
      const ack = /^[0-9a-f-]{36}$/i.test(a.id) ? `update alerts set acked_at = now() where id = '${a.id}';` : "update alerts set acked_at = now() where id = '<the alert id>';";
      await o.email.send({
        dedupeKey: `ops.alert:${a.id}`, kind: "ops.alert", to: [o.to], klass: "C",
        subject: `Mosshatch ${page ? "page" : "warning"}: ${a.kind}`,
        text: page ? [
          `A page was raised: ${a.kind}${a.subject ? ` (${a.subject})` : ""}.`,
          "If nobody acknowledges it within 30 minutes, auto-safe pauses registrar writes and new registrations wait.",
          "Look at the cause first (docs/runbooks). To acknowledge it once handled:",
          ack,
          "If auto-safe already engaged, clearing the pause is a separate, deliberate step (docs/AUDIT-2026-10-07.md section 7).",
        ].join("\n\n") : [
          `A warning was raised: ${a.kind}${a.subject ? ` (${a.subject})` : ""}. Nothing pauses by itself; it needs a person.`,
          ...(GUIDANCE[a.kind] ? [GUIDANCE[a.kind]!] : []),
          "To acknowledge it once handled:",
          ack,
        ].join("\n\n"),
      });
    },
  };
}
