# Purchase entry review — 2026-10-11

Based on remote main `64b9130602670b44ddfd75298d362f489206bcae`, in an isolated worktree and branch. The saved
`claude/vigilant-ritchie-8vinxb` branch was at `689ea51`; it and the original worktree were left unchanged.
No `.agents` skills or `AGENTS.md` were present. Read BUILD-CONTRACT, the October 8 handoff, build plan and purchase audit.

## UI changes

- Explain what registration includes (DNS management, renewal controls, creature), with website hosting and email service separate.
- State that public purchases are not open; keep the preview, invite gate and waitlist.
- Label preview registration and renewal amounts as test prices, including screen-reader labels and the shortlist.
- Explain that a shortlist is neither a cart nor a reservation. Keep the existing single-domain quote/checkout flow.
- Offer invited-account sign-in from a selected name. Keep its context through account and waitlist screens; pass the selected name to the waitlist form.
- Escape dismisses the frontmost waitlist/sign-in screen without clearing the selected name underneath; focus returns to the name. Returning with purchase access loads the existing live quote flow.
- Keep the price labels readable in the narrow sheet, separate the contextual buttons, and supply the missing homepage favicon (the browser checks exposed its 404).

No price values, server authorization, purchase execution, legal documents, registrar settings, DNS, credentials or billing configuration changed.
No real email or paid transaction was sent. Production merge/deployment is outside this task.

## Launch evidence and outstanding gates

These are separate from the UI work. Older GO-LIVE and LAUNCH-CHECKLIST documents are not current completion records.

- The October 8 handoff and BUILD-PLAN record a completed owner .com purchase at 16:14 UTC, after three failed attempts and fixes. This is repository evidence, not a new supplier/payment verification by this change.
- The same handoff explicitly leaves the live post-purchase verification pass open: renewal, refund window, auto-renew, Gate, Nest and transfer code; the build plan also requires a completed transfer-in rehearsal. Local fakes do not close these live verification gates.
- Owner tasks remain recorded for email DNS/reputation, Stripe statement descriptor/Managed Payments settings and accountant tax code. Their current completion cannot be inferred from unchanged source files.
- The build plan's F5 requires a verified supplier .com price for the November 1 price update. No price was changed or guessed here.
- Public activation still requires specific owner authorization and verified fulfillment readiness; this task grants neither.
- A read-only attempt to inspect the public session and health endpoints was blocked by the environment's outbound proxy (403). This is a verification limitation, not evidence the site is down. No production credentials were read.

## Validation

- All-workspace typecheck passed. Production build, bundle scan and budgets passed; initial JavaScript is 109.5 kB gzip (110 kB target, 130 kB hard limit).
- 110 targeted unit/integration tests passed (web, invite gate and checkout).
- Three invite browser scenarios passed: invited signup/sign-in/sign-out and return to the selected name; desktop and mobile Escape/waitlist continuity, no anonymous shop requests, accessible sheet, no horizontal overflow.
- Six distinct public-build browser scenarios passed across the final reruns: preview banner, registry search/practice hatch, first paint, Find/results/deal accessibility, keyboard selection/dismissal, and no-WebGL search. Used installed Chromium; the normal Playwright browser download was blocked by the environment proxy.
- Screenshots reviewed at 1280 × 844 and 390 × 844.
- Full unit/integration run: 1487 passed, 119 skipped, five failed. Four restore-related tests cannot spawn `/usr/lib/postgresql/16/bin/pg_dump` (absent on this host, although the local PostgreSQL container is running). The fifth was the CLI pack test using an unwritable default npm cache; rerunning its file with `npm_config_cache=/tmp/mh-npm-cache` passed all three tests. The full suite is not claimed green.
- Security-test ID check passed (155 scheduled). `git diff --check` passed. This repository defines no lint script or lint configuration.

Browser checks use local PostgreSQL, fake registrar/payment services and a recording mailbox; they cannot prove real supplier fulfillment or delivery. No routes or migrations were added. Temporary machine-specific browser configurations and screenshots are outside the commit; the added tests run under the repository's normal CI configuration.
