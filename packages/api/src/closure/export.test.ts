import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mintToken } from "../util/token.ts";
import { sha256 } from "../util/bytes.ts";
import { newSession } from "../stepup/testkit.ts";
import { exportSweep, toCsv } from "./export.ts";
import { unzip, zip } from "./zip.ts";
import { addDomain, call, gated, makeClosureKit, makePerson, q, runJobs, stepUp, type ClosureKit, type Person } from "./testkit.ts";

/**
 * Export (design section 4, test plan item 5; C-48 right of access, C-52 DSAR tooling). Security cases first: the request needs a
 * passkey, the file never holds a secret value, ciphertext, token or another person's row, and the one-time link fails without a
 * session, for another person, from another session, twice, and after expiry.
 */

let k: ClosureKit;
let ada: Person, bob: Person;
const SECRET_CANARY = "sk_live_EXPORT_CANARY_do_not_export_0123456789";
const CIPHER_CANARY = Buffer.from("CIPHERTEXT_CANARY_NEVER_EXPORTED");
let adaToken = "", bobDomain = "";

beforeAll(async () => {
  k = await makeClosureKit();
  ada = await makePerson(k, "ada-export");
  bob = await makePerson(k, "bob-export");
  const d = await addDomain(k, ada, `ada-export-${Date.now().toString(36)}.dev`);
  bobDomain = `bob-private-${Date.now().toString(36)}.com`;
  await addDomain(k, bob, bobDomain);
  // A secret with a version whose "ciphertext" is a canary: the export must carry the name and version, never the bytes.
  const s = (await q(k, "insert into secrets (user_id, domain_id, env, name, current_version) values ($1,$2,'prod','STRIPE_KEY',null) returning id", [ada.user.userId, d]))[0].id;
  await q(k, "insert into secret_versions (secret_id, user_id, version, ciphertext, nonce, tag, wrapped_dek, kek_ref, kek_class, created_by_kind) values ($1,$2,1,$3,$4,$5,$6,'kek-1','vault-nonprod','user')",
    [s, ada.user.userId, CIPHER_CANARY, Buffer.alloc(12, 1), Buffer.alloc(16, 2), Buffer.from(SECRET_CANARY)]);
  const t = mintToken("live"); adaToken = t.token;
  await q(k, "insert into bindings (user_id, kind, name, token_prefix, token_hash, expires_at) values ($1,'agent','Ada helper bot',$2,$3, now() + interval '30 days')", [ada.user.userId, t.prefix, t.hash]);
}, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await q(k, "delete from rate_counters"); });

async function requestExport(p: Person): Promise<string> {
  const { actionId } = await stepUp(k, p, "account.export");
  const r = await call(k, p, "POST", "/api/v1/account/export", {}, gated(actionId));
  expect(r.status, r.text).toBe(202);
  return r.json.export.id as string;
}
async function ticket(p: Person, id: string) {
  return call(k, p, "POST", `/api/v1/account/exports/${id}/link`, {});
}
async function download(p: Person, id: string, token: string) {
  return call(k, p, "POST", `/api/v1/account/exports/${id}/download`, { token });
}

describe("C-48 export: the request needs a passkey", () => {
  it("POST /account/export without a committed account.export action is 403 step_up_required, and nothing is queued", async () => {
    const r = await call(k, ada, "POST", "/api/v1/account/export", {});
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({ code: "step_up_required", type: "account.export" });
    expect((await q(k, "select count(*)::int as n from account_exports where user_id = $1", [ada.user.userId]))[0].n).toBe(0);
  });
  it("an action of another type, another person's action, or a bearer token does not open it", async () => {
    const close = await stepUp(k, ada, "account.close", { delete_domains: true });
    expect((await call(k, ada, "POST", "/api/v1/account/export", {}, gated(close.actionId))).status).toBe(403);
    const bobs = await stepUp(k, bob, "account.export");
    expect((await call(k, ada, "POST", "/api/v1/account/export", {}, gated(bobs.actionId))).status).toBe(403);
    const bearer = await k.h.app.call("POST", "/api/v1/account/export", { authorization: `Bearer ${adaToken}`, body: {}, browser: false });
    expect([401, 403]).toContain(bearer.status);
    // Preparing for someone else's account is the same 404 as a made-up target.
    const other = await k.h.app.call("POST", "/api/v1/actions/prepare", { cookie: ada.user.cookie, body: { type: "account.export", target_id: bob.user.userId, user_input: {} } });
    expect(other.status).toBe(404);
    await q(k, "update actions set state = 'cancelled' where state = 'committed'");
  });
});

