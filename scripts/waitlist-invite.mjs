#!/usr/bin/env node
// Owner-only invites for the gradual rollout. Picks the next N confirmed, still subscribed, never-invited people in line (or one
// address), creates a single-use invite each (random token, only its hash stored, expires in 14 days) and emails it through Resend.
//   DATABASE_URL=... RESEND_API_KEY=... node scripts/waitlist-invite.mjs --next 25
//   DATABASE_URL=... RESEND_API_KEY=... node scripts/waitlist-invite.mjs --email person@example.com
// Optional: DATABASE_URL_CRON (used instead of DATABASE_URL), WAITLIST_ORIGIN (default https://mosshatch.com), WAITLIST_FROM.
// Without RESEND_API_KEY nothing is created: an invite nobody receives would only hold a place. Prints counts only.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const next = arg("--next"), email = arg("--email");
if ((!next && !email) || (next && !/^\d+$/.test(next))) { console.error("Usage: waitlist-invite.mjs --next N | --email address"); process.exit(2); }
const url = process.env.DATABASE_URL_CRON ?? process.env.DATABASE_URL;
if (!url) { console.error("Set DATABASE_URL (owner or cron role)."); process.exit(2); }
if (!process.env.RESEND_API_KEY) { console.error("Set RESEND_API_KEY: invites are only created when they can be emailed."); process.exit(2); }
const { connect } = await import("../packages/db/src/index.ts");
const { ResendTransport } = await import("../packages/api/src/mail/transport.ts");
const { createInvites } = await import("../packages/api/src/waitlist/owner.ts");
const { FROM_DEFAULT } = await import("../packages/api/src/waitlist/text.ts");
const pool = connect(url, { max: 2 });
try {
  const mail = new ResendTransport({ apiKey: process.env.RESEND_API_KEY, from: process.env.WAITLIST_FROM ?? FROM_DEFAULT });
  const r = await createInvites(pool, mail, process.env.WAITLIST_ORIGIN ?? "https://mosshatch.com", email ? { email } : { next: Number(next) });
  console.log(`invited ${r.invited}, failed ${r.failed}${email ? `, skipped ${r.skipped} (not confirmed, unsubscribed, or holding an open invite)` : ""}`);
  if (r.failed) process.exitCode = 1;
} finally { await pool.end(); }
