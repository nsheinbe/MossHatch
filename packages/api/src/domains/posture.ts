import { tx } from "@mosshatch/db";
import { RegistrarError, type DomainStatus } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { appendAudit } from "../audit.ts";
import { closeAlerts, raiseAlert } from "../ops/alerts.ts";
import { notifyDomainEvent } from "../domain-mgmt/common.ts";
import { domainsServices, registrarOf, rowToDomain, type DomainRow, type Q } from "./common.ts";
import { EXPLAIN_WINDOW_MS, finishRun, openFinding, startRun } from "./detector.ts";

/**
 * `registrar.posture` (nightly; ST-113, PLAN threat row 32). For every live domain the registrar must show what we set, not what we
 * hope: registrar-side auto-renew off (renewal is ours, D-008) and `let_expire` off, the lock as the owner last set it with us (see
 * `ownerUnlocked`: an unlock stands until the owner or a safety path locks again, never until a timer runs out), privacy as the extension
 * offers it (no paid privacy service; `.ai` and `.io` show contacts), and, once per run, that a Horizon test profile's login to the
 * registrar's end-user interface redirects. Auto-renew and the lock are put right at once, because both are the safe direction; the rest
 * is a finding for a person. Every mismatch is a `reconciliation_findings` row of kind `mismatch`. A re-lock is recorded like any other
 * (our row, the audit chain, a new code, a notice), so the next sync does not see it as a change nobody made.
 */
export interface PostureResult { checked: number; mismatches: number; fixed: number; errors: number; endUser: "redirects" | "reachable" | "unreachable" | "not_configured" }

/** The privacy state each extension is expected to show (`.ai` and `.io` have no privacy option; the rest redact by default). */
export const expectedPrivacy = (tld: string): DomainStatus["privacyStatus"] => (tld === "ai" || tld === "io" ? "not_available" : "redacted_default");

export async function runPosture(ctx: AppContext): Promise<PostureResult> {
  const reg = registrarOf(ctx);
  const runId = await startRun(ctx.cron, "posture", ctx.clock.now());
  const res: PostureResult = { checked: 0, mismatches: 0, fixed: 0, errors: 0, endUser: "not_configured" };
  const rows = (await ctx.cron.query("select * from domains where released_at is null and state <> 'pending' order by id")).rows.map(rowToDomain);
  for (const d of rows) {
    let up: DomainStatus | null;
    try { up = await reg.getDomain(d.fqdn); } catch (e) { if (e instanceof RegistrarError) { res.errors++; continue; } throw e; }
    if (!up) continue;                                      // the sync handles a name the registrar does not know
    res.checked++;
    const bad: string[] = [];
    const fixes: (() => Promise<void>)[] = [];
    if (up.autoRenew || up.letExpire) { bad.push(up.autoRenew ? "auto_renew" : "let_expire"); if (up.autoRenew && up.letExpire) bad.push("let_expire"); fixes.push(() => reg.setAutoRenew(d.fqdn, false)); }
    if (!up.locked && !(await ownerUnlocked(ctx.cron, d, ctx.clock.now()))) { bad.push("lock"); fixes.push(() => relock(ctx, d)); }
    if (up.privacyStatus !== expectedPrivacy(d.tld) || up.privacyServiceEnabled) bad.push("privacy");
    if (bad.length === 0) continue;
    res.mismatches++;
    await tx(ctx.cron, (c) => openFinding(ctx, c, { runId, domain: d, kind: "mismatch", fields: bad, observed: { ar: up!.autoRenew, le: !!up!.letExpire, l: up!.locked, p: up!.privacyStatus, ps: !!up!.privacyServiceEnabled }, detail: { fields: bad.length } }));
    for (const fix of fixes) { try { await fix(); res.fixed++; } catch (e) { if (!(e instanceof RegistrarError)) throw e; res.errors++; } }
  }

  // The end-user interface (ST-113, threat row 32): a test profile that logs in there must be sent away, not shown codes or a reset.
  const s = domainsServices(ctx);
  if (s.endUserProbe && s.probeProfile) {
    const v = await s.endUserProbe.probeLogin(s.probeProfile);
    res.endUser = v.verdict;
    if (v.verdict !== "redirects") {
      await tx(ctx.cron, async (c) => {
        await raiseAlert(ctx, c, { severity: "page", kind: "end_user_interface_reachable", subject: "registrar", detail: { verdict: v.verdict } });
        await openFinding(ctx, c, { runId, domain: { id: "", userId: "" }, kind: "mismatch", fields: ["end_user_interface"], observed: { v: v.verdict }, detail: { verdict: v.verdict } });
      });
      res.mismatches++;
    } else await closeAlerts(ctx.cron, "end_user_interface_reachable", "registrar");
    await closeAlerts(ctx.cron, "posture_probe_not_configured", "registrar");
  } else {
    await tx(ctx.cron, (c) => raiseAlert(ctx, c, { severity: "warn", kind: "posture_probe_not_configured", subject: "registrar" }));
  }
  await finishRun(ctx.cron, runId, ctx.clock.now(), res.checked, res.mismatches);
  return res;
}

/**
 * Whether the owner wants the name unlocked: the gated unlock handler recorded `unlocked_at` (every re-lock path clears it again), or an
 * unlock action committed in the last 7 days has not finished yet (the registrar can be unlocked a moment before our row says so).
 */
export async function ownerUnlocked(q: Q, d: DomainRow, now: Date): Promise<boolean> {
  const s = (await q.query("select unlocked_at from domain_security where domain_id = $1", [d.id])).rows[0];
  if (s?.unlocked_at) return true;
  const a = await q.query(
    `select 1 from actions where user_id = $1 and type = 'domain.unlock' and state in ('committed','dispatching','outcome_unknown') and committed_at >= $2
        and (resource_id = $3 or target_id = $3 or target_id = $4) limit 1`, [d.userId, new Date(now.getTime() - EXPLAIN_WINDOW_MS), d.id, d.fqdn]);
  return (a.rowCount ?? 0) > 0;
}

/** Lock again a name nobody unlocked through us: at the registrar, in our row (so the detector sees our own change), with a new code and a notice. */
async function relock(ctx: AppContext, d: DomainRow): Promise<void> {
  const reg = registrarOf(ctx);
  await reg.setLock(d.fqdn, true);
  await tx(ctx.cron, async (c) => {
    await c.query("update domains set locked = true where id = $1 and released_at is null", [d.id]);
    await c.query("insert into domain_security (domain_id, user_id) values ($1,$2) on conflict (domain_id) do nothing", [d.id, d.userId]);
    await appendAudit(ctx, c, { chainId: d.userId, actorKind: "system", action: "domain.relocked", resourceKind: "domain", resourceId: d.id, detail: { reason: "posture" } });
    await notifyDomainEvent(ctx, c, d.userId, {
      kind: "domain.relocked", domainId: d.id, subject: "A domain on your Mosshatch account was locked again",
      text: `${d.fqdn} was unlocked at our registrar without your passkey, so we locked it again and replaced its transfer code. To move it to another registrar, unlock it from your Mosshatch account.`,
    });
  });
  // The code could have been read while the name was unlocked: replace it, as at every re-lock (ST-120). `.io` codes are set by support.
  try { await reg.rerandomizeAuthCode(d.fqdn); }
  catch (e) { if (e instanceof RegistrarError && e.code === "code_by_support") return; throw e; }
  await ctx.cron.query("update domain_security set code_rerandomized_at = $2, code_rerandomize_at = null where domain_id = $1", [d.id, ctx.clock.now()]);
}

export type { DomainRow };
