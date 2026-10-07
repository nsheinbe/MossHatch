import { describe, expect, it } from "vitest";
import { FakeEmail } from "../email.ts";
import { alertAddressFromEnv, createAlertNotifier } from "./notifier.ts";

describe("AUD-F10: pages reach a person (docs/AUDIT-2026-10-07.md)", () => {
  const id = "01a10233-f82c-7f7f-96c8-e7a5af9bfc39";

  it("a page is logged and emailed once to MH_ALERT_EMAIL, with how to acknowledge it and nothing but its kind and opaque subject", async () => {
    const email = new FakeEmail(); const lines: string[] = [];
    const n = createAlertNotifier({ email, to: "ops@example.org", log: (l) => lines.push(l) });
    await n.notify({ id, severity: "page", kind: "audit.anchor_stale", subject: "anchors" });
    await n.notify({ id, severity: "page", kind: "audit.anchor_stale", subject: "anchors" });     // the same alert again: one mail
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.to).toEqual(["ops@example.org"]);
    expect(email.sent[0]!.subject).toBe("Mosshatch page: audit.anchor_stale");
    expect(email.sent[0]!.text).toContain(`update alerts set acked_at = now() where id = '${id}';`);
    expect(email.sent[0]!.text).toContain("auto-safe pauses registrar writes");
    expect(lines).toEqual(["alert page audit.anchor_stale", "alert page audit.anchor_stale"]);
  });

  it("warnings are logged, not emailed; without an address nothing is emailed and the page is still logged", async () => {
    const email = new FakeEmail(); const lines: string[] = [];
    await createAlertNotifier({ email, to: "ops@example.org", log: (l) => lines.push(l) }).notify({ id, severity: "warn", kind: "outcome_unknown", subject: null });
    await createAlertNotifier({ email, to: null, log: (l) => lines.push(l) }).notify({ id, severity: "page", kind: "tick.stale", subject: null });
    expect(email.sent).toHaveLength(0);
    expect(lines).toEqual(["alert warn outcome_unknown", "alert page tick.stale"]);
  });

  it("an id that is not a UUID never lands in the SQL line", async () => {
    const email = new FakeEmail();
    await createAlertNotifier({ email, to: "ops@example.org", log: () => undefined }).notify({ id: "x'; drop table alerts; --", severity: "page", kind: "k", subject: null });
    expect(email.sent[0]!.text).not.toContain("drop table");
  });

  it("MH_ALERT_EMAIL must be one plain address", () => {
    expect(alertAddressFromEnv({ MH_ALERT_EMAIL: " Ops@Example.org " })).toBe("ops@example.org");
    expect(alertAddressFromEnv({ MH_ALERT_EMAIL: "a@b.org, c@d.org" })).toBeNull();
    expect(alertAddressFromEnv({ MH_ALERT_EMAIL: "not an address" })).toBeNull();
    expect(alertAddressFromEnv({})).toBeNull();
  });
});
