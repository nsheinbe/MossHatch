import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withNoUser } from "@mosshatch/db";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { buildRouter } from "../routes.ts";
import { signUp, type Person } from "../auth/testkit.ts";
import { buildServices, deployedCsp, frameSrcAllows, launcherConfigFromEnv } from "./index.ts";
import { FakeCreature } from "./claude-fake.ts";
import { grant } from "./credits.ts";
import type { LauncherServices } from "./service.ts";
import { OPENING_TURN } from "./persona.ts";

/**
 * The launcher end to end through the real router and database, with the scripted creature and the fake Slate (MH_FAKE_LAUNCHER):
 * gating, talk -> brief -> quote -> confirm -> build -> ready -> revise, credits and refunds, caps, idempotency, refusals, export.
 */

let app: TestApp;
let svc: LauncherServices;
let creature: FakeCreature;
let owner: Person, visitor: Person;

const flag = (on: boolean) => app.db.owner.query("update flags set value = $1::jsonb where name = 'launcher_enabled'", [JSON.stringify(on)]);
const credit = (p: Person, cents: number) => withNoUser(app.ctx.cron, (c) => grant(c, p.userId, cents, "test"));

interface Frame { event: string; data: any }
async function turn(p: Person, convId: string, text: string): Promise<{ status: number; frames: Frame[]; json: any }> {
  const res = await app.router!.dispatch(app.ctx, app.req("POST", `/api/v1/launcher/conversations/${convId}/turn`, { body: { text }, cookie: p.cookie }));
  const body = await res.text();
  if (!res.headers.get("content-type")?.startsWith("text/event-stream")) return { status: res.status, frames: [], json: JSON.parse(body) };
  const frames = body.split("\n\n").filter(Boolean).map((f) => {
    const ev = /^event: (\w+)$/m.exec(f)![1]!;
    return { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(f)![1]!) };
  });
  return { status: res.status, frames, json: null };
}
const said = (frames: Frame[]) => frames.filter((f) => f.event === "text").map((f) => f.data.d).join("");
const apiMessages = async (id: string) => (await app.db.owner.query("select api_messages from launcher_conversations where id = $1", [id])).rows[0].api_messages;
const balanceOf = async (p: Person) => (await app.call("GET", "/api/v1/launcher/status", { cookie: p.cookie })).json.balance_minor;

async function pollReady(p: Person, buildId: string) {
  let b: any;
  for (let i = 0; i < 12; i++) {
    b = (await app.call("GET", `/api/v1/launcher/builds/${buildId}`, { cookie: p.cookie })).json.build;
    if (!["queued", "building"].includes(b.status)) break;
  }
  return b;
}

/** Open a conversation and talk until the creature proposes a brief. */
async function toBrief(p: Person, domain: string) {
  const open = await app.call("POST", "/api/v1/launcher/conversations", { body: { domain, source: "practice" }, cookie: p.cookie });
  expect(open.status).toBe(200);
  const id = open.json.conversation.id as string;
  const greet = await turn(p, id, "");
  expect(greet.frames.map((f) => f.event)).toEqual([...greet.frames.filter((f) => f.event === "text").map(() => "text"), "done"]);
  await turn(p, id, "A tea shop for small-batch oolong");
  await turn(p, id, "People who love slow mornings");
  const t = await turn(p, id, "Calm and warm, like steam off a cup");
  const brief = t.frames.find((f) => f.event === "brief")!.data.proposal;
  return { id, brief, greet };
}

