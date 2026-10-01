import type { PoolClient } from "@mosshatch/db";
import type { EmailMessage, EmailPort } from "./ports.ts";

/** Records outgoing mail for assertions; also the "log only" transport of Local and Preview (no addresses or bodies persisted by the app). */
export class FakeEmail implements EmailPort {
  sent: (EmailMessage & { id: string })[] = [];
  private seen = new Set<string>();
  async send(msg: EmailMessage) {
    if (this.seen.has(msg.dedupeKey)) return { id: "dup" };
    this.seen.add(msg.dedupeKey);
    const id = "fake_" + this.sent.length;
    this.sent.push({ ...msg, id });
    return { id };
  }
  to(address: string) { return this.sent.filter((m) => m.to.includes(address)); }
  last() { return this.sent[this.sent.length - 1]; }
  clear() { this.sent = []; this.seen.clear(); }
}

/**
 * Idempotent send: the `email_log` row (unique dedupe key, no body, no address) is claimed first, then the provider is
 * called, then the row is updated. A duplicate call returns without sending.
 */
export async function sendMail(c: PoolClient, port: EmailPort, msg: EmailMessage): Promise<{ sent: boolean }> {
  const claim = await c.query(
    "insert into email_log (kind, dedupe_key, user_id, status) values ($1,$2,$3,'queued') on conflict (dedupe_key) do nothing returning id",
    [msg.kind, msg.dedupeKey, msg.userId ?? null],
  );
  if (claim.rowCount === 0) return { sent: false };
  const { id } = await port.send(msg);
  await c.query("update email_log set provider_message_id = $2, status = 'sent' where id = $1", [claim.rows[0].id, id]);
  return { sent: true };
}
