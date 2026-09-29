# Neon Postgres, Drizzle ORM and Resend: verified facts for MossHatch Phase 0

## TL;DR

1. **Neon today** is Free / Launch / Scale, pure usage-based (no base fee): Launch $0.106 per CU-hour, Scale $0.222 per CU-hour, storage $0.35 per GB-month, PITR history $0.20 per GB-month. Free (0.5 GB, 6 h PITR, compute suspends at the quota) is not a production plan. Launch gives PITR up to 7 days; Scale gives 30 days, IP Allow, PrivateLink, the 99.95% SLA and SOC 2 report access at 2.1x the compute price [N1-N8, N26, N37-N47].
2. **Region:** Neon `aws-us-east-1` pairs with Vercel's default function region `iad1` (= us-east-1). A Neon project's region can never be changed, so pin it deliberately. Neon's status history shows 6 database-connectivity incidents across regions in May-Sep 2026 and no cross-region replication [N22-N25, N48-N54].
3. **Driver verdict:** Drizzle `neon-http` still has NO interactive transactions (`db.transaction()` throws "No transactions support in neon-http driver" in drizzle-orm 0.45.3 and 1.0.0-rc.4; only `db.batch()`). Neon itself now recommends node-postgres over TCP with a pool and `attachDatabasePool` on Vercel Fluid. Use that (or the `neon-serverless` WebSocket driver) for idempotency keys, ledger and audit writes [D5-D12, N17-N19].
4. **Drizzle versions:** npm `latest` is 0.45.3 (2026-09-21); 1.0 is still RC (rc.4, 2026-06-27) and the docs now default to `@rc`. Migrations: `drizzle-kit generate` + `migrate` over the direct (unpooled) URL, hand-written `--custom` migrations for REVOKE/triggers; Drizzle's own docs say `push` is used in production by some teams, so "no push in prod" is our policy, not theirs [D1-D4, D14-D18].
5. **Postgres patterns all check out in the current (18.x) docs:** owner rights cannot be revoked (app role must not own the audit table), BEFORE triggers can RAISE, TRUNCATE needs its own statement trigger, `FOR UPDATE SKIP LOCKED` suits job queues, only transaction-level advisory locks are safe (Neon's pooler rejects session-level), `UNIQUE` + `ON CONFLICT` gives atomic idempotency, RLS is default-deny but owners/BYPASSRLS roles skip it [P1-P21, N14].
6. **Trap:** roles created in the Neon Console/API/CLI (including `neondb_owner`) get `neon_superuser` with BYPASSRLS and CREATEROLE. Create the runtime role with SQL and grant only what it needs [N55].
7. **Resend:** Free 3,000/mo and 100/day (1 webhook endpoint, 3 domains); Pro $20/mo = 50,000 (5 webhook endpoints, 10 domains); API limit 10 requests/s per team; `Idempotency-Key` on `/emails` and `/emails/batch` (24 h, 256 chars, 409 on payload mismatch); batch = 100 emails, no attachments; Svix-signed webhooks with 8 retries [R1-R15, R26-R27].
8. **Resend privacy:** email content, metadata and logs are kept 30 days (dashboard logs show the full request body), stored in the US whatever sending region you pick, and a small sample is processed by a trust-and-safety subprocessor. Never put secrets, tokens or approval links in an email; keep tracking off; enable Enforced TLS [R28-R37].
9. **Alternatives:** Postmark $15/mo per 10k (45-day retention default), SES $0.10 per 1,000 (sandbox first); neither fetched page shows an idempotency-key parameter, so keep an outbox with local dedupe regardless of vendor [A1-A7].
10. **Not verifiable here:** Neon Trust Center (403), Drizzle's GitHub issue tracker (proxy 403), whether `neondb_owner` can bypass triggers via `session_replication_role`, Resend webhook ordering guarantees. See section 8.


Prepared 2026-09-29. Every fact below was fetched on 2026-09-29 from the provider's own page (or the npm registry / package source). Bracketed IDs such as [N26] point to the Findings Register in section 10, which carries the exact URL, the access date and a verbatim quote (each quote was machine-checked against the saved page text). Statements marked **(design reasoning)** are my inference, not provider claims.

---

## 1. Neon Postgres

### 1.1 Plans and prices (all rows accessed 2026-09-29)

Source for the whole table: https://neon.com/docs/introduction/plans (also https://neon.com/pricing, which agrees). Plan names are now Free / Launch / Scale; the SLA page still says "Business or Scale" (legacy name) [N47].

| Item | Free | Launch | Scale |
|---|---|---|---|
| Price model | $0/month | usage-based, no minimum [N1] | usage-based, no minimum |
| Compute | 100 CU-h per project per month | $0.106 per CU-h [N2] | $0.222 per CU-h [N3] |
| Max compute | 2 CU (8 GB RAM) | autoscale to 16 CU (64 GB) | autoscale to 16 CU; fixed up to 56 CU (224 GB) [N7] |
| Scale to zero | 5 min, cannot disable | 5 min, can disable | 1 min to always on [N8] |
| Storage | 0.5 GB per project | $0.35 per GB-month [N4] | $0.35 per GB-month |
| Projects | 100 | 100 | 1,000 (soft, on request) |
| Branches per project included | 10 | 10 | 25 |
| Extra branches | not available | $1.50 per branch-month, prorated hourly (max 5,000) [N32] | same |
| Public egress | 5 GB per project | 500 GB per project then $0.10/GB [N59] | same |
| Monitoring retention | 1 day | 3 days | 14 days |
| Metrics/log export (Datadog, OTel) | no | no | yes |
| Spending notifications | no | yes (80% and 100% of a threshold; no hard cap documented) [N58] | yes |
| PITR (history window) max | 6 h, capped at 1 GB of history, free | 7 days, $0.20 per GB-month of retained WAL [N26] | 30 days, $0.20 per GB-month |
| PITR default window | 6 h | 1 day [N27] | 1 day |
| Snapshots | 1 manual | 100 manual, $0.09 per GB-month, scheduled backups on paid plans [N31] | same |
| Protected branches | no | yes | yes |
| IP Allow | no | no | yes [N37] |
| Private Networking (AWS PrivateLink) | no | no | yes, $0.01 per GB [N38] |
| Compliance / SOC 2 report access | not listed | not listed | SOC 2, SOC 3, ISO 27001/27701, GDPR, CCPA; HIPAA extra charge [N43] |
| Uptime SLA | no | no | yes [N45] |
| Support | Community | Billing support | Standard |
| Org members | unlimited | unlimited | unlimited |

Free-plan behaviour at the limit: compute is suspended until the next billing period or until you upgrade; hitting the 0.5 GB cap makes writes fail; branch creation fails at 10 [N6]. Not a production plan.

Cost sketch (my arithmetic, using Neon's own 750-hour basis for an always-on 0.25 CU compute = 187.5 CU-h): Launch about $19.88/month compute; Scale about $41.63/month compute; plus storage and history. With scale-to-zero on, Neon's own "intermittent load" example (140 CU-h, 1 GB) is about $15/month on Launch [N10]. The Launch to Scale premium is 2.09x on compute.

### 1.2 Connection limits

| Compute | RAM | max_connections (direct) |
|---|---|---|
| 0.25 CU | 1 GB | 104 (7 reserved for Neon) |
| 1 CU | 4 GB | 419 |
| 2 CU | 8 GB | 839 |
| 9 to 56 CU | 36 to 224 GB | 4,000 |

Source: https://neon.com/docs/connect/connection-pooling [N12, N16]. The PgBouncer pooler accepts up to 10,000 client connections, default pool size is 90% of max_connections per user/database pair, and queued clients time out after 120 s; these settings are not user-configurable [N63].

### 1.3 Autosuspend ("scale to zero") and cold start

- Default suspend is after 5 minutes idle; paid plans can disable it; Scale can go down to 1 minute; the latency doc says the timeout can be extended up to 7 days [N8, N9, N62].
- Cold start: "activating a Neon compute from an idle state typically takes a few hundred milliseconds" [N9]; Neon's pricing page uses "350ms" in an example [N10]. These are Neon's own claims; I could not measure them from the Vercel side.
- If scale-to-zero is disabled, Neon recommends a manual weekly compute restart to pick up compute image updates [N11].
- **(design reasoning)** For a product whose money-moving path is a passkey approval, disable scale-to-zero on the production branch (cost about $20/month at 0.25 CU minimum) and keep it on for preview/CI branches.

### 1.4 Pooled vs unpooled connection strings

- Pooled host = endpoint id plus `-pooler`; PgBouncer runs in `pool_mode=transaction` [N12, N13].
- Not supported on pooled connections: `SET`/`RESET`, `LISTEN`/`NOTIFY`, SQL-level `PREPARE`, `WITH HOLD` cursors, temp tables with preserve, `LOAD`, and **session-level advisory locks** [N14].
- Use the direct string for schema migrations (Neon names Drizzle Kit explicitly), `CREATE INDEX CONCURRENTLY`, `LISTEN/NOTIFY`, pg_dump [N15].
- The Vercel-managed Neon integration injects `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct) [N35].

### 1.5 The serverless driver on Vercel functions (HTTP vs WebSocket vs plain TCP)

| Option | Transport | Interactive transactions | First-query cost | Neon's guidance |
|---|---|---|---|---|
| `pg` (node-postgres) + pooled URL + `attachDatabasePool` | TCP | yes | about 8 round trips once, then reused | Recommended on Vercel Fluid compute [N17, N18, V1] |
| `@neondatabase/serverless` `Pool`/`Client` | WebSocket | yes | about 4 round trips | For classic serverless / edge; needs `ws` on Node; create and close inside one request [N19, N21] |
| `@neondatabase/serverless` `neon()` | HTTP fetch | no; only `sql.transaction([...])` (non-interactive) | about 3 round trips | Fastest single query; 64 MB request/response cap [N19, N20] |

Facts that decide it: Fluid compute is on by default for new Vercel projects since 2025-04-23 [V2]; `attachDatabasePool` exists in `@vercel/functions` 3.9.9 [V3]; driver v1.x needs Node 19+ and is at 1.1.0 (2026-04-17) [D3]. Neon adds a benchmark caveat: apps with very many cold starts may still favour HTTP [N18].

### 1.6 Regions

Eight AWS regions: us-east-1 (N. Virginia), us-east-2 (Ohio), us-west-2 (Oregon), eu-central-1 (Frankfurt), eu-west-2 (London), ap-southeast-1, ap-southeast-2, sa-east-1; Azure regions are deprecated for new projects [N22]. Region is fixed per project; moving means a new project plus data migration [N23].

Vercel Functions default to `iad1` (Washington, D.C.) for new projects and `iad1` maps to AWS `us-east-1` [N24, N25]. **Pick `aws-us-east-1`** and pin the function region in `vercel.json` so the pairing is explicit. Status history shows incidents in both us-east regions in the last five months (section 1.11), so the choice buys latency, not immunity. Neon's guidance is to place the application and database in the same region [N61].

### 1.7 Point-in-time restore

| | Free | Launch | Scale |
|---|---|---|---|
| Max window | 6 h (1 GB cap) | 7 days | 30 days |
| Default | 6 h | 1 day | 1 day |
| Billing | free | $0.20 per GB-month of WAL | same |

Sources: [N26, N27]. Restore works on root branches only [N28]. A restore is a complete overwrite of the branch timeline (not a merge) and Neon keeps the pre-restore state as a backup branch named `{branch}_old_{timestamp}` [N29]. Setting the window to 0 turns PITR off [N30]. The Neon backups page says "1 day up to 30 days, depending on your Neon plan" while the plans page says Free is 6 hours; the plans page is the specific one (https://neon.com/docs/postgres/backup-restore/backups).

**(design reasoning)** A PITR restore rewinds the audit log along with everything else. Treat a restore as an audited incident and keep an external anchor of the audit hash chain (section 3.1).

### 1.8 Branching for CI and previews

- Copy-on-write branches; TTL via `expires_at` / `--expires-at` (Console default is 1 day) [N33].
- Neon publishes GitHub Actions to create, delete and reset branches and post a schema diff to the PR [N34].
- Vercel-managed integration creates one branch per Vercel preview deployment, but cleanup follows Vercel's deployment retention (default 6 months), so branches can linger for months [N35, N36]. Cheaper hygiene: GitHub Action delete on PR close plus a TTL.
- Launch includes 10 branches per project; extras cost $1.50 per branch-month [N32].
- **(design reasoning)** A child branch inherits the parent's data, including registrant PII and vault ciphertext. Parent previews off a seeded or anonymised branch, not production. The docs nav lists "Schema-only branches" and "Data anonymization"; I did not fetch those pages (section 8).

### 1.9 IP allow-list and private networking

- IP Allow: Scale plan only [N37]. Private Networking (AWS PrivateLink): Scale only, and only for Organization (not Personal) accounts [N38, N66].
- Vercel deployments use dynamic egress IPs; Static IPs are a Pro/Enterprise add-on at $100 per project per month plus data transfer [N39].
- **(design reasoning)** For Phase 0 an IP allow-list on Neon is uneconomic (Scale compute premium plus $100/month Vercel Static IPs). Compensating controls: TLS with `verify-full` (Neon requires TLS on every connection) [N41], least-privilege SQL-created roles [N55], credential rotation by password reset [N65], and GitHub secret-scanning (Neon is a partner) [N64]. Whether Vercel Functions can reach a Neon PrivateLink endpoint was not verified.

### 1.10 Encryption at rest and SOC 2

- At rest: AES-256; keys managed in AWS KMS with rotation; TLS 1.2/1.3 in transit [N40, N41].
- Compliance page: SOC 2 Type 1 and Type 2, SOC 3, ISO 27001, ISO 27701, GDPR, CCPA; reports are requested through the Trust Center "if available on your plan" [N42, N44]. The plans page lists the certifications and the SOC 2 report under Scale [N43]. The Trust Center itself returned 403 to my fetch, so what a Launch customer can actually download is unverified.
- Neon's encryption is platform-level (storage and transport). **(design reasoning)** The vault's confidentiality must come from our own envelope encryption with the cloud KMS, not from Neon's disk encryption; PITR history keeps old ciphertext for the history window and snapshots keep it for as long as they exist, so key destruction is the real delete.

### 1.11 Uptime record

- SLA: Scale (and legacy Business) only; covers Compute Endpoints only; credits of 10% below 99.95%, 15% below 99.0%, 20% below 98.0%, 80% below 96.0%; credit-only remedy; the SLA states both a 21-day (section 2.2) and a 24-hour (section 3.1.1) deadline to open a support ticket [N45-N47] (https://neon.com/sla, last modified Feb 20, 2026).
- Status page on 2026-09-29: "All Systems Operational"; maintenance on Neon auth services 2026-09-30 08:00-09:00 UTC [N50]. The page shows no uptime percentage.
- The status history page (covers May to Sep 2026; entries dated 2026-05-07 to 2026-08-17) lists 14 non-maintenance incident entries. Six touched "Database Connectivity": 2026-05-07 sa-east-1, 05-08 us-east-1 (Cell 6, partial disruption), 05-10 us-east-2, 05-25 sa-east-1, 07-11 us-west-2, 07-15 eu-central-1. Others: compute start failures in us-east-1 on 08-10, branch reset/restore failures in us-east-2 on 08-17 [N51-N53]. Planned maintenance windows on Neon's internal databases (e.g. 2026-09-16/17) can raise API and database-start latency; running databases are unaffected [N54].
- HA: storage is multi-AZ; compute is stateless and single-AZ at any time; AZ failure recovery 1-10 minutes; no cross-region replication [N48, N49]. Scale and Enterprise get 3 days' notice of planned compute updates from 2026-07-10 [N60].

### 1.12 Roles

Roles created in the Console, CLI or API (including the default `neondb_owner`) join `neon_superuser` (CREATEDB, CREATEROLE, BYPASSRLS, REPLICATION); roles created with SQL get only basic public-schema privileges [N55]. Postgres major versions 14-18 are available with the latest minors (18.6 etc. as of Aug 2026); a major upgrade means a new project [N56]. `pgcrypto` and `pg_partman` are available [N57].

---

## 2. Drizzle ORM

### 2.1 Versions (npm registry, 2026-09-29)

| Package | `latest` | Pre-release tags |
|---|---|---|
| drizzle-orm | 0.45.3 (2026-09-21) | beta 1.0.0-beta.22 (2026-04-16); rc 1.0.0-rc.4 (2026-06-27) |
| drizzle-kit | 0.31.11 (2026-09-21) | rc 1.0.0-rc.4 |
| @neondatabase/serverless | 1.1.0 (2026-04-17) | none |

Sources: [D1-D3]. The Drizzle docs now install with `drizzle-orm@rc` [D4], so docs and `latest` disagree; an `rc5` dist-tag points at pre-release build `1.0.0-rc.5-5935859` (2026-09-09) while the `rc` tag still points at rc.4 [D21], so 1.0 has no clean rc.5 yet.

### 2.2 Drivers and what each can do

| Import path | Underlying client | Interactive `db.transaction()` | `db.batch()` | Note |
|---|---|---|---|---|
| `drizzle-orm/node-postgres` | `pg` (TCP) | yes | no | Neon's Vercel Fluid recommendation [N17] |
| `drizzle-orm/postgres-js` | `postgres` (TCP) | yes (standard) | no | documented Neon option [D5]; not source-checked |
| `drizzle-orm/neon-serverless` | `@neondatabase/serverless` Pool/Client (WebSocket) | yes; issues real BEGIN/COMMIT/ROLLBACK and savepoints [D11] | no | Drizzle docs call it "neon-websockets"; needs `ws` on Node [D5, D6] |
| `drizzle-orm/neon-http` | `neon()` over fetch | **no**; throws [D7, D8] | yes, executed as one Neon non-interactive transaction [D9] | one-shot statements only |

Where interactive transactions exist, Drizzle supports nested transactions as savepoints and per-transaction isolation level, access mode and deferrable settings [D13].

### 2.3 Does neon-http support interactive transactions? No (verified in source today)

`NeonHttpSession.transaction()` is `throw new Error("No transactions support in neon-http driver")` in both drizzle-orm 0.45.3 (`latest`) and 1.0.0-rc.4 (files `neon-http/session.js` from the published tarballs) [D7, D8]. Drizzle's docs steer you to the WebSocket driver for interactive transactions [D6]. `db.batch([...])` runs a fixed list of statements atomically via Neon's `transaction()` but cannot read a value and then decide what to write, so it cannot implement "check idempotency key, then debit, then write audit row" in one atomic unit. The neon-http migrator even warns "if any part of a migration fails, no rollback will be executed" [D10].

### 2.4 Migration workflow

- **Production path:** `drizzle-kit generate` writes SQL migration files from schema diffs; `drizzle-kit migrate` applies unapplied ones and records them in `drizzle.__drizzle_migrations` (table and schema configurable) [D14, D15].
- **Hand-written SQL:** `drizzle-kit generate --custom --name=...` creates an empty migration for DDL Drizzle Kit cannot express [D17]. The Drizzle docs index has no trigger or GRANT/REVOKE DSL (absence, low confidence) [D20], so REVOKE, trigger functions, `ENABLE ALWAYS TRIGGER`, RLS enabling and partition DDL belong in custom migrations.
- **Connection for migrations:** use the direct URL (Neon names Drizzle Kit) [N15]. `drizzle-kit` chooses a driver by installed package (`pg`, then `postgres`, then `@vercel/postgres`, then `@neondatabase/serverless`, which is WebSocket-only) [D19]; with `pg` installed, the pg dialect wraps all pending migrations in one transaction [D12], which gives all-or-nothing DDL; **(design reasoning)** statements that cannot run inside a transaction, such as `CREATE INDEX CONCURRENTLY`, would then fail and need a separate mechanism.
- **`push`:** introspects the database, diffs and applies with no SQL files. Drizzle says it is "the best approach for rapid prototyping" and that dozens of teams use it in production [D16]. That conflicts with our rule; our reason is auditability: `push` leaves no reviewable migration artefact and cannot carry custom SQL. Keep `push` for throwaway dev/preview branches only.
- **v1 layout change:** Drizzle 1.0 moves to one folder per migration (`migration.sql` plus snapshot) with no `journal.json`, and `drizzle-kit up` converts old folders [D18]. Decide 0.45.x vs 1.0-rc before writing the first migration.

### 2.5 Known issues and watch-outs

1. `neon-http` transactions (above); no rollback in its migrator.
2. Docs (`@rc`) and `latest` (0.45.3) describe different major lines.
3. Pooled URL plus session state: `SET`, session advisory locks and SQL `PREPARE` break under PgBouncer transaction mode [N14]; **(design reasoning)** Drizzle transactions should be fine because transaction-mode pooling holds one server connection for the whole transaction.
4. `drizzle-kit` silently prefers `pg` over the Neon WebSocket driver if both are installed [D19].
5. The Drizzle GitHub issue tracker could not be reached (the sandbox proxy answered 403 for github.com outside the session's repositories), so I cannot list open bugs; this section rests on package source, docs and the npm registry.

---

## 3. Postgres patterns (verified against PostgreSQL 18.6 docs, the current release; PG 19 is in beta) [P1]

### 3.1 Append-only audit log

| Control | Verified behaviour | Caveat |
|---|---|---|
| `REVOKE UPDATE, DELETE, TRUNCATE` from the runtime role | Owner rights cannot be revoked: "The right to drop an object, or to alter its definition in any way ... cannot be granted or revoked", though an owner may revoke some of its own privileges [P2, P3] | The runtime role must not own the table; keep an owner role (`migrator`) used only by CI |
| BEFORE UPDATE/DELETE row trigger that raises | `RAISE EXCEPTION` aborts the statement [P4]; returning NULL silently skips the row [P5] | Raise, do not return NULL |
| BEFORE TRUNCATE statement trigger | TRUNCATE triggers can only be FOR EACH STATEMENT [P6]; TRUNCATE does not fire DELETE triggers [P7] | Needs its own trigger |
| Trigger bypass | Owner can `ALTER TABLE ... DISABLE TRIGGER`; superuser or SET-privileged roles can set `session_replication_role = replica` [P8, P9] | Mark triggers `ENABLE ALWAYS`; keep app role unprivileged; whether Neon's `neondb_owner` can do this is unverified |
| Hash chaining | Built-in `sha256(bytea)` and pgcrypto `digest()` exist [P10, P11] | Chain appends must be serialised per chain (row lock on a chain-head row or `pg_advisory_xact_lock`, section 3.3) |
| Partitioning | Unique/PK constraints must include all partition-key columns [P20]; old partitions can be detached, even CONCURRENTLY [P21] | Not needed in Phase 0; `pg_partman` is available on Neon [N57] |

**(design reasoning)** A hash chain is tamper-evident, not tamper-proof: anyone holding the owner credential can rewrite rows and recompute hashes. Publish the chain head periodically to a store the database admin cannot rewrite (for example a signed head hash written to object storage with retention lock, or to a separate account). Combined with Neon's PITR overwrite semantics [N29], this is what makes the log defensible.

### 3.2 Jobs table with SKIP LOCKED

`SELECT ... FOR UPDATE SKIP LOCKED` skips rows that cannot be locked immediately and is documented for "multiple consumers accessing a queue-like table" while warning it gives an "inconsistent view" unsuitable for general use [P12]. Row locks live for the transaction, so this works through Neon's transaction-mode pooler. **(design reasoning)** Pair it with a transactional outbox: the business transaction inserts the job/email row; a short worker transaction claims a batch, marks attempt and lease, commits, then performs the side effect outside the lock. What triggers the worker on Vercel (cron, queue) is outside this dossier's scope and was not verified.

### 3.3 Advisory locks

Session-level locks ignore transaction rollback; transaction-level locks release at transaction end [P13]; `pg_advisory_xact_lock(bigint)` is the function to use [P14]. Neon's pooler does not support session-level advisory locks [N14]. Rule: only `pg_advisory_xact_lock*` on pooled connections.

### 3.4 Unique indexes for idempotency keys

A unique constraint or primary key automatically builds a unique index [P15]. `INSERT ... ON CONFLICT DO UPDATE` guarantees an atomic insert-or-update "even under high concurrency"; `DO NOTHING` skips the insert [P16, P17]. **(design reasoning)** Table shape: unique on (principal, operation, key); store a request hash and the stored response; same key plus same hash returns the stored response, same key plus different hash returns 409, in-flight duplicate returns 409 retry. This mirrors Resend's documented behaviour [R12]. The insert and the effect must share one transaction, which rules out `neon-http`.

### 3.5 Row-level security

With RLS enabled and no policy the table is default-deny; superusers and BYPASSRLS roles always bypass; owners bypass unless `FORCE ROW LEVEL SECURITY` [P18, P19]. TRUNCATE and REFERENCES are not subject to RLS (so REVOKE TRUNCATE still matters) [P18]. Neon-specific: Console/API-created roles carry BYPASSRLS [N55], so RLS only works for a SQL-created runtime role; per-request context must be set transaction-locally (Neon's own example uses `set_config(..., true)` inside a transaction) because pooled sessions do not keep `SET` [N14]. Drizzle can declare policies (`pgPolicy`, and a `crudPolicy` helper under `drizzle-orm/neon`) per its RLS docs (https://orm.drizzle.team/docs/rls).

---

## 4. Resend

### 4.1 Pricing tiers (https://resend.com/pricing.md; accessed 2026-09-29) [R1, R2, R4]

| Plan | Price | Emails/month | Overage per 1,000 |
|---|---|---|---|
| Free | $0 | 3,000 (max 100/day) | none |
| Pro | $20 | 50,000 | $0.90 |
| Pro | $35 | 100,000 | $0.90 |
| Scale | $90 | 100,000 | $0.90 |
| Scale | $160 | 200,000 | $0.80 |
| Scale | $350 | 500,000 | $0.70 |
| Scale | $650 | 1,000,000 | $0.65 |
| Scale | $825 | 1,500,000 | $0.52 |
| Scale | $1,150 | 2,500,000 | $0.46 |
| Enterprise | custom | custom | custom |

Add-ons: extra 100 domains $20/mo; dedicated IPs $30/mo (Scale, more than 3,000 emails/day); SSO $150/mo. Marketing (Broadcasts) is a separate contact-based price list and not needed here.

Plan feature limits [R3]: custom domains 3 / 10 / 1,000 (Free / Pro / Scale); webhook endpoints 1 / 5 / 10; data retention 30 days on all three. Sent and received emails both count toward quota, and every To/CC/BCC recipient counts as a separate email [R7]. Overage is optional pay-as-you-go with a default hard stop at 5x the monthly quota [R8].

### 4.2 Sending limits

- API rate limit: 10 requests per second per team, shared across all API keys, no burst allowance, 429 on excess; increase on request; response headers `ratelimit-*` and `retry-after` [R5, R6]. A batch call counts as one request.
- Quota headers `x-resend-daily-quota` (Free only, UTC day) and `x-resend-monthly-quota`; errors `daily_quota_exceeded` / `monthly_quota_exceeded` (429) [R42].
- Reputation guardrails: bounce rate under 4% and spam rate under 0.08% or sending may pause [R9].
- Per email: `to` max 50; attachments max 40 MB after Base64 [R15].

### 4.3 Domain verification records

Generated per domain by Resend (example from the create-domain API response, values are placeholders) [R16-R18]:

| Purpose | Type | Name | Value pattern |
|---|---|---|---|
| DKIM | TXT | `resend._domainkey` | `p=<public key>` |
| SPF (Return-Path) | MX | `send` | `feedback-smtp.us-east-1.amazonses.com`, priority 10 (region-specific) |
| SPF | TXT | `send` | `v=spf1 include:amazonses.com ~all` |
| Tracking (optional) | CNAME | `links` | `links1.resend-dns.com` |
| DMARC (you add it) | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:<reports address>;` then tighten to quarantine/reject [R19] |

Return-Path defaults to `send.<your domain>` and carries SPF and DMARC alignment [R18]. Verification usually completes within 15 minutes, up to 72 hours; CNAMEs must not be proxied (Cloudflare orange cloud) [R20]. Resend recommends a dedicated sending subdomain for reputation isolation [R21]. Resend states a message needs to pass only one of SPF or DKIM for DMARC compliance (https://resend.com/docs/dashboard/domains/dmarc).

### 4.4 Idempotency-Key

Supported on `POST /emails` and `POST /emails/batch`; header `Idempotency-Key` (SMTP: `Resend-Idempotency-Key`); key length 1-256; retained 24 hours; same key and payload returns the original response without re-sending; 409 `invalid_idempotent_request` on a different payload; 409 `concurrent_idempotent_requests` while the first is in flight; 400 `invalid_idempotency_key` [R10-R12]. Resend suggests keys like `<event-type>/<entity-id>`. **(design reasoning)** The 24-hour window is shorter than a long outbox retry horizon, so dedupe locally as well.

### 4.5 Webhooks

- Email events: `email.sent`, `delivered`, `delivery_delayed`, `bounced` (permanent rejection), `complained` (delivered, then marked spam), `failed`, `suppressed`, `opened`, `clicked`, `scheduled`, `received`; plus domain, contact, topic and suppression events [R25].
- Signing: Svix (`svix-id`, `svix-timestamp`, `svix-signature`); verify against the raw body [R27].
- Retries: 8 attempts with exponential backoff (immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h); persistent failure auto-disables the endpoint (email notice); any message, failed or succeeded, can be replayed [R26].
- Endpoints per plan: 1 / 5 / 10 [R3]. Gmail/Google Workspace typically do not report complaints [R38].
- Not documented on the fetched pages: event ordering guarantees, per-request timeout. Dedupe on `svix-id` and make handlers order-independent.

### 4.6 Batch API

Up to 100 emails per call, each with its own recipients and content; `Idempotency-Key` supported; attachments are not supported in batch [R13, R14].

### 4.7 Data retention and privacy

- Email content, metadata, delivery status/events, logs and metrics are kept 30 days on Free, Pro and Scale (Enterprise flexible) [R28, R29]. Dashboard logs display the complete request payload [R30]. Resend will remove a specific message earlier on request; remaining data is deleted within 90 days of termination [R31, R32].
- Data is stored in the United States, including message content, delivery logs and webhook payloads, whatever sending region is chosen [R23, R31].
- A small sample of emails is processed by RunPod on Resend-operated infrastructure for trust and safety; Anthropic sees content only through the AI editor/support agent; no training on customer content [R33].
- Security posture: SOC 2 Type II (not HIPAA, not ISO 27001), datastores encrypted at rest, TLS 1.3 in transit, 7-day backups [R34, R35].
- **Never put secrets or tokens in emails** (also true because mail transits third-party systems). Content is retained 30 days, is readable by anyone with dashboard/API-log access, and a sample is machine-processed. Use notification-only emails with no credential material.
- TLS is opportunistic by default (falls back to unencrypted); Enforced TLS is an opt-in per-domain setting [R36]. Open/click tracking is documented as off by default, but the create-domain API example response shows `open_tracking: true`; set both flags explicitly to false on the transactional domain [R37].

### 4.8 Region selection

Four sending regions, chosen per domain: us-east-1, eu-west-1, sa-east-1, ap-northeast-1 [R22]. Region controls where mail is sent from, not where data is stored [R23]. Changing a domain's region means deleting and re-adding it and updating DNS [R24]. Multi-region for one domain uses per-region subdomains.

### 4.9 Reliability

Status page (https://resend-status.com/) for Aug-Sep 2026: Email Sending 99.93% uptime (Broadcast Emails 99.93%; single, batch, scheduled, SMTP, API, webhooks 100%) [R40]. No contractual SLA below Enterprise was found.

### 4.10 API coverage relevant to MossHatch

| Capability | Supported | Limits | Register |
|---|---|---|---|
| Send single (`POST /emails`) | yes | to max 50; attachments 40 MB; `scheduled_at`; tags; custom headers | R15 |
| Send batch (`POST /emails/batch`) | yes | 100 per call; no attachments | R13, R14 |
| Idempotency | yes on both | 24 h; 256 chars; 409 semantics | R10-R12 |
| SMTP relay | yes | `Resend-Idempotency-Key` header | R10 |
| Webhooks | yes | Svix signing; 8 retries; replay; 1/5/10 endpoints | R25-R27 |
| Domains API | create/verify/update/delete | region, tracking flags, `custom_return_path`, tracking subdomain | R16-R24 |
| API keys | yes | name, permission, optional domain restriction; value shown once | R39 |
| Suppressions | list/add/remove | team-wide; origins bounce, complaint, manual | R38 |
| Logs | dashboard and API | full request body visible; 30-day retention | R30 |
| Rate limit | 10 req/s per team | 429 + headers | R5 |
| SDK | `resend` 6.31.0 (Node >= 20) | | R41 |

---

## 5. Alternatives (brief)

| | Resend | Postmark | Amazon SES |
|---|---|---|---|
| Entry price | Free 3,000/mo (100/day); Pro $20 = 50k | Free 100/mo; Basic $15 = 10k, extra $1.80 per 1,000; Pro $16.50; Platform $18 [A1] | a la carte $0.10 per 1,000; new Essentials plan $0.16 per 1,000; Pro plan $105/mo + $0.22 per 1,000 [A5] |
| Content retention | 30 days | 45 days default, up to 365 days on Pro/Platform [A2] | not fetched |
| Batch | 100 per call | 500 messages / 50 MB per call [A3] | not fetched |
| Idempotency key | yes (24 h) | none found on the Email API page [A4] | none found in the SendEmail v2 API reference [A7] |
| Onboarding | verify domain | account approval not fetched | new accounts start in the sandbox: 200 messages/24 h, 1 message/s, verified recipients only [A6] |
| Notes | US-stored data; its SPF/MX records point at Amazon SES [R16] | transactional focus | cheapest at volume |

The "none found" cells are absence of a match on the fetched page, not a proof of absence. **(design reasoning)** Put an `EmailProvider` interface and an outbox in front of whichever vendor is chosen so a swap is cheap.

---

## 6. Design implications for MossHatch

1. **DB tier:** Launch is the minimum for production (7-day PITR, no quota suspension, protected branches). Move to Scale only if we need the SLA, IP Allow, PrivateLink or SOC 2 report access (2.09x compute). Free is for throwaway dev only [N5, N6, N26, N37-N47].
2. **Region:** Neon `aws-us-east-1` with Vercel functions pinned to `iad1`. Confirm data-residency needs (EU registrants) before creating the project, because the region cannot change [N22-N25].
3. **Driver:** Drizzle `node-postgres` + `pg` Pool + `attachDatabasePool` + pooled URL for all request handlers. Never use `neon-http` on any path that needs read-then-write atomicity (idempotency, ledger, audit). Keep `neon-http` out of the codebase unless a latency-critical read needs it, and use `db.batch` only for fixed statement groups [D7-D12, N17-N19, V1-V3].
4. **Migrations:** CI-only `drizzle-kit generate` + `migrate` on the direct URL with the `migrator` role; install `pg` in the CI environment; custom SQL migrations for grants, triggers, RLS and partitions; `push` only on disposable branches. Pin the Drizzle line (0.45.x vs 1.0-rc) before the first migration [D14-D19].
5. **Roles:** create `migrator` (owner), `app_rw` (no ownership, INSERT/SELECT on the audit table, no UPDATE/DELETE/TRUNCATE) and optionally `app_ro` via SQL. Do not run the app as `neondb_owner` or any Console/API-created role. Override the Vercel integration's injected `DATABASE_URL` if it uses the owner role (which role it injects is unverified) [N55, P2, P3, P18].
6. **Audit log:** REVOKE + raising triggers (row and TRUNCATE, `ENABLE ALWAYS`) + hash chain with serialised appends + external anchoring of the head hash; expect PITR to rewind the log [P2-P11, N29].
7. **Idempotency and jobs:** unique index + `ON CONFLICT` for idempotency keys in the same transaction as the effect; outbox + `SKIP LOCKED` worker; only `pg_advisory_xact_lock` (never session-level) [P12-P17, N14].
8. **Money-approval flow (passkey):** **(design reasoning)** every approval check-then-commit sequence needs an interactive transaction; that is the concrete reason `neon-http` is out [D7, D8].
9. **Email content policy:** notification-only emails; no secrets, tokens, magic links or approval links; expect content to persist 30 days in a US-stored vendor log and a sample to be machine-reviewed. Turn click and open tracking off, enable Enforced TLS, use a dedicated sending subdomain, separate API keys per function (domain-restricted), Svix verification on the raw body, dedupe on `svix-id`, honour bounce/complaint/suppression events [R28-R39].
10. **Email reliability:** stay under 10 requests/s per team with batching and a worker token bucket; derive `Idempotency-Key` from the outbox row (`<event-type>/<entity-id>`) and keep local dedupe because the key expires in 24 hours; alert on bounce rate approaching 4% [R5-R14].
11. **Environments:** per-PR Neon branch through GitHub Actions with TTL; prefer explicit delete on PR close over the Vercel integration's months-long cleanup; parent previews off anonymised data; set spending notifications and an autoscaling maximum because there is no documented hard cap [N32-N36, N58].
12. **Network security without IP allow:** TLS `verify-full`, least privilege, rotation via password reset, secret scanning; revisit Scale + PrivateLink or Vercel Static IPs ($100/project/month) when the risk model demands it [N37-N41].
13. **Vault:** Neon's AES-256 at rest is not a substitute for envelope encryption with our KMS; PITR history retains ciphertext for the configured window (up to 7 days on Launch, 30 on Scale) and snapshots retain it while they exist, so plan key destruction as the deletion mechanism [N26, N31, N40].
14. **Resilience:** a single-region database with 1-10 minute AZ recovery and six connectivity incidents in five months means all money-moving code must be retry-safe and idempotent; surface degraded-mode UX [N48-N54].

---

## 7. Conflicts between sources

| Topic | Source A | Source B | Resolution |
|---|---|---|---|
| Drizzle `push` in production | Drizzle: teams use it as "a primary migrations flow in their production applications" [D16] | MossHatch rule: push is not for production | Project policy; keep generate + migrate |
| Free PITR | Neon backups page: "1 day up to 30 days" | Plans and history-window pages: Free is 6 hours | Use plans/history-window (specific, newer) |
| Resend tracking default | Tracking doc: "disabled by default for all domains" [R37] | create-domain API example shows `open_tracking: true` | Set both flags explicitly |
| Drizzle docs vs npm | Docs install `@rc` [D4] | npm `latest` is 0.45.3 [D1] | Decide the line explicitly |
| Neon "SOC 2 Certified" (footer) vs "certifications available on Scale" | Company is audited [N42] | Report access is plan-gated [N43] | Both true; report access for Launch unverified |
| Neon SLA plan name | "Business or Scale" [N47] | Plans page has Free/Launch/Scale | Business is legacy naming |

## 8. Unverified or not reachable

- Neon Trust Center content (403 to bot fetch): what SOC 2 report a Launch customer can obtain.
- Whether `neondb_owner` / `neon_superuser` members can `SET session_replication_role` or otherwise bypass audit triggers on Neon (owner `DISABLE TRIGGER` is standard Postgres; the Neon-specific ceiling was not documented on fetched pages).
- Which role Neon's Vercel integration puts in the injected `DATABASE_URL` (the pooled/unpooled distinction is documented; the role is not).
- Neon "Schema-only branches" and "Data anonymization" pages (present in docs nav, not fetched).
- Measured cold-start latency from Vercel to Neon (only Neon's "few hundred ms" and "350ms" claims).
- Whether Vercel Functions can use Neon PrivateLink.
- Drizzle open bugs (GitHub blocked by the session proxy: HTTP 403 "sessions are bound to their configured repositories"); Drizzle 1.0 GA date.
- Resend: webhook ordering/at-least-once wording, endpoint timeout, ability to redact or disable stored bodies, any SLA below Enterprise.
- Postmark and SES: rate limits, approval criteria, SES retention (only pricing, retention/batch, sandbox and the absence of idempotency parameters were checked).
- Worker trigger on Vercel (Cron/Queues) for the jobs table: out of scope, not verified.
- Independent third-party reports: the search tool's quota was exhausted before any search ran, so everything here comes from primary pages fetched directly by URL; no secondary sources were used.

## 9. Needs a lawyer or accountant

- Data protection: registrant contact data will sit in Neon (US region or another) and Resend (US storage regardless of sending region). Review the DPAs, subprocessor lists (Neon links a "Neon's Sub Contractors" page from its footer, not fetched; Resend's is at https://resend.com/legal/subprocessors, last updated 2026-08-27), and SCC/DPF reliance for EU registrants.
- Retention conflicts: Neon PITR (up to 7 days on Launch, 30 on Scale) and snapshots, and Resend's 30-day content retention, versus any registrar or registry record-keeping duties and GDPR erasure requests. The applicable retention periods must come from counsel; I did not verify them.
- Vendor assurance: what evidence (SOC 2 report, DPA) the upstream registrar API partner or ICANN-related agreements require of sub-processors.
- Email content classification (transactional vs marketing, renewal notices) and consent rules.
- Tax treatment of usage-based, USD-billed infrastructure invoices (no analysis done).

---

## 10. Findings register

All rows accessed 2026-09-29. "Conf." is my confidence that the value is current and correctly read. Quotes are verbatim from the fetched page text (markdown symbols and whitespace ignored).

| ID | Claim | Value | Source URL | Conf. | Verbatim quote |
|---|---|---|---|---|---|
| N1 | Neon plans today are Free, Launch and Scale; both paid plans are pure usage-based with no base fee | Free $0; Launch and Scale pay-per-use, no minimum | https://neon.com/docs/introduction/plans | high | On Launch and Scale plans, you pay only for what you use; there's no minimum monthly fee. |
| N2 | Compute price per CU-hour by plan (1 CU is about 4 GB RAM) | Launch $0.106/CU-h; Scale $0.222/CU-h; Free 100 CU-h per project per month | https://neon.com/docs/introduction/plans | high | Launch: $0.106/CU-hour |
| N3 | Scale compute price | $0.222/CU-hour | https://neon.com/docs/introduction/plans | high | Scale: $0.222/CU-hour |
| N4 | Storage price on paid plans; Free storage cap | $0.35/GB-month; Free 0.5 GB per project | https://neon.com/docs/introduction/plans | high | Launch/Scale plan storage cost: $0.35/GB-month |
| N5 | Free plan allowances | 100 projects, 100 CU-h/project, 0.5 GB/project, 5 GB egress/project | https://neon.com/docs/introduction/plans | high | Includes 100 projects, 100 CU-hours/project, 0.5 GB storage per project, and 5 GB of egress per project. |
| N6 | Free plan behaviour at the limit: compute is suspended (not for production) | Compute suspended until next billing period or upgrade; storage cap makes writes fail | https://neon.com/docs/introduction/plans | high | your compute is suspended until the next billing period or until you upgrade |
| N7 | Compute size limits by plan | Free up to 2 CU (8 GB); Launch autoscale up to 16 CU (64 GB); Scale autoscale up to 16 CU, fixed up to 56 CU (224 GB) | https://neon.com/docs/introduction/plans | high | Scale: Up to 16 CU for autoscaling; fixed sizes up to 56 CU (224 GB RAM) |
| N8 | Scale-to-zero (autosuspend) controls by plan | Free fixed 5 min; Launch 5 min default, can disable; Scale configurable 1 min to always on | https://neon.com/docs/introduction/plans | high | Scale: Fully configurable; 1 minute to always on |
| N9 | Cold start (wake from idle) latency | A few hundred milliseconds typical; Neon pricing page cites 350 ms | https://neon.com/docs/connect/connection-latency | high | activating a Neon compute from an idle state typically takes a few hundred milliseconds |
| N10 | Neon pricing page states a 350 ms restart figure for the intermittent-load example | 350 ms | https://neon.com/pricing | high | start back up in 350ms when it's needed |
| N11 | If scale-to-zero is disabled, a manual weekly compute restart is recommended to pick up compute image updates | Weekly compute releases | https://neon.com/docs/connect/connection-latency | high | Neon typically releases compute-related updates weekly. |
| N12 | Pooled connections use PgBouncer; up to 10,000 client connections; pooled host has the -pooler suffix | max_client_conn 10,000; add -pooler to the endpoint host | https://neon.com/docs/connect/connection-pooling | high | Neon uses PgBouncer to provide connection pooling, enabling up to 10,000 concurrent connections. |
| N13 | Pooler runs in transaction mode | pool_mode=transaction | https://neon.com/docs/connect/connection-pooling | high | Neon uses PgBouncer in transaction mode (pool_mode=transaction) |
| N14 | Session-level advisory locks, SET/RESET, LISTEN/NOTIFY, SQL PREPARE are not supported on pooled connections | Use xact-level advisory locks only | https://neon.com/docs/connect/connection-pooling | high | Not supported with pooled connections: SET / RESET (session variables) LISTEN / NOTIFY WITH HOLD CURSOR PREPARE / DEALLOCATE (SQL-level prepared statements) Temporary tables with PRESERVE / DELETE ROWS LOAD statement Session-level advisory locks |
| N15 | Schema migrations (including Drizzle Kit) should use the direct (unpooled) connection | Direct string for drizzle-kit | https://neon.com/docs/connect/choose-connection | high | Schema migrations (Prisma Migrate, Drizzle Kit, django-admin migrate) |
| N16 | Direct connections are capped by max_connections which depends on compute size | 0.25 CU = 104 (7 reserved); 1 CU = 419; 9+ CU = 4000 | https://neon.com/docs/connect/connection-pooling | high | 0.25 \| 1 GB \| 104 |
| N17 | Neon recommends node-postgres over TCP with a pool on Vercel Fluid compute | pg + attachDatabasePool + pooled URL | https://neon.com/docs/connect/choose-connection | high | Vercel Fluid keeps functions warm long enough to reuse TCP connections, so you skip the connection setup cost on subsequent requests. |
| N18 | Neon: HTTP/WebSocket serverless driver is for classic serverless without pooling | HTTP ~3 round trips vs TCP ~8; WS ~4 | https://neon.com/docs/guides/vercel-connection-methods | medium | Lowest (~3) \| Classic Serverless. |
| N19 | Serverless driver over HTTP suits one-shot and non-interactive transactions; WebSocket needed for session or interactive transactions | HTTP: sql.transaction([...]) only; WS: Pool/Client | https://neon.com/docs/serverless/serverless-driver | high | WebSockets: If you require session or interactive transaction support or compatibility with node-postgres |
| N20 | HTTP request and response size limit; Node version for driver v1 | 64 MB; Node >= 19 | https://neon.com/docs/serverless/serverless-driver | high | The maximum request size and response size for queries over HTTP is 64 MB. |
| N21 | WebSocket Pool/Client must be created, used and closed inside one request handler on edge/serverless | Per-request lifecycle | https://neon.com/docs/serverless/serverless-driver | high | WebSocket connections can't outlive a single request. |
| N22 | Neon regions (AWS): us-east-1, us-east-2, us-west-2, eu-central-1, eu-west-2, ap-southeast-1, ap-southeast-2, sa-east-1 | 8 AWS regions; Azure regions deprecated for new projects | https://neon.com/docs/introduction/regions | high | AWS US East (N. Virginia) — aws-us-east-1 |
| N23 | Region is fixed per project and cannot be changed | Migrate by creating a new project | https://neon.com/docs/introduction/regions | high | You cannot change the region for an existing project. |
| N24 | Vercel Functions default region for new projects is iad1 (Washington, D.C.), which maps to AWS us-east-1 | iad1 = us-east-1 | https://vercel.com/docs/functions/configuring-functions/region | high | By default, Vercel Functions execute in Washington, D.C., USA (iad1) for all new projects |
| N25 | Vercel region code table maps iad1 to us-east-1 | iad1 \| us-east-1 | https://vercel.com/docs/regions | high | \| iad1 \| us-east-1 \| Washington, D.C., USA |
| N26 | Point-in-time restore (history window) maximum by plan; Free is 6 hours capped at 1 GB | Free 6 h; Launch up to 7 d; Scale up to 30 d; billed $0.20/GB-month of retained WAL on paid plans | https://neon.com/docs/introduction/plans | high | Launch: Up to 7 days, billed at $0.20/GB-month |
| N27 | History window defaults: 6 hours Free, 1 day paid; Scale can go to 30 days | Default 1 day on paid | https://neon.com/docs/introduction/plans | high | The history window defaults are 6 hours for Free plan projects and 1 day for paid plan projects. |
| N28 | Only root branches support instant restore | PITR on root branch only | https://neon.com/docs/postgres/backup-restore/branch-restore | high | child branches do not support instant restore |
| N29 | A restore is a full overwrite of the branch timeline (not a merge); a backup branch preserves the pre-restore state | Overwrite; backup branch {name}_old_{timestamp} | https://neon.com/docs/postgres/backup-restore/branch-restore | high | you are performing a complete overwrite of the database timeline, not a merge or refresh |
| N30 | History window of zero disables instant restore and Time Travel | history_retention_seconds = 0 disables PITR | https://neon.com/docs/postgres/backup-restore/history-window | high | Setting it to zero disables instant restore and Time Travel entirely. |
| N31 | Snapshots: 100 manual on paid plans, $0.09/GB-month, scheduled backups on paid plans | Launch/Scale 100 manual snapshots; Free 1 | https://neon.com/docs/introduction/plans | high | Snapshot storage is billed at $0.09/GB-month. |
| N32 | Branch allowances and overage | Free/Launch 10 per project, Scale 25; extra $1.50/branch-month | https://neon.com/docs/introduction/plans | high | Cost: $1.50/branch-month (~$0.002/hour). |
| N33 | Branch expiration (TTL) exists for ephemeral CI and preview branches | Console default 1 day; CLI --expires-at; API expires_at (up to 30 days) | https://neon.com/docs/guides/branch-expiration | high | Branch expiration allows you to set automatic deletion timestamps on branches. |
| N34 | Neon publishes GitHub Actions for create, delete, reset branch and schema diff | 4 actions | https://neon.com/docs/guides/branching-github-actions | high | The actions cover branch creation, deletion, reset, and schema diff. |
| N35 | Vercel-managed integration creates one Neon branch per Vercel preview deployment and injects pooled and unpooled URLs | DATABASE_URL pooled; DATABASE_URL_UNPOOLED direct | https://neon.com/docs/guides/vercel-managed-integration | high | Pooled connection string (PgBouncer) |
| N36 | Vercel-managed integration cleanup can lag for months because it follows Vercel deployment retention | Default retention 6 months | https://neon.com/docs/guides/vercel-managed-integration | high | Because of Vercel's default retention settings, preview branches can persist long after a PR is closed. |
| N37 | IP Allow is a Scale-plan feature | Scale only | https://neon.com/docs/introduction/ip-allow | high | Neon's IP Allow feature, available with the Neon Scale plan |
| N38 | Private Networking (AWS PrivateLink) is Scale-only; private transfer $0.01/GB | Scale only | https://neon.com/docs/introduction/plans | high | Private networking is available on the Scale plan. It uses AWS PrivateLink |
| N39 | Vercel deployments use dynamic egress IPs; Static IPs add-on is Pro and Enterprise | $100/month per project plus data transfer | https://vercel.com/docs/networking/static-ips | high | $100.00/month per project |
| N40 | Neon encrypts data at rest with AES-256 and requires TLS for all connections | AES-256 at rest (NVMe hardware AES-256; KMS-managed keys); TLS required | https://neon.com/docs/security/security-overview | high | All customer and sensitive data is encrypted using AES-256 encryption at rest. |
| N41 | Neon requires SSL/TLS on all connections | TLS required; verify-full supported | https://neon.com/docs/security/security-overview | high | Neon requires that all connections use SSL/TLS encryption |
| N42 | Neon has SOC 2 Type 1 and Type 2, SOC 3, ISO 27001, ISO 27701, GDPR, CCPA | Independent audits complete | https://neon.com/docs/security/compliance | high | We have successfully attained SOC 2 Type 1 and Type 2 compliance. |
| N43 | Access to reports and compliance features is plan-gated (listed under Scale); reports are requested through the Trust Center | SOC 2 report: Scale | https://neon.com/docs/introduction/plans | high | Compliance certifications available on Scale: |
| N44 | Trust Center report request path | If available on your plan, request via Trust Center | https://neon.com/docs/security/compliance | high | If available on your plan, you can request the report through our Trust Center. |
| N45 | Uptime SLA applies to Scale (and legacy Business) only and covers Compute Endpoints only | Credits when monthly uptime < 99.95%: 10% (99.0-99.95), 15%, 20%, 80% (<96%) | https://neon.com/sla | high | This SLA applies only to the availability of Compute Endpoints |
| N46 | SLA credit table threshold | Below 99.95% earns 10% credit | https://neon.com/sla | high | Less than 99.95% but greater than or equal to 99.0% \| 10% |
| N47 | SLA is limited to Business or Scale customers; last modified Feb 20, 2026 | Not on Launch or Free | https://neon.com/sla | high | applies exclusively to customers who have subscribed to the Neon Business or Scale plan |
| N48 | Neon HA: multi-AZ storage, single-AZ stateless compute, no cross-region replication | AZ failure: compute rescheduled in 1-10 minutes | https://neon.com/docs/introduction/high-availability | high | No cross-region replication. |
| N49 | Neon compute AZ failure recovery time | 1-10 minutes | https://neon.com/docs/introduction/high-availability | high | Availability Zone failure \| Compute unavailable in affected AZ \| Rescheduling to healthy AZs \| 1-10 minutes |
| N50 | Neon status page today (2026-09-29): all systems operational; upcoming auth maintenance 2026-09-30 08:00-09:00 UTC | Operational | https://neonstatus.com/ | high | All Systems Operational |
| N51 | Neon status history includes a database-connectivity partial disruption in us-east-1 on 2026-05-08 | Database Connectivity, AWS us-east-1 | https://neonstatus.com/pages/history/6878fc85709daa75be6c7e3c | high | Database connectivity issues with projects in US-East-1 Cell 6 |
| N52 | Neon status history includes a compute-start degradation in us-east-1 on 2026-08-10 | Project/Branch Operations, AWS us-east-1 | https://neonstatus.com/pages/history/6878fc85709daa75be6c7e3c | high | Issue with starting computes in us-east-1 |
| N53 | Neon status history includes branch reset/restore failures in us-east-2 on 2026-08-17 | Console API, AWS us-east-2 | https://neonstatus.com/pages/history/6878fc85709daa75be6c7e3c | high | Neon Branch Reset and Restore Failures |
| N54 | Neon runs scheduled maintenance windows on internal databases that can raise API and database-start latency (running databases unaffected) | Sep 16-17 2026, 1 h per region group | https://neonstatus.com/pages/history/6878fc85709daa75be6c7e3c | high | there may be increased API request latency, and database start latency. Running databases will not be affected. |
| N55 | Roles created in the Console, CLI or API get neon_superuser membership including BYPASSRLS; roles created with SQL get only basic privileges | Create the runtime role with SQL | https://neon.com/docs/manage/roles | high | Roles created via the Console, CLI, or API automatically receive neon_superuser membership (CREATEDB, CREATEROLE, BYPASSRLS, REPLICATION). Roles created with SQL receive only basic public schema privileges and must be granted permissions explicitly. |
| N56 | Neon supports Postgres 14-18 with latest minors (18.6, 17.11, 16.15, 15.19, 14.24 as of Aug 2026); major upgrade means new project | PG 14-18 | https://neon.com/docs/postgresql/postgres-version-policy | high | As of August 2026, Neon runs the latest community minor release for every supported major version: 18.6, 17.11, 16.15, 15.19, and 14.24. |
| N57 | pgcrypto and pg_partman are available on Neon (all supported majors) | pgcrypto 1.3 (PG14-17), 1.4 (PG18); pg_partman 5.1.0 | https://neon.com/docs/extensions/pg-extensions | high | pgcrypto \| 1.3 \| 1.3 \| 1.3 \| 1.3 \| 1.4 |
| N58 | Neon has no hard spending cap; spending controls are notifications at 80% and 100% of a threshold | Notifications only (hard cap not documented) | https://neon.com/docs/changelog | medium | Spending limits have been renamed to spending notifications. |
| N59 | Public network transfer allowance on paid plans was raised to 500 GB per project per month (2026-06-05) | 500 GB/project/month then $0.10/GB | https://neon.com/docs/changelog | high | We've increased the public network transfer (egress) allowance on all paid plans from 100 GB to **500 GB per project per month**. |
| N60 | Neon compute maintenance updates: Scale/Enterprise planned-update notice shortened from 7 to 3 days from 2026-07-10 | 3 days notice | https://neon.com/docs/changelog | high | the advance notice period for planned updates on the Scale and Enterprise plans is changing from 7 days to 3 days, effective July 10, 2026 |
| N61 | Neon advises putting the application and database in the same region to cut connection latency | Same region | https://neon.com/docs/connect/connection-latency | high | Place your application and database in the same region |
| N62 | Scale-to-zero timeout can be extended up to 7 days on paid plans and, on Scale, set as low as 1 minute | Default 300 s; suspend_timeout_seconds via API | https://neon.com/docs/connect/connection-latency | high | You can extend it up to 7 days to reduce how often cold starts occur, or on the Scale plan, configure it down to as little as 1 minute. |
| N63 | PgBouncer default pool size is 90% of max_connections per user and database; queued clients wait up to 120 s; settings not user-configurable | default_pool_size 0.9 x max_connections; query_wait_timeout 120 | https://neon.com/docs/connect/connection-pooling | high | default_pool_size = 0.9 × max_connections |
| N64 | Neon is a GitHub Secret Scanning partner (leaked Neon credentials are reported to Neon) | Partner | https://neon.com/docs/security/security-overview | high | Neon is a GitHub Secret Scanning Partner. |
| N65 | Credential rotation on Neon = reset the role's password; old password stops working on next connection | Password reset | https://neon.com/docs/security/security-overview | high | you rotate it by resetting the role's password |
| N66 | Private Networking is available to Organization accounts, not Personal accounts | Org accounts only | https://neon.com/docs/security/security-overview | high | It's not accessible to Personal Neon accounts. |
| V1 | Vercel recommends a global pg Pool plus attachDatabasePool on Fluid compute | attachDatabasePool from @vercel/functions | https://vercel.com/kb/guide/connection-pooling-with-functions | high | Attach a pool**: Use the `attachDatabasePool` helper to handle idle connections. |
| V2 | Fluid compute is enabled by default for new Vercel projects since 2025-04-23 | Default on | https://vercel.com/docs/fluid-compute | high | As of April 23, 2025, fluid compute is enabled by default for new projects. |
| V3 | attachDatabasePool is exported by @vercel/functions 3.9.9 | export declare function attachDatabasePool(dbPool: DbPool): void; | https://www.npmjs.com/package/@vercel/functions | high | export declare function attachDatabasePool(dbPool: DbPool): void; |
| D1 | drizzle-orm npm latest tag is 0.45.3 (2026-09-21); 1.0 is still a release candidate (rc.4 on 2026-06-27) | latest 0.45.3; rc 1.0.0-rc.4; beta 1.0.0-beta.22 | https://www.npmjs.com/package/drizzle-orm | high | drizzle-orm dist-tag latest = 0.45.3; beta = 1.0.0-beta.22; rc = 1.0.0-rc.4 |
| D2 | drizzle-kit npm latest is 0.31.11 (2026-09-21); rc tag 1.0.0-rc.4 | 0.31.11 | https://www.npmjs.com/package/drizzle-kit | high | drizzle-kit dist-tag latest = 0.31.11; beta = 1.0.0-beta.22; rc = 1.0.0-rc.4 |
| D3 | @neondatabase/serverless latest is 1.1.0 (2026-04-17), Node >= 19 | 1.1.0 | https://www.npmjs.com/package/@neondatabase/serverless | high | @neondatabase/serverless@1.1.0 published 2026-04-17T14:01:05.102Z |
| D4 | Drizzle docs currently install with the rc tag (docs track v1 RC) | npm i drizzle-orm@rc | https://orm.drizzle.team/docs/connect-neon | high | npm i drizzle-orm@rc @neondatabase/serverless |
| D5 | Drizzle has native Neon drivers neon-http and neon-serverless (WebSocket), plus node-postgres and postgres.js | drizzle-orm/neon-http, drizzle-orm/neon-serverless, drizzle-orm/node-postgres, drizzle-orm/postgres-js | https://orm.drizzle.team/docs/connect-neon | high | Drizzle has native support for Neon connections with the neon-http and neon-websockets drivers. |
| D6 | Drizzle docs point to the WebSocket driver for interactive transactions | neon-serverless for interactive tx | https://orm.drizzle.team/docs/connect-neon | high | If you need session or interactive transaction support, or a fully compatible drop-in replacement for the pg driver, you can use the WebSocket-based neon-serverless driver. |
| D7 | neon-http does NOT support interactive transactions today: db.transaction() throws in drizzle-orm 0.45.3 (latest) | Error: No transactions support in neon-http driver | https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.3.tgz (file neon-http/session.js) | high | throw new Error("No transactions support in neon-http driver"); |
| D8 | Same in drizzle-orm 1.0.0-rc.4 | Error: No transactions support in neon-http driver | https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-1.0.0-rc.4.tgz (file neon-http/session.js) | high | throw new Error("No transactions support in neon-http driver"); |
| D9 | db.batch() on neon-http runs the statements as one Neon non-interactive transaction (atomic, but no read-then-decide logic) | batch -> client.transaction(builtQueries) | https://orm.drizzle.team/docs/batch-api | high | Drizzle supports running SQL statements in a batch with the Neon HTTP driver for PostgreSQL. |
| D10 | drizzle-orm neon-http migrator warns that a failed migration is not rolled back | No rollback on neon-http migrate | https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-1.0.0-rc.4.tgz (file neon-http/migrator.js) | high | NOTE: The Neon HTTP driver does not support transactions. This means that if any part of a migration fails, no rollback will be executed. |
| D11 | neon-serverless (WebSocket) driver issues real BEGIN/COMMIT/ROLLBACK and savepoints | Interactive transactions supported | https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.3.tgz (file neon-serverless/session.js) | high | await tx.execute(sql`commit`); |
| D12 | With the pg dialect migrator all pending migrations run inside one session.transaction | Atomic migrate on node-postgres | https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.3.tgz (file pg-core/dialect.js) | medium | await session.transaction(async (tx) => { |
| D13 | Drizzle transactions API supports nested transactions (savepoints) and isolation level / access mode config | isolationLevel, accessMode, deferrable | https://orm.drizzle.team/docs/transactions | high | Drizzle ORM supports savepoints with nested transactions API |
| D14 | Migration workflow: generate creates SQL files, migrate applies them and logs to drizzle.__drizzle_migrations | drizzle-kit generate then drizzle-kit migrate | https://orm.drizzle.team/docs/migrations | high | Drizzle lets you generate SQL migration files based on your schema changes with drizzle-kit generate and then apply them to the database with drizzle-kit migrate commands. |
| D15 | Migration log table defaults to drizzle.__drizzle_migrations and is configurable | table __drizzle_migrations, schema drizzle | https://orm.drizzle.team/docs/drizzle-kit-migrate | high | It will store them in migrations log table named __drizzle_migrations in drizzle schema. |
| D16 | drizzle-kit push introspects the DB, diffs and applies without SQL files; Drizzle itself says push is used in production by some teams (our 'not for production' rule is a project policy, not a Drizzle prohibition) | Conflict: Drizzle docs vs MossHatch policy | https://orm.drizzle.team/docs/drizzle-kit-push | high | we've seen dozens of teams and solo developers successfully using it as a primary migrations flow in their production applications |
| D17 | Custom (hand-written) SQL migrations are generated with --custom, for DDL Drizzle Kit does not support | drizzle-kit generate --custom --name=... | https://orm.drizzle.team/docs/kit-custom-migrations | high | Drizzle lets you generate empty migration files to write your own custom SQL migrations for DDL alternations currently not supported by Drizzle Kit or data seeding |
| D18 | Drizzle v1 changes the migrations folder layout (folder per migration, no journal.json); run drizzle-kit up to convert | One folder per migration with migration.sql and snapshot.json | https://orm.drizzle.team/docs/upgrade-v1 | high | grouping SQL files and snapshots into separate migration folders |
| D19 | drizzle-kit CLI picks a driver by which package is installed (pg, postgres, @vercel/postgres, then @neondatabase/serverless); the Neon driver path is WebSocket | Install pg to make drizzle-kit use TCP | https://registry.npmjs.org/drizzle-kit/-/drizzle-kit-0.31.11.tgz (file bin.cjs) | medium | '@neondatabase/serverless' can only connect to remote Neon/Vercel Postgres/Supabase instances through a websocket |
| D20 | Drizzle docs index has no mention of triggers or GRANT/REVOKE DSL; use custom SQL migrations for audit-log hardening | Absence in docs index (unverified as a hard negative) | https://orm.drizzle.team/llms.txt | low | Drizzle is a modern TypeScript ORM |
| D21 | A newer pre-release build exists (dist-tag rc5 = 1.0.0-rc.5-5935859, 2026-09-09) but the rc tag still points to 1.0.0-rc.4, so 1.0 has no clean rc.5 yet | rc.4 dated 2026-06-27; rc5 build dated 2026-09-09 | https://www.npmjs.com/package/drizzle-orm | high | drizzle-orm dist-tag rc5 = 1.0.0-rc.5-5935859 published 2026-09-09T10:25:53.776Z; dist-tag rc = 1.0.0-rc.4 published 2026-06-27T16:10:10.709Z |
| P1 | PostgreSQL current release is 18 (18.6 docs); 19 is in beta (Beta 4 on 2026-09-24) | PG 18.6 current | https://www.postgresql.org/docs/current/ | high | PostgreSQL 19 Beta 4 Released! |
| P2 | Object owner keeps DROP/ALTER rights that cannot be revoked; the app role must not own audit tables | Owner is not restrictable | https://www.postgresql.org/docs/current/sql-grant.html | high | The right to drop an object, or to alter its definition in any way, is not treated as a grantable privilege; it is inherent in the owner, and cannot be granted or revoked. |
| P3 | Owners may revoke some of their own privileges for safety | REVOKE UPDATE, DELETE, TRUNCATE ON audit FROM app_role | https://www.postgresql.org/docs/current/sql-grant.html | high | The owner could, however, choose to revoke some of their own privileges for safety. |
| P4 | Row-level BEFORE trigger can abort by RAISE EXCEPTION or skip by returning NULL | RAISE EXCEPTION in trigger function | https://www.postgresql.org/docs/current/plpgsql-trigger.html | high | RAISE EXCEPTION 'empname cannot be null'; |
| P5 | Returning NULL from a BEFORE row trigger skips the operation for that row | Silent skip (use RAISE to make it loud) | https://www.postgresql.org/docs/current/trigger-definition.html | high | It can return NULL to skip the operation for the current row. |
| P6 | TRUNCATE triggers can only be FOR EACH STATEMENT; TRUNCATE does not fire DELETE triggers | Add a BEFORE TRUNCATE statement trigger that raises | https://www.postgresql.org/docs/current/sql-createtrigger.html | high | triggers may be defined to fire for TRUNCATE, though only FOR EACH STATEMENT |
| P7 | TRUNCATE skips ON DELETE triggers but fires ON TRUNCATE triggers | Separate trigger needed | https://www.postgresql.org/docs/current/sql-truncate.html | high | TRUNCATE will not fire any ON DELETE triggers that might exist for the tables. But it will fire ON TRUNCATE triggers. |
| P8 | Triggers can be bypassed: session_replication_role=replica (superuser or SET privilege) and ALTER TABLE DISABLE TRIGGER (owner) | Use ENABLE ALWAYS TRIGGER and keep app role unprivileged | https://www.postgresql.org/docs/current/runtime-config-client.html | high | Only superusers and users with the appropriate SET privilege can change this setting. |
| P9 | ALTER TABLE offers DISABLE TRIGGER and ENABLE ALWAYS TRIGGER | ENABLE ALWAYS TRIGGER trigger_name | https://www.postgresql.org/docs/current/sql-altertable.html | high | ENABLE ALWAYS TRIGGER trigger_name |
| P10 | Built-in sha256(bytea) exists; pgcrypto digest() offers more algorithms | sha256(bytea) -> bytea | https://www.postgresql.org/docs/current/functions-binarystring.html | high | Computes the SHA-256 hash of the binary string. |
| P11 | pgcrypto digest(data bytea, type text) returns bytea | digest(..., 'sha256') | https://www.postgresql.org/docs/current/pgcrypto.html | high | digest(data bytea, type text) returns bytea |
| P12 | SELECT ... FOR UPDATE SKIP LOCKED is documented for queue-like tables | Skips rows that cannot be locked immediately | https://www.postgresql.org/docs/current/sql-select.html | high | but can be used to avoid lock contention with multiple consumers accessing a queue-like table |
| P13 | Session-level advisory locks ignore transaction rollback; transaction-level ones release at end of transaction | Prefer pg_advisory_xact_lock | https://www.postgresql.org/docs/current/explicit-locking.html | high | Transaction-level lock requests, on the other hand, behave more like regular lock requests: they are automatically released at the end of the transaction, and there is no explicit unlock operation. |
| P14 | pg_advisory_xact_lock(key bigint) obtains an exclusive transaction-level advisory lock | pg_advisory_xact_lock(bigint) | https://www.postgresql.org/docs/current/functions-admin.html | high | pg_advisory_xact_lock ( key bigint ) → void |
| P15 | A unique constraint or primary key automatically creates a unique index (the idempotency-key enforcement mechanism) | UNIQUE (scope, idempotency_key) | https://www.postgresql.org/docs/current/indexes-unique.html | high | PostgreSQL automatically creates a unique index when a unique constraint or primary key is defined for a table. |
| P16 | INSERT ... ON CONFLICT DO UPDATE guarantees an atomic insert-or-update even under high concurrency | Atomic upsert | https://www.postgresql.org/docs/current/sql-insert.html | high | ON CONFLICT DO UPDATE guarantees an atomic INSERT or UPDATE outcome; provided there is no independent error, one of those two outcomes is guaranteed, even under high concurrency. |
| P17 | ON CONFLICT DO NOTHING avoids inserting the row | Use RETURNING to detect winner | https://www.postgresql.org/docs/current/sql-insert.html | high | ON CONFLICT DO NOTHING simply avoids inserting a row as its alternative action. |
| P18 | RLS with no policy is default-deny; table owners and BYPASSRLS roles bypass unless FORCE ROW LEVEL SECURITY; TRUNCATE is not subject to RLS | Default-deny | https://www.postgresql.org/docs/current/ddl-rowsecurity.html | high | If no policy exists for the table, a default-deny policy is used, meaning that no rows are visible or can be modified. |
| P19 | Superusers, BYPASSRLS roles and (normally) table owners bypass RLS | FORCE ROW LEVEL SECURITY to bind owners | https://www.postgresql.org/docs/current/ddl-rowsecurity.html | high | Superusers and roles with the BYPASSRLS attribute always bypass the row security system when accessing a table. |
| P20 | Partitioned-table unique/PK constraints must include all partition key columns | Audit table PK must include the partition key (e.g. created_at) | https://www.postgresql.org/docs/current/ddl-partitioning.html | high | the constraint's columns must include all of the partition key columns |
| P21 | Old partitions can be detached (optionally CONCURRENTLY) for archival | DETACH PARTITION ... CONCURRENTLY | https://www.postgresql.org/docs/current/ddl-partitioning.html | high | ALTER TABLE measurement DETACH PARTITION measurement_y2006m02 CONCURRENTLY; |
| R1 | Resend transactional pricing: Free $0 (3,000/mo, 100/day); Pro $20 (50,000) and $35 (100,000); Scale from $90 (100,000); overage $0.90 per 1,000 on Pro | See pricing table | https://resend.com/pricing.md | high | \| Pro \| $20/mo \| 50,000 \| $0.90 \| |
| R2 | Resend Free plan limited to 100 emails per day | 100/day, 3,000/month | https://resend.com/pricing.md | high | The Free plan is limited to 100 emails per day. |
| R3 | Resend plan feature limits: domains 3/10/1,000; webhook endpoints 1/5/10; retention 30 days on Free/Pro/Scale | Free/Pro/Scale | https://resend.com/pricing | high | Webhook endpoints \| 1 endpoint \| 5 endpoints \| 10 endpoints \| Flexible |
| R4 | Resend add-ons: dedicated IP $30/mo (Scale, >3,000 emails/day), extra 100 domains $20/mo, SSO $150/mo | See pricing table | https://resend.com/pricing.md | high | Dedicated IPs — $30 / mo |
| R5 | Resend API rate limit is 10 requests per second per team, shared across all API keys | 10 req/s/team; 429 on excess; increase on request | https://resend.com/docs/api-reference/rate-limit | high | The default maximum rate limit is **10 requests per second per team**. |
| R6 | No burst allowance above the per-second limit; batch requests count as one request | Use batch to reduce request count | https://resend.com/docs/knowledge-base/account-quotas-and-limits | high | There is no separate burst allowance above the stated limit. |
| R7 | Each recipient in To/CC/BCC counts as a separate email against quota; inbound emails count too | Quota counts recipients | https://resend.com/docs/knowledge-base/account-quotas-and-limits | high | Multiple `To`, `CC`, or `BCC` recipients in sent emails count as separate emails towards the monthly quota. |
| R8 | Overage is capped at 5x the monthly quota by default; sending then pauses until the next cycle | 5x hard cap | https://resend.com/docs/knowledge-base/account-quotas-and-limits | high | a hard limit of 5x your monthly quota applies |
| R9 | Sender reputation guardrails: bounce rate under 4%, spam rate under 0.08%, else sending may pause | <4% bounce, <0.08% spam | https://resend.com/docs/knowledge-base/account-quotas-and-limits | high | All accounts must have a spam rate of under **0.08%**. |
| R10 | Idempotency-Key supported on POST /emails and POST /emails/batch; kept 24 hours; max 256 characters | Header Idempotency-Key; SMTP header Resend-Idempotency-Key | https://resend.com/docs/dashboard/emails/idempotency-keys | high | Idempotency keys are kept in the system for **24 hours**. |
| R11 | Idempotency scope statement | POST /emails and POST /emails/batch | https://resend.com/docs/dashboard/emails/idempotency-keys | high | Idempotency keys are currently supported on the `POST /emails` and the `POST /emails/batch` endpoints on the Resend API. |
| R12 | Idempotency errors: 409 invalid_idempotent_request (same key, different payload) and 409 concurrent_idempotent_requests; 400 invalid_idempotency_key | 409 / 409 / 400 | https://resend.com/docs/dashboard/emails/idempotency-keys | high | this idempotency key has already been used on a request that had a different payload |
| R13 | Batch API sends up to 100 emails per call; attachments not supported in batch; supports Idempotency-Key | 100 per call | https://resend.com/docs/api-reference/emails/send-batch-emails | high | The `attachments` field is not supported yet. |
| R14 | Batch endpoint permits up to 100 emails per API call | 100 | https://resend.com/docs/api-reference/emails/send-batch-emails | high | Resend provides a batching endpoint that permits you to send up to 100 emails in a single API call. |
| R15 | Single send: max 50 recipients in to; attachments max 40 MB after Base64 | 50 / 40 MB | https://resend.com/docs/api-reference/emails/send-email | high | max 40MB per email, after Base64 encoding of the attachments |
| R16 | Domain verification records: DKIM TXT at resend._domainkey; SPF as MX and TXT on the send subdomain (include:amazonses.com); optional tracking CNAME | DKIM TXT, SPF TXT+MX on 'send', tracking CNAME 'links' | https://resend.com/docs/api-reference/domains/create-domain | high | "value": "v=spf1 include:amazonses.com ~all", |
| R17 | DKIM record name in the API example response | resend._domainkey (TXT) | https://resend.com/docs/api-reference/domains/create-domain | high | "name": "resend._domainkey", |
| R18 | Return-Path defaults to the send subdomain and carries SPF, DMARC alignment and bounces | send.yourdomain.tld | https://resend.com/docs/api-reference/domains/create-domain | high | custom return path is used for SPF authentication, DMARC alignment, and handling bounced emails. |
| R19 | DMARC is a customer-added TXT at _dmarc; Resend recommends starting at p=none | v=DMARC1; p=none; rua=mailto:...; | https://resend.com/docs/dashboard/domains/dmarc | high | v=DMARC1; p=none; rua=mailto:dmarcreports@example.com; |
| R20 | Domain verification usually within 15 minutes, up to 72 hours; CNAMEs must not be proxied | 15 min to 72 h | https://resend.com/docs/add-a-domain | high | your domain will often verify within 15 minutes of adding the DNS records. However, DNS changes can occasionally take up to 72 hours to propagate globally. |
| R21 | Resend recommends sending from a subdomain to isolate reputation | e.g. updates.example.com | https://resend.com/docs/dashboard/domains/introduction | high | We recommend sending your emails from one or more subdomains |
| R22 | Sending regions: us-east-1, eu-west-1, sa-east-1, ap-northeast-1; chosen per domain | 4 regions | https://resend.com/docs/dashboard/domains/regions | high | Tokyo (ap-northeast-1) |
| R23 | Region choice controls sending only; account data and logs are stored in the United States regardless | US storage | https://resend.com/docs/dashboard/domains/regions | high | All account data, including email metadata, logs, and API records, is stored in the United States regardless of the sending region you select. |
| R24 | Changing a domain's region requires deleting and re-adding the domain | Delete and re-add | https://resend.com/docs/dashboard/domains/regions | medium | Delete your current domain in the |
| R25 | Webhook events: email.bounced (permanent rejection), email.complained, email.delivered, plus sent, delivery_delayed, failed, suppressed, opened, clicked, scheduled, received | email.* events | https://resend.com/docs/webhooks/event-types | high | Occurs whenever the recipient's mail server permanently rejected the email. |
| R26 | Webhook retries: 8 attempts with exponential backoff (immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h); endpoint auto-disabled if it keeps failing; manual replay of any message | 8 attempts | https://resend.com/docs/webhooks/retries-and-replays | high | Resend attempts to deliver each webhook message based on a schedule with exponential backoff. |
| R27 | Webhooks are Svix-signed (svix-id, svix-timestamp, svix-signature); verify against the raw body | Svix headers | https://resend.com/docs/webhooks/verify-webhooks-requests | high | Make sure that you're using the raw request body when verifying webhooks. |
| R28 | Resend retains email content, metadata, delivery events, logs and metrics for 30 days on Free, Pro and Scale | 30 days | https://resend.com/docs/knowledge-base/account-quotas-and-limits | high | Resend retains email data for **30 days** across all plans (Free, Pro, and Scale). |
| R29 | Retained data explicitly includes email content | Content and metadata | https://resend.com/docs/knowledge-base/account-quotas-and-limits | high | Email content and metadata |
| R30 | Dashboard logs show the full request body of API calls (so email HTML sent through the API is visible to team members) | Full JSON payload in logs | https://resend.com/docs/dashboard/logs/introduction | high | The full JSON payload sent to the API |
| R31 | Customer data (message content, delivery logs, webhook payloads) stored in the US; deletion within 90 days of termination; a specific message can be removed on request | US; 90 days after termination | https://resend.com/security/gdpr | high | Resend stores customer data in the United States, including message content, delivery logs, webhook payloads, and account records. |
| R32 | Resend will remove a specific message before the retention window on request | By contacting Resend | https://resend.com/security/gdpr | high | If you need a specific message removed before the retention window ends, contact us. |
| R33 | A subprocessor (RunPod, Resend-operated infrastructure) processes a small sample of emails for trust and safety | Sample of email content processed | https://resend.com/security | high | RunPod processes a small sample of emails for trust and safety, on dedicated infrastructure that Resend operates. |
| R34 | Resend is SOC 2 Type II compliant; not HIPAA or ISO 27001 | SOC 2 Type II | https://resend.com/security | high | Yes, Resend is SOC 2 Type II compliant. |
| R35 | Resend datastores are encrypted at rest; sensitive info encrypted at application level; TLS 1.3 in transit; backups retained 7 days | AES-256 | https://resend.com/security | high | All datastores are encrypted at rest. |
| R36 | Default TLS for outbound mail is opportunistic; Enforced TLS is opt-in per domain | Enable Enforced TLS | https://resend.com/docs/dashboard/domains/tls | high | By default, Resend will attempt to make a secure connection, but will fall back to sending messages unencrypted when the receiving server does not support TLS. |
| R37 | Open and click tracking is disabled by default for domains (the create-domain API example response shows open_tracking true; set both flags explicitly) | Tracking off by default (docs conflict) | https://resend.com/docs/dashboard/domains/tracking | high | Open and click tracking is disabled by default for all domains. |
| R38 | Suppression list is team-wide; entries added automatically on bounce or complaint or manually; Gmail does not return complaints | origins: bounce, complaint, manual | https://resend.com/docs/dashboard/emails/email-suppressions | high | Any address added to the suppression list will be skipped across all your domains and subdomains |
| R39 | API keys are scoped by permission and optional domain restriction; the value cannot be viewed after creation | Use one key per function | https://resend.com/docs/dashboard/api-keys/introduction | high | You cannot view or edit an API key value after it has been created. |
| R40 | Resend status page shows Email Sending 99.93% uptime and General API 100% for Aug-Sep 2026 | 99.93% / 100% | https://resend-status.com/ | high | Email Sending 4 components 99.93 % uptime |
| R41 | resend npm SDK latest is 6.31.0 (2026-09-29), Node >= 20 | 6.31.0 | https://www.npmjs.com/package/resend | high | resend@6.31.0 published 2026-09-29T18:33:26.449Z |
| R42 | Free-plan daily quota is a UTC calendar day; paid plans have no daily quota; quota errors are 429 daily_quota_exceeded / monthly_quota_exceeded | Headers x-resend-daily-quota (Free only), x-resend-monthly-quota | https://resend.com/docs/api-reference/rate-limit | high | The daily quota applies only to the Free plan. |
| A1 | Postmark: Free 100 emails/mo; Basic $15/mo for 10,000 (extra $1.80 per 1,000); Pro $16.50; Platform $18; 45-day retention default | $15-$18 per 10k | https://postmarkapp.com/pricing | high | Everyone starts on our free Developer plan, which includes 100 emails every month. |
| A2 | Postmark retention defaults to 45 days, customizable to 365 days on Pro and Platform | 45 days | https://postmarkapp.com/pricing | high | Customizable data retention up to 365 days (45-day default) |
| A3 | Postmark batch endpoint accepts up to 500 messages and 50 MB per call | 500 / 50 MB | https://postmarkapp.com/developer/api/email-api | high | the batch endpoint accepts up to 500 messages per API call, and up to 50 MB payload size, including attachments |
| A4 | Postmark Email API page shows no idempotency-key parameter (0 matches for 'idempot' on the fetched page) | None found | https://postmarkapp.com/developer/api/email-api | low | (none: absence check, see claim) |
| A5 | Amazon SES: a la carte $0.10 per 1,000 emails; new Essentials plan $0.16 per 1,000 (0-10M/month); Pro $105/month plus $0.22 per 1,000 | $0.10 to $0.23 per 1,000 | https://aws.amazon.com/ses/pricing/ | high | $0.10 / 1,000 emails |
| A6 | SES new accounts start in the sandbox: 200 messages per 24 h and 1 message per second, verified recipients only | Sandbox | https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html | high | You can send a maximum of 200 messages per 24-hour period. |
| A7 | SES v2 SendEmail API reference has no idempotency or client-token parameter (0 matches for 'idempot' or 'ClientToken' on the fetched page) | None found | https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html | low | (none: absence check, see claim) |

---

## 11. Method and limits

- Fetched with curl through the session proxy (TLS verification on); the HTML was converted to text locally; npm facts come from `npm view` and from unpacking the published tarballs (`drizzle-orm@0.45.3`, `drizzle-orm@1.0.0-rc.4`, `drizzle-kit@0.31.11`, `@vercel/functions@3.9.9`).
- Primary sources only: neon.com (docs, pricing, SLA, changelog), neonstatus.com, vercel.com docs, orm.drizzle.team, npm registry, postgresql.org/docs/current, resend.com docs/pricing/security, resend-status.com, postmarkapp.com, aws.amazon.com and docs.aws.amazon.com.
- Hosts that refused or were blocked: github.com (proxy 403, session policy), trust.neon.com (403 bot protection). Not worked around.
- Raw page text is saved under `.../scratchpad/research/raw/` for audit.
