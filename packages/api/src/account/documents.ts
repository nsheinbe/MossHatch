import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Pool } from "@mosshatch/db";

/** The legal document set. Each file's SHA-256 is its version; acceptance records the hash the person was shown. */
export const DOCUMENT_FILES: Record<string, string> = { terms: "terms.html", registration_agreement: "registration-agreement.html", auto_renew_authorisation: "auto-renew-authorisation.html" };

export function hashOfFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Publish the current files as the versions in force. Idempotent: an unchanged file adds nothing; a changed one retires the old version. */
export async function syncDocuments(pool: Pool, dir: string, now = new Date()): Promise<{ kind: string; hash: string; changed: boolean }[]> {
  const out = [];
  for (const [kind, file] of Object.entries(DOCUMENT_FILES)) {
    // A document without a file is simply not published (the auto-renew authorisation only matters once domains exist).
    if (!fs.existsSync(path.join(dir, file))) continue;
    const hash = hashOfFile(path.join(dir, file));
    const cur = (await pool.query("select version_hash from document_versions where kind = $1 and retired_at is null order by effective_at desc limit 1", [kind])).rows[0];
    if (cur?.version_hash === hash) { out.push({ kind, hash, changed: false }); continue; }
    await pool.query("update document_versions set retired_at = $2 where kind = $1 and retired_at is null", [kind, now]);
    await pool.query("insert into document_versions (kind, version_hash, effective_at) values ($1,$2,$3) on conflict do nothing", [kind, hash, now]);
    out.push({ kind, hash, changed: true });
  }
  return out;
}
