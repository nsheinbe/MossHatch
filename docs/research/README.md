# Research evidence

Everything in `docs/PLAN.md` and `docs/DECISIONS.md` traces to a file here. Research date for all of it: **2026-09-29**.

**File kinds.**
- `<topic>.md`: the analyst's dossier. Each starts with a TL;DR; every non-trivial claim carries a source URL, the access date and, for load-bearing claims, a short exact quote. Claims the analyst could not verify are listed as unverified.
- `<topic>.verify-<lens>.md`: notes from an independent verifier who was told to refute the load-bearing claims by re-fetching the primary sources. The verifiers for some dossiers returned their findings inline instead of writing a file; those are all collected in `verification-digest.md`.
- `verification-digest.md`: every claim a verifier corrected, refuted or could not verify, plus what the verifier said the analyst missed, for all dossiers.
- `unit-economics.py` and `unit-economics-output.md`: the fee model (an analysis script, not application code) and its output.

**Paths that start with `working-directory/`** point to raw captures (downloaded pages, extracted text, scratch experiments) in the container where the research ran. They were not kept; the URLs, dates and quotes in each dossier are the evidence.

**Reading order.** `reg-*.md` (registrar dossiers) → `tld-registry-facts.md` → `stripe-*.md` and `tax-vat.md` → `icann-transfer-policy.md`, `registrar-data-obligations.md`, `lifecycle-and-consumer-law.md` → `tech-*.md` and `measure-*.md` → `tm-*.md` and `ref-*.md`.

**Limits.** The search tool's 200-call budget was exhausted early, so later work used direct fetches; sites that blocked access were not worked around. No credentials existed for any provider, so no live API call was made and nothing was deployed. Screenshots taken during the reference-site study (81 MB) are not kept.
