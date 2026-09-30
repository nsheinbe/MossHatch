import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { connect } from "@mosshatch/db";
import type { Clock, KmsPort } from "../ports.ts";
import { appendAudit, SYSTEM_CHAIN } from "../audit.ts";
import type { AnchorSink, AnchorVerification, ChainVerification } from "./anchor.ts";
import { verifyAllChains, verifyAnchors } from "./anchor.ts";
import { erasureHash, purgeFromLedger, type ErasureLedger } from "./erasure.ts";

const run = promisify(execFile);
export const DEFAULT_PG_BIN = "/usr/lib/postgresql/16/bin";
/** Own targets (PLAN 4.3b): reads back within 4 hours, writes within 8. */
export const RECOVERY_TARGET_MS = { reads: 4 * 3_600_000, writes: 8 * 3_600_000 };

export interface RestoreDrillOptions {
  /** Connection URL of the database to back up (a role that may pg_dump everything). */
  sourceUrl: string;
  /** Connection URL of a server where the scratch database may be created; defaults to the source server. */
  adminUrl?: string;
  pgBin?: string;
  ledger: ErasureLedger;
  sink: AnchorSink;
  kms: KmsPort;
  clock?: Clock;
  /** Directory for the dump file. */
  workDir: string;
  /** Append the timing line here (docs/runbooks/restore-drill-log.md). Omit to skip. */
  logPath?: string;
  label?: string;
  keepScratch?: boolean;
  /** When the backup was taken; defaults to the moment the dump starts. A real drill passes the backup's own timestamp. */
  backupTakenAt?: Date;
  /** Use an existing dump instead of running pg_dump (drill of "last night's off-Neon backup"). */
  dumpFile?: string;
}

export interface RestoreDrillResult {
  ok: boolean;
  scratchDb: string;
  backupTakenAt: string;
  steps: { name: string; ms: number }[];
  totalMs: number;
  chains: ChainVerification;
  anchors: AnchorVerification;
  purge: { ledgerEntries: number; erased: number };
  /** Ledger users still not purged after the purge: must be 0. */
  resurrected: number;
  withinTargets: { reads: boolean; writes: boolean };
  logLine: string;
}

const withDb = (url: string, db: string) => { const u = new URL(url); u.pathname = "/" + db; return u.toString(); };
const secs = (ms: number) => (ms / 1000).toFixed(1) + " s";

/**
 * ST-143 and ST-152. pg_dump the source (or use a supplied dump), restore into a scratch database, write the
 * `restore` event, re-run the erasure purge from the ledger that lives outside the database, verify every chain and
 * compare with the external anchors, and record the elapsed time. Rows after the last anchor are reported as
 * unanchored; anchors newer than the backup are the expected gap; a missing row before the backup is tampering.
 * Proven here against a local PostgreSQL 16 only: a Neon branch, the Object Lock bucket and the KMS key are not exercised.
 */
