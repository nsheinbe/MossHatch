import zlib from "node:zlib";
import { domainToASCII } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, makeDomain, makeKit, makePerson, resetFuse, resetPrepareLimit, stepUp, type Kit, type Person } from "../domain-mgmt/testkit.ts";
import { prepare } from "../stepup/testkit.ts";
import { sha256 } from "../util/bytes.ts";
import { releaseDomain } from "../domains/release.ts";
import { decodePng, encodePng, sanitizePng, PngError } from "./png.ts";
import { MemoryCardStorage, MemoryCardsSite } from "./storage.ts";
import { FakeWebRisk, screenName } from "./screen.ts";
import { installPublish } from "./service.ts";
import { EXPORT_KEYS } from "./export.ts";
import { purgeUnpublished, rescanCards, takeDownCard } from "./jobs.ts";

let k: Kit; let alice: Person; let bob: Person;
let storage: MemoryCardStorage; let webRisk: FakeWebRisk; let site: MemoryCardsSite;

beforeAll(async () => {
  k = await makeKit();
  storage = new MemoryCardStorage(); webRisk = new FakeWebRisk(); site = new MemoryCardsSite();
  installPublish(k.app.ctx, { storage, webRisk, site, cardsOrigin: "https://hatchkind.test" });
  alice = await makePerson(k, "alice"); bob = await makePerson(k, "bob");
}, 120_000);
afterAll(async () => { await k?.app.drop(); });
beforeEach(async () => { await resetFuse(k); await resetPrepareLimit(k); webRisk.flagged.clear(); webRisk.down = false; });

// ---- PNG helpers -----------------------------------------------------------------------------------------------------
function pixels(w: number, h: number, seed = 1) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = (i * seed) & 255; rgba[i * 4 + 1] = (i >> 3) & 255; rgba[i * 4 + 2] = 90; rgba[i * 4 + 3] = 255; }
  return { width: w, height: h, rgba };
}
function crcChunk(type: string, data: Buffer) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, "latin1"); data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(data, zlib.crc32(Buffer.from(type, "latin1"))), 8 + data.length);
  return out;
}
/** Insert chunks right after IHDR (offset 33). */
const withChunks = (png: Buffer, ...chunks: Buffer[]) => Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)]);
const PII = "alice-login@example.org";
const cardPng = (seed = 1) => withChunks(encodePng(pixels(256, 320, seed)), crcChunk("tEXt", Buffer.from(`Author\0${PII}`, "latin1")), crcChunk("eXIf", Buffer.from("MM\0*GPS 51.5N 0.1W")));

async function publishCard(p: Person, domainId: string, png: Buffer, indexable = false) {
  const sha = sha256(png).toString("hex");
  const action = await stepUp(k, p, "card.publish", domainId, { image_sha256: sha, indexable });
  return call(k, p, "POST", `/api/v1/domains/${domainId}/card`, { png: png.toString("base64"), indexable }, action);
}

describe("ST-145 card portrait intake (PNG validation and re-encoding)", () => {
  it("re-encodes to IHDR, IDAT and IEND only, dropping text and EXIF chunks, with the same pixels", () => {
    const up = cardPng();
    expect(up.toString("latin1")).toContain(PII);
    const out = sanitizePng(up);
    expect(out.png.toString("latin1")).not.toContain(PII);
    expect(out.png.toString("latin1")).not.toContain("GPS");
    const types: string[] = [];
    for (let off = 8; off < out.png.length;) { const len = out.png.readUInt32BE(off); types.push(out.png.toString("latin1", off + 4, off + 8)); off += 12 + len; }
    expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(decodePng(out.png).rgba.equals(decodePng(up).rgba)).toBe(true);
  });

  it("refuses the wrong type, size, dimensions, colour type, interlace, bad CRCs, trailing bytes, animation and a decompression bomb", () => {
    const good = encodePng(pixels(256, 320));
    const expectCode = (b: Buffer, code: PngError["code"]) => { try { decodePng(b); throw new Error("accepted"); } catch (e) { expect((e as PngError).code, code).toBe(code); } };
    expectCode(Buffer.from("\xff\xd8\xff\xe0JFIF-not-a-png-at-all", "latin1"), "not_png");
    expectCode(encodePng(pixels(300, 300)), "bad_dimensions");
    expectCode(Buffer.alloc(200_000, 1), "too_large");
    const ihdrPatched = (i: number, v: number) => { const b = Buffer.from(good); b[16 + i] = v; b.writeUInt32BE(zlib.crc32(b.subarray(16, 29), zlib.crc32(Buffer.from("IHDR"))), 29); return b; };
    expectCode(ihdrPatched(9, 3), "unsupported");    // palette
    expectCode(ihdrPatched(12, 1), "unsupported");   // interlaced
    expectCode(ihdrPatched(8, 16), "unsupported");   // 16-bit
    const badCrc = Buffer.from(good); badCrc[30] = badCrc[30]! ^ 0xff; expectCode(badCrc, "bad_crc");
    expectCode(Buffer.concat([good, Buffer.from("<script>")]), "bad_chunk");
    expectCode(withChunks(good, crcChunk("acTL", Buffer.alloc(8))), "unsupported");
    expectCode(withChunks(good, crcChunk("PLTE", Buffer.alloc(3))), "unsupported");
    // A bomb: an IDAT that inflates far past width x height.
    const bomb = zlib.deflateSync(Buffer.alloc(5_000_000), { level: 9 });
    const ihdr = good.subarray(8, 33);
    expectCode(Buffer.concat([good.subarray(0, 8), ihdr, crcChunk("IDAT", bomb), crcChunk("IEND", Buffer.alloc(0))]), "bad_pixels");
  });
});

