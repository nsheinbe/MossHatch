import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHarness, makeBuyer, type Buyer, type OrdersHarness } from "../orders/testkit.ts";
import { registerAccountRoutes } from "./routes.ts";
import { syncDocuments } from "./documents.ts";

let h: OrdersHarness; let ada: Buyer; let cy: Buyer;
const CONTACT = { name: "Ada Moss", email: "", phone: "+1.5555550100", street: "1 Fern Lane", city: "Portland", region: "OR", postalCode: "97201", country: "US" };
const post = (b: Buyer, path: string, body: unknown, key?: string) => h.app.call("POST", path, { cookie: b.cookie, body, headers: key ? { "idempotency-key": key } : {} });

beforeAll(async () => {
  h = await makeHarness();
  registerAccountRoutes(h.app.router!);
  ada = await makeBuyer(h, "ada-acct@example.org", { contact: false });
  cy = await makeBuyer(h, "cy-acct@example.org");
}, 60_000);
afterAll(async () => { await h?.app.drop(); });

describe("C-15: registrant contact form", () => {
  it("rejects malformed input and an email that is not one of the person's verified addresses", async () => {
    expect((await post(ada, "/api/v1/contact", { ...CONTACT, email: ada.email, phone: "555" })).status).toBe(422);
    expect((await post(ada, "/api/v1/contact", { ...CONTACT, email: ada.email, extra: "x" })).status).toBe(422);
    const other = await post(ada, "/api/v1/contact", { ...CONTACT, email: "someone-else@example.org" });
    expect(other.status).toBe(422); expect(other.json.error.code).toBe("email_not_verified");
  });
  it("stores the contact encrypted, and only the owner can read a summary of it", async () => {
    const ok = await post(ada, "/api/v1/contact", { ...CONTACT, email: ada.email });
    expect(ok.status).toBe(201);
    const raw = JSON.stringify((await h.app.db.owner.query("select fields_enc from contacts where user_id = $1", [ada.userId])).rows);
    expect(raw).not.toContain("Fern Lane"); expect(raw).not.toContain("97201");
    const mine = await h.app.call("GET", "/api/v1/contact", { cookie: ada.cookie });
    expect(mine.json).toMatchObject({ present: true, country: "US" });
    const cysView = await h.app.call("GET", "/api/v1/contact", { cookie: cy.cookie });
    expect(JSON.stringify(cysView.json)).not.toContain(ada.email);
  });
  it("needs a session", async () => {
    expect((await h.app.call("POST", "/api/v1/contact", { body: { ...CONTACT, email: ada.email } })).status).toBe(401);
  });
});

describe("C-12 and C-14: acceptance is explicit and recorded per registration", () => {
  it("an order without the current document hashes is refused, and nothing is created", async () => {
    const none = await post(cy, "/api/v1/orders", { fqdn: "moonfern.com", years: 1 }, "acc-1");
    expect(none.status, none.text).toBe(422); expect(none.json.error.code).toBe("terms_not_accepted");
    const wrong = await post(cy, "/api/v1/orders", { fqdn: "moonfern.com", years: 1, accept: { terms: "nope", registration_agreement: "nope" } }, "acc-2");
    expect(wrong.status).toBe(422);
    expect((await h.app.db.owner.query("select count(*)::int n from orders where user_id = $1", [cy.userId])).rows[0].n).toBe(0);
  });
  it("with the hashes shown, the order is created and two consent rows carry them", async () => {
    const docs = (await h.app.call("GET", "/api/v1/documents")).json.documents as { kind: string; version: string; url: string }[];
    expect(docs.map((d) => d.kind).sort()).toEqual(["registration_agreement", "terms"]);
    const accept = Object.fromEntries(docs.map((d) => [d.kind, d.version]));
    const res = await post(cy, "/api/v1/orders", { fqdn: "moonfern.com", years: 1, accept }, "acc-3");
    expect(res.status).toBe(201);
    const rows = (await h.app.db.owner.query("select kind, document_hash from consents where order_id = $1 order by kind", [res.json.order_id])).rows;
    expect(rows.map((r) => r.kind)).toEqual(["registration_agreement", "terms"]);
    expect(rows.map((r) => r.document_hash).sort()).toEqual(Object.values(accept).sort());
  });
});

describe("document set", () => {
  it("syncDocuments publishes file hashes, is idempotent, and retires a changed version", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-"));
    fs.writeFileSync(path.join(dir, "terms.html"), "v1 terms"); fs.writeFileSync(path.join(dir, "registration-agreement.html"), "v1 agreement");
    await h.app.db.owner.query("delete from document_versions");
    const first = await syncDocuments(h.app.db.owner, dir);
    expect(first.every((d) => d.changed)).toBe(true);
    expect((await syncDocuments(h.app.db.owner, dir)).every((d) => !d.changed)).toBe(true);
    fs.writeFileSync(path.join(dir, "terms.html"), "v2 terms");
    const third = await syncDocuments(h.app.db.owner, dir);
    expect(third.find((d) => d.kind === "terms")!.changed).toBe(true);
    const live = (await h.app.db.owner.query("select count(*)::int n from document_versions where kind = 'terms' and retired_at is null")).rows[0].n;
    expect(live).toBe(1);
  });
});