describe("C-48 export: contents", () => {
  let files: Map<string, Buffer>;
  let exportId = "";
  it("builds as the tenant, marks it ready for 7 days and mails every verified address with no link but the site", async () => {
    k.h.app.email.clear();
    exportId = await requestExport(ada);
    expect(await runJobs(k, ["account.export"])).toBe(1);
    const row = (await q(k, "select * from account_exports where id = $1", [exportId]))[0];
    expect(row.state).toBe("ready");
    expect(new Date(row.expires_at).getTime() - new Date(row.ready_at).getTime()).toBe(7 * 86_400_000);
    const mails = k.h.app.email.sent.filter((m) => m.kind === "account_export_ready");
    expect(mails.map((m) => m.to[0]).sort()).toEqual([ada.email, ada.second].sort());
    for (const m of mails) for (const u of m.text.match(/https?:\/\/\S+/g) ?? []) expect(u.replace(/[.,]$/, "")).toBe(k.h.app.ctx.config.origin);
    // The stored file is encrypted: neither the email nor the contact name appears in the table.
    const stored = JSON.stringify((await q(k, "select envelope from account_export_files where export_id = $1", [exportId]))[0]);
    expect(stored).not.toContain(ada.email);
    expect(stored).not.toContain("Ada Moss");
  });
  it("downloads once through a ticket and holds the person's data, in JSON and one CSV per table", async () => {
    const t = await ticket(ada, exportId);
    expect(t.status, t.text).toBe(201);
    expect(t.headers.get("cache-control")).toContain("no-store");
    const d = await download(ada, exportId, t.json.token);
    expect(d.status, d.text).toBe(200);
    expect(d.headers.get("cache-control")).toContain("no-store");
    const bytes = Buffer.from(d.json.data, "base64");
    expect(sha256(bytes).toString("hex")).toBe(d.json.sha256);
    files = unzip(bytes);
    expect([...files.keys()]).toEqual(expect.arrayContaining(["README.txt", "export.json", "tables/account.csv", "tables/contacts.csv", "tables/domains.csv", "tables/orders.csv", "tables/payments.csv", "tables/refunds.csv", "tables/notices.csv", "tables/consents.csv", "tables/audit_log.csv", "tables/tokens.csv", "tables/cards.csv", "tables/secrets.csv"]));
    const data = JSON.parse(files.get("export.json")!.toString("utf8"));
    expect(data.format).toBe("mosshatch-export-v1");
    expect(data.account_id).toBe(ada.user.userId);
    expect(data.tables.account[0].email).toBe(ada.email);
    expect(data.tables.contacts[0]).toMatchObject({ name: "Ada Moss", street: "1 Fern Lane", email: ada.email });
    expect(data.tables.secrets[0]).toMatchObject({ name: "STRIPE_KEY", env: "prod" });
    expect(data.tables.tokens[0]).toMatchObject({ name: "Ada helper bot" });
    expect(data.tables.audit_log.length).toBeGreaterThan(0);
    expect(data.tables.audit_log.every((r: { seq: number }) => typeof r.seq === "number")).toBe(true);
    expect(files.get("tables/account.csv")!.toString("utf8")).toContain(ada.email);
  });
  it("design test 5: no secret value, no ciphertext, no token or its hash, no passkey key, and no other person's row", async () => {
    const all = [...files.values()].map((b) => b.toString("utf8")).join("\n");
    const tokenRow = (await q(k, "select token_hash from bindings where user_id = $1", [ada.user.userId]))[0];
    const pk = (await q(k, "select public_key, credential_id from passkeys where user_id = $1", [ada.user.userId]))[0];
    const forbidden = [SECRET_CANARY, CIPHER_CANARY.toString("utf8"), CIPHER_CANARY.toString("base64"), adaToken, adaToken.slice(8), Buffer.from(tokenRow.token_hash).toString("hex"),
      Buffer.from(tokenRow.token_hash).toString("base64"), Buffer.from(pk.public_key).toString("base64"), pk.credential_id,
      bob.email, bob.second, bob.user.userId, bobDomain];
    for (const f of forbidden) expect(all.includes(f), `export contains ${f.slice(0, 16)}`).toBe(false);
    // Nothing bytea-shaped at all: a "\x" hex dump would mean a hash or key column was selected.
    expect(all).not.toMatch(/\\x[0-9a-f]{16}/);
  });
});