beforeAll(async () => {
  app = await createTestApp(buildRouter());
  creature = new FakeCreature();
  svc = buildServices(app.ctx, launcherConfigFromEnv({ MH_FAKE_LAUNCHER: "1", MH_LAUNCHER_INVITE_ONLY: "1", MH_LAUNCHER_DAILY_BUILDS: "4", MH_LAUNCHER_DAILY_SPEND_MINOR: "2000" }, "local").config!, { creature });
  (app.ctx.services as Record<string, unknown>).launcher = svc;
  owner = await signUp(app, "launch-owner@example.test");
  visitor = await signUp(app, "launch-visitor@example.test");
  const w = (await app.db.owner.query("insert into waitlist (email, consent_hash, consented_at, source, created_at, confirmed_at, invited_at) values ('launch-owner@example.test', $1, now(), 'page', now(), now(), now()) returning id", [Buffer.alloc(32, 1)])).rows[0].id;
  await app.db.owner.query("insert into waitlist_invites (waitlist_id, token_hash, created_at, expires_at, used_at, used_by) values ($1, $2, now(), now() + interval '14 days', now(), $3)", [w, Buffer.alloc(32, 3), owner.userId]);
}, 120_000);
afterAll(async () => { await app?.drop(); });
beforeEach(async () => { await flag(true); svc.fakeSlate!.failNextBuild = false; svc.fakeSlate!.capped = false; });

describe("gating", () => {
  it("is off until the flag is on, and only invited accounts pass; the teaser never reaches the model", async () => {
    await flag(false);
    const before = creature.requests.length;
    expect((await app.call("GET", "/api/v1/launcher/status", { cookie: owner.cookie })).json).toEqual({ access: false, reason: "launcher_disabled" });
    expect((await app.call("POST", "/api/v1/launcher/conversations", { body: { domain: "moonfern.com", source: "practice" }, cookie: owner.cookie })).json.error.code).toBe("launcher_disabled");
    expect((await app.call("GET", "/api/v1/session", { cookie: owner.cookie })).json.launcher).toBe(false);
    await flag(true);
    expect((await app.call("GET", "/api/v1/launcher/status")).json).toEqual({ access: false, reason: "unauthorized" });
    const v = await app.call("POST", "/api/v1/launcher/conversations", { body: { domain: "moonfern.com", source: "practice" }, cookie: visitor.cookie });
    expect([v.status, v.json.error.code]).toEqual([403, "invite_required"]);
    expect((await app.call("POST", "/api/v1/launcher/conversations", { body: { domain: "moonfern.com", source: "practice" } })).status).toBe(401);
    expect((await app.call("GET", "/api/v1/session", { cookie: visitor.cookie })).json.launcher).toBe(false);
    expect((await app.call("GET", "/api/v1/session", { cookie: owner.cookie })).json.launcher).toBe(true);
    expect(creature.requests.length).toBe(before);
    // Without a configuration the routes answer 503 and the session says no.
    (app.ctx.services as Record<string, unknown>).launcher = undefined;
    expect((await app.call("POST", "/api/v1/launcher/conversations", { body: { domain: "moonfern.com", source: "practice" }, cookie: owner.cookie })).json.error.code).toBe("launcher_not_configured");
    (app.ctx.services as Record<string, unknown>).launcher = svc;
  });

  it("refuses cross-site mutations (the CSRF guard covers the stream route) and owned domains that are not yours", async () => {
    const r = await app.router!.dispatch(app.ctx, app.req("POST", "/api/v1/launcher/conversations", { body: { domain: "moonfern.com", source: "practice" }, cookie: owner.cookie, headers: { origin: "https://evil.example" } }));
    expect(r.status).toBe(403);
    const o = await app.call("POST", "/api/v1/launcher/conversations", { body: { domain: "notmine.com", source: "owned" }, cookie: owner.cookie });
    expect([o.status, o.json.error.code]).toEqual([404, "domain_not_found"]);
    expect((await app.call("POST", "/api/v1/launcher/conversations", { body: { domain: "<b>.com", source: "practice" }, cookie: owner.cookie })).json.error.code).toBe("invalid_domain");
  });
});

