import type { PoolClient } from "@mosshatch/db";
import type { DomainStatus } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { appendAudit } from "../audit.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { hashOf } from "../util/bytes.ts";
import { DAY_MS, type DomainRow, type Q } from "./common.ts";

/**
 * The unattributed-change detector (PLAN 4.3b jobs table; ST-114, ST-60).
 *
 * A change at the registrar is "attributed" when a step-up action we committed explains it. The comparison is against what the last sync saw
 * (lock, nameservers, DS presence, registrant email hash, privacy state, pending transfer) and against fixed expectations (`auto_renew` and
 * `let_expire` are always off, the paid privacy service is never on). Anything else is a finding: a row in `reconciliation_findings`
 * and a page.
 *
 * Ordering rule (ST-60): the actions committed for a domain are read in commit order and every value they set is acceptable. An observed
 * state that any prefix of the committed sequence produces is explained, so a process that died between "registrar changed" and "cache
 * updated" leaves the detector quiet once the job (or the sync) catches up, and a state that no prefix produces is a finding.
 *
 * `expected_post_state` on the action row (the domain-management module writes it) uses the DomainStatus field names:
 * `{ locked?, nameservers?, owner_email_hash?, ds_present?, transfer_away? }`. Without it the action type explains its own field, with the
 * value its params name: unlock -> lock, nameservers.change -> nameservers (or DS presence), contact.change -> the `owner_email_hash` it
 * sets, transfer_out -> transfer and lock. An action whose resulting value is unknown explains nothing.
 */
export type Field = "lock" | "nameservers" | "ds" | "contact_email_hash" | "auto_renew" | "let_expire" | "privacy" | "transfer";
export const DETECTOR_FIELDS: readonly Field[] = ["lock", "nameservers", "ds", "contact_email_hash", "auto_renew", "let_expire", "privacy", "transfer"];

/** How far back a committed action can explain a change (the transfer window). */
export const EXPLAIN_WINDOW_MS = 7 * DAY_MS;

const sortedNs = (ns: readonly string[]) => [...ns].map((n) => n.toLowerCase().replace(/\.$/, "")).sort().join(",");

/** Fields whose upstream value differs from what we last saw, or from the fixed expectation. */
export function diffFields(cached: DomainRow, up: DomainStatus): Field[] {
  const out: Field[] = [];
  if (up.locked !== cached.locked) out.push("lock");
  if (sortedNs(up.nameservers) !== sortedNs(cached.nameservers)) out.push("nameservers");
  if (up.dsPresent !== cached.dsPresent) out.push("ds");
  // The first observation of the registrant email hash is the baseline, not a change.
  if (up.ownerEmailHash !== undefined && cached.ownerEmailHash !== null && up.ownerEmailHash !== cached.ownerEmailHash) out.push("contact_email_hash");
  if (up.autoRenew) out.push("auto_renew");
  if (up.letExpire) out.push("let_expire");
  if (up.privacyStatus !== cached.privacyStatus || up.privacyServiceEnabled) out.push("privacy");
  if (!!up.transferAwayInProgress !== cached.transferAway && !!up.transferAwayInProgress) out.push("transfer");
  return out;
}

interface Explain {
  locked?: Set<boolean> | "any"; nameservers?: Set<string> | "any"; owner_email_hash?: Set<string> | "any"; ds_present?: Set<boolean> | "any"; transfer?: boolean;
}
/** Add the value an action leaves behind. An action whose resulting value is not known explains nothing (never "any value"). */
function add<T>(cur: Set<T> | "any" | undefined, v: T | undefined): Set<T> | "any" {
  if (cur === "any") return cur;
  const s = cur ?? new Set<T>();
  if (v !== undefined) s.add(v);
  return s;
}

export async function loadExplanation(q: Q, d: DomainRow, now: Date): Promise<Explain> {
  const rows = (await q.query(
    `select type, params, expected_post_state from actions
      where user_id = $1 and state in ('committed','dispatching','executed','outcome_unknown') and committed_at >= $2
        and type in ('domain.unlock','domain.nameservers.change','domain.contact.change','domain.transfer_out')
        and (resource_id = $3 or target_id = $3 or target_id = $4)
      order by committed_at, id`,
    [d.userId, new Date(now.getTime() - EXPLAIN_WINDOW_MS), d.id, d.fqdn])).rows as { type: string; params: Record<string, any> | null; expected_post_state: Record<string, any> | null }[];
  const ex: Explain = {};
  for (const a of rows) {
    const post = a.expected_post_state ?? {};
    const p = a.params ?? {};
    if (a.type === "domain.unlock" || a.type === "domain.transfer_out") {
      ex.locked = add(ex.locked, typeof post.locked === "boolean" ? post.locked : false);
      ex.locked = add(ex.locked, true);              // the re-lock that follows an unlock is ours too
    }
    if (a.type === "domain.transfer_out") ex.transfer = true;
    if (a.type === "domain.nameservers.change") {
      // The action carries either a nameserver change or a DS add/remove (`params.op`); each explains only its own field.
      const op = typeof p.op === "string" ? p.op : "nameservers";
      // An add leaves a DS record in place; removing the last one leaves none (removing one of several changes no presence, so there is nothing to explain).
      if (op === "ds_add" || op === "ds_remove") ex.ds_present = add(ex.ds_present, typeof post.ds_present === "boolean" ? post.ds_present : op === "ds_add");
      else {
        const ns = Array.isArray(post.nameservers) ? post.nameservers : Array.isArray(p.nameservers) ? p.nameservers : undefined;
        ex.nameservers = add(ex.nameservers, ns ? sortedNs(ns as string[]) : undefined);
      }
    }
    if (a.type === "domain.contact.change") {
      const h = typeof post.owner_email_hash === "string" ? post.owner_email_hash : typeof p.owner_email_hash === "string" ? p.owner_email_hash : undefined;
      ex.owner_email_hash = add(ex.owner_email_hash, h);
    }
  }
  return ex;
}