describe("C-48 export: the one-time link", () => {
  let exportId = "";
  beforeAll(async () => {
    await q(k, "delete from account_exports where user_id = $1 and state <> 'ready'", [ada.user.userId]).catch(() => undefined);
    exportId = (await q(k, "select id from account_exports where user_id = $1 and state = 'ready' order by requested_at desc limit 1", [ada.user.userId]))[0].id;
  });
  it("a spent ticket, a made-up one, another session's, and another person's all fail the same way", async () => {
    const t = await ticket(ada, exportId);
    expect((await download(ada, exportId, t.json.token)).status).toBe(200);
    const again = await download(ada, exportId, t.json.token);
    expect(again.status).toBe(403); expect(again.json.error.code).toBe("link_invalid");
    expect((await download(ada, exportId, "A".repeat(43))).status).toBe(403);
    // Minted in one session, spent in another: refused.
    const t2 = await ticket(ada, exportId);
    const other = await newSession(k.h.app, ada.user);
    const fromOther = await k.h.app.call("POST", `/api/v1/account/exports/${exportId}/download`, { cookie: other.cookie, body: { token: t2.json.token } });
    expect(fromOther.status).toBe(403);
    // Bob with Ada's live ticket and export id: the same 404 as an export that does not exist.
    const t3 = await ticket(ada, exportId);
    const bobTry = await download(bob, exportId, t3.json.token);
    const bobMissing = await download(bob, "018f0000-0000-7000-8000-000000000000", t3.json.token);
    expect(bobTry.status).toBe(404);
    expect(JSON.stringify([bobTry.status, bobTry.json])).toBe(JSON.stringify([bobMissing.status, bobMissing.json]));
    expect((await ticket(bob, exportId)).status).toBe(404);
    // The ticket Bob tried is still Ada's to use.
    expect((await download(ada, exportId, t3.json.token)).status).toBe(200);
  });
  it("without a session the link and the download are refused", async () => {
    const t = await ticket(ada, exportId);
    const anon = await k.h.app.call("POST", `/api/v1/account/exports/${exportId}/download`, { body: { token: t.json.token } });
    expect(anon.status).toBe(401);
    expect((await k.h.app.call("POST", `/api/v1/account/exports/${exportId}/link`, { body: {} })).status).toBe(401);
    expect((await k.h.app.call("GET", "/api/v1/account/exports")).status).toBe(401);
  });
  it("a ticket dies after 5 minutes, and the export itself after 7 days, when the sweep deletes the file", async () => {
    const t = await ticket(ada, exportId);
    k.h.app.clock.advance(5 * 60_000 + 1000);
    expect((await download(ada, exportId, t.json.token)).status).toBe(403);
    k.h.app.clock.advance(7 * 86_400_000);
    ada = { ...ada, user: await newSession(k.h.app, ada.user) };             // the old session ended long ago (8 hours absolute)
    const late = await ticket(ada, exportId);
    expect(late.status).toBe(409); expect(late.json.error.code).toBe("export_unavailable");
    const s = await exportSweep(k.h.app.ctx);
    expect(s.expired).toBeGreaterThanOrEqual(1);
    const row = (await q(k, "select state, storage_ref, file_deleted_at from account_exports where id = $1", [exportId]))[0];
    expect(row).toMatchObject({ state: "expired", storage_ref: null });
    expect((await q(k, "select count(*)::int as n from account_export_files where export_id = $1", [exportId]))[0].n).toBe(0);
    // The list never shows a storage reference.
    const list = await call(k, ada, "GET", "/api/v1/account/exports");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toMatch(/storage_ref|db:/);
  });
});