describe("ST-145 publish flow", () => {
  it("publishes with a passkey step-up: stores only the re-encoded portrait, computed traits and the hatch date", async () => {
    const d = await makeDomain(k, alice, "mossy-garden.com");
    const res = await publishCard(alice, d.id, cardPng());
    expect(res.status, res.text).toBe(201);
    expect(res.json.card).toMatchObject({ slug: "mossy-garden.com", url: "https://hatchkind.test/mossy-garden.com/", indexable: false, hatched_on: k.app.clock.now().toISOString().slice(0, 10) });
    expect(Object.keys(res.json.card).sort()).toEqual(["family", "hatched_on", "indexable", "published_at", "rarity", "slug", "species", "traits", "url"]);
    const row = (await k.app.db.owner.query("select * from cards where domain_id = $1", [d.id])).rows[0];
    const stored = storage.files.get(row.snapshot_ref)!;
    expect(stored.toString("latin1")).not.toContain(PII);
    expect(sha256(stored).toString("hex")).toBe(row.image_sha256);
    expect(row.snapshot_ref).not.toContain("mossy");
    expect(JSON.stringify(row)).not.toContain(PII);
    const audit = (await k.app.db.owner.query("select detail from audit_log where action = 'card.published' and resource_id = $1", [row.id])).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("mossy-garden");
    expect((await k.app.db.owner.query("select count(*)::int as n from jobs where kind = 'cards.rebuild'")).rows[0].n).toBeGreaterThan(0);
  });

  it("refuses without a committed action, with another file than the one signed, a changed listing choice, a free-text field, and on reuse", async () => {
    const d = await makeDomain(k, alice, "quiet-fern.dev");
    const png = cardPng(3);
    const none = await call(k, alice, "POST", `/api/v1/domains/${d.id}/card`, { png: png.toString("base64"), indexable: false });
    expect(none.status).toBe(403); expect(none.json.error.code).toBe("step_up_required");
    const sha = sha256(png).toString("hex");
    const act = await stepUp(k, alice, "card.publish", d.id, { image_sha256: sha, indexable: false });
    const other = await call(k, alice, "POST", `/api/v1/domains/${d.id}/card`, { png: cardPng(5).toString("base64"), indexable: false }, act);
    expect(other.status).toBe(409); expect(other.json.error.code).toBe("card_mismatch");
    const listed = await call(k, alice, "POST", `/api/v1/domains/${d.id}/card`, { png: png.toString("base64"), indexable: true }, act);
    expect(listed.status).toBe(409);
    const caption = await call(k, alice, "POST", `/api/v1/domains/${d.id}/card`, { png: png.toString("base64"), indexable: false, caption: "Visit my shop" }, act);
    expect(caption.status).toBe(422); expect(caption.json.error.code).toBe("invalid_card");
    const ok = await call(k, alice, "POST", `/api/v1/domains/${d.id}/card`, { png: png.toString("base64"), indexable: false }, act);
    expect(ok.status, ok.text).toBe(201);
    const again = await call(k, alice, "POST", `/api/v1/domains/${d.id}/card`, { png: png.toString("base64"), indexable: false }, act);
    expect(again.status).toBe(403);
    expect((await k.app.db.owner.query("select count(*)::int as n from cards where domain_id = $1", [d.id])).rows[0].n).toBe(1);
  });

  it("a bad image is refused with a reason code and nothing is stored", async () => {
    const d = await makeDomain(k, alice, "bad-image.app");
    const before = storage.files.size;
    const res = await publishCard(alice, d.id, encodePng(pixels(512, 512)));
    expect(res.status).toBe(422); expect(res.json.error).toMatchObject({ code: "invalid_image", reason: "bad_dimensions" });
    expect(storage.files.size).toBe(before);
  });

  it("the name screen refuses brand look-alikes and mixed scripts at prepare; Web Risk refuses flagged names and fails closed when down", async () => {
    for (const [name, reason] of [["paypal-login.com", "brand_lookalike"], ["g00gle.com", "brand_lookalike"], ["micros0ft.dev", "brand_lookalike"], [domainToASCII("pаypal.com"), "mixed_script"]] as const) {
      const d = await makeDomain(k, alice, name);
      const p = await prepare(k.app, alice.user, { type: "card.publish", target_id: d.id, user_input: { image_sha256: "a".repeat(64), indexable: false } });
      expect(p.status, name).toBe(422); expect(p.json.error, name).toMatchObject({ code: "card_screen_refused", reason });
      expect(JSON.stringify(p.json)).not.toContain("paypal");
    }
    expect(screenName("applesauce-kitchen.com").ok).toBe(true);
    expect(screenName("mossy-garden.com").ok).toBe(true);
    const flagged = await makeDomain(k, alice, "lure-flagged.com");
    webRisk.flagged.add("http://lure-flagged.com/");
    const f = await publishCard(alice, flagged.id, cardPng(7));
    expect(f.status).toBe(422); expect(f.json.error.reason).toBe("web_risk_flagged");
    const down = await makeDomain(k, alice, "screen-down.com");
    webRisk.down = true;
    const size = storage.files.size;
    const dn = await publishCard(alice, down.id, cardPng(8));
    expect(dn.status).toBe(503); expect(storage.files.size).toBe(size);
    expect((await k.app.db.owner.query("select count(*)::int as n from cards where domain_id in ($1,$2)", [flagged.id, down.id])).rows[0].n).toBe(0);
    expect((await k.app.db.owner.query("select sum(lookups)::int as n from card_screen_counts")).rows[0].n).toBeGreaterThan(0);
  });

  it("unpublish is free, purges the portrait at once, and a second unpublish, a foreign id and an unknown id all give the same 404", async () => {
    const d = await makeDomain(k, alice, "leaf-and-lantern.com");
    expect((await publishCard(alice, d.id, cardPng(9))).status).toBe(201);
    const ref = (await k.app.db.owner.query("select snapshot_ref from cards where domain_id = $1", [d.id])).rows[0].snapshot_ref;
    expect(storage.files.has(ref)).toBe(true);
    const foreign = await call(k, bob, "DELETE", `/api/v1/domains/${d.id}/card`);
    const unknown = await call(k, bob, "DELETE", `/api/v1/domains/018f0000-0000-7000-8000-000000000000/card`);
    expect(foreign.status).toBe(404); expect(foreign.text).toBe(unknown.text);
    expect((await call(k, bob, "GET", `/api/v1/domains/${d.id}/card`)).status).toBe(404);
    const del = await call(k, alice, "DELETE", `/api/v1/domains/${d.id}/card`);
    expect(del.status, del.text).toBe(200);
    expect(storage.files.has(ref)).toBe(false);
    const row = (await k.app.db.owner.query("select unpublish_reason, purged_at from cards where domain_id = $1", [d.id])).rows[0];
    expect(row.unpublish_reason).toBe("owner"); expect(row.purged_at).not.toBeNull();
    const twice = await call(k, alice, "DELETE", `/api/v1/domains/${d.id}/card`);
    expect(twice.status).toBe(404); expect(twice.text).toBe(unknown.text);
    const status = await call(k, alice, "GET", `/api/v1/domains/${d.id}/card`);
    expect(status.json.card).toBeNull();
  });

  it("a storage failure on unpublish leaves the card unpublished and the purge job finishes it later", async () => {
    const d = await makeDomain(k, alice, "slow-storage.com");
    expect((await publishCard(alice, d.id, cardPng(10))).status).toBe(201);
    storage.failNextDelete = true;
    expect((await call(k, alice, "DELETE", `/api/v1/domains/${d.id}/card`)).status).toBe(200);
    expect((await k.app.db.owner.query("select purged_at from cards where domain_id = $1", [d.id])).rows[0].purged_at).toBeNull();
    const r = await purgeUnpublished(k.app.ctx);
    expect(r.purged).toBeGreaterThanOrEqual(1);
    expect((await k.app.db.owner.query("select purged_at from cards where domain_id = $1", [d.id])).rows[0].purged_at).not.toBeNull();
  });
});

