import type { EmailPort } from "../ports.ts";
import type { AlertNotifier } from "./services.ts";

const ADDRESS = /^[^\s@<>,;]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;

/** The operator inbox for pages (`MH_ALERT_EMAIL`), or null when it is unset or not one plain address. */
export function alertAddressFromEnv(env: Record<string, string | undefined>): string | null {
  const v = env.MH_ALERT_EMAIL?.trim();
  return v && ADDRESS.test(v) ? v.toLowerCase() : null;
}

/**
 * Pages reach a person. Every alert is still logged; a page is also emailed to the operator inbox, once per alert id. Without an
 * address the notifier only logs, which is what left the 2026-10-03 page unseen until auto-safe paused registrar writes
 * (docs/AUDIT-2026-10-07.md). The mail carries the alert's kind and opaque subject only, never a customer value.
 */
export function createAlertNotifier(o: { email: EmailPort; to: string | null; log?: (line: string) => void }): AlertNotifier {
  const log = o.log ?? ((line: string) => console.warn(line));
  return {
    async notify(a) {
      log(`alert ${a.severity} ${a.kind}`);
      if (!o.to || a.severity !== "page") return;
      const ack = /^[0-9a-f-]{36}$/i.test(a.id) ? `update alerts set acked_at = now() where id = '${a.id}';` : "update alerts set acked_at = now() where id = '<the alert id>';";
      await o.email.send({
        dedupeKey: `ops.alert:${a.id}`, kind: "ops.alert", to: [o.to], klass: "C",
        subject: `Mosshatch page: ${a.kind}`,
        text: [
          `A page was raised: ${a.kind}${a.subject ? ` (${a.subject})` : ""}.`,
          "If nobody acknowledges it within 30 minutes, auto-safe pauses registrar writes and new registrations wait.",
          "Look at the cause first (docs/runbooks). To acknowledge it once handled:",
          ack,
          "If auto-safe already engaged, clearing the pause is a separate, deliberate step (docs/AUDIT-2026-10-07.md section 7).",
        ].join("\n\n"),
      });
    },
  };
}
