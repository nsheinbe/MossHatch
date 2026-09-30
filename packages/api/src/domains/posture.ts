import { tx } from "@mosshatch/db";
import { RegistrarError, type DomainStatus } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { closeAlerts, raiseAlert } from "../ops/alerts.ts";
import { domainsServices, registrarOf, rowToDomain, type DomainRow } from "./common.ts";
import { finishRun, loadExplanation, openFinding, startRun } from "./detector.ts";

/**
 * `registrar.posture` (nightly; ST-113, PLAN threat row 32). For every live domain the registrar must show what we set, not what we
 * hope: registrar-side auto-renew off (renewal is ours, D-008) and `let_expire` off, the lock on unless an unlock we committed explains it,
 * privacy as the extension offers it (no paid privacy service; `.ai` and `.io` show contacts), and, once per run, that a Horizon test
 * profile's login to the registrar's end-user interface redirects. Auto-renew and the lock are put right at once, because both are the
 * safe direction; the rest is a finding for a person. Every mismatch is a `reconciliation_findings` row of kind `mismatch`.
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
    if (!up.locked) {
      const ex = await loadExplanation(ctx.cron, d, ctx.clock.now());
      const explained = ex.locked === "any" || ex.locked?.has(false);
      if (!explained) { bad.push("lock"); fixes.push(() => reg.setLock(d.fqdn, true)); }
    }
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

export type { DomainRow };
