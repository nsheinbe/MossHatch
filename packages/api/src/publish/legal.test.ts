import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { DOCUMENT_FILES, hashOfFile, syncDocuments } from "../account/documents.ts";

const legalDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../apps/web/public/legal");
/** The fourteen documents of COMPLIANCE.md "Legal document set", by the kind each is published under. */
const SET = ["terms", "registration_agreement", "privacy_notice", "refund_policy", "fees_notifications", "auto_renew_authorisation", "acceptable_use",
  "abuse_dmca", "registrant_rights", "security_policy", "legal_process", "accessibility", "storage_cookies", "search_commitments"];

let app: TestApp;
beforeAll(async () => { app = await createTestApp(); }, 60_000);
afterAll(async () => { await app?.drop(); });

describe("C-72 the legal document set", () => {
  it("all fourteen documents exist as files, each marked as a draft that counsel has not approved", () => {
    for (const kind of SET) {
      const file = DOCUMENT_FILES[kind];
      expect(file, kind).toBeTruthy();
      const html = fs.readFileSync(path.join(legalDir, file!), "utf8");
      expect(html, kind).toMatch(/Draft awaiting counsel|Counsel has not (approved|reviewed)/);
      expect(html, kind).not.toMatch(/<script/i);
    }
  });

  it("syncDocuments publishes a version for each, keyed by the SHA-256 of the file, and republishing is a no-op", async () => {
    await app.db.owner.query("delete from document_versions");
    const out = await syncDocuments(app.db.owner, legalDir, app.clock.now());
    for (const kind of SET) {
      const row = out.find((d) => d.kind === kind);
      expect(row, kind).toBeDefined();
      expect(row!.hash).toBe(hashOfFile(path.join(legalDir, DOCUMENT_FILES[kind]!)));
    }
    const live = (await app.db.owner.query("select kind from document_versions where retired_at is null")).rows.map((r) => r.kind);
    for (const kind of SET) expect(live).toContain(kind);
    expect((await syncDocuments(app.db.owner, legalDir, app.clock.now())).every((d) => !d.changed)).toBe(true);
  });
});