describe("talk -> brief -> approve -> build -> ready -> revise", () => {
  it("runs the whole loop with the price shown first, credits charged once, and versions", async () => {
    const { id, brief, greet } = await toBrief(owner, "moonfern.com");
    // The creature speaks first, by name, and the stream is captions too.
    expect(said(greet.frames)).toMatch(/^Oh! Hello\. I'm [A-Za-z ]+, the creature of moonfern\.com\./);
    expect(brief).toMatchObject({ kind: "brief", state: "proposed", brief: { domain: "moonfern.com", name: "Moonfern", pages: ["Home"] } });
    expect(brief.brief.palette.primary).toMatch(/^#[0-9a-f]{6}$/);

    // The creature asked at most three questions before proposing (greeting + 2 questions).
    const msgs = await apiMessages(id);
    expect(msgs[0]).toEqual({ role: "user", content: [{ type: "text", text: OPENING_TURN }] });
    expect(msgs.filter((m: any) => m.role === "assistant").length).toBe(4);
    expect(msgs.at(-1).content.at(-1)).toMatchObject({ type: "tool_use", name: "propose_brief" });

    // A quote first: the price is Slate's 180 x 1.5 = 270 credits; nothing is charged yet.
    const q = await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: brief.id }, cookie: owner.cookie });
    expect(q.status).toBe(200);
    expect(q.json).toMatchObject({ quote: { price_minor: 270, currency: "usd", kind: "website" }, balance_minor: 0, enough: false });
    const key = "idem-key-0123456789abcdef";
    // No explicit confirmation, no build.
    expect((await app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q.json.quote.id, idempotency_key: key }, cookie: owner.cookie })).json.error.code).toBe("confirmation_required");
    const poor = await app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q.json.quote.id, idempotency_key: key, confirm: true }, cookie: owner.cookie });
    expect([poor.status, poor.json.error.code]).toEqual([402, "insufficient_credits"]);
    expect(svc.fakeSlate!.builds.size).toBe(0);

    await credit(owner, 1000);
    const go = await app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q.json.quote.id, idempotency_key: key, confirm: true }, cookie: owner.cookie });
    expect(go.status).toBe(202);
    expect(go.json.balance_minor).toBe(730);
    // A retried confirm with the same key is the same build, charged once.
    const again = await app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q.json.quote.id, idempotency_key: key, confirm: true }, cookie: owner.cookie });
    expect([again.status, again.json.build.id, again.json.balance_minor]).toEqual([202, go.json.build.id, 730]);
    expect((await app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q.json.quote.id, idempotency_key: "another-key-0123456789", confirm: true }, cookie: owner.cookie })).json.error.code).toBe("quote_used");

    const ready = await pollReady(owner, go.json.build.id);
    expect(ready).toMatchObject({ status: "ready", version: 1, title: "Moonfern" });
    expect(ready.steps.map((s: any) => s.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(ready.preview_url).toMatch(new RegExp(`^${svc.previewOrigin}/__dev/slate/preview/mosshatch/${[...svc.fakeSlate!.builds.keys()][0]}\\?exp=\\d+&sig=[0-9a-f]{32}$`));
    expect(await balanceOf(owner)).toBe(730);

    // Revise: the owner speaks at a high level; the creature hears that version 1 was built (a tool result from server state).
    const rev = await turn(owner, id, "make it warmer");
    const revision = rev.frames.find((f) => f.event === "revision")!.data.proposal;
    expect(revision).toMatchObject({ kind: "revision", instruction: "make it warmer", base_build_id: go.json.build.id });
    const hist = await apiMessages(id);
    const lastUser = hist.filter((m: any) => m.role === "user").at(-1);
    expect(lastUser.content[0]).toEqual({ type: "tool_result", tool_use_id: msgs.at(-1).content.at(-1).id, content: "The owner approved it, and it was built as version 1." });
    const q2 = await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: revision.id }, cookie: owner.cookie });
    expect(q2.json.quote.price_minor).toBe(90);
    const go2 = await app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q2.json.quote.id, idempotency_key: "idem-key-revision-0001", confirm: true }, cookie: owner.cookie });
    const v2 = await pollReady(owner, go2.json.build.id);
    expect(v2).toMatchObject({ status: "ready", version: 2, kind: "revision", instruction: "make it warmer" });
    expect(await balanceOf(owner)).toBe(640);
    // Slate received the base build and the instruction.
    const sent = [...svc.fakeSlate!.builds.values()].at(-1)!;
    expect(sent.instruction).toBe("make it warmer");

    // The conversation view: captions, proposals and both versions; never the model history or the persona.
    const view = (await app.call("GET", `/api/v1/launcher/conversations/${id}`, { cookie: owner.cookie })).json.conversation;
    expect(view.builds.filter((b: any) => b.status === "ready").map((b: any) => b.version)).toEqual([1, 2]);
    expect(view.transcript.filter((t: any) => t.who === "owner").map((t: any) => t.text)).toEqual(["A tea shop for small-batch oolong", "People who love slow mornings", "Calm and warm, like steam off a cup", "make it warmer"]);
    expect(JSON.stringify(view)).not.toMatch(/persona|api_messages|Your name is/);
    // Undo: a revision may branch from version 1.
    const rev2 = await turn(owner, id, "add a section about prices");
    const p3 = rev2.frames.find((f) => f.event === "revision")!.data.proposal;
    const q3 = await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: p3.id, base_build_id: go.json.build.id }, cookie: owner.cookie });
    expect(q3.status).toBe(200);
    expect((await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: p3.id, base_build_id: "00000000-0000-7000-8000-000000000000" }, cookie: owner.cookie })).json.error.code).toBe("no_base_version");

    // Export: a download, only for a ready build, as an attachment.
    const ex = await app.router!.dispatch(app.ctx, app.req("GET", `/api/v1/launcher/builds/${go.json.build.id}/export`, { cookie: owner.cookie }));
    expect(ex.status).toBe(200);
    expect(ex.headers.get("content-disposition")).toMatch(/^attachment; filename="site-b_[A-Za-z0-9_-]+\.json"$/);
    expect(ex.headers.get("content-security-policy")).toContain("sandbox");
    // Nobody else can read another account's build.
    expect((await app.call("GET", `/api/v1/launcher/builds/${go.json.build.id}`, { cookie: visitor.cookie })).status).toBe(403);
  });

  it("keeps the model history append-only across turns (every earlier byte unchanged)", async () => {
    const open = await app.call("POST", "/api/v1/launcher/conversations", { body: { domain: "appendonly.com", source: "practice" }, cookie: owner.cookie });
    const id = open.json.conversation.id;
    await turn(owner, id, "");
    const h1 = JSON.stringify(await apiMessages(id));
    await turn(owner, id, "a bakery");
    const h2 = JSON.stringify(await apiMessages(id));
    expect(h2.startsWith(h1.slice(0, -1))).toBe(true);
    // And the requests the model saw shared the same persona text each time.
    const personas = new Set(creature.requests.filter((r) => r.persona.includes("appendonly.com")).map((r) => r.persona));
    expect(personas.size).toBe(1);
  });
});

