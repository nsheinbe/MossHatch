# Acquisition measurement
Use links such as https://mosshatch.com/?utm_source=google&utm_medium=cpc&utm_campaign=launch_01.
Labels accept only letters, numbers, underscores and hyphens, at most 64 characters. Never put personal information in labels.

Attribution is captured in memory on app load and attached to the first waitlist signup. Repeat signups cannot overwrite it. No tracking cookies, ad pixels, click IDs or full URLs are stored. Navigation/reloads that lose the tagged URL and the plain HTML fallback form are unattributed.

Run `DATABASE_URL_CRON=... node scripts/acquisition-stats.mjs 30` using the existing secure database environment. This prints aggregate cohorts by signup date, including confirmed, active confirmed, invited and accepted. It never sends emails. Unconfirmed records expire after 30 days, so historical signup totals can shrink; export aggregate reports regularly if needed. Deletions also remove attribution.

Combine campaign spend from the ad platform with confirmed signup counts to calculate cost per confirmed signup. These are signup cohorts, not page-view analytics or proof of incremental lift. Accepted invites are not paid customers. Do not optimize for purchases until a real payment, registration, receipt and recovery journey has passed.

Before spending: provider login and funding healthy; registrar pause resolved through operations procedure; commercial policies completed; real end-to-end delivery and purchase verified. Keep paid campaigns off while those gates remain.
