# Launch checklist

The order agreed on 2026-09-30 (D-058). Each gate lists who owns it and the evidence that closes it. Nothing moves to the next stage until its gates are closed.

## Stage 1: finish the build (Claude)
- [ ] Openprovider adapter verified against the live sandbox (contract suite, recorded fixtures) — evidence: test run and `docs/registrar-parity.md`
- [ ] Creature redesign (species from the name, rarity from name quality, spec-driven hatch) — evidence: screenshots, distribution test
- [ ] Demo mode: banner, honest practice-hatch wording, waitlist with double opt-in and invites, pre-launch SEO — evidence: tests
- [ ] Full verification green (typecheck, unit and database, builds, every Playwright project) and CI green

## Stage 2: waitlist-only site (you + Claude)
- [ ] Resend DNS records for `send.mosshatch.com` added at Namecheap and verified (you add, Claude verifies)
- [ ] Deploy from a reviewed `main` branch (Claude)
- [ ] mosshatch.com pointed at Vercel at Namecheap (you; Claude confirms the records)
- [ ] Google Search Console domain property verified and sitemap submitted (you)
- [ ] 2FA on the real Openprovider account; sandbox password changed after testing (you)

## Stage 3: dogfood and live rehearsal (you, with Claude)
The exact steps, env vars and checks for the first live purchase, and how to roll back: `docs/GO-LIVE.md`.
- [ ] Openprovider membership bought and balance funded (you)
- [ ] Stripe live keys (restricted key) and live webhook, owner-only use (you + Claude)
- [ ] AWS account and KMS keys for production encryption (you + Claude)
- [ ] Rehearsal with your own names and card: one .com and one .dev, a refund inside the grace window, a renewal, lock and unlock, a DNS change, transfer out and back, a dispute drill in test mode (PLAN Phase 6)
- [ ] Backup restore drill on Neon recorded

## Stage 4: audit (outside parties)
- [ ] External penetration test (sign-in and recovery, step-up, payments, public site) and retest; findings closed or accepted in writing
- [ ] Counsel: registrar contract (Openprovider Articles 4, 11, 12, 35), registration agreement, terms, privacy policy, auto-renewal terms; the 14 draft documents finalised
- [ ] Openprovider written answers: terms precedence, 4% annual rise, expired-name parking opt-out, USD funding, what counts as an operation

## Stage 5: entity (you)
Decided 2026-09-30: Mosshatch operates under your parent LLC, to be filed in January 2027 (or the last two weeks of December 2026) so 2027 is its first California franchise-tax year; confirm dates with an accountant. Until then: waitlist-only site, owner dogfooding in your own name, audit and counsel review. Accounts opened before then move to the LLC once it exists.
- [ ] DBA "Mosshatch" filed for the parent LLC (LA County); confirm local registration and tax points with an accountant
- [ ] Live Stripe and Openprovider accounts in the parent LLC's name; separate bank account or books for Mosshatch
- [ ] Insurance (general and cyber liability) covering the parent LLC
- [ ] Legal name and address filled into the documents and footer as "Mosshatch, a trade name of [Parent LLC]" (Claude)
- [ ] Later: consider a subsidiary LLC to ring-fence Mosshatch's liability, or a Delaware C-corp if raising money

## Stage 6: invite-only launch, then public (you + Claude)
- [ ] Site mode switched to live with invite-only sign-up and the daily registration cap
- [ ] Invites sent in small batches from the waitlist
- [ ] 14 days without an unresolved registration or payment issue and no unacknowledged alert
- [ ] Open to the public; the Nest and agents follow as a second launch with their own audit