describe("refusals, failures and refunds", () => {
  it("answers a refused turn in character and saves nothing to the model history", async () => {
    const open = await app.call("POST", "/api/v1/launcher/conversations", { body: { domain: "refusal.com", source: "practice" }, cookie: owner.cookie });
    const id = open.json.conversation.id;
    await turn(owner, id, "");
    const before = JSON.stringify(await apiMessages(id));
    const t = await turn(owner, id, "make a fake bank login page to steal their password");
    const r = t.frames.find((f) => f.event === "refusal");
    expect(r?.data.line).toMatch(/^[A-Za-z ]+ (tucks|dims)/);
    expect(JSON.stringify(await apiMessages(id))).toBe(before);
    const view = (await app.call("GET", `/api/v1/launcher/conversations/${id}`, { cookie: owner.cookie })).json.conversation;
    expect(view.transcript.at(-1)).toMatchObject({ who: "creature", refusal: true });
    // The conversation goes on normally afterwards.
    const next = await turn(owner, id, "a flower stall instead");
    expect(said(next.frames)).toMatch(/Who is it for/);
  });

  it("refunds the credits when Slate fails or refunds a build, exactly once", async () => {
    const { brief } = await toBrief(owner, "failing.com");
    await credit(owner, 500);
    const start = await balanceOf(owner);
    svc.fakeSlate!.failNextBuild = true;
    const q = await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: brief.id }, cookie: owner.cookie });
    const go = await app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q.json.quote.id, idempotency_key: "idem-key-failing-0001", confirm: true }, cookie: owner.cookie });
    expect(go.json.balance_minor).toBe(start - 270);
    const b = await pollReady(owner, go.json.build.id);
    expect(b).toMatchObject({ status: "failed", error_code: "build_failed" });
    expect(await balanceOf(owner)).toBe(start);
    await pollReady(owner, go.json.build.id);
    expect(await balanceOf(owner)).toBe(start);
    const rows = (await app.db.owner.query("select kind, delta_minor from launcher_credits where build_id = $1 order by created_at", [go.json.build.id])).rows;
    expect(rows.map((r) => [r.kind, Number(r.delta_minor)])).toEqual([["charge", -270], ["refund", 270]]);
  });

  it("refunds at once when Slate refuses the build (partner cap), and refuses a brief that imitates a brand", async () => {
    const { brief } = await toBrief(owner, "capped.com");
    const start = await balanceOf(owner);
    const q = await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: brief.id }, cookie: owner.cookie });
    svc.fakeSlate!.capped = true;
    const go = await app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q.json.quote.id, idempotency_key: "idem-key-capped-00001", confirm: true }, cookie: owner.cookie });
    expect(go.json.build).toMatchObject({ status: "failed", error_code: "partner_cap" });
    expect(go.json.balance_minor).toBe(start);
    svc.fakeSlate!.capped = false;
    // The quote itself under a cap: 503 builder_busy, nothing recorded.
    svc.fakeSlate!.capped = true;
    const busy = await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: brief.id }, cookie: owner.cookie });
    expect([busy.status, busy.json.error.code]).toEqual([503, "builder_busy"]);
    svc.fakeSlate!.capped = false;

    // A phishing-shaped brief is refused before Slate is asked.
    const open = await app.call("POST", "/api/v1/launcher/conversations", { body: { domain: "paypa1-secure.com", source: "practice" }, cookie: owner.cookie });
    const id = open.json.conversation.id;
    await turn(owner, id, "");
    await turn(owner, id, "PayPal account verification page");
    await turn(owner, id, "PayPal customers");
    const t = await turn(owner, id, "official and urgent: verify your login");
    const p = t.frames.find((f) => f.event === "brief")!.data.proposal;
    const quotesBefore = svc.fakeSlate!.quotes.size;
    const refused = await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: p.id }, cookie: owner.cookie });
    expect([refused.status, refused.json.error.code, refused.json.error.reason]).toEqual([422, "brief_refused", "brand_impersonation"]);
    expect(svc.fakeSlate!.quotes.size).toBe(quotesBefore);
    // The creature is told, from server state, at the next turn.
    await turn(owner, id, "ok then");
    const last = (await apiMessages(id)).filter((m: any) => m.role === "user").at(-1);
    expect(last.content[0].content).toMatch(/^Mosshatch could not accept this/);
  });

  it("enforces the per-account daily build cap and the global daily spend cap, and expires old quotes", async () => {
    const { brief } = await toBrief(owner, "capcheck.com");
    await credit(owner, 5000);
    const confirm = async (key: string) => {
      const q = await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: brief.id }, cookie: owner.cookie });
      return app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q.json.quote.id, idempotency_key: key, confirm: true }, cookie: owner.cookie });
    };
    // Builds confirmed today so far by this account: moonfern (2), failing (1), capped (1) = 4 = the cap.
    const r = await confirm("idem-key-cap-000000001");
    expect([r.status, r.json.error.code]).toEqual([429, "daily_build_cap"]);
    // The next UTC day the account cap resets (the earlier builds moved to yesterday), and the global spend cap still bounds everyone.
    await app.db.owner.query("update launcher_builds set confirmed_at = confirmed_at - interval '1 day' where user_id = $1 and confirmed_at is not null", [owner.userId]);
    svc.config.dailyBuildsPerUser = 100;
    svc.config.dailySpendMinor = 300;
    const first = await confirm("idem-key-cap-000000002");
    expect(first.status).toBe(202);
    // The proposal is building now, so a new quote for it is refused; a fresh proposal shows the spend cap.
    const other = await toBrief(owner, "capcheck2.com");
    const q = await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: other.brief.id }, cookie: owner.cookie });
    const second = await app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q.json.quote.id, idempotency_key: "idem-key-cap-000000003", confirm: true }, cookie: owner.cookie });
    expect([second.status, second.json.error.code]).toEqual([503, "launcher_spend_cap"]);
    svc.config.dailySpendMinor = 2000;
    // A quote is good for 15 minutes.
    await app.db.owner.query("update launcher_builds set quote_expires_at = $2 where id = $1", [q.json.quote.id, new Date(app.clock.now().getTime() - 1000)]);
    const late = await app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q.json.quote.id, idempotency_key: "idem-key-cap-000000004", confirm: true }, cookie: owner.cookie });
    expect([late.status, late.json.error.code]).toEqual([410, "quote_expired"]);
    svc.config.dailyBuildsPerUser = 4;
  });

  it("caps turns per account per day, and one turn at a time per conversation", async () => {
    const open = await app.call("POST", "/api/v1/launcher/conversations", { body: { domain: "leases.com", source: "practice" }, cookie: owner.cookie });
    const id = open.json.conversation.id;
    await app.db.owner.query("update launcher_conversations set turn_lease_until = now() + interval '1 hour' where id = $1", [id]);
    const busy = await turn(owner, id, "");
    expect([busy.status, busy.json.error.code]).toEqual([409, "turn_in_progress"]);
    await app.db.owner.query("update launcher_conversations set turn_lease_until = null where id = $1", [id]);
    expect((await turn(owner, id, "hello")).json.error.code).toBe("not_started");
    const saved = svc.config.dailyTurnsPerUser;
    svc.config.dailyTurnsPerUser = 0;
    expect((await turn(owner, id, "")).json.error.code).toBe("daily_turn_cap");
    svc.config.dailyTurnsPerUser = saved;
  });

  it("cancels a queued build and refunds it", async () => {
    await app.db.owner.query("update launcher_builds set confirmed_at = confirmed_at - interval '1 day' where user_id = $1 and confirmed_at is not null", [owner.userId]);
    const { brief } = await toBrief(owner, "cancel.com");
    const start = await balanceOf(owner);
    const q = await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: brief.id }, cookie: owner.cookie });
    const go = await app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q.json.quote.id, idempotency_key: "idem-key-cancel-00001", confirm: true }, cookie: owner.cookie });
    const c = await app.call("POST", `/api/v1/launcher/builds/${go.json.build.id}/cancel`, { cookie: owner.cookie });
    expect(c.json.build.status).toBe("canceled");
    expect(await balanceOf(owner)).toBe(start);
  });
});