export async function restoreDrill(o: RestoreDrillOptions): Promise<RestoreDrillResult> {
  const bin = o.pgBin ?? DEFAULT_PG_BIN;
  const clock = o.clock ?? { now: () => new Date() };
  const admin = o.adminUrl ?? o.sourceUrl;
  const steps: RestoreDrillResult["steps"] = [];
  const t0 = performance.now();
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const s = performance.now();
    try { return await fn(); } finally { steps.push({ name, ms: Math.round(performance.now() - s) }); }
  };

  fs.mkdirSync(o.workDir, { recursive: true });
  const backupTakenAt = o.backupTakenAt ?? clock.now();
  const dump = o.dumpFile ?? path.join(o.workDir, `drill-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.dump`);
  if (!o.dumpFile) await step("dump", async () => { await run(path.join(bin, "pg_dump"), ["--format=custom", "--no-owner", "--file", dump, o.sourceUrl]); });

  const scratchDb = `mh_drill_${crypto.randomBytes(4).toString("hex")}`;
  const scratchUrl = withDb(admin, scratchDb);
  const a = new pg.Client({ connectionString: admin });
  await a.connect();
  let pool: ReturnType<typeof connect> | undefined;
  try {
    await step("create_scratch", async () => { await a.query(`create database "${scratchDb}"`); });
    await step("restore", async () => { await run(path.join(bin, "pg_restore"), ["--no-owner", "--exit-on-error", "--dbname", scratchUrl, dump]); });
    pool = connect(scratchUrl, { max: 2 });
    const ctx = { cron: pool, kms: o.kms, clock, services: {} };

    await step("restore_event", async () => {
      const c = await pool!.connect();
      try {
        await c.query("begin");
        await appendAudit(ctx, c, { chainId: SYSTEM_CHAIN, actorKind: "system", action: "restore", resourceKind: "database", detail: { restored_to: backupTakenAt.toISOString(), drill: true } });
        await c.query("commit");
      } catch (e) { await c.query("rollback").catch(() => undefined); throw e; } finally { c.release(); }
    });
    const purge = await step("purge_from_ledger", () => purgeFromLedger(ctx, o.ledger));
    const chains = await step("verify_chains", () => verifyAllChains(ctx));
    const anchors = await step("verify_anchors", () => verifyAnchors(ctx, o.sink));
    const hashes = (await o.ledger.list()).map((e) => e.userHash);
    const resurrected = hashes.length ? (await pool.query(
      "select count(*)::int as n from users where status <> 'purged' and encode(sha256(convert_to('mh-erasure-v1:' || id::text, 'UTF8')), 'hex') = any($1::text[])", [hashes])).rows[0].n as number : 0;

    const totalMs = Math.round(performance.now() - t0);
    const ok = chains.failures.length === 0 && anchors.ok && resurrected === 0;
    const withinTargets = { reads: totalMs <= RECOVERY_TARGET_MS.reads, writes: totalMs <= RECOVERY_TARGET_MS.writes };
    const stepMs = (n: string) => steps.find((s) => s.name === n)?.ms ?? 0;
    const logLine = `| ${clock.now().toISOString().slice(0, 10)} | ${o.label ?? "drill"} | ${secs(totalMs)} | dump ${secs(stepMs("dump"))}, restore ${secs(stepMs("restore"))}, purge ${secs(stepMs("purge_from_ledger"))}, verify ${secs(stepMs("verify_chains") + stepMs("verify_anchors"))} | ${chains.chains} chains, ${anchors.unanchored.rows} unanchored rows, ${anchors.expectedGap.length} gap findings, ${anchors.tampered.length} tampered | ${purge.erased} re-erased, ${resurrected} resurrected | ${ok ? "pass" : "FAIL"} |`;
    if (o.logPath) appendDrillLog(o.logPath, logLine);
    return { ok, scratchDb, backupTakenAt: backupTakenAt.toISOString(), steps, totalMs, chains, anchors, purge, resurrected, withinTargets, logLine };
  } finally {
    await pool?.end().catch(() => undefined);
    if (!o.keepScratch) await a.query(`drop database if exists "${scratchDb}" with (force)`).catch(() => undefined);
    await a.end();
    if (!o.dumpFile) fs.rmSync(dump, { force: true });
  }
}

const LOG_HEADER = `# Restore drill log

One line per drill, appended by \`scripts/ops-restore-drill.mjs\`. Targets (own targets, D-027): reads back within 4 hours, writes within 8.
A drill on a small scratch database measures the mechanism, not the production restore time; the first drill on a production-sized Neon branch replaces these numbers.

| Date | Label | Total | Steps | Chains and anchors | Erasure ledger | Result |
|---|---|---|---|---|---|---|
`;
export function appendDrillLog(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, LOG_HEADER);
  fs.appendFileSync(file, line + "\n");
}
export { erasureHash };
