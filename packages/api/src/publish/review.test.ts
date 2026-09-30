import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, makeDomain, makeKit, makePerson, resetFuse, resetPrepareLimit, stepUp, type Kit, type Person } from "../domain-mgmt/testkit.ts";
import { prepare } from "../stepup/testkit.ts";
import { sha256 } from "../util/bytes.ts";
import { encodePng } from "./png.ts";
import { MemoryCardStorage, MemoryCardsSite, type CardStoragePort } from "./storage.ts";
import { FakeWebRisk } from "./screen.ts";
import { installPublish, type PublishServices } from "./service.ts";
import { CARDS_KEY_HEADER } from "./export.ts";
import { reinstateCard, rescanCards, takeDownCard } from "./jobs.ts";

/** Reproductions of the independent review of the publish module (each failed on the code as reviewed). */

const EXPORT_KEY = "cards-export-key-for-tests-0123456789abcdef";
let k: Kit; let alice: Person;
let storage: MemoryCardStorage; let webRisk: FakeWebRisk; let svc: PublishServices;

beforeAll(async () => {
  k = await makeKit();
  storage = new MemoryCardStorage(); webRisk = new FakeWebRisk();
  svc = installPublish(k.app.ctx, { storage, webRisk, site: new MemoryCardsSite(), cardsOrigin: "https://hatchkind.test", exportKey: EXPORT_KEY });
  alice = await makePerson(k, "alice");
}, 120_000);
afterAll(async () => { await k?.app.drop(); });
beforeEach(async () => { await resetFuse(k); await resetPrepareLimit(k); webRisk.flagged.clear(); webRisk.down = false; installPublish(k.app.ctx, { ...svc, storage }); });

function pixels(w: number, h: number, seed = 1) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = (i * seed) & 255; rgba[i * 4 + 1] = (i >> 3) & 255; rgba[i * 4 + 2] = 90; rgba[i * 4 + 3] = 255; }
  return { width: w, height: h, rgba };
}
const cardPng = (seed: number) => encodePng(pixels(256, 320, seed));
async function publishCard(p: Person, domainId: string, png: Buffer, indexable = false) {
  const action = await stepUp(k, p, "card.publish", domainId, { image_sha256: sha256(png).toString("hex"), indexable });
  return call(k, p, "POST", `/api/v1/domains/${domainId}/card`, { png: png.toString("base64"), indexable }, action);
}
const liveRef = async (domainId: string) => (await k.app.db.owner.query("select snapshot_ref from cards where domain_id = $1 and unpublished_at is null", [domainId])).rows[0]?.snapshot_ref as string | undefined;
const exportPage = (headers: Record<string, string> = { [CARDS_KEY_HEADER]: EXPORT_KEY }, query = "") => k.app.call("GET", `/api/v1/cards/public${query}`, { headers });