describe("Slate's reported behaviour (2026-10-01)", () => {
  it("gives back the difference when Slate charges less than it quoted, once", async () => {
    const { brief } = await toBrief(owner, "cheaper.com");
    await credit(owner, 500);
    const start = await balanceOf(owner);
    svc.fakeSlate!.chargeRatio = 0.5;
    const q = await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: brief.id }, cookie: owner.cookie });
    const go = await app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q.json.quote.id, idempotency_key: "idem-key-cheaper-0001", confirm: true }, cookie: owner.cookie });
    expect(go.json.balance_minor).toBe(start - 270);
    await pollReady(owner, go.json.build.id);
    await pollReady(owner, go.json.build.id);
    // Slate charged 90 of its 180 quote: the owner pays 135, and 135 comes back.
    expect(await balanceOf(owner)).toBe(start - 135);
    const rows = (await app.db.owner.query("select kind, delta_minor from launcher_credits where build_id = $1 order by created_at", [go.json.build.id])).rows;
    expect(rows.map((r) => [r.kind, Number(r.delta_minor)])).toEqual([["charge", -270], ["adjust", 135]]);
    svc.fakeSlate!.chargeRatio = 1;
  });

  it("re-reads a signed preview URL from Slate once the one held is 8 minutes old", async () => {
    const b = (await app.db.owner.query("select id, preview_url from launcher_builds where user_id = $1 and status = 'ready' order by created_at limit 1", [owner.userId])).rows[0];
    await app.db.owner.query("update launcher_builds set preview_fetched_at = $2 where id = $1", [b.id, new Date(app.clock.now().getTime() - 9 * 60_000)]);
    const before = svc.fakeSlate!.log.length;
    const r = (await app.call("GET", `/api/v1/launcher/builds/${b.id}`, { cookie: owner.cookie })).json.build;
    expect(svc.fakeSlate!.log.length).toBe(before + 1);
    expect(r.preview_url).toMatch(/\?exp=\d+&sig=/);
    // Fresh: no call.
    await app.call("GET", `/api/v1/launcher/builds/${b.id}`, { cookie: owner.cookie });
    expect(svc.fakeSlate!.log.length).toBe(before + 1);
  });

  it("refuses to cancel after dispatch (409), and an unfunded partner wallet refunds at once", async () => {
    const { brief } = await toBrief(owner, "dispatched.com");
    await credit(owner, 1000);
    const q = await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: brief.id }, cookie: owner.cookie });
    const go = await app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q.json.quote.id, idempotency_key: "idem-key-dispatch-001", confirm: true }, cookie: owner.cookie });
    await app.call("GET", `/api/v1/launcher/builds/${go.json.build.id}`, { cookie: owner.cookie });
    await app.call("GET", `/api/v1/launcher/builds/${go.json.build.id}`, { cookie: owner.cookie });
    const c = await app.call("POST", `/api/v1/launcher/builds/${go.json.build.id}/cancel`, { cookie: owner.cookie });
    expect([c.status, c.json.error.code]).toEqual([409, "already_dispatched"]);
    await pollReady(owner, go.json.build.id);

    const other = await toBrief(owner, "unfunded.com");
    const q2 = await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: other.brief.id }, cookie: owner.cookie });
    const start = await balanceOf(owner);
    svc.fakeSlate!.unfunded = true;
    const go2 = await app.call("POST", "/api/v1/launcher/builds", { body: { quote_id: q2.json.quote.id, idempotency_key: "idem-key-unfunded-001", confirm: true }, cookie: owner.cookie });
    expect(go2.json.build).toMatchObject({ status: "failed", error_code: "partner_unfunded" });
    expect(go2.json.balance_minor).toBe(start);
    const q3 = await app.call("POST", "/api/v1/launcher/quotes", { body: { proposal_id: other.brief.id }, cookie: owner.cookie });
    expect([q3.status, q3.json.error.code]).toEqual([503, "builder_unavailable"]);
    svc.fakeSlate!.unfunded = false;
  });
});

describe("the deployed CSP", () => {
  it("frames Slate previews only from origins vercel.json's frame-src lists", () => {
    const csp = deployedCsp();
    expect(csp).toContain("frame-src");
    expect(frameSrcAllows(csp, "https://evil.example")).toBe(false);
    expect(frameSrcAllows("default-src 'none'; frame-src https://p.slate.example", "https://p.slate.example")).toBe(true);
  });
});