describe("ST-145 the public view and the cards role", () => {
  it("ST-95 re-run: the cards role reads only published, unreleased, not-taken-down cards, through the view, with no owner fields", async () => {
    const live = await makeDomain(k, alice, "view-live.com");
    const gone = await makeDomain(k, alice, "view-released.com");
    const off = await makeDomain(k, alice, "view-unpublished.com");
    const down = await makeDomain(k, bob, "view-takedown.com");
    for (const [p, d, i] of [[alice, live, 11], [alice, gone, 12], [alice, off, 13], [bob, down, 14]] as const) expect((await publishCard(p, d.id, cardPng(i), true)).status).toBe(201);
    expect((await call(k, alice, "DELETE", `/api/v1/domains/${off.id}/card`)).status).toBe(200);
    // ST-95 re-run for cards: a release unpublishes, records why, and the purge follows.
    expect((await releaseDomain(k.app.ctx, gone.id, "transferred_out")).released).toBe(true);
    expect((await k.app.db.owner.query("select unpublish_reason from cards where domain_id = $1", [gone.id])).rows[0].unpublish_reason).toBe("released");
    expect((await takeDownCard(k.app.ctx, { slug: "view-takedown.com", actor: "support", cause: "notice" })).takenDown).toBe(true);
    await purgeUnpublished(k.app.ctx);
    expect((await k.app.db.owner.query("select count(*)::int as n from cards where domain_id in ($1,$2,$3) and purged_at is null", [gone.id, off.id, down.id])).rows[0].n).toBe(0);

    const c = await k.app.db.owner.connect();
    try {
      await c.query("begin"); await c.query("set local role mh_cards");
      const rows = (await c.query("select * from public_cards")).rows;
      const slugs = rows.map((r) => r.slug);
      expect(slugs).toContain("view-live.com");
      for (const s of ["view-released.com", "view-unpublished.com", "view-takedown.com"]) expect(slugs).not.toContain(s);
      expect(Object.keys(rows[0]!).sort()).toEqual(["family", "hatched_on", "image_height", "image_sha256", "image_width", "indexable", "published_at", "rarity", "slug", "snapshot_url", "species", "traits"]);
      for (const t of ["cards", "domains", "users", "notification_addresses", "sessions", "card_publish_blocks"]) {
        await c.query("savepoint s");
        await expect(c.query(`select 1 from ${t} limit 1`), t).rejects.toThrow(/permission denied/);
        await c.query("rollback to savepoint s");
      }
      await c.query("savepoint s");
      await expect(c.query("update public_cards set indexable = true")).rejects.toThrow(/permission denied|cannot update view/);
      await c.query("rollback to savepoint s");
      await c.query("rollback");
    } finally { c.release(); }
  });

  it("the export carries only the public fields, and traits are fixed phrases computed from the name", async () => {
    const res = await k.app.call("GET", "/api/v1/cards/public");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.json.cards.length).toBeGreaterThan(0);
    for (const card of res.json.cards) {
      expect(Object.keys(card).sort()).toEqual([...EXPORT_KEYS].sort());
      for (const t of card.traits) expect(t).toMatch(/^(common|uncommon|rare) coat$|^(long|short) (ears|tail)$|^\d spots?$/);
    }
    const text = res.text;
    for (const f of [alice.user.userId, bob.user.userId, alice.login, bob.login, "view-released.com", "view-takedown.com", "view-unpublished.com"]) expect(text).not.toContain(f);
  });

  it("repeat take-downs end a person's publishing, and the daily re-scan takes down a card that turns up on a threat list", async () => {
    const one = await makeDomain(k, bob, "bob-second.com");
    expect((await publishCard(bob, one.id, cardPng(15))).status).toBe(201);
    const report = (await k.app.db.owner.query("insert into abuse_reports (target_kind, channel) values ('card','form') returning id")).rows[0].id;
    const r = await takeDownCard(k.app.ctx, { slug: "bob-second.com", reportId: report, actor: "support", cause: "notice" });
    expect(r).toEqual({ takenDown: true, blocked: true });
    expect((await k.app.db.owner.query("select state, decision, target_id from abuse_reports where id = $1", [report])).rows[0]).toMatchObject({ state: "actioned", decision: "takedown" });
    const next = await makeDomain(k, bob, "bob-third.com");
    const p = await prepare(k.app, bob.user, { type: "card.publish", target_id: next.id, user_input: { image_sha256: "b".repeat(64), indexable: false } });
    expect(p.status).toBe(403); expect(p.json.error.code).toBe("card_publish_blocked");

    const d = await makeDomain(k, alice, "rescan-me.com");
    expect((await publishCard(alice, d.id, cardPng(16))).status).toBe(201);
    webRisk.flagged.add("http://rescan-me.com/");
    const scan = await rescanCards(k.app.ctx);
    expect(scan.takenDown).toBe(1);
    expect((await k.app.db.owner.query("select takedown_state from cards where domain_id = $1", [d.id])).rows[0].takedown_state).toBe("taken_down");
  });
});