describe("review: replaying one card.publish action concurrently", () => {
  it("review: the losing request never deletes the live card's portrait", async () => {
    // Both requests pass the gate while the action is still committed, then meet at storage together (a double click or a retry).
    let waiting: (() => void)[] = [];
    const barrier: CardStoragePort = {
      kind: "memory",
      put: async (key, png) => { await new Promise<void>((go) => { waiting.push(go); if (waiting.length === 2) { for (const w of waiting) w(); waiting = []; } }); return storage.put(key, png); },
      delete: (ref) => storage.delete(ref),
    };
    installPublish(k.app.ctx, { ...svc, storage: barrier });
    const d = await makeDomain(k, alice, "replay-twice.com");
    const png = cardPng(21);
    const act = await stepUp(k, alice, "card.publish", d.id, { image_sha256: sha256(png).toString("hex"), indexable: false });
    const body = { png: png.toString("base64"), indexable: false };
    const [a, b] = await Promise.all([call(k, alice, "POST", `/api/v1/domains/${d.id}/card`, body, act), call(k, alice, "POST", `/api/v1/domains/${d.id}/card`, body, act)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const ref = await liveRef(d.id);
    expect(ref).toBeTruthy();
    expect(storage.files.has(ref!), "the live card's portrait is still stored").toBe(true);
    expect(storage.deletes).not.toContain(ref);
  });
});

describe("review: a take-down holds until support reinstates", () => {
  it("review: the owner cannot republish a taken-down card, at prepare or with an action committed before the take-down", async () => {
    const carol = await makePerson(k, "carol");
    const d = await makeDomain(k, carol, "held-card.com");
    expect((await publishCard(carol, d.id, cardPng(31))).status).toBe(201);
    // An action committed while the card was still live, for a republish.
    const late = cardPng(32);
    const act = await stepUp(k, carol, "card.publish", d.id, { image_sha256: sha256(late).toString("hex"), indexable: true });
    expect((await takeDownCard(k.app.ctx, { slug: "held-card.com", actor: "support", cause: "notice" })).takenDown).toBe(true);

    const p = await prepare(k.app, carol.user, { type: "card.publish", target_id: d.id, user_input: { image_sha256: "c".repeat(64), indexable: false } });
    expect(p.status).toBe(409); expect(p.json.error.code).toBe("card_taken_down");
    const before = storage.files.size;
    const post = await call(k, carol, "POST", `/api/v1/domains/${d.id}/card`, { png: late.toString("base64"), indexable: true }, act);
    expect(post.status).toBe(409); expect(post.json.error.code).toBe("card_taken_down");
    expect(storage.files.size).toBe(before);
    expect((await call(k, carol, "GET", `/api/v1/domains/${d.id}/card`)).json).toMatchObject({ card: null, eligible: false });
    expect((await exportPage()).json.cards.some((c: { slug: string }) => c.slug === "held-card.com")).toBe(false);

    // Support reinstates (a counter-notice or put-back); the owner may then publish again, under a new step-up.
    expect((await reinstateCard(k.app.ctx, { slug: "held-card.com", actor: "support", cause: "counter_notice" })).reinstated).toBe(1);
    expect((await k.app.db.owner.query("select count(*)::int as n from audit_log where action = 'card.reinstated'")).rows[0].n).toBe(1);
    expect((await publishCard(carol, d.id, cardPng(33))).status).toBe(201);
  });

  it("review: a take-down still holds when the owner had already unpublished the card", async () => {
    const dave = await makePerson(k, "dave");
    const d = await makeDomain(k, dave, "quick-exit.com");
    expect((await publishCard(dave, d.id, cardPng(41))).status).toBe(201);
    expect((await call(k, dave, "DELETE", `/api/v1/domains/${d.id}/card`)).status).toBe(200);
    expect((await takeDownCard(k.app.ctx, { slug: "quick-exit.com", actor: "support", cause: "registrar_hold" })).takenDown).toBe(true);
    const p = await prepare(k.app, dave.user, { type: "card.publish", target_id: d.id, user_input: { image_sha256: "d".repeat(64), indexable: false } });
    expect(p.status).toBe(409); expect(p.json.error.code).toBe("card_taken_down");
  });
});

describe("review: the export is for the cards build only", () => {
  it("review: an anonymous or wrong-key request cannot list unlisted cards; the build key can, uncached", async () => {
    const d = await makeDomain(k, alice, "jane-doe-unlisted.com");
    expect((await publishCard(alice, d.id, cardPng(51), false)).status).toBe(201);
    const anon = await k.app.call("GET", "/api/v1/cards/public");
    const wrong = await exportPage({ [CARDS_KEY_HEADER]: EXPORT_KEY.slice(0, -1) + "x" });
    for (const r of [anon, wrong]) {
      expect(r.status).toBe(401);
      expect(r.text).not.toContain("jane-doe");
    }
    expect(anon.text).toBe(wrong.text);
    const ok = await exportPage();
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.json.cards.find((c: { slug: string }) => c.slug === "jane-doe-unlisted.com")).toMatchObject({ indexable: false });
    // Without a configured key the export is closed, never open.
    installPublish(k.app.ctx, { ...svc, exportKey: undefined });
    expect((await exportPage()).status).toBe(401);
  });
});

describe("review: the export and the daily re-scan reach every live card", () => {
  /** Bulk cards straight into the tables (the publish path is proven above): `n` names, the higher the number the older. */
  async function bulk(from: number, to: number) {
    await k.app.db.owner.query(
      `with d as (
         insert into domains (user_id, fqdn_ascii, tld, registrar, state, registered_at, livemode)
         select $1, 'bulk-' || lpad(g::text, 5, '0') || '.com', 'com', 'mock', 'registered', now(), false from generate_series($2::int, $3::int) g
         returning id, fqdn_ascii)
       insert into cards (user_id, domain_id, slug, species, family, rarity, traits, hatched_on, snapshot_ref, snapshot_url, image_sha256, image_width, image_height, image_bytes, indexable, published_at)
       select $1, d.id, d.fqdn_ascii, 'Ember Fox', 'fox', 'common', '["common coat"]'::jsonb, current_date, 'cards/bulk.png', 'https://blob.local.test/cards/bulk.png', repeat('a', 64), 256, 320, 100, false,
              now() - (substring(d.fqdn_ascii from 6 for 5)::int * interval '1 minute')
       from d`, [alice.user.userId, from, to]);
  }

  it("review: following the export's pages returns every card past 5,000, the oldest included", async () => {
    await bulk(1, 5005);
    const total = (await k.app.db.owner.query("select count(*)::int as n from public_cards")).rows[0].n as number;
    expect(total).toBeGreaterThan(5000);
    const seen: string[] = [];
    let query = "";
    for (let i = 0; i < 100; i++) {
      const r = await exportPage(undefined, query);
      expect(r.status, r.text).toBe(200);
      seen.push(...r.json.cards.map((c: { slug: string }) => c.slug));
      if (!r.json.next) break;
      query = `?after=${encodeURIComponent(r.json.next)}`;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(total);
    expect(seen).toContain("bulk-05005.com");
    expect((await exportPage(undefined, "?after=%3Cscript%3E")).status).toBe(422);
  }, 120_000);

  it("review: the daily re-scan screens cards past the first 10,000", async () => {
    await bulk(5006, 10005);
    const d = await makeDomain(k, alice, "zz-last-in-order.com");
    expect((await publishCard(alice, d.id, cardPng(61))).status).toBe(201);
    expect((await k.app.db.owner.query("select count(*)::int as n from public_cards")).rows[0].n).toBeGreaterThan(10_000);
    webRisk.flagged.add("http://zz-last-in-order.com/");
    const scan = await rescanCards(k.app.ctx);
    expect(scan.takenDown).toBe(1);
    expect((await k.app.db.owner.query("select takedown_state from cards where domain_id = $1", [d.id])).rows[0].takedown_state).toBe("taken_down");
  }, 300_000);
});
