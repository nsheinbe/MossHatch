#!/usr/bin/env node
// Restore drill (ST-143, ST-152): pg_dump -> scratch database -> restore -> purge from the erasure ledger ->
// verify chains against the external anchors -> record the time in docs/runbooks/restore-drill-log.md.
//
//   MH_DRILL_SOURCE_URL=postgres://... MH_ANCHOR_DIR=/path MH_ERASURE_LEDGER=/path/ledger.jsonl node scripts/ops-restore-drill.mjs [--label monthly]
//
// Optional: MH_DRILL_ADMIN_URL (server for the scratch database), MH_PG_BIN, MH_DRILL_DUMP (restore this dump file
// instead of dumping), MH_DRILL_BACKUP_AT (ISO time the dump was taken), MH_DRILL_LOG (default docs/runbooks/restore-drill-log.md).
// Only the local KMS is wired: the AWS KMS HMAC adapter is not built, so a drill against production anchors needs it first.
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The library is TypeScript with parameter properties; Node needs the transform flag to load it.
if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const missing = ["MH_DRILL_SOURCE_URL", "MH_ANCHOR_DIR", "MH_ERASURE_LEDGER"].filter((k) => !env[k]);
if (missing.length) { console.error("missing: " + missing.join(", ")); process.exit(2); }
if (env.MH_KMS && env.MH_KMS !== "local") { console.error("only MH_KMS=local is supported: the AWS KMS adapter is not built"); process.exit(2); }

const { restoreDrill } = await import(path.join(root, "packages/api/src/ops/restore.ts"));
const { FileAnchorSink } = await import(path.join(root, "packages/api/src/ops/anchor.ts"));
const { FileErasureLedger } = await import(path.join(root, "packages/api/src/ops/erasure.ts"));
const { LocalKms } = await import(path.join(root, "packages/api/src/kms.ts"));

const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "drill";
const r = await restoreDrill({
  sourceUrl: env.MH_DRILL_SOURCE_URL, adminUrl: env.MH_DRILL_ADMIN_URL, pgBin: env.MH_PG_BIN,
  ledger: new FileErasureLedger(env.MH_ERASURE_LEDGER), sink: new FileAnchorSink(env.MH_ANCHOR_DIR), kms: new LocalKms(),
  workDir: path.join(os.tmpdir(), "mh-restore-drill"), label, dumpFile: env.MH_DRILL_DUMP,
  backupTakenAt: env.MH_DRILL_BACKUP_AT ? new Date(env.MH_DRILL_BACKUP_AT) : undefined,
  logPath: env.MH_DRILL_LOG ?? path.join(root, "docs/runbooks/restore-drill-log.md"),
});
console.log(JSON.stringify({ ok: r.ok, totalMs: r.totalMs, steps: r.steps, chains: r.chains.chains, chainFailures: r.chains.failures.length, tampered: r.anchors.tampered.length, expectedGap: r.anchors.expectedGap.length, unanchoredRows: r.anchors.unanchored.rows, purge: r.purge, resurrected: r.resurrected, withinTargets: r.withinTargets }));
process.exit(r.ok ? 0 : 1);