describe("C-48 export: limits", () => {
  it("one request in flight (409 export_in_progress) and three per 30 days (429); a refused request leaves its action unused", async () => {
    const carl = await makePerson(k, "carl-export");
    const first = await stepUp(k, carl, "account.export");
    expect((await call(k, carl, "POST", "/api/v1/account/export", {}, gated(first.actionId))).status).toBe(202);
    const second = await stepUp(k, carl, "account.export");
    const busy = await call(k, carl, "POST", "/api/v1/account/export", {}, gated(second.actionId));
    expect(busy.status).toBe(409); expect(busy.json.error.code).toBe("export_in_progress");
    expect((await q(k, "select state from actions where id = $1", [second.actionId]))[0].state).toBe("committed");
    await runJobs(k, ["account.export"]);
    expect((await call(k, carl, "POST", "/api/v1/account/export", {}, gated(second.actionId))).status).toBe(202);
    await runJobs(k, ["account.export"]);
    const third = await stepUp(k, carl, "account.export");
    expect((await call(k, carl, "POST", "/api/v1/account/export", {}, gated(third.actionId))).status).toBe(202);
    await runJobs(k, ["account.export"]);
    const fourth = await stepUp(k, carl, "account.export");
    const limited = await call(k, carl, "POST", "/api/v1/account/export", {}, gated(fourth.actionId));
    expect(limited.status).toBe(429);
    // An action is single use: the one that opened the first export cannot open another.
    expect((await call(k, carl, "POST", "/api/v1/account/export", {}, gated(first.actionId))).status).toBe(403);
  });
});

describe("export file format", () => {
  it("CSV cells that a spreadsheet would run as a formula are neutralised; quotes, commas and newlines are escaped", () => {
    const csv = toCsv([{ a: "=HYPERLINK(\"x\")", b: "+1", c: "@cmd", d: "-2", e: "-x", f: 'say "hi", then\nleave', g: null, h: { k: 1 } }]);
    const [head, row] = csv.split("\r\n");
    expect(head).toBe("a,b,c,d,e,f,g,h");
    expect(row).toBe(`"'=HYPERLINK(""x"")",'+1,'@cmd,-2,'-x,"say ""hi"", then\nleave",,"{""k"":1}"`);
  });
  it("the ZIP round-trips, checks each CRC, and refuses unsafe entry names", () => {
    const at = new Date("2026-10-01T12:00:00Z");
    const z = zip([{ name: "a.txt", data: "hello" }, { name: "t/b.csv", data: "x,y\r\n".repeat(200) }], at);
    const back = unzip(z);
    expect(back.get("a.txt")!.toString()).toBe("hello");
    expect(back.get("t/b.csv")!.toString()).toBe("x,y\r\n".repeat(200));
    for (const bad of ["../x", "/abs", "a/../../b", "with space"]) expect(() => zip([{ name: bad, data: "" }], at), bad).toThrow();
    const corrupt = Buffer.from(z); corrupt[40] = corrupt[40]! ^ 0xff;
    expect(() => unzip(corrupt)).toThrow();
  });
});