/** Which of the differing fields no committed action explains. */
export function unexplained(fields: Field[], up: DomainStatus, ex: Explain): Field[] {
  return fields.filter((f) => {
    switch (f) {
      case "lock": return !(ex.locked === "any" || ex.locked?.has(up.locked));
      case "nameservers": return !(ex.nameservers === "any" || ex.nameservers?.has(sortedNs(up.nameservers)));
      case "ds": return !(ex.ds_present === "any" || ex.ds_present?.has(up.dsPresent));
      case "contact_email_hash": return !(ex.owner_email_hash === "any" || (up.ownerEmailHash !== undefined && ex.owner_email_hash?.has(up.ownerEmailHash)));
      case "transfer": return !ex.transfer;
      default: return true;                            // auto_renew, let_expire and privacy have no action that changes them
    }
  });
}

export async function startRun(c: Q, kind: "inventory" | "sync" | "posture", now: Date): Promise<string> {
  return (await c.query("insert into reconciliation_runs (kind, started_at) values ($1,$2) returning id", [kind, now])).rows[0].id as string;
}
export async function finishRun(c: Q, id: string, now: Date, seen: number, opened: number, error?: string): Promise<void> {
  await c.query("update reconciliation_runs set finished_at = $2, domains_seen = $3, findings_opened = $4, error = $5 where id = $1", [id, now, seen, opened, error ?? null]);
}

export interface FindingInput {
  runId: string | null; domain: Pick<DomainRow, "id" | "userId"> & { fqdn?: string };
  kind: "unexplained_change" | "missing_domain" | "extra_domain" | "mismatch";
  fields: string[]; detail?: Record<string, unknown>; observed?: unknown; withFqdn?: string;
}
/** Open a finding once per distinct observation; a repeat of the same observation is a no-op. Returns true when a new row was written. */
export async function openFinding(ctx: AppContext, c: PoolClient, f: FindingInput): Promise<boolean> {
  const fields = [...f.fields].sort();
  const fingerprint = hashOf({ d: f.domain.id, k: f.kind, f: fields, o: f.observed ?? null }).toString("hex");
  const r = await c.query(
    `insert into reconciliation_findings (run_id, domain_id, fqdn_ascii, kind, fields, detail, fingerprint, found_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (fingerprint) where state = 'open' do nothing returning id`,
    [f.runId, f.domain.id === "" ? null : f.domain.id, f.withFqdn ?? null, f.kind, fields, f.detail ?? {}, fingerprint, ctx.clock.now()]);
  if (r.rowCount !== 1) return false;
  const id = r.rows[0].id as string;
  await raiseAlert(ctx, c, { severity: "page", kind: f.kind === "unexplained_change" ? "unattributed_change" : `reconcile_${f.kind}`, subject: f.domain.id || id, detail: { finding_id: id, fields, domain_id: f.domain.id || null } });
  if (f.domain.userId) {
    await appendAudit(ctx, c, { chainId: f.domain.userId, actorKind: "system", action: `domain.${f.kind}`, resourceKind: "domain", resourceId: f.domain.id || undefined, detail: { fields, finding_id: id } });
  }
  return true;
}

/**
 * Compare one upstream reading with the cache. Runs inside the sync transaction BEFORE the cache is overwritten, so the finding and the new
 * cache values commit together. Returns the fields that differed and whether a finding was written.
 */
export async function observeDomain(ctx: AppContext, c: PoolClient, d: DomainRow, up: DomainStatus, runId: string | null): Promise<{ changed: Field[]; unexplained: Field[]; opened: boolean }> {
  const changed = diffFields(d, up);
  if (changed.length === 0) return { changed, unexplained: [], opened: false };
  const ex = await loadExplanation(c, d, ctx.clock.now());
  const bad = unexplained(changed, up, ex);
  if (bad.length === 0) return { changed, unexplained: [], opened: false };
  const opened = await openFinding(ctx, c, {
    runId, domain: d, kind: "unexplained_change", fields: bad,
    observed: { lock: up.locked, ns: sortedNs(up.nameservers), ds: up.dsPresent, h: up.ownerEmailHash ?? null, ar: up.autoRenew, le: !!up.letExpire, p: up.privacyStatus, ps: !!up.privacyServiceEnabled, t: !!up.transferAwayInProgress },
    detail: { changed: changed.length, unexplained: bad.length },
  });
  return { changed, unexplained: bad, opened };
}
