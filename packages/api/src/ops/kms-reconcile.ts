import { tx, type Pool, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { signV4, type AwsCredentials, type FetchLike } from "../vault/kms/aws.ts";
import { closeAlerts, raiseAlert } from "./alerts.ts";

/**
 * audit.kms_reconcile (PLAN 4.6 row 2, ST-10): every CloudTrail `Decrypt` must match an audit row written BEFORE the call.
 *
 * The contract, valid under real AWS KMS semantics:
 * - `Decrypt` succeeds only with exactly the encryption context used at `GenerateDataKey`, so a per-call nonce cannot be
 *   added to it (the first design's `decrypt_nonce=<uuid>` would make every real Decrypt fail with InvalidCiphertextException).
 * - The reconcile token is therefore a stored per-row id that is already in the ORIGINAL context: the vault's
 *   `{app, env, owner_id, secret_id}` carries `secret_id` (the secret version or credential row id). CloudTrail logs the
 *   context in `requestParameters.encryptionContext`, so every Decrypt event names its row.
 * - The audit row for the read carries the same id in `detail.decrypt_nonce` (the vault's field name; `detail.kms_ref` is
 *   accepted too). The name is historical: it is the row id, not a per-call value. Only the actions in
 *   RECONCILE_AUDIT_ACTIONS count: `secret.reveal*` and `secret.read*` rows can be inserted only by the vault database role
 *   (0800 trigger; 0805 extends it to `connection.credential.used`), so app code cannot forge a match.
 * - Because the token repeats across reads of one row, matching is ONE-TO-ONE and durable: each event (by CloudTrail
 *   `eventID`) is judged once and consumes one audit row with the same token whose time is at most 5 minutes before the
 *   event (the row commits before KMS is called, ST-26) or 2 minutes after it (clock skew). A second Decrypt of the same
 *   row with no second audit row is unaudited, however close in time.
 *
 * Cadence: every 5 minutes over a 60-minute lookback of delivered events. CloudTrail delivers in about 5 minutes (not
 * guaranteed), so an unmatched Decrypt pages within about 10 minutes, inside the 15-minute own target of ST-10. An event
 * delivered more than 60 minutes late is missed by this job; the audit-side check below (an audited read whose Decrypt
 * never appeared within 30 minutes) is the signal that delivery is late or the trail is excluding KMS events.
 *
 * Runs that did not happen (a tick outage, CloudTrail failing) leave no gap: the window starts one lookback before the last
 * run that read CloudTrail, up to MAX_CATCHUP_MS back; a longer gap pages (`kms.reconcile_gap`) because it can no longer be
 * judged here. A monitor that has not read CloudTrail for the 15-minute target pages too (`kms.reconcile_blind`).
 */
export const KMS_RECONCILE_EVERY_SEC = 300;
export const CLOUDTRAIL_LOOKBACK_MS = 60 * 60_000;
/** How far back a run reaches to cover runs that did not happen. */
export const MAX_CATCHUP_MS = 24 * 60 * 60_000;
/** An audited read whose Decrypt has not appeared after this long is reported (trail late, misconfigured, or the call failed). */
export const AUDIT_SETTLE_MS = 30 * 60_000;
export const MATCH_BEFORE_MS = 5 * 60_000;
export const MATCH_AFTER_MS = 2 * 60_000;
/** The encryption-context key that carries the reconcile token. */
export const RECONCILE_CONTEXT_KEY = "secret_id";
/** Audit actions whose rows may match a Decrypt (a POSIX regex for `audit_log.action`). */
export const RECONCILE_AUDIT_ACTIONS = "^(secret\\.(reveal|read)(\\.|$)|connection\\.credential\\.used$)";
/** The ST-10 target the cadence is checked against. */
export const UNAUDITED_ALERT_TARGET_MS = 15 * 60_000;

export interface KmsDecryptEvent {
  /** CloudTrail `eventID`: unique per API call; the dedupe key. */
  eventId: string;
  /** CloudTrail `eventTime`. */
  at: Date;
  keyId: string;
  /** `userIdentity.arn` (the assumed-role session). */
  principal?: string | null;
  /** `requestParameters.encryptionContext` exactly as logged. */
  encryptionContext?: Record<string, string> | null;
  /** Set when the call failed (AccessDenied, InvalidCiphertext...): nothing was decrypted, so it needs no audit row. */
  errorCode?: string | null;
  /** Legacy field: the reconcile token taken from the context by the caller. Read only when `encryptionContext` is absent. */
  nonce?: string | null;
}

export function reconcileToken(e: KmsDecryptEvent): string | null {
  const v = e.encryptionContext ? e.encryptionContext[RECONCILE_CONTEXT_KEY] : e.nonce;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** CloudTrail Decrypt events DELIVERED so far with `eventTime` in [from, to). */
export interface CloudTrailPort {
  listDecryptEvents(from: Date, to: Date): Promise<KmsDecryptEvent[]>;
}

/**
 * In-memory CloudTrail. With a clock, an event is visible only once `deliveredAt` (default `at` + `lagMs`) has passed,
 * which models delivery delay; without one, every event is visible at once (the drill's usage).
 */
export class FakeCloudTrail implements CloudTrailPort {
  events: (KmsDecryptEvent & { deliveredAt?: Date })[] = [];
  constructor(private o: { clock?: { now(): Date }; lagMs?: number } = {}) {}
  async listDecryptEvents(from: Date, to: Date) {
    const now = this.o.clock?.now();
    return this.events.filter((e) => e.at >= from && e.at < to
      && (!now || (e.deliveredAt ?? new Date(e.at.getTime() + (this.o.lagMs ?? 0))) <= now));
  }
}

/**
 * Production stand-in while there is nothing for CloudTrail to be joined against (the vault is not configured, so no secret is
 * revealed and no vault Decrypt can be audited). It is NOT a pass: `kmsReconcile` raises `kms.reconcile_not_configured` (warn)
 * on every run until a real adapter replaces it, so a quiet dashboard never means "reconciled".
 */
export class UnwiredCloudTrail implements CloudTrailPort {
  constructor(readonly reason: string) {}
  async listDecryptEvents(): Promise<KmsDecryptEvent[]> { throw new Error("kms_reconcile_not_configured"); }
}

/**
 * Only Decrypts of the vault KEKs are reconciled against reveal and read rows. The PII key is decrypted on ordinary order
 * paths that write no reveal row, so its events must not be judged here (they would all page as unaudited).
 */
export class VaultKeyDecrypts implements CloudTrailPort {
  private ids: Set<string>;
  constructor(private inner: CloudTrailPort, vaultKeyArns: string[]) { this.ids = new Set(vaultKeyArns.map(keyIdOf)); }
  async listDecryptEvents(from: Date, to: Date) {
    return (await this.inner.listDecryptEvents(from, to)).filter((e) => this.ids.has(keyIdOf(e.keyId)));
  }
}
const keyIdOf = (arnOrId: string) => arnOrId.slice(arnOrId.lastIndexOf("/") + 1);

/**
 * The real adapter: CloudTrail `LookupEvents` (JSON 1.1, `X-Amz-Target: com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.LookupEvents`)
 * filtered on `EventName=Decrypt`, paginated by `NextToken`, signed with the vault's SigV4 signer. Wired in production (behind
 * VaultKeyDecrypts) only when the vault is configured; tested against fakes, not yet against a live trail. Unverified details: the event history includes KMS management events for 90 days; LookupEvents is limited to
 * 2 requests a second per account and Region; `StartTime`/`EndTime` are epoch seconds in JSON 1.1; `CloudTrailEvent` is a JSON
 * string with `eventID`, `eventTime`, `userIdentity.arn`, `requestParameters.encryptionContext`, `resources[].ARN` and `errorCode`.
 * At higher volume the Athena query over the log-archive copy replaces it behind the same port.
 */
export class CloudTrailLookupEvents implements CloudTrailPort {
  constructor(private o: { region: string; credentials: () => Promise<AwsCredentials>; fetch: FetchLike; clock?: { now(): Date }; maxPages?: number }) {
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(o.region)) throw new Error("cloudtrail: region must be pinned");
  }
  async listDecryptEvents(from: Date, to: Date): Promise<KmsDecryptEvent[]> {
    const out: KmsDecryptEvent[] = [];
    let next: string | undefined;
    for (let page = 0; page < (this.o.maxPages ?? 200); page++) {
      const body = JSON.stringify({
        LookupAttributes: [{ AttributeKey: "EventName", AttributeValue: "Decrypt" }],
        StartTime: Math.floor(from.getTime() / 1000), EndTime: Math.ceil(to.getTime() / 1000), MaxResults: 50, ...(next ? { NextToken: next } : {}),
      });
      const r = await this.post(body);
      for (const ev of (r.Events as { CloudTrailEvent?: string }[] | undefined) ?? []) {
        const parsed = parseCloudTrailDecrypt(ev.CloudTrailEvent ?? "");
        if (parsed && parsed.at >= from && parsed.at < to) out.push(parsed);
      }
      next = typeof r.NextToken === "string" ? r.NextToken : undefined;
      if (!next) return out;
    }
    throw new Error("cloudtrail: page limit reached");
  }
  private async post(body: string): Promise<Record<string, unknown>> {
    const host = `cloudtrail.${this.o.region}.amazonaws.com`;
    const amzDate = (this.o.clock ?? { now: () => new Date() }).now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const headers: Record<string, string> = { "content-type": "application/x-amz-json-1.1", "x-amz-target": "com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.LookupEvents" };
    const creds = await this.o.credentials();
    const { authorization } = signV4({ method: "POST", host, path: "/", headers, body, region: this.o.region, service: "cloudtrail", amzDate, credentials: creds });
    const res = await this.o.fetch(`https://${host}/`, { method: "POST", headers: { ...headers, host, "x-amz-date": amzDate, authorization, ...(creds.sessionToken ? { "x-amz-security-token": creds.sessionToken } : {}) }, body, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`cloudtrail: http ${res.status}`);
    return JSON.parse(text) as Record<string, unknown>;
  }
}

/** One `CloudTrailEvent` record (a JSON string) to the port's shape; null for anything that is not a KMS Decrypt. */
export function parseCloudTrailDecrypt(raw: string): KmsDecryptEvent | null {
  let e: Record<string, any>;
  try { e = JSON.parse(raw); } catch { return null; }
  if (e?.eventSource !== "kms.amazonaws.com" || e?.eventName !== "Decrypt" || typeof e.eventID !== "string") return null;
  const at = new Date(String(e.eventTime));
  if (Number.isNaN(at.getTime())) return null;
  const ctxIn = e.requestParameters?.encryptionContext;
  const context = ctxIn && typeof ctxIn === "object" ? Object.fromEntries(Object.entries(ctxIn).map(([k, v]) => [k, String(v)])) : null;
  const keyArn = Array.isArray(e.resources) ? e.resources.find((x: any) => x?.type === "AWS::KMS::Key")?.ARN : undefined;
  return { eventId: e.eventID, at, keyId: String(e.requestParameters?.keyId ?? keyArn ?? ""), principal: e.userIdentity?.arn ?? null, encryptionContext: context, errorCode: e.errorCode ?? null };
}

const AUDIT_CURSOR = "audit.kms_reconcile.audit_cursor";
/** The `now` of the last run that read CloudTrail and judged what it listed. */
const EVENT_CURSOR = "audit.kms_reconcile.event_cursor";
/** Set by the first failing read after a success; cleared by the next success. */
const FAILING_SINCE = "audit.kms_reconcile.failing_since";
const LOCK = "audit.kms_reconcile";

type Q = Pick<Pool | PoolClient, "query">;
async function flagTime(q: Q, name: string): Promise<Date | null> {
  const v = (await q.query("select value from flags where name = $1", [name])).rows[0]?.value;
  const d = typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}
const setFlagTime = (q: Q, name: string, at: Date) => q.query(
  "insert into flags (name, value, updated_by) values ($1, to_jsonb($2::text), 'kms_reconcile') on conflict (name) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()",
  [name, at.toISOString()]);

export interface KmsReconcileResult {
  /** Newly judged events this run. */
  events: number;
  /** Event ids judged unaudited this run. */
  unaudited: string[];
  /** Audited reads older than AUDIT_SETTLE_MS whose Decrypt never appeared (checked once per row). */
  auditWithoutEvent: number;
}

interface AuditCand { chain_id: string; seq: string; at: Date; token: string; used?: boolean }

export async function kmsReconcile(ctx: Pick<AppContext, "cron" | "clock" | "services">, ct: CloudTrailPort): Promise<KmsReconcileResult> {
  if (ct instanceof UnwiredCloudTrail) {
    await raiseAlert(ctx, ctx.cron, { severity: "warn", kind: "kms.reconcile_not_configured", subject: "cloudtrail", detail: { reason: ct.reason } });
    return { events: 0, unaudited: [], auditWithoutEvent: 0 };
  }
  const now = ctx.clock.now();
  const lastRead = await flagTime(ctx.cron, EVENT_CURSOR);
  const wanted = new Date(Math.min(now.getTime(), (lastRead ?? now).getTime()) - CLOUDTRAIL_LOOKBACK_MS);
  const floor = new Date(now.getTime() - MAX_CATCHUP_MS);
  const from = wanted < floor ? floor : wanted;
  let listed: KmsDecryptEvent[];
  try {
    listed = (await ct.listDecryptEvents(from, now)).filter((e) => !e.errorCode);
  } catch (e) {
    // Blind: nothing is being judged. Page once it lasts as long as the ST-10 target, counted from the last good read (or the first failure).
    await ctx.cron.query("insert into flags (name, value, updated_by) values ($1, to_jsonb($2::text), 'kms_reconcile') on conflict (name) do nothing", [FAILING_SINCE, now.toISOString()]);
    const since = lastRead ?? await flagTime(ctx.cron, FAILING_SINCE) ?? now;
    if (now.getTime() - since.getTime() >= UNAUDITED_ALERT_TARGET_MS) {
      await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "kms.reconcile_blind", subject: "cloudtrail", detail: { minutes: Math.floor((now.getTime() - since.getTime()) / 60_000) } });
    }
    throw e;
  }

  return tx(ctx.cron, async (c) => {
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [LOCK]);
    if (wanted < floor) await raiseAlert(ctx, c, { severity: "page", kind: "kms.reconcile_gap", subject: "cloudtrail", detail: { unjudged_minutes: Math.floor((floor.getTime() - wanted.getTime()) / 60_000) } });
    const ids = [...new Set(listed.map((e) => e.eventId))];
    const judged = new Set((await c.query("select event_id from kms_reconcile_events where event_id = any($1::text[])", [ids])).rows.map((r) => r.event_id as string));
    const seen = new Set<string>();
    const fresh = listed.filter((e) => !judged.has(e.eventId) && !seen.has(e.eventId) && seen.add(e.eventId)).sort((a, b) => a.at.getTime() - b.at.getTime());

    const unaudited: string[] = [];
    if (fresh.length) {
      const tokens = [...new Set(fresh.map(reconcileToken).filter((t): t is string => !!t))];
      const lo = new Date(Math.min(...fresh.map((e) => e.at.getTime())) - MATCH_BEFORE_MS);
      const hi = new Date(Math.max(...fresh.map((e) => e.at.getTime())) + MATCH_AFTER_MS);
      const cands = tokens.length ? (await c.query(
        `select a.chain_id, a.seq::text as seq, a.at, coalesce(a.detail->>'kms_ref', a.detail->>'decrypt_nonce') as token
           from audit_log a
          where coalesce(a.detail->>'kms_ref', a.detail->>'decrypt_nonce') = any($1::text[]) and a.at >= $2 and a.at <= $3 and a.action ~ $4
            and not exists (select 1 from kms_reconcile_events k where k.audit_chain_id = a.chain_id and k.audit_seq = a.seq)
          order by a.at, a.chain_id, a.seq`, [tokens, lo, hi, RECONCILE_AUDIT_ACTIONS])).rows as AuditCand[] : [];
      const byToken = new Map<string, AuditCand[]>();
      for (const a of cands) { const l = byToken.get(a.token) ?? []; l.push(a); byToken.set(a.token, l); }
      for (const e of fresh) {
        const token = reconcileToken(e);
        const t = e.at.getTime();
        const hit = token ? (byToken.get(token) ?? []).find((a) => !a.used && a.at.getTime() >= t - MATCH_BEFORE_MS && a.at.getTime() <= t + MATCH_AFTER_MS) : undefined;
        if (hit) hit.used = true; else unaudited.push(e.eventId);
        await c.query(
          `insert into kms_reconcile_events (event_id, at, key_id, principal, token, state, audit_chain_id, audit_seq, judged_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (event_id) do nothing`,
          [e.eventId, e.at, e.keyId || null, e.principal ?? null, token, hit ? "matched" : "unaudited", hit?.chain_id ?? null, hit ? hit.seq : null, now]);
      }
    }

    // Audit side, once per row: reads in [cursor, now - settle) that never consumed an event.
    const settled = new Date(now.getTime() - AUDIT_SETTLE_MS);
    const cur = (await c.query("select value from flags where name = $1", [AUDIT_CURSOR])).rows[0]?.value as string | undefined;
    const auditFrom = cur ? new Date(cur) : new Date(settled.getTime() - CLOUDTRAIL_LOOKBACK_MS);
    let auditWithoutEvent = 0;
    if (auditFrom < settled) {
      auditWithoutEvent = (await c.query(
        `select count(*)::int as n from audit_log a
          where (a.detail ? 'decrypt_nonce' or a.detail ? 'kms_ref') and a.at >= $1 and a.at < $2 and a.action ~ $3
            and not exists (select 1 from kms_reconcile_events k where k.audit_chain_id = a.chain_id and k.audit_seq = a.seq)`, [auditFrom, settled, RECONCILE_AUDIT_ACTIONS])).rows[0].n as number;
      await c.query(
        "insert into flags (name, value, updated_by) values ($1, to_jsonb($2::text), 'kms_reconcile') on conflict (name) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()",
        [AUDIT_CURSOR, settled.toISOString()]);
    }

    // CloudTrail was read and every listed event judged: the next run's window starts from here.
    await setFlagTime(c, EVENT_CURSOR, now);
    await c.query("delete from flags where name = $1", [FAILING_SINCE]);
    await closeAlerts(c, "kms.reconcile_blind", "cloudtrail");

    // Event ids and counts only (opaque), never context values. The open page is what the vault's auto-deny watches.
    if (unaudited.length) await raiseAlert(ctx, c, { severity: "page", kind: "kms.decrypt_unaudited", subject: "cloudtrail", detail: { count: unaudited.length, event_ids: unaudited.slice(0, 10) } });
    if (auditWithoutEvent) await raiseAlert(ctx, c, { severity: "warn", kind: "kms.audit_without_event", subject: "cloudtrail", detail: { count: auditWithoutEvent } });
    return { events: fresh.length, unaudited, auditWithoutEvent };
  });
}
